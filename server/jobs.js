import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { projects, clips, jobs } from './db.js';
import { probe } from './media.js';
import { analyzeAudio, detectScenes, trackSubject } from './analyze.js';
import { transcribe } from './transcribe.js';
import { transliterate } from './translit.js';
import { pickClips, speechUnits, sentences as indexSentences, dedupeWords } from './select.js';
import { curate } from './curate.js';
import { renderClip, framePlan } from './render.js';
import { planCuts } from './cuts.js';
import { BROLL, DIRS } from './config.js';
import { planBroll as planBrollAssets } from './broll/index.js';
import { resolveMusic } from './music/index.js';
import { lookMusic } from './looks/index.js';

export const bus = new EventEmitter();
bus.setMaxListeners(50);
export const emit = (type, payload) => bus.emit('event', { type, ...payload, at: Date.now() });

const DEFAULTS = {
  count: 6,
  minLen: 16,
  maxLen: 46,
  template: 'pop',
  crop: 'auto',
  position: 0.78,
  size: 1,
  accent: 'yellow',
  title: '',
  zoom: 0,
  punch: 1.3,
  look: 'none',
  music: 'auto',
  musicTrack: '',
  musicGain: 0.22,
  musicPulse: true,
  preset: 'podcast',
};

// Rendering is CPU-bound but one ffmpeg rarely fills 16 threads: two clips at
// once measured 1.5x the throughput (20.7s → 13.7s for two clips).
const MAX_PARALLEL = Math.max(1, Number(process.env.CLIPFORGE_PARALLEL || 2));
let running = 0;

export function enqueue(projectId, type, payload = {}) {
  const id = randomUUID();
  jobs.insert({ id, project_id: projectId, type, payload, status: 'queued' });
  emit('job', { jobId: id, projectId, status: 'queued' });
  kick();
  return id;
}

export function kick() {
  while (running < MAX_PARALLEL) {
    const job = jobs.next();
    if (!job) return;
    running++;
    // processJob marks the row 'running' synchronously, so the next jobs.next()
    // in this loop can never pick the same job twice
    processJob(job)
      .catch((err) => {
        console.error('[job]', err);
        jobs.upd(job.id, { status: 'error', log: String(err.stack || err) });
        if (job.project_id) {
          projects.upd(job.project_id, { status: 'error', step: String(err.message || err).slice(0, 220) });
          emit('project', { project: projects.get(job.project_id) });
        }
        emit('log', { projectId: job.project_id, message: `error: ${err.message}` });
      })
      .finally(() => { running--; setImmediate(kick); });
  }
}

async function processJob(job) {
  jobs.upd(job.id, { status: 'running', progress: 0 });
  if (job.type === 'preview') return previewOne(job);
  if (job.type === 'render') return renderOne(job);
  return runFull(job);
}

function progressFor(job, projectId) {
  return (p, step, extra = {}) => {
    jobs.upd(job.id, { progress: p });
    if (projectId) projects.upd(projectId, { progress: p, step });
    emit('progress', { projectId, progress: p, step, ...extra });
  };
}

async function runFull(job) {
  const p = projects.get(job.project_id);
  if (!p) throw new Error('project missing');
  const opt = { ...DEFAULTS, ...(p.meta?.options || {}), ...(job.payload || {}) };
  const set = progressFor(job, p.id);
  const log = (message) => { jobs.upd(job.id, { log: message }); emit('log', { projectId: p.id, message }); };
  // Stage timings: the whole job is dominated by full-file ffmpeg passes, so
  // every pass gets measured and reported (CLIPFORGE_TIMING=1 or always, cheap).
  const t0 = Date.now();
  const timings = [];
  let last = t0;
  const stage = (name, extra = '') => {
    const now = Date.now();
    const secs = (now - last) / 1000;
    last = now;
    timings.push(`${name}: ${secs.toFixed(1)}s${extra ? ` (${extra})` : ''}`);
    log(`⏱ ${name}: ${secs.toFixed(1)}s`);
    try { fs.writeFileSync(path.join(DIRS.cache, 'last-timings.txt'), timings.join('\n')); } catch {}
  };

  projects.upd(p.id, { status: 'running', progress: 0.01, step: 'Reading video…' });
  emit('project', { project: projects.get(p.id) });

  const meta = await probe(p.original);
  const base = { ...(p.meta || {}), ...meta, options: opt };
  projects.upd(p.id, { meta: base });
  log(`Video ${meta.width}×${meta.height}, ${meta.duration.toFixed(1)}s, ${meta.fps}fps`);
  stage('probe', `${meta.width}×${meta.height}`);
  set(0.04, 'Listening to audio…');

  const audio = await analyzeAudio(p.original, (x) => set(0.05 + x * 0.18, 'Listening to audio…'));
  stage('audio (silence+energy)');
  set(0.24, 'Finding scene changes…');
  const scenes = await detectScenes(p.original);
  stage('scenes');

  set(0.3, 'Transcribing speech…');
  let transcript = { words: [], text: '', source: 'none' };
  try {
    transcript = await transcribe(p.original, {
      onLog: log,
      onProgress: (x) => set(0.3 + x * 0.32, 'Transcribing speech…'),
    });
  } catch (err) {
    log(`Transcription failed (${err.message.slice(0, 160)}) — continuing with audio analysis only`);
  }
  stage('transcribe', transcript.source);
  const hasWords = transcript.words?.length > 3;
  log(hasWords
    ? `Transcript ready: ${transcript.words.length} words (${transcript.source})`
    : 'No transcript — clipping from audio energy + scene cuts.');

  // Whisper sometimes re-decodes a stretch, leaving two overlapping word runs.
  let tWords = dedupeWords(transcript.words || []);
  if (tWords.length < (transcript.words?.length || 0)) {
    log(`Cleaned ${(transcript.words?.length || 0) - tWords.length} duplicated words from the transcript`);
  }

  // Captions must be Hinglish in Roman script, never Devanagari.
  if (hasWords && tWords.some((w) => /[\u0900-\u097F]/.test(String(w.word || '')))) {
    set(0.62, 'Romanising the Hinglish…');
    try {
      const ro = await transliterate(tWords, { onLog: log });
      tWords = ro.words;
    } catch (err) {
      log(`Romanisation failed (${String(err.message).slice(0, 120)}) — keeping the transcript as-is`);
    }
  }
  stage('romanise');

  set(0.74, 'Picking the best moments…');
  const units = speechUnits(tWords, audio.silence, meta.duration);
  const sentences = indexSentences(tWords, audio.silence, meta.duration);
  let chosen = [];
  if (hasWords && sentences.length >= 4) {
    log('Reading the transcript for self-contained moments…');
    chosen = await curate({
      sentences, count: opt.count, minLen: 18, maxLen: 42,
      title: p.name, silence: audio.silence, onLog: log,
    }) || [];
  }
  if (!chosen.length) {
    chosen = pickClips({
      units, energy: audio.energy, step: audio.step, silence: audio.silence,
      duration: meta.duration, count: opt.count, minLen: opt.minLen, maxLen: opt.maxLen,
    }).map((c) => ({ ...c, source: 'heuristic' }));
    log(`${chosen.length} moments picked with the audio heuristic`);
  } else {
    log(`${chosen.length} AI-picked moments out of ${sentences.length} sentences`);
  }
  stage('curate', `${chosen.length} clips`);

  // Speaker tracking only where it is needed: the windows that survive
  // curation. Sampling the whole podcast would cost ~13 s for data that is
  // thrown away (only chosen clips are rendered).
  set(0.8, 'Detecting speakers…');
  let subject = null;
  if (opt.crop === 'auto' && chosen.length) {
    const windows = chosen
      .map((c) => ({ start: Math.max(0, c.start - 2), end: c.end + 2 }))
      .sort((a, b) => a.start - b.start);
    subject = await trackSubject(p.original, windows, (x) => set(0.8 + x * 0.05, 'Detecting speakers…')).catch(() => null);
    if (subject) {
      log(`Speaker tracking confidence ${(subject.confidence * 100).toFixed(0)}%`);
      if (subject.twoSpeakers >= 0.4) log('Two speakers in frame — keeping the full width in those clips');
    }
  }
  stage('speakers', subject ? `${subject.nodes.length} nodes` : 'skipped');

  const autoCrop = opt.crop === 'auto' ? 'punch' : opt.crop;
  projects.upd(p.id, {
    meta: { ...base, scenes, subject, autoCrop, transcriptSource: transcript.source, wordCount: transcript.words?.length || 0, language: transcript.language },
  });

  for (const c of clips.byProject(p.id)) {
    if (c.path) { try { fs.unlinkSync(c.path); } catch {} }
    if (c.thumb) { try { fs.unlinkSync(c.thumb); } catch {} }
    try { fs.unlinkSync(path.join(DIRS.preview, `${c.id}.mp4`)); } catch {}
    clips.del(c.id);
  }

  const total = chosen.length || 1;
  let done = 0;
  let shown = 0.76;
  const bump = (p) => { shown = Math.max(shown, p); set(shown, `Rendering ${done + 1}/${total}…`); };

  // Clips are independent: render two at a time.
  const queue = chosen.map((c, i) => ({ c, i }));
  const worker = async () => {
    while (queue.length) {
      const { c, i } = queue.shift();
      const id = randomUUID().slice(0, 8);
      const cutAt = Number.isFinite(c.cut) ? c.cut : c.start;
      // Trust the curated word span: the padded clip end also catches the first
      // word of the next sentence on Whisper's overlapping re-decodes.
      const lastWordEnd = c.words?.length ? c.words[c.words.length - 1].end : null;
      const words = lastWordEnd
        ? tWords.filter((w) => w.start >= cutAt - 0.02 && w.start <= lastWordEnd)
        : tWords.filter((w) => w.start >= cutAt - 0.001 && w.start < c.end);
      // Two talking heads in frame: zooming in cuts half a face off, so show the
      // whole frame card instead of the punch-in. Single heads only get a crop
      // when the tracked range provably fits inside it (see framePlan).
      const win = subject ? subject.nodes.filter((n) => n.t >= c.start - 1 && n.t <= c.end + 1) : [];
      const twoUp = win.length >= 3
        ? win.filter((n) => n.two).length / win.length >= 0.4
        : (subject?.twoSpeakers || 0) >= 0.4;
      const framing = framePlan({
        nodes: win, punch: opt.punch, confidence: subject?.confidence ?? 1,
        srcW: meta.width, srcH: meta.height, twoUp,
      });
      const punch = framing.card;
      // Short-form pacing: drop the dead air and the discourse fillers that sit
      // inside the clip. The opening and the ending are left intact.
      const plan = planCuts({ words, start: c.start, end: c.end, silence: audio.silence });
      if (plan.removed >= 0.5) log(`Clip ${i + 1}: removing ${plan.removed.toFixed(1)}s of dead air`);
      // Topic visuals: what the speaker is actually talking about shows up on
      // the centre card (b-roll), so the clip never reads as a static face.
      let broll = null;
      if (BROLL && opt.broll !== false) {
        try {
          const rows = await planBrollAssets({ words, start: c.start, end: c.end, hook: c.hook || '', max: 4, onLog: log });
          if (rows.length) {
            broll = rows;
            log(`Clip ${i + 1} b-roll: ${rows.map((r) => `${r.query || r.label}${r.provider ? ` (${r.provider}${r.license ? ', ' + r.license : ''})` : ' (text card)'}`).join(' · ')}`);
          }
        } catch (err) {
          log(`Clip ${i + 1} b-roll skipped: ${String(err.message || err).slice(0, 90)}`);
        }
      }
      const data = {
        words, template: opt.template, crop: autoCrop, position: opt.position, size: opt.size,
        accent: opt.accent, title: opt.title || c.hook || '', zoom: opt.zoom, punch, twoUp,
        framing: framing.reason, look: opt.look || 'none',
        music: opt.music ?? 'auto', musicTrack: opt.musicTrack || '',
        musicGain: opt.musicGain ?? 0.22, musicPulse: opt.musicPulse !== false,
        reason: c.reason, text: c.text, hook: c.hook || '', source: c.source || 'heuristic',
        cuts: plan.cuts, removed: plan.removed,
        broll,
        subject: subject ? { nodes: subject.nodes.filter((n) => n.t >= c.start - 2 && n.t <= c.end + 2), confidence: subject.confidence } : null,
      };
      if (framing.reason !== 'punch') log(`Clip ${i + 1}: full frame over blur (${framing.reason})`);
      clips.insert({
        id, project_id: p.id, start: c.start, end: c.end, duration: c.end - c.start,
        score: c.score, reason: c.reason, data, status: 'rendering',
      });
      emit('clip', { projectId: p.id, clip: clips.get(id) });
      bump(0.76 + (done / total) * 0.22);
      try {
        const music = await resolveMusic({
          mode: data.music, track: data.musicTrack, look: data.look,
          seed: `${p.id}:${id}`, ...(lookMusic(data.look) || {}), onLog: log,
        });
        const out = await renderClip({
          id, source: p.original, start: c.start, end: c.end, crop: data.crop, template: data.template,
          position: data.position, size: data.size, accent: data.accent, title: data.title, zoom: data.zoom,
          punch: data.punch, words, subject: data.subject, srcW: meta.width, srcH: meta.height,
          hasAudio: Boolean(meta.hasAudio), cuts: plan.cuts, look: data.look,
          musicPath: music?.path, musicBpm: music?.bpm || 0, musicGain: data.musicGain,
          musicPulse: data.musicPulse, broll: data.broll,
          onLog: log,
          onProgress: (x) => bump(0.76 + ((done + x) / total) * 0.22),
        });
        clips.upd(id, {
          path: out.path, thumb: out.thumb, status: 'ready',
          duration: out.duration ?? c.end - c.start,
          data: {
            ...data, punch: out.punch ?? data.punch, framing: out.framing ?? data.framing,
            encoder: out.encoder, mode: out.mode,
            renderedEdits: data.captionEdits || {},
            musicName: music?.name || '', musicId: music?.id || '',
            brollUsed: out.broll,
          },
        });
      } catch (err) {
        log(`clip ${i + 1} failed: ${err.message.slice(0, 200)}`);
        clips.upd(id, { status: 'error' });
      }
      done++;
      stage(`render ${i + 1}`, `${(c.end - c.start).toFixed(1)}s`);
      emit('clip', { projectId: p.id, clip: clips.get(id) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, worker));

  log(`⏱ total: ${((Date.now() - t0) / 1000).toFixed(1)}s for ${chosen.length} clips`);
  set(1, 'Done');
  projects.upd(p.id, { status: 'done', progress: 1, step: `${chosen.length} clips ready` });
  jobs.upd(job.id, { status: 'done', progress: 1 });
  emit('project', { project: projects.get(p.id) });
  emit('done', { projectId: p.id });
}

// Clips analysed by an older tracker have no head box, so a safe crop cannot
// be proven from them. Re-run the (cheap, clip-window only) tracker once per
// clip and cache it, so previews and the final render agree.
const trackCache = new Map();

async function trackForClip(p, c, subject) {
  if (subject?.nodes?.some((n) => Number.isFinite(n.w))) return subject;
  if (trackCache.has(c.id)) return trackCache.get(c.id);
  try {
    const t = await trackSubject(p.original, [{ start: Math.max(0, c.start - 2), end: c.end + 2 }]);
    if (t?.nodes?.length) {
      const fresh = { nodes: t.nodes, confidence: t.confidence, twoSpeakers: t.twoSpeakers };
      trackCache.set(c.id, fresh);
      return fresh;
    }
  } catch {}
  return subject;
}

async function renderOne(job) {
  const c = clips.get(job.payload.clipId);
  if (!c) throw new Error('clip missing');
  const p = projects.get(c.project_id);
  const data = { ...c.data, ...job.payload };
  delete data.clipId;
  const subject = await trackForClip(p, c, data.subject || p.meta?.subject);
  const set = progressFor(job, null);
  const log = (message) => { jobs.upd(job.id, { log: message }); emit('log', { projectId: p.id, message }); };

  clips.upd(c.id, { start: data.start ?? c.start, end: data.end ?? c.end, data: { ...c.data, ...job.payload, clipId: undefined }, status: 'rendering' });
  emit('clip', { projectId: p.id, clip: clips.get(c.id) });
  set(0, 'Re-rendering clip…');

  const look = data.look ?? p.meta?.options?.look ?? 'none';
  const music = await resolveMusic({
    mode: data.music ?? p.meta?.options?.music ?? 'auto',
    track: data.musicTrack || '',
    look, seed: `${p.id}:${c.id}`, ...(lookMusic(look) || {}), onLog: log,
  });
  const out = await renderClip({
    id: c.id, source: p.original, start: data.start ?? c.start, end: data.end ?? c.end,
    crop: data.crop, template: data.template, position: data.position, size: data.size,
    accent: data.accent, title: data.title, zoom: data.zoom, punch: data.punch ?? p.meta?.options?.punch ?? 1.3,
    words: data.words || [], subject,
    srcW: p.meta.width, srcH: p.meta.height, hasAudio: Boolean(p.meta?.hasAudio),
    cuts: data.cuts || [], edits: data.captionEdits || {}, look,
    musicPath: music?.path, musicBpm: music?.bpm || 0, musicGain: data.musicGain ?? 0.22,
    musicPulse: data.musicPulse !== false,
    broll: Array.isArray(data.broll) ? data.broll : null,
    onLog: log,
    onProgress: (x) => set(x, 'Re-rendering clip…'),
  });
  const clipStart = data.start ?? c.start;
  const clipEnd = data.end ?? c.end;
  const storeSubject = subject?.nodes?.some((n) => Number.isFinite(n.w))
    ? {
      nodes: subject.nodes.filter((n) => n.t >= clipStart - 2 && n.t <= clipEnd + 2),
      confidence: subject.confidence,
    }
    : data.subject;
  clips.upd(c.id, {
    path: out.path, thumb: out.thumb, status: 'ready',
    duration: out.duration ?? (clipEnd - clipStart),
    data: {
      ...data, subject: storeSubject,
      punch: out.punch ?? data.punch, framing: out.framing ?? data.framing,
      encoder: out.encoder, mode: out.mode, clipId: undefined,
      renderedEdits: data.captionEdits || {},
      musicName: music?.name || '', musicId: music?.id || '',
      brollUsed: out.broll,
    },
  });
  // the final file replaces the draft; keeping it around would let the editor
  // serve a stale preview on the next click
  try { fs.unlinkSync(path.join(DIRS.preview, `${c.id}.mp4`)); } catch {}
  jobs.upd(job.id, { status: 'done', progress: 1 });
  emit('clip', { projectId: p.id, clip: clips.get(c.id) });
  emit('done', { projectId: p.id });
}

async function previewOne(job) {
  const c = clips.get(job.payload.clipId);
  if (!c) throw new Error('clip missing');
  const p = projects.get(c.project_id);
  const data = { ...c.data, ...job.payload };
  delete data.clipId;
  const subject = await trackForClip(p, c, data.subject || p.meta?.subject);
  const set = progressFor(job, null);
  const log = (message) => { jobs.upd(job.id, { log: message }); emit('log', { projectId: p.id, message }); };

  set(0, 'Draft preview…');
  const look = data.look ?? p.meta?.options?.look ?? 'none';
  const music = await resolveMusic({
    mode: data.music ?? p.meta?.options?.music ?? 'auto',
    track: data.musicTrack || '',
    look, seed: `${p.id}:${c.id}`, ...(lookMusic(look) || {}), onLog: log,
  });
  const out = await renderClip({
    id: c.id, source: p.original, start: data.start ?? c.start, end: data.end ?? c.end,
    crop: data.crop, template: data.template, position: data.position, size: data.size,
    accent: data.accent, title: data.title, zoom: data.zoom,
    punch: data.punch ?? p.meta?.options?.punch ?? 1.3,
    words: data.words || [], subject,
    srcW: p.meta.width, srcH: p.meta.height, hasAudio: Boolean(p.meta?.hasAudio),
    cuts: data.cuts || [], preview: true, edits: data.captionEdits || {},
    look,
    musicPath: music?.path, musicBpm: music?.bpm || 0, musicGain: data.musicGain ?? 0.22,
    musicPulse: data.musicPulse !== false,
    broll: Array.isArray(data.broll) ? data.broll : null,
    onLog: log,
    onProgress: (x) => set(x, 'Draft preview…'),
  });
  jobs.upd(job.id, { status: 'done', progress: 1, log: `preview ${(out.size / 1e6).toFixed(1)}MB` });
  emit('preview', { projectId: p.id, clipId: c.id, at: Date.now(), duration: out.duration });
}

export function recover() {
  // Restart-safe queue: anything stuck 'running' (crash, `node --watch`
  // restart) goes back to queued so the worker resumes it instead of leaving
  // clips 'rendering' forever.
  try {
    const n = jobs.requeueRunning();
    if (n) console.log(`  resumed ${n} interrupted job${n === 1 ? '' : 's'}`);
  } catch (err) {
    console.warn('  job recovery failed:', err.message);
  }
  kick();
}

export function pathsFor(id) {
  return {
    clip: path.join(DIRS.clips, `${id}.mp4`),
    thumb: path.join(DIRS.thumbs, `${id}.jpg`),
  };
}
