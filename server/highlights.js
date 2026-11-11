/**
 * Gameplay highlight picker.
 *
 * Podcasts are cut from sentences: speech rate and hooks decide. Gameplay has
 * no sentences to trust — the interesting second is the one that is LOUDER
 * than the minute around it (explosion, killstreak, scream, roar of the crowd)
 * or the one where the editor cut fastest (scene changes per second).
 *
 * So this module ignores the transcript for selection entirely:
 *
 *   1. smooth the RMS energy to 1 s,
 *   2. subtract the 60 s neighbourhood median-ish mean → local "contrast",
 *   3. every local maximum of that contrast is a candidate peak,
 *   4. grow a window around the peak (2 s pre/post padding by default),
 *   5. snap the edges to scene cuts / silence so a clip never starts mid-swipe,
 *   6. rank by contrast + cut density, enforce spacing and overlap.
 *
 * Everything is O(n) over the 100 ms energy track, so a 3-hour stream costs
 * milliseconds.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function movingAvg(values, win) {
  const n = values.length;
  const out = new Array(n);
  const w = Math.max(1, win | 0);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= w) sum -= values[i - w];
    out[i] = sum / Math.min(i + 1, w);
  }
  return out;
}

function nearestSorted(sorted, t) {
  if (!sorted.length) return null;
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1; else hi = mid;
  }
  const a = sorted[lo];
  const b = lo > 0 ? sorted[lo - 1] : null;
  if (b == null) return a;
  return Math.abs(a - t) <= Math.abs(b - t) ? a : b;
}

function countBetween(sorted, a, b) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < a) lo = m + 1; else hi = m; }
  const from = lo;
  lo = 0; hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= b) lo = m + 1; else hi = m; }
  return Math.max(0, lo - from);
}

export function pickHighlights({
  energy = [],
  step = 0.1,
  scenes = [],
  silence = [],
  duration = 0,
  count = 4,
  targetLen = 20,
  minLen = 10,
  maxLen = 38,
  pad = 2,
} = {}) {
  const n = energy.length;
  if (!n || !(duration > 0)) return [];
  const dt = step > 0 ? step : 0.1;

  // 1 s loudness, then the 60 s context it is compared against.
  const loud = movingAvg(energy, Math.round(1 / dt));
  const base = movingAvg(loud, Math.round(60 / dt));
  const contrast = loud.map((v, i) => v - base[i]);
  // a second pass keeps single-frame spikes (gunshot at 100 ms) from winning
  const soft = movingAvg(contrast, Math.round(0.6 / dt));

  const cuts = (Array.isArray(scenes) ? scenes : [])
    .map(Number).filter((t) => Number.isFinite(t) && t >= 0 && t <= duration)
    .sort((a, b) => a - b);
  const gapEnds = (Array.isArray(silence) ? silence : [])
    .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0 }))
    .filter((s) => s.end > s.start);

  const cutRate = (a, b) => {
    const span = Math.max(0.5, b - a);
    return countBetween(cuts, a, b) / span;
  };

  // ---- candidate peaks ----
  const radius = Math.max(2, Math.round(3 / dt));
  const peaks = [];
  for (let i = 0; i < n; i++) {
    const c = soft[i];
    if (!(c > 0.8)) continue;             // 0.8 dB over the local norm is noise
    if (i - radius >= 0 && soft[i - radius] > c) continue;
    if (i + radius < n && soft[i + radius] > c) continue;
    peaks.push({ i, t: i * dt, c });
  }
  peaks.sort((a, b) => b.c - a.c);

  const snapStart = (t, len) => {
    let out = t;
    const cut = nearestSorted(cuts, out);
    if (cut != null && Math.abs(cut - out) <= 1.5) out = cut;
    else {
      // start on the end of a silent stretch rather than in its middle
      const sil = gapEnds.reduce((best, s) => (
        s.end >= out - 1.2 && s.end <= out + 1.2 && (!best || Math.abs(s.end - out) < Math.abs(best - out)) ? s.end : best
      ), null);
      if (sil != null) out = sil;
      else out += len * 0.06;             // tiny trim keeps the first hit audible
    }
    return out;
  };
  const snapEnd = (t) => {
    const cut = nearestSorted(cuts, t);
    if (cut != null && Math.abs(cut - t) <= 1.5) return cut;
    const sil = gapEnds.reduce((best, s) => (
      s.start <= t + 1.2 && s.start >= t - 1.2 && (!best || Math.abs(s.start - t) < Math.abs(best - t)) ? s.start : best
    ), null);
    if (sil != null) return sil;
    return t;
  };

  // ---- build windows around peaks ----
  const minGap = clamp(duration / Math.max(1, count * 4), 4, 40);
  const chosen = [];
  const taken = (start, end, gap) => chosen.some((c) => (
    Math.min(c.end, end) - Math.max(c.start, start) > 0
    || (start >= c.start && start < c.end + gap)
    || (end > c.start - gap && end <= c.end)
    || (start < c.start && end > c.start - gap)
    || (start < c.end + gap && end > c.end)
  ));

  const tryTake = (list, gap) => {
    for (const p of list) {
      if (chosen.length >= count) break;
      const len = clamp(targetLen + 2 * pad, minLen, maxLen);
      let start = snapStart(p.t - len * 0.45 - pad, len);
      start = clamp(start, 0, Math.max(0, duration - minLen));
      let end = snapEnd(start + len);
      if (end - start < minLen) end = Math.min(duration, start + minLen);
      if (end > duration) { end = duration; start = Math.max(0, end - minLen); }
      if (end - start < 5) continue;
      if (taken(start, end, gap)) continue;
      const rate = cutRate(start, end);
      chosen.push({
        start: Math.round(start * 100) / 100,
        end: Math.round(end * 100) / 100,
        peak: Math.round(p.t * 100) / 100,
        peaks: [],
        score: Math.round((p.c + Math.min(3, rate) * 1.5) * 10) / 10,
        boost: p.c,
        rate,
      });
    }
  };

  tryTake(peaks, minGap);
  // Not every video has enough separated peaks (short clips, steady boss music).
  // Relax the spacing before giving up on the requested count.
  if (chosen.length < count) tryTake(peaks.filter((p) => !chosen.some((c) => Math.abs(c.peak - p.t) < 2)), minGap / 2);
  if (chosen.length < count) tryTake(peaks, 0);
  if (!chosen.length) return [];

  chosen.sort((a, b) => a.start - b.start);

  // Peaks per clip drive the action punch-in: the loudest ones inside the
  // window, kept at least 2.5 s apart so three peaks on the same boom do not
  // stack into one (already capped) pulse.
  for (const c of chosen) {
    const inside = [];
    for (const p of peaks
      .filter((p) => p.t > c.start + 0.6 && p.t < c.end - 0.6)
      .sort((a, b) => b.c - a.c)) {
      if (inside.some((t) => Math.abs(t - p.t) < 2.5)) continue;
      inside.push(p.t);
      if (inside.length >= 3) break;
    }
    c.peaks = inside.length
      ? inside.sort((a, b) => a - b)
      : [Math.round(((c.start + c.end) / 2) * 100) / 100];
    c.reason = `audio peak +${c.boost.toFixed(1)} dB · ${c.rate.toFixed(1)} cuts/s`;
    c.text = '';
    c.words = [];
  }
  return chosen;
}
