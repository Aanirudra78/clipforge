#!/usr/bin/env node
/**
 * Headless ClipForge run — no DB, no HTTP server, no SSE.
 *
 *   node scripts/cloud-render.mjs --src in/source.mp4 --out out
 *
 * Used by .github/workflows/render.yml (phone → GitHub Actions), but it runs
 * anywhere Node + ffmpeg exist, so the same code can be tested locally.
 * Output:
 *   out/clip-01.mp4 ... clip-NN.mp4
 *   out/clip-01.jpg ... (thumbnails)
 *   out/manifest.json   (what was picked, for the phone UI / re-render)
 *   out/log.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import { probe } from '../server/media.js';
import { analyzeAudio, detectScenes, trackSubject } from '../server/analyze.js';
import { transcribe } from '../server/transcribe.js';
import { transliterate } from '../server/translit.js';
import { pickClips, speechUnits, sentences as indexSentences, dedupeWords } from '../server/select.js';
import { pickHighlights } from '../server/highlights.js';
import { curate } from '../server/curate.js';
import { renderClip, framePlan } from '../server/render.js';
import { planCuts } from '../server/cuts.js';
import { BROLL, setFps } from '../server/config.js';
import { planBroll, brollHealth } from '../server/broll/index.js';
import { resolveMusic } from '../server/music/index.js';
import { lookMusic } from '../server/looks/index.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);

const SRC = path.resolve(args.src || '');
const OUT = path.resolve(args.out || 'out');
// Public repo: keep transcript-derived text (b-roll phrases, spoken cards) out
// of the Actions log. The manifest still carries the hook for the phone UI.
const QUIET = process.env.CF_QUIET === '1' || args.quiet === 'true';
if (!SRC || !fs.existsSync(SRC)) {
  console.error(`source video not found: ${SRC || '(missing --src)'}`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const MODE = String(args.mode || 'podcast').toLowerCase() === 'gaming' ? 'gaming' : 'podcast';
// Gaming clips: the game is the b-roll, a music bed fights the gameplay audio,
// and captions only make sense when the commentary is real speech (pure
// gameplay ASR comes back as hallucinated garbage). Each is opt-out.
const MUSIC_DEFAULT = MODE === 'gaming' ? 'none' : 'auto';
const BROLL_DEFAULT = MODE === 'gaming' ? false : (args.broll !== 'off' && BROLL);
const CAPTIONS = String(args.captions || 'auto').toLowerCase(); // auto | on | off

const OPT = {
  count: clampInt(args.count, 1, 8, 6),
  mode: MODE,
  template: args.template || 'pop',
  accent: args.accent || 'yellow',
  look: args.look || 'none',
  music: args.music || MUSIC_DEFAULT,
  musicTrack: args.musicTrack || '',
  musicGain: Number(args.musicGain || 0.22),
  punch: Number(args.punch || 1.3),
  position: Number(args.position || 0.78),
  size: 1,
  crop: args.crop || 'auto',
  zoom: 0,
  title: args.title || '',
  broll: BROLL_DEFAULT,
};

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
}

const lines = [];
function log(msg) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
  lines.push(line);
  console.log(line);
}
function step(name) { log(`STEP ${name}`); }
function saveLog() {
  try { fs.writeFileSync(path.join(OUT, 'log.txt'), `${lines.join('\n')}\n`); } catch {}
}

const t0 = Date.now();
try {
  step('probe');
  const meta = await probe(SRC);
  log(`source ${meta.width}x${meta.height} ${meta.duration.toFixed(1)}s ${meta.fps}fps audio=${Boolean(meta.hasAudio)}`);

  // Output fps follows the source (60 -> 60, 30 -> 30) but never above the cap:
  // on a 2-core Actions runner every extra frame is encoder time, so the default
  // cap is 30 unless the caller passes --max-fps 60.
  const maxFps = clampInt(args.maxFps ?? args['max-fps'] ?? process.env.CF_MAX_FPS ?? 30, 24, 60, 30);
  const fps = setFps(Math.min(maxFps, meta.fps >= 50 ? 60 : 30));
  log(`output fps ${fps} (source ${meta.fps}, cap ${maxFps}, mode ${OPT.mode})`);

  step('audio');
  const audio = await analyzeAudio(SRC, (x) => { if (x % 0.25 < 0.01) log(`listening ${(x * 100).toFixed(0)}%`); });
  step('scenes');
  const scenes = await detectScenes(SRC);

  step('transcribe');
  let transcript = { words: [], text: '', source: 'none' };
  // Groq's free tier rate-limits hard; a 40-minute podcast can hit 429 halfway
  // through the chunks. Back off and try the whole file again before giving up.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      transcript = await transcribe(SRC, {
        onLog: log,
        onProgress: (x) => { if (x % 0.2 < 0.01) log(`transcribing ${(x * 100).toFixed(0)}%`); },
      });
      break;
    } catch (err) {
      const msg = String(err.message || err).slice(0, 200);
      const rate = /\b429\b|rate.?limit|quota|too many/i.test(msg);
      log(`transcription attempt ${attempt} failed (${msg})`);
      if (attempt === 3 || !rate) {
        log('transcription failed — audio-only mode');
        break;
      }
      const wait = attempt * 60;
      log(`rate limited — waiting ${wait}s before retry`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  const hasWords = transcript.words?.length > 3;
  log(hasWords ? `${transcript.words.length} words (${transcript.source})` : 'no transcript');

  step('cleanup');
  let tWords = dedupeWords(transcript.words || []);
  if (hasWords && tWords.some((w) => /[\u0900-\u097F]/.test(String(w.word || '')))) {
    try {
      const ro = await transliterate(tWords, { onLog: log });
      tWords = ro.words;
    } catch (err) {
      log(`romanise failed: ${String(err.message).slice(0, 120)}`);
    }
  }

  step('curate');
  let chosen = [];
  let sentenceCount = 0;
  if (OPT.mode === 'gaming') {
    // The transcript still runs (facecam commentary gets captions), but the
    // SELECTION ignores it: highlights are loudness-vs-neighbourhood peaks plus
    // scene-cut density, snapped to cuts/silence, 2 s padded.
    const hl = pickHighlights({
      energy: audio.energy, step: audio.step, silence: audio.silence, scenes,
      duration: meta.duration, count: OPT.count,
      targetLen: clampInt(args.len ?? args['clip-len'], 8, 45, 20), pad: 2,
    });
    chosen = hl.map((c) => ({ ...c, source: 'audio', hook: '' }));
    log(`${chosen.length} action moments picked from audio peaks`);
    if (!chosen.length) throw new Error('no clips could be picked from this video');
  } else {
    const units = speechUnits(tWords, audio.silence, meta.duration);
    const sentences = indexSentences(tWords, audio.silence, meta.duration);
    sentenceCount = sentences.length;
    if (hasWords && sentences.length >= 4) {
      chosen = await curate({
        sentences, count: OPT.count, minLen: 18, maxLen: 42,
        title: OPT.title || path.basename(SRC), silence: audio.silence, onLog: log,
      }) || [];
    }
    if (!chosen.length) {
      chosen = pickClips({
        units, energy: audio.energy, step: audio.step, silence: audio.silence,
        duration: meta.duration, count: OPT.count, minLen: 16, maxLen: 46,
      }).map((c) => ({ ...c, source: 'heuristic' }));
      log(`${chosen.length} moments picked with the audio heuristic`);
    } else {
      log(`${chosen.length} AI-picked moments out of ${sentences.length} sentences`);
    }
    if (!chosen.length) throw new Error('no clips could be picked from this video');
  }

  // Caption gate for gaming: Whisper on pure gameplay audio returns hallucinated
  // phrases. Real commentary shows up as a sane words-per-minute with varied
  // vocabulary, so rate it and decide once per video.
  let captions = CAPTIONS !== 'off';
  if (captions && OPT.mode === 'gaming') {
    const wpm = tWords.length / Math.max(1, meta.duration / 60);
    const uniq = new Set(tWords.slice(0, 4000).map((w) => String(w.word).toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))).size;
    const variety = tWords.length ? uniq / tWords.length : 0;
    const sane = wpm >= 45 && wpm <= 320 && variety >= 0.25;
    if (!sane) {
      captions = false;
      log(`captions off: speech looks sparse or garbled (wpm ${Math.round(wpm)}, variety ${(variety * 100).toFixed(0)}%)`);
    } else {
      log(`captions on: speech ${Math.round(wpm)} wpm, variety ${(variety * 100).toFixed(0)}%`);
    }
  }

  step('speakers');
  let subject = null;
  if (OPT.mode !== 'gaming') {
    // The skin-blob tracker means nothing on gameplay footage; skip it.
    const windows = chosen
      .map((c) => ({ start: Math.max(0, c.start - 2), end: c.end + 2 }))
      .sort((a, b) => a.start - b.start);
    subject = await trackSubject(SRC, windows).catch(() => null);
    if (subject) log(`speaker tracking ${(subject.confidence * 100).toFixed(0)}%`);
  }

  step('render');
  // Gaming keeps the whole frame (facecam + HUD live in it) as a wide card over
  // the blur bed; podcasts punch in on the talking head.
  const autoCrop = OPT.crop === 'auto' ? (OPT.mode === 'gaming' ? 'blur' : 'punch') : OPT.crop;
  const made = [];
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i];
    const cutAt = Number.isFinite(c.cut) ? c.cut : c.start;
    const lastWordEnd = c.words?.length ? c.words[c.words.length - 1].end : null;
    let words = lastWordEnd
      ? tWords.filter((w) => w.start >= cutAt - 0.02 && w.start <= lastWordEnd)
      : tWords.filter((w) => w.start >= cutAt - 0.001 && w.start < c.end);
    if (!captions) words = [];
    const win = subject ? subject.nodes.filter((n) => n.t >= c.start - 1 && n.t <= c.end + 1) : [];
    const twoUp = win.length >= 3
      ? win.filter((n) => n.two).length / win.length >= 0.4
      : (subject?.twoSpeakers || 0) >= 0.4;
    const framing = framePlan({
      nodes: win, punch: OPT.punch, confidence: subject?.confidence ?? 1,
      srcW: meta.width, srcH: meta.height, twoUp,
    });
    const plan = planCuts({ words, start: c.start, end: c.end, silence: audio.silence });
    log(`clip ${i + 1}/${chosen.length}: ${c.start.toFixed(1)}-${c.end.toFixed(1)}s (${framing.reason})`);

    let broll = null;
    if (OPT.broll) {
      try {
        const rows = await planBroll({ words, start: c.start, end: c.end, hook: c.hook || '', max: 4, onLog: QUIET ? undefined : log });
        if (rows.length) {
          broll = rows;
          if (!QUIET) log(`clip ${i + 1} visuals: ${rows.map((r) => r.query || r.label).join(' · ')}`);
          else log(`clip ${i + 1} visuals: ${rows.length}`);
        }
      } catch (err) {
        log(`clip ${i + 1} b-roll skipped: ${String(err.message || err).slice(0, 90)}`);
      }
    }

    const id = `c${String(i + 1).padStart(2, '0')}`;
    const music = await resolveMusic({
      mode: OPT.music, track: OPT.musicTrack, look: OPT.look,
      seed: `${path.basename(SRC)}:${i}`, ...(lookMusic(OPT.look) || {}), onLog: log,
    });
    const out = await renderClip({
      id, source: SRC, start: c.start, end: c.end, crop: autoCrop, template: OPT.template,
      position: OPT.position, size: OPT.size, accent: OPT.accent,
      title: OPT.title || c.hook || '', zoom: OPT.zoom,
      punch: framing.card, words, subject: subject
        ? { nodes: subject.nodes.filter((n) => n.t >= c.start - 2 && n.t <= c.end + 2), confidence: subject.confidence }
        : null,
      srcW: meta.width, srcH: meta.height, hasAudio: Boolean(meta.hasAudio),
      cuts: plan.cuts, look: OPT.look,
      musicPath: music?.path, musicBpm: music?.bpm || 0, musicGain: OPT.musicGain,
      musicPulse: true, broll,
      punchIns: (c.peaks || []).map((t) => ({ t: t - c.start })),
      showBar: captions,
      onLog: log,
      onProgress: () => {},
    });
    const file = `clip-${String(i + 1).padStart(2, '0')}.mp4`;
    const thumb = `clip-${String(i + 1).padStart(2, '0')}.jpg`;
    fs.copyFileSync(out.path, path.join(OUT, file));
    if (out.thumb && fs.existsSync(out.thumb)) fs.copyFileSync(out.thumb, path.join(OUT, thumb));
    log(`clip ${i + 1} rendered: ${file} (${(fs.statSync(path.join(OUT, file)).size / 1e6).toFixed(1)} MB)`);

    const entry = {
      id, file,
      thumb: fs.existsSync(path.join(OUT, thumb)) ? thumb : null,
      start: c.start, end: c.end, duration: out.duration ?? (c.end - c.start),
      hook: c.hook || '', reason: c.reason || '',
      score: c.score ?? 0,
      framing: out.framing ?? framing.reason,
      mode: out.mode || '', encoder: out.encoder || '',
      peaks: c.peaks || [],
      captions: words.length > 0,
      visuals: (out.broll?.assets || 0) + (out.broll?.cards || 0),
      broll: (broll || []).map((r) => ({ query: r.query, label: r.label, kind: r.kind, provider: r.provider })),
      music: music?.name || '',
    };
    // The manifest is published on a public release: keep the raw transcript
    // out unless the caller explicitly asks for a re-renderable copy.
    if (args.full === 'true') {
      entry.text = c.text || '';
      entry.plan = {
        start: c.start, end: c.end, data: {
          words, crop: autoCrop, template: OPT.template, accent: OPT.accent,
          position: OPT.position, size: OPT.size, punch: framing.card, look: OPT.look,
          music: OPT.music, musicTrack: OPT.musicTrack, musicGain: OPT.musicGain,
          title: OPT.title || c.hook || '', cuts: plan.cuts, broll,
        },
      };
    }
    made.push(entry);
  }

  const manifest = {
    version: 1,
    created: new Date().toISOString(),
    source: {
      name: path.basename(SRC), width: meta.width, height: meta.height,
      duration: meta.duration, fps: meta.fps,
    },
    options: OPT,
    stats: {
      words: tWords.length, sentences: sentenceCount,
      clips: made.length, scenes: scenes?.length || 0,
      fps, captions,
      seconds: Math.round((Date.now() - t0) / 1000),
    },
    clips: made,
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  // Provider health in one line, even in quiet mode: a CI run that spends its
  // time on dead hosts should say so (no transcript text, safe to publish).
  const bh = brollHealth();
  if (bh.length) {
    const ok = bh.filter((h) => h.ok).map((h) => `${h.provider}:${h.ok}`);
    const bad = bh.filter((h) => h.fail).map((h) => `${h.provider}:${h.fail}${h.msg ? ` (${h.msg})` : ''}`);
    log(`b-roll sources${ok.length ? ` · ok ${ok.join(' ')}` : ''}${bad.length ? ` · failed ${bad.join(' · ')}` : ''}`);
  }
  step('done');
  log(`${made.length} clips in ${manifest.stats.seconds}s`);
  saveLog();
} catch (err) {
  log(`FAILED: ${String(err?.message || err)}`);
  saveLog();
  process.exitCode = 1;
}
