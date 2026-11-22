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
 *   4. follow that burst until it dies (short punch or long streak, not a
 *      fixed 15 s box),
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
  // The renderer caps one run at 8 clips, so a long video is cut by several
  // runs. Selection is deterministic, which made every run return the same
  // top 8. `skip` reserves the peaks earlier runs already used and returns the
  // next `count` ones, so run 2 (skip 8) continues where run 1 stopped.
  skip = 0,
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
  // A steady loud soundtrack is not a highlight. Prefer peaks that sit near
  // fast cutting (a kill / explosion usually lands right on an edit); a pure
  // "loud but boring" boom drifts down the ranking without being discarded,
  // which keeps short/quiet streams from ending up with zero clips.
  peaks.sort((a, b) => {
    const sa = a.c + Math.min(3, cutRate(a.t - 6, a.t + 6)) * 1.2;
    const sb = b.c + Math.min(3, cutRate(b.t - 6, b.t + 6)) * 1.2;
    return sb - sa;
  });

  const snapStart = (t, len) => {
    let out = t;
    const cut = nearestSorted(cuts, out);
    if (cut != null && Math.abs(cut - out) <= 0.8) out = cut;
    else {
      // start on the end of a silent stretch rather than in its middle
      const sil = gapEnds.reduce((best, s) => (
        s.end >= out - 0.7 && s.end <= out + 0.7 && (!best || Math.abs(s.end - out) < Math.abs(best - out)) ? s.end : best
      ), null);
      if (sil != null) out = sil;
      else out += len * 0.06;             // tiny trim keeps the first hit audible
    }
    return out;
  };
  const snapEnd = (t) => {
    const cut = nearestSorted(cuts, t);
    if (cut != null && Math.abs(cut - t) <= 0.8) return cut;
    const sil = gapEnds.reduce((best, s) => (
      s.start <= t + 0.7 && s.start >= t - 0.7 && (!best || Math.abs(s.start - t) < Math.abs(best - t)) ? s.start : best
    ), null);
    if (sil != null) return sil;
    return t;
  };

  // ---- build windows around peaks ----
  const want = Math.max(1, count) + Math.max(0, skip);
  // Spacing must NOT depend on count/skip: the candidate order has to be the
  // same for every run, otherwise `skip` reserves a different set than the
  // earlier run actually returned (duplicate clips). 32 = 8 clips x 4 slots.
  const minGap = clamp(duration / 32, 4, 40);
  const chosen = [];
  const reserved = [];   // peaks already taken by earlier runs (skip)
  const taken = (start, end, gap) => [...chosen, ...reserved].some((c) => (
    Math.min(c.end, end) - Math.max(c.start, start) > 0
    || (start >= c.start && start < c.end + gap)
    || (end > c.start - gap && end <= c.end)
    || (start < c.start && end > c.start - gap)
    || (start < c.end + gap && end > c.end)
  ));

  // Follow the loudness burst around a peak instead of stamping a fixed box.
  // One gunshot -> a short punch; a multi-kill streak stays long enough to read
  // as one moment. `targetLen` is only the centre of gravity, not a hard rule.
  const burstWindow = (p) => {
    const idx = clamp(Math.round(p.t / dt), 0, n - 1);
    const floor = Math.max(0.3, p.c * 0.4);
    const back = clamp(targetLen * 0.55, 3, 8);
    const fwd = clamp(targetLen * 0.75, 4, 10);
    let a = idx;
    while (a > 0 && (idx - a) * dt < back && soft[a - 1] >= floor) a--;
    let b = idx;
    while (b < n - 1 && (b - idx) * dt < fwd && soft[b + 1] >= floor) b++;
    // Count distinct HITS, not every local maximum in a loud section: two
    // peaks 200 ms apart are one explosion, not a two-kill streak.
    const strong = p.c * 0.6;
    const hits = peaks
      .filter((q) => q.t >= a * dt && q.t <= b * dt && q.c >= strong)
      .sort((x, y) => x.t - y.t);
    let inBurst = 0;
    let lastHit = -99;
    for (const q of hits) {
      if (q.t - lastHit >= 2.5) { inBurst++; lastHit = q.t; }
    }
    let start = a * dt - Math.min(pad, 0.9);
    let end = b * dt + Math.min(pad, 1.3);
    const wanted = clamp(
      targetLen + Math.min(5, Math.max(0, inBurst - 1) * 2.2) + Math.min(3, p.c * 0.35),
      minLen, maxLen,
    );
    const raw = end - start;
    if (raw < wanted) {
      const grow = wanted - raw;
      start -= grow * 0.35;
      end += grow * 0.65;
    } else if (raw > maxLen) {
      // Keep the biggest moment at ~40% in, trim the long quiet tail.
      start = p.t - maxLen * 0.4;
      end = start + maxLen;
    }
    return { start, end, inBurst };
  };

  const tryTake = (list, gap) => {
    for (const p of list) {
      if (chosen.length + reserved.length >= want) break;
      const burst = burstWindow(p);
      let start = snapStart(burst.start, burst.end - burst.start);
      start = clamp(start, 0, Math.max(0, duration - minLen));
      let end = snapEnd(burst.end);
      if (end - start < minLen) end = Math.min(duration, start + minLen);
      if (end - start > maxLen) end = start + maxLen;
      if (end > duration) {
        end = duration;
        start = Math.max(0, end - Math.min(maxLen, Math.max(minLen, end - start)));
      }
      if (end - start < 5) continue;
      if (taken(start, end, gap)) continue;
      const rate = cutRate(start, end);
      const item = {
        start: Math.round(start * 100) / 100,
        end: Math.round(end * 100) / 100,
        peak: Math.round(p.t * 100) / 100,
        peaks: [],
        score: Math.round((p.c + Math.min(3, rate) * 1.5 + Math.min(2, burst.inBurst * 0.4)) * 10) / 10,
        boost: p.c,
        rate,
        inBurst: burst.inBurst,
      };
      if (reserved.length < skip) reserved.push(item);
      else chosen.push(item);
    }
  };

  tryTake(peaks, minGap);
  // Not every video has enough separated peaks (short clips, steady boss music).
  // Relax the spacing before giving up on the requested count.
  const used = (p) => [...chosen, ...reserved].some((c) => Math.abs(c.peak - p.t) < 2);
  if (chosen.length + reserved.length < want) tryTake(peaks.filter((p) => !used(p)), minGap / 2);
  if (chosen.length + reserved.length < want) tryTake(peaks, 0);
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
