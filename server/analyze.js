import { ff } from './media.js';

const SAMPLE_RATE = 8000;
const WIN = 800; // 100ms

export async function analyzeAudio(file, onProgress) {
  const energy = [];
  const silence = [];
  let residual = Buffer.alloc(0);
  let sum = 0;
  let count = 0;
  let pendingSilence = null;

  await ff([
    '-v', 'info', '-i', file, '-vn',
    '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-af', 'silencedetect=noise=-32dB:d=0.45',
    '-f', 's16le', 'pipe:1',
  ], {
    onStdout(chunk) {
      let buf = residual.length ? Buffer.concat([residual, chunk]) : chunk;
      const usable = buf.length - (buf.length % (WIN * 2));
      for (let i = 0; i < usable; i += WIN * 2) {
        for (let j = 0; j < WIN; j++) {
          const v = buf.readInt16LE(i + j * 2) / 32768;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / WIN);
        energy.push(Math.max(-90, Math.round(20 * Math.log10(rms + 1e-9) * 10) / 10));
        sum = 0;
      }
      residual = buf.subarray(usable);
    },
    onStderr(s) {
      const startRe = /silence_start:\s*([\d.]+)/g;
      const endRe = /silence_end:\s*([\d.]+)/g;
      let m;
      while ((m = startRe.exec(s))) pendingSilence = Number(m[1]);
      while ((m = endRe.exec(s))) {
        if (pendingSilence != null) silence.push({ start: pendingSilence, end: Number(m[1]) });
        pendingSilence = null;
      }
    },
  });
  if (pendingSilence != null) silence.push({ start: pendingSilence, end: energy.length * 0.1 });

  onProgress?.(1);
  return { energy, step: 0.1, silence };
}

export async function detectScenes(file) {
  const times = [];
  // Scene cuts are a coarse signal here, so only keyframes are decoded: same
  // list on a podcast, ~10x faster than decoding every frame (27s → 3s on a
  // 44-minute video).
  await ff([
    '-v', 'info', '-skip_frame', 'nokey', '-i', file, '-an',
    '-vf', 'scale=320:-2,scdet=threshold=10',
    '-f', 'null', '-',
  ], {
    onStderr(s) {
      const re = /lavfi\.scd\.time:\s*([\d.]+)/g;
      let m;
      while ((m = re.exec(s))) times.push(Number(m[1]));
    },
  });
  const uniq = [];
  for (const t of times) if (!uniq.length || t - uniq[uniq.length - 1] > 0.6) uniq.push(t);
  return uniq;
}

/**
 * Cheap talking-head subject tracker: skin-tone blob detection.
 * No ML model — works well on podcasts / interviews, bails out (low confidence)
 * when the frame is too busy, in which case the caller falls back to blur-pad.
 *
 * Only the windows that will actually be rendered are sampled (a handful of
 * 30 s ranges), not the whole podcast: four frames per second of a 44-minute
 * file costs ~13 s and tells us nothing we don't throw away.
 *
 * The blob score matters more than the threshold: brown furniture and warm walls
 * also read as "skin", so blobs are ranked by how face-like they are (height in
 * frame, aspect, brightness) instead of just by size.
 */
export async function trackSubject(file, windows, onProgress) {
  const W = 160, H = 90;
  const frameBytes = W * H * 3;
  const samples = [];
  const fps = 4;
  const ranges = (Array.isArray(windows) ? windows : [windows])
    .map((w) => (typeof w === 'number'
      ? { start: 0, end: w }
      : { start: Number(w.start) || 0, end: Number(w.end) || 0 }))
    .filter((w) => w.end - w.start > 0.4)
    .sort((a, b) => a.start - b.start);

  const mask = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);

  function bestBlob(buf, off) {
    mask.fill(0);
    let skin = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = off + (y * W + x) * 3;
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        if (cb >= 77 && cb <= 127 && cr >= 133 && cr <= 176 && r > 55 && r > b && r >= g - 12) {
          mask[y * W + x] = 1;
          skin++;
        }
      }
    }
    if (skin < W * H * 0.002) return null;

    let best = null;
    const faces = [];
    for (let p0 = 0; p0 < mask.length; p0++) {
      if (mask[p0] !== 1) continue;
      let sp = 0;
      stack[sp++] = p0;
      mask[p0] = 2;
      let area = 0, sumX = 0, sumY = 0, sumL = 0;
      let minX = W, maxX = -1, minY = H, maxY = -1;
      while (sp) {
        const p = stack[--sp];
        const x = p % W, y = (p - x) / W;
        area++; sumX += x; sumY += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const i = off + p * 3;
        sumL += 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
        if (x > 0 && mask[p - 1] === 1) { mask[p - 1] = 2; stack[sp++] = p - 1; }
        if (x < W - 1 && mask[p + 1] === 1) { mask[p + 1] = 2; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - W] === 1) { mask[p - W] = 2; stack[sp++] = p - W; }
        if (y < H - 1 && mask[p + W] === 1) { mask[p + W] = 2; stack[sp++] = p + W; }
      }
      if (area < 48) continue;
      const w = maxX - minX + 1, h = maxY - minY + 1;
      if (w < 3 || h < 3) continue;
      if (w > W * 0.55 || h > H * 0.96) continue;

      const cx = sumX / area / W;
      const cy = sumY / area / H;
      const luma = sumL / area;
      const aspect = w / Math.max(1, h);

      const vertical = Math.max(0.15, 1 - Math.abs(cy - 0.42) * 1.35);
      const shape = 1 / (1 + Math.abs(Math.log(aspect / 1.05)) * 1.05);
      const bright = 0.35 + 0.65 * Math.min(1, luma / 150);
      // heads are compact: penalise blobs that are mostly a thin horizontal band
      const solid = Math.min(1, area / (w * h) / 0.55);
      const score = Math.pow(area, 0.85) * vertical * shape * bright * (0.55 + 0.45 * solid);

      if (!best || score > best.score) best = { score, x: cx, y: cy, area, bw: w / W, bh: h / H };
      if (area >= 36 && w >= 5 && h >= 5) faces.push({ x: cx, y: cy, area });
    }
    // two talking heads: a second, comparable face away from the best one
    let second = null;
    if (best) {
      for (const f of faces) {
        if (Math.abs(f.x - best.x) < 0.16) continue;
        if (f.area < Math.max(36, best.area * 0.2)) continue;
        if (!second || f.area > second.area) second = f;
      }
    }
    return best ? { ...best, two: Boolean(second), x2: second ? second.x : null } : null;
  }

  for (let i = 0; i < ranges.length; i++) {
    const w = ranges[i];
    const from = Math.max(0, w.start);
    const len = Math.max(0.4, w.end - from);
    let residual = Buffer.alloc(0);
    let frameIndex = 0;
    await ff([
      '-v', 'error', '-ss', from.toFixed(3), '-t', len.toFixed(3), '-i', file, '-an',
      '-vf', `fps=${fps},scale=${W}:${H}`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], {
      onStdout(chunk) {
        let buf = residual.length ? Buffer.concat([residual, chunk]) : chunk;
        let off = 0;
        while (off + frameBytes <= buf.length) {
          const blob = bestBlob(buf, off);
          samples.push({
            t: from + frameIndex / fps,
            x: blob ? blob.x : 0.5,
            y: blob ? blob.y : 0.42,
            x2: blob && Number.isFinite(blob.x2) ? blob.x2 : null,
            w: blob ? blob.bw : null,
            h: blob ? blob.bh : null,
            ok: Boolean(blob),
            two: Boolean(blob && blob.two),
          });
          frameIndex++;
          off += frameBytes;
        }
        residual = buf.subarray(off);
      },
    });
    onProgress?.((i + 1) / Math.max(1, ranges.length));
  }

  // smooth + downsample to ~1 node / second, on the absolute timeline
  const nodes = [];
  let emaX = 0.5, emaY = 0.42, has = false;
  const buckets = new Map();
  for (const s of samples) {
    if (s.ok) {
      emaX = has ? emaX * 0.82 + s.x * 0.18 : s.x;
      emaY = has ? emaY * 0.82 + s.y * 0.18 : s.y;
      has = true;
    }
    const k = Math.floor(s.t);
    const b = buckets.get(k) || { x: 0, y: 0, two: 0, w: 0, h: 0, x2: 0, x2n: 0, hit: 0, n: 0 };
    b.x += emaX; b.y += emaY; b.two += s.two ? 1 : 0; b.n++;
    if (s.ok && Number.isFinite(s.w)) { b.w += s.w; b.h += s.h; b.hit++; }
    if (Number.isFinite(s.x2)) { b.x2 += s.x2; b.x2n++; }
    buckets.set(k, b);
  }
  for (const [k, b] of [...buckets.entries()].sort((a, b2) => a[0] - b2[0])) {
    nodes.push({
      t: k,
      x: Math.round((b.x / b.n) * 1000) / 1000,
      y: Math.round((b.y / b.n) * 1000) / 1000,
      two: b.two / b.n >= 0.5,
      hit: Math.round((b.hit / b.n) * 100) / 100,
      ...(b.hit ? {
        w: Math.round((b.w / b.hit) * 1000) / 1000,
        h: Math.round((b.h / b.hit) * 1000) / 1000,
      } : {}),
      // second head only when it persists through most of this second
      ...(b.x2n >= Math.max(1, b.n * 0.4) ? { x2: Math.round((b.x2 / b.x2n) * 1000) / 1000 } : {}),
    });
  }
  const confidence = samples.length ? samples.filter((s) => s.ok).length / samples.length : 0;
  const twoSpeakers = samples.length ? samples.filter((s) => s.two).length / samples.length : 0;
  onProgress?.(1);
  return { nodes, confidence, twoSpeakers };
}

export function energyStats(energy) {
  if (!energy.length) return { mean: -60, std: 1 };
  const sorted = [...energy].sort((a, b) => a - b);
  const mean = energy.reduce((a, b) => a + b, 0) / energy.length;
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const std = Math.sqrt(energy.reduce((a, b) => a + (b - mean) ** 2, 0) / energy.length) || 1;
  return { mean, std, p90 };
}
