import fs from 'node:fs';
import path from 'node:path';
import { ff, videoEncoder, useCpuEncoder, escFilterPath } from './media.js';
import { buildCaptions, writeASS } from './captions.js';
import { keptSegments, remapWords, remapTime } from './cuts.js';
import { lookFilters, lookPush, lookCaption, lookVignette } from './looks/index.js';
import { DIRS, OUT_W, OUT_H, FPS } from './config.js';

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Speech chain for short-form: kill rumble below the male fundamental, tame
 * sibilance on a cheap phone mic, then hit the -14 LUFS that Reels/Shorts
 * normalise to so the clip never sounds quieter than the next one.
 */
const AUDIO_CHAIN = 'highpass=f=72,deesser=i=0.35,loudnorm=I=-14.2:TP=-1.5:LRA=11';

/** Piecewise-linear ffmpeg expression through tracked points. */
function panExpression(nodes, clipStart, clipEnd, scaledW, cropW) {
  const usable = nodes
    .filter((n) => n.t >= clipStart - 2 && n.t <= clipEnd + 2)
    .map((n) => ({ t: Math.max(0, n.t - clipStart), x: n.x }));
  if (usable.length < 3) return null;
  return linearExpr(usable, scaledW, cropW);
}

function linearExpr(points, scaledW, cropW) {
  const step = Math.max(1, Math.ceil(points.length / 12));
  const pts = [];
  for (let i = 0; i < points.length; i += step) pts.push(points[i]);
  const maxX = Math.max(0, scaledW - cropW);
  const toPx = (x) => Math.round(Math.min(maxX, Math.max(0, x * scaledW - cropW / 2)));

  const p = pts.map((n, i) => ({ t: i === 0 ? 0 : n.t, x: toPx(n.x) }));
  // skip pans that never actually move (just centre it)
  if (p.every((n) => Math.abs(n.x - p[0].x) < 6)) return String(Math.round(p[0].x));

  let expr = String(p[p.length - 1].x);
  for (let i = p.length - 2; i >= 0; i--) {
    const a = p[i], b = p[i + 1];
    const dt = Math.max(0.001, b.t - a.t);
    const seg = `${a.x}+(${b.x - a.x})*(t-${a.t.toFixed(2)})/${dt.toFixed(2)}`;
    expr = `if(lt(t,${b.t.toFixed(2)}),${seg},${expr})`;
  }
  return expr;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
}

/**
 * Face-safe framing for the punch-in card.
 *
 * The subject tracker only knows where a skin blob's centre is, not how wide
 * the head is. Following that centre frame by frame is what cuts faces: one
 * bad blob (a warm wall, a lamp, a hand) whips the card across the source and
 * slices a head in half. Auto therefore picks ONE static crop window that
 * provably contains every tracked head for the whole clip — with a generous
 * head-radius margin — and falls back to the full frame over the blurred bed
 * whenever that is not provable. The blur bed itself is untouched.
 */
export function framePlan({
  nodes = [], punch = 1.3, confidence = 1, srcW = 1920, srcH = 1080, twoUp = false,
}) {
  const aspect = Math.max(0.2, (Number(srcH) || 1080) / Math.max(1, Number(srcW) || 1920));
  // A card taller than the canvas would crop vertically, so cap the scale at
  // the point where the card exactly fills the height (9:16 sources → 1x).
  const fitH = Math.max(1, (OUT_H / OUT_W) / aspect);
  const requested = clamp(Number(punch) || 1.3, 1, 1.9);
  const usable = (nodes || []).filter((n) => n && Number.isFinite(n.x) && n.x >= 0 && n.x <= 1);
  const y = clamp(median(usable.map((n) => n.y)) ?? 0.42, 0.05, 0.95);
  const full = (reason) => ({ card: 1, x: 0, y, reason });

  if (!usable.length) return full('no-track');
  // Two heads in frame: no single-head crop can promise both stay whole.
  const twoShare = usable.filter((n) => n.two).length / usable.length;
  if (twoUp || twoShare >= 0.35) return full('two-up');
  if (confidence != null && confidence < 0.5) return full('low-confidence');

  // Head half-width as a fraction of the source width. Blob width is the
  // visible skin (forehead + cheeks), so the head with hair is a bit wider.
  // Older tracker data has no box: without a width we cannot prove a crop is
  // safe, so keep the full frame (the source, uncropped, over the blur bed).
  const widths = usable.map((n) => Number(n.w)).filter((w) => Number.isFinite(w) && w > 0).sort((a, b) => a - b);
  if (!widths.length) return full('no-box');
  const blobW = widths[Math.floor(widths.length / 2)];
  const radius = clamp(blobW * 0.8 + 0.035, 0.11, 0.18);

  const lo = Math.min(...usable.map((n) => Math.min(n.x, Number.isFinite(n.x2) ? n.x2 : n.x)));
  const hi = Math.max(...usable.map((n) => Math.max(n.x, Number.isFinite(n.x2) ? n.x2 : n.x)));
  // A head hugging the source edge cannot be saved by cropping — only the
  // full frame (which is the source, uncropped) keeps it intact.
  if (lo - radius < 0.004 || hi + radius > 0.996) return full('edge');

  const span = hi - lo;
  const needed = span + 2 * radius + 0.02;
  // Shrink the punch until the whole track fits instead of giving up at once;
  // below 1.1x there is no point in cropping, so keep the full frame.
  let card = Math.min(requested, fitH, needed > 0 ? 1 / needed : 1.9);
  card = Math.floor(card * 20) / 20;
  if (card < 1.1) return full('wide');

  const vis = 1 / card;
  const low = Math.max(0, hi + radius - vis);
  const high = Math.min(1 - vis, lo - radius);
  if (low > high + 0.001) return full('wide');
  const x = clamp((lo + hi) / 2 - vis / 2, low, high);
  return { card: Math.round(card * 100) / 100, x: Math.round(x * 1000) / 1000, y, reason: 'punch' };
}

export async function renderClip({
  id, source, start, end, crop = 'blur', template = 'pop', position = 0.78,
  size = 1, accent = 'yellow', title = '', zoom = 0, punch = 1.3, words = [], subject = null,
  srcW = 1920, srcH = 1080, hasAudio = true, cuts = [], preview = false, edits = {},
  look = 'none', musicPath = null, musicBpm = 0, musicGain = 0.22, musicPulse = true,
  broll = null,
  onProgress, onLog, retried = false,
}) {
  const enc = await videoEncoder();

  // Draft renders: half resolution + the encoder's fast preset, so tweaking
  // feels instant.
  const outW = preview ? Math.round(OUT_W / 2) : OUT_W;
  const outH = preview ? Math.round(OUT_H / 2) : OUT_H;
  const encArgs = preview ? (enc.previewArgs || enc.args) : enc.args;
  const srcDur = Math.max(0.4, end - start);
  const cutList = (cuts || [])
    .map((c) => ({ from: Math.max(start, c.from), to: Math.min(end, c.to) }))
    .filter((c) => c.to - c.from > 0.08)
    .sort((a, b) => a.from - b.from);
  const segments = cutList.length ? keptSegments(start, end, cutList) : [{ start, end }];
  const dur = Math.max(0.4, segments.reduce((n, s) => n + (s.end - s.start), 0));
  const capWords = cutList.length ? remapWords(words, segments) : words;
  const capStart = cutList.length ? 0 : start;
  const capEnd = cutList.length ? dur : end;
  // subject nodes live on the cut timeline too, so the pan follows the spliced video
  const localNodes = subject?.nodes?.length
    ? subject.nodes
      .map((n) => ({ ...n, t: cutList.length ? remapTime(n.t, segments) : n.t - start }))
      .filter((n) => n.t >= -2 && n.t <= dur + 2)
    : null;
  const confidence = subject?.confidence ?? 1;
  const workDir = path.join(DIRS.work, id);
  fs.mkdirSync(workDir, { recursive: true });

  const outName = `${id}.mp4`;
  const outPath = path.join(preview ? DIRS.preview : DIRS.clips, outName);
  const scaledW = Math.max(outW, Math.round(outH * (srcW / Math.max(1, srcH))));

  let mode = crop;
  if (mode === 'punch' || mode === 'auto') mode = 'punch';
  let panExpr = null;
  if (mode === 'center') panExpr = localNodes?.length ? panExpression(localNodes, 0, dur, scaledW, outW) : null;

  // ---------- b-roll: topic footage for the centre card ----------
  // The blurred bed is untouched; inside a b-roll window the CARD ITSELF shows
  // the topic (video/image with alpha fades; a text card when no footage was
  // found). Windows are clip-relative source seconds, mapped through the
  // jump-cut timeline below, once the card rectangle exists.
  const brRows = Array.isArray(broll) ? broll.filter(Boolean) : [];

  // Where the video card starts vertically: the hook line is pinned just above
  // it so the title never sits on someone's forehead.
  let hookTop = Math.round(outH * 0.15);

  // Drafts run every filter at half size: pre-shrink the source once so the
  // trim / concat / blur / overlay chain all work on a quarter of the pixels.
  // `min(iw, …)` keeps it honest even when the project metadata lies about the
  // source size.
  let pre = '';
  if (preview) {
    pre = `scale='min(iw,${outW * 2})':-2:flags=fast_bilinear,`;
  }

  // A look is a grade + film texture + caption style. It is applied after the
  // framing composite (so the blur bed and the crop are untouched) and before
  // the captions (so type stays clean and legible).
  const lookFx = lookFilters(look, { outH });
  const lookStyle = lookCaption(look);
  const totalZoom = Math.max(0, Number(zoom) || 0) + lookPush(look);

  let graph = '';
  let vA = 'vcA';
  let vB = 'vcB';
  let usedPunch = null;
  let framing = null;
  let vLast = 'v0';
  let fgW = 0; let fgH = 0; let xPx = 0; let yPx = 0; // card rectangle (set by the framing branch)
  let audioIn = '0:a';
  // 'center' pans the whole frame, so it needs one branch instead of two
  const needsTwo = mode !== 'center';
  if (segments.length > 1) {
    graph += `[0:v]${pre}split=${segments.length}${segments.map((_, i) => `[sp${i}]`).join('')};`;
    segments.forEach((s, i) => {
      const a = (s.start - start).toFixed(3);
      const b = (s.end - start).toFixed(3);
      graph += `[sp${i}]trim=start=${a}:end=${b},setpts=PTS-STARTPTS,fps=${FPS}[vs${i}];`;
      if (hasAudio) graph += `[0:a]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS[as${i}];`;
    });
    graph += `${segments.map((_, i) => `[vs${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[vc];`;
    if (hasAudio) {
      graph += `${segments.map((_, i) => `[as${i}]`).join('')}concat=n=${segments.length}:v=0:a=1[ac];`;
      audioIn = 'ac';
    }
    // the concat output is already at FPS, so the branches below need no
    // frame-rate conversion of their own
    if (needsTwo) graph += `[vc]split=2[vcA][vcB];`;
    else vA = 'vc';
  } else if (needsTwo) {
    graph += `[0:v]${pre}fps=${FPS},split=2[vcA][vcB];`;
  } else {
    graph += `[0:v]${pre}fps=${FPS}[vcA];`;
  }

  if (mode === 'punch' || mode === 'blur') {
    // Landscape source in a vertical frame: never magnify 3x. Keep the video
    // card at a readable width over a blurred bed, face in the upper third.
    // Auto framing is static and face-safe (see framePlan); blur pad is always
    // the full, uncropped frame.
    const plan = framePlan({
      nodes: localNodes, punch: mode === 'blur' ? 1 : punch, confidence, srcW, srcH,
    });
    const card = plan.card;
    usedPunch = card;
    framing = plan.reason;
    fgW = even(outW * card);
    fgH = even(fgW * (srcH / Math.max(1, srcW)));
    xPx = card > 1 ? Math.round(clamp(-plan.x * fgW, outW - fgW, 0)) : Math.round((outW - fgW) / 2);
    const padTop = Math.round(outH * 0.045);
    const padBottom = Math.round(outH * 0.15);
    // Keep the card fully inside the canvas; with a 9:16 source it simply
    // fills the frame.
    const loY = Math.min(padTop, Math.max(0, outH - fgH));
    const hiY = Math.max(loY, outH - fgH - padBottom);
    yPx = Math.round(clamp(outH * 0.36 - plan.y * fgH, loY, hiY));
    hookTop = yPx;
    if (plan.reason !== 'punch') {
      onLog?.(`Auto framing: full frame over blur (${plan.reason})`);
    }

    // The blurred bed only needs the low frequencies: blur and grade a
    // quarter-size copy, then stretch it back. Same look, a fraction of the
    // filter cost.
    const bgW = even(outW / 4);
    const bgH = even(outH / 4);
    const sigma = Math.max(2, Math.round(outH * 0.0135) / 4);
    graph += `[${vA}]scale=${bgW}:${bgH}:force_original_aspect_ratio=increase,crop=${bgW}:${bgH},gblur=sigma=${sigma},eq=brightness=-0.12:saturation=1.12,scale=${outW}:${outH}:flags=bilinear[bg];`;
    graph += `[${vB}]scale=${fgW}:${fgH}:flags=bicubic[fg];`;
    graph += `[bg][fg]overlay=x=${xPx}:y=${yPx}:format=yuv420[v0];`;
  } else if (mode === 'stack') {
    const half = Math.round(outH / 2);
    graph += `[${vA}]crop=iw/2:ih:0:0,scale=${outW}:${half}:force_original_aspect_ratio=increase,crop=${outW}:${half}[top];`;
    graph += `[${vB}]crop=iw/2:ih:iw/2:0,scale=${outW}:${half}:force_original_aspect_ratio=increase,crop=${outW}:${half}[bot];`;
    graph += `[top][bot]vstack=inputs=2[v0];`;
  } else {
    const xExpr = panExpr ?? String(Math.round((scaledW - outW) / 2));
    graph += `[${vA}]scale=${outW}:${outH}:force_original_aspect_ratio=increase:flags=bicubic,crop=${outW}:${outH}:x='${xExpr}':y=0[v0];`;
  }

  // b-roll windows → card overlays. Runs after the framing branch so the
  // composite is already [v0] and the card rectangle (fgW/fgH/xPx/yPx) exists.
  let brInput = musicPath ? 2 : 1; // 0 source, 1 music, then one input per asset
  const brAssets = []; // { kind, file, idx } for the input list
  const brChains = []; // complete per-asset filter statements
  const cards = [];    // text-only fallback windows for the ASS layer
  const notCovered = (t) => {
    if (!cutList.length) {
      const lt = t - start;
      return lt >= 0 && lt <= dur ? lt : null;
    }
    const hit = segments.find((s) => t >= s.start && t <= s.end);
    if (hit) return remapTime(t, segments);
    // A topic start that fell into a removed pause shows as soon as the
    // surviving speech resumes, instead of being dropped.
    const next = cutList.length ? segments.find((s) => s.start >= t - 0.5 && s.start <= t + 1.3) : null;
    return next ? remapTime(next.start, segments) : null;
  };
  if (brRows.length && (mode === 'punch' || mode === 'blur')) {
    // A visual that outlives the sentence feels like a cutaway; one that
    // flashes for half a second feels like a glitch. 1.3–3.4s, at least 2s of
    // speaker between inserts, and never more than ~40% of the clip: 16s gets
    // two visuals, 24s three, 32s+ four.
    const MAX_WIN = 3.4;
    const MIN_WIN = 1.3;
    const GAP = 2.0;
    const budget = Math.max(2, Math.min(4, Math.floor(dur / 8)));
    const cap = dur * 0.42;
    let lastEnd = 1.2 - GAP;
    let used = 0;
    let count = 0;
    for (const row of brRows) {
      if (count >= budget) break;
      const ta = notCovered(row.t0);
      const tb = notCovered(row.t1 ?? row.t0 + 2.2);
      if (ta == null) continue;
      const t0 = clamp(ta, 1.2, Math.max(1.2, dur - 1.8));
      if (t0 < lastEnd + GAP) continue;
      const t1 = Math.min(
        clamp(tb != null ? tb : t0 + 2.2, t0 + MIN_WIN, Math.max(t0 + MIN_WIN, dur - 0.8)),
        t0 + MAX_WIN,
      );
      if (t1 - t0 < MIN_WIN) continue;
      if (used + (t1 - t0) > cap) continue;
      used += t1 - t0;
      count++;
      lastEnd = t1;
      const win = t1 - t0;
      if (row.kind === 'video' || row.kind === 'image') {
        if (!row.file || !fs.existsSync(row.file)) { cards.push({ start: t0, end: t1, label: row.label || row.query || '', query: row.query || '' }); continue; }
        const idx = brInput++;
        brAssets.push({ kind: row.kind, file: row.file, idx });
        const from = Math.max(0, Number(row.offset) || 0);
        // Both kinds are trimmed to the window: a video starts at its offset,
        // a still (fed with -loop 1) must be cut too or it would stay on screen
        // for the rest of the clip. Stills also get a slow push-in so a 2–3s
        // photo does not read as a freeze.
        const chain = row.kind === 'video'
          ? `trim=start=${from.toFixed(2)}:end=${(from + win + 0.4).toFixed(2)},setpts=PTS-STARTPTS,fps=${FPS}`
          : `trim=duration=${(win + 0.4).toFixed(2)},setpts=PTS-STARTPTS,fps=${FPS}`;
        const fit = row.kind === 'video'
          ? `scale=${fgW}:${fgH}:force_original_aspect_ratio=increase:flags=bicubic,crop=${fgW}:${fgH}`
          : `scale=${even(fgW * 1.18)}:${even(fgH * 1.18)}:force_original_aspect_ratio=increase:flags=bicubic,crop=${even(fgW * 1.18)}:${even(fgH * 1.18)},zoompan=z='1+${(0.06 / Math.max(1, win * FPS)).toFixed(6)}*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${fgW}x${fgH}:fps=${FPS}`;
        brChains.push({
          idx, kind: row.kind, file: row.file, t0, t1,
          graph: `[${idx}:v]${chain},${fit},setsar=1,format=yuva420p,fade=t=in:st=0.04:d=0.22:alpha=1,fade=t=out:st=${Math.max(0.08, win - 0.18).toFixed(2)}:d=0.22:alpha=1,setpts=PTS+${t0.toFixed(2)}/TB[bk${brChains.length}];`,
        });
      } else {
        cards.push({ start: t0, end: t1, label: row.label || row.query || '', query: row.query || '' });
      }
    }
    for (const c of brChains) graph += c.graph;
    if (brChains.length) {
      // overlay each asset when its stream starts (pts were shifted to t0);
      // before that / after eof the primary passes through untouched
      let cur = 'v0';
      brChains.forEach((c, k) => {
        const outK = `vbr${k}`;
        graph += `[${cur}][bk${k}]overlay=x=${xPx}:y=${yPx}:eof_action=pass:repeatlast=0:shortest=0:format=yuv420[${outK}];`;
        cur = outK;
      });
      vLast = cur; // the rest of the chain (zoompan/look/captions) reads the composite
      onLog?.(`b-roll ${brChains.length} asset(s) + ${cards.length} text card(s)`);
    }
  }

  const ass = buildCaptions({
    words: capWords, start: capStart, end: capEnd, duration: dur, template, position, size, accent, title,
    outW: outW, outH: outH, hookTop, edits, lookStyle,
    cards: cards.length ? { frame: { x: xPx, y: yPx, w: fgW, h: fgH } } : null,
    cardWindows: cards,
  });
  const assName = preview ? 'cap.preview.ass' : 'cap.ass';
  writeASS(workDir, assName, ass);

  if (totalZoom > 0) {
    graph += `[${vLast}]zoompan=z='min(1+${(totalZoom / Math.max(1, dur * FPS)).toFixed(6)}*on,${(1 + totalZoom).toFixed(3)})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${outW}x${outH}:fps=${FPS}[vzoom];`;
    vLast = 'vzoom';
  }

  if (lookFx) {
    graph += `[${vLast}]${lookFx}[vgrade];`;
    vLast = 'vgrade';
  }

  // Vignette at full size is the most expensive look filter (0.26s per second
  // of video). Build the mask at quarter size from a white source, normalise
  // white's 235 luma back to 255 so the centre stays untouched, then multiply
  // only the luma plane: blending U/V would drag neutral chroma toward green.
  const vig = lookVignette(look);
  if (vig > 0) {
    const vw = even(outW / 4);
    const vh = even(outH / 4);
    graph += `color=c=white:size=${vw}x${vh}:r=${FPS}:d=${dur.toFixed(3)},format=yuv420p,`;
    graph += `vignette=angle=${Math.round(vig * 1000) / 1000},lut=y='clip(val*255/235,0,255)',scale=${outW}:${outH}[vmask];`;
    graph += `[${vLast}]format=yuv420p[vmain];`;
    graph += `[vmain][vmask]blend=c0_mode=multiply:c1_mode=normal:c2_mode=normal[vlook];`;
    vLast = 'vlook';
  }

  // Beat pump: a short luma lift on each beat that decays before the next one.
  // ffmpeg's eq ignores brightness below ~0.015, so the bump has to clear that
  // (0.030 ≈ +6 luma at the onset) and decay fast enough that it reads as a
  // pulse, not a flicker. Deliberately not a zoom: `zoompan` costs ~0.3s per
  // second of video at 1080x1920, this eq ~0.02s.
  if (musicPath && musicPulse && musicBpm >= 40) {
    const bpm = Math.max(40, Math.min(180, musicBpm));
    const beat = (60 / bpm).toFixed(4);
    graph += `[${vLast}]eq=brightness='0.030*exp(-12*mod(t,${beat}))':eval=frame[vpulse];`;
    vLast = 'vpulse';
  }

  graph += `[${vLast}]ass=${assName}:fontsdir=../../../assets/fonts:shaping=complex[vout]`;

  if (musicPath) {
    // Music bed: loop the track, trim to the clip, fade in/out, and duck it
    // under speech with a sidechain compressor keyed by the dialogue. The mix
    // is normalised to the same -14 LUFS as a music-free clip, so Reels does
    // not turn it down relative to the next one.
    const fadeOut = Math.max(0, dur - 1.2);
    const bed = `[1:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${Math.max(0.02, Number(musicGain) || 0.22).toFixed(3)},afade=t=in:st=0:d=0.8,afade=t=out:st=${fadeOut.toFixed(3)}:d=1.2[mus]`;
    if (hasAudio) {
      graph += `;[${audioIn}]aresample=48000,aformat=channel_layouts=stereo,highpass=f=72,deesser=i=0.35,asplit=2[sp][key];`;
      graph += `${bed};[mus][key]sidechaincompress=threshold=0.045:ratio=9:attack=10:release=320:makeup=1[duck];`;
      graph += `[sp][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${AUDIO_CHAIN}[aout]`;
    } else {
      graph += `;${bed}[mus]${AUDIO_CHAIN}[aout]`;
    }
  } else if (hasAudio) graph += `;[${audioIn}]${AUDIO_CHAIN}[aout]`;

  if (process.env.CLIPFORGE_DEBUG) console.log('[filter]', graph);
  const args = [
    '-y', '-v', 'info',
    '-ss', String(Math.max(0, start)), '-t', String(srcDur + 0.3), '-i', source,
    ...(musicPath ? ['-stream_loop', '-1', '-i', musicPath] : []),
    ...brAssets.flatMap((a) => (a.kind === 'image'
      ? ['-loop', '1', '-r', String(FPS), '-i', a.file]
      : ['-i', a.file])),
    '-filter_complex', graph,
    '-map', '[vout]', '-map', hasAudio || musicPath ? '[aout]' : '0:a?',
    ...encArgs, '-r', String(FPS), '-t', String(dur),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    outPath,
  ];

  const report = (s) => {
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
    if (m) {
      const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
      onProgress?.(Math.min(0.985, t / dur));
    }
  };

  try {
    if (process.env.DUMP_ARGS) {
      fs.writeFileSync(path.join(DIRS.cache, 'last-args.json'), JSON.stringify({ cwd: workDir, args }, null, 1));
    }
    const tEnc = Date.now();
    await ff(args, { cwd: workDir, onStderr: report });
    if (process.env.CLIPFORGE_TIMING) console.log(`[timing] ffmpeg ${((Date.now() - tEnc) / 1000).toFixed(1)}s ${enc.name} ${mode} ${preview ? 'draft' : 'final'}`);
  } catch (err) {
    const msg = String(err.message || err);
    if (!retried && enc.name !== 'libx264' && /nvenc|cuda|no device|gpu/i.test(msg)) {
      onLog?.('GPU encoder not usable — switching to CPU (x264)');
      useCpuEncoder();
      return renderClip({
        id, source, start, end, crop, template, position, size, accent, title, zoom,
        punch, words, subject, srcW, srcH, hasAudio, cuts, preview, edits, look,
        musicPath, musicBpm, musicGain, musicPulse, broll,
        onProgress, onLog, retried: true,
      });
    }
    if (mode === 'center') throw err;
    const next = mode === 'punch' ? 'blur' : 'center';
    onLog?.(`${mode} render failed, retrying with ${next}`);
    return renderClip({
      id, source, start, end, crop: next, template, position, size, accent, title, zoom,
      punch: 1, words, subject: next === 'blur' ? null : subject, srcW, srcH, hasAudio, cuts, preview, edits, look,
      musicPath, musicBpm, musicGain, musicPulse, broll,
      onProgress, onLog,
    });
  }

  onProgress?.(0.99);
  let thumb = null;
  if (!preview) {
    const thumbName = `${id}.jpg`;
    await ff(['-y', '-v', 'error', '-ss', '0.5', '-i', outPath, '-frames:v', '1', '-vf', 'scale=480:-2', path.join(DIRS.thumbs, thumbName)]);
    thumb = path.join(DIRS.thumbs, thumbName);
  }

  const stat = fs.statSync(outPath);
  return {
    path: outPath,
    thumb,
    ass: path.join(workDir, assName),
    size: stat.size,
    encoder: enc.name,
    mode,
    punch: usedPunch ?? punch,
    framing,
    music: musicPath ? { bpm: musicBpm || 0, gain: musicGain } : null,
    broll: { assets: brChains.length, cards: cards.length, planned: brRows.length },
    duration: dur,
    preview,
  };
}
