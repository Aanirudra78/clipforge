/**
 * Jump-cut planning: short-form clips live or die on pacing. Podcast audio is
 * full of dead air and discourse fillers, so we cut the pauses and the
 * "you know / matlab / so" beats out of the middle of a clip and let ffmpeg
 * splice the remainder. The opening and the ending are left alone — those were
 * already cleaned by the deterministic curation pass.
 */

/** Fillers that can go when they sit on a breath, never mid-phrase. */
const FILLERS = [
  ['you', 'know'], ['i', 'mean'], ['i', 'think'], ['i', 'guess'], ['you', 'see'],
  ['well'], ['so'], ['like'], ['okay'], ['ok'], ['right'], ['yeah'], ['yep'],
  ['actually'], ['basically'], ['honestly'], ['anyway'], ['um'], ['uh'], ['hmm'],
  ['matlab'], ['yaani'], ['yani'], ['toh'], ['dekho'], ['suno'], ['arre'],
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Plan the cuts for one clip.
 *
 * @returns {{cuts: {from:number,to:number}[], removed:number}}
 *   `cuts` are absolute source-time ranges, sorted and merged.
 */
export function planCuts({
  words = [], start = 0, end = 0, silence = [],
  minPause = 0.62, keep = 0.24, edgeIn = 0.7, edgeOut = 0.9, maxShare = 0.35,
} = {}) {
  const dur = end - start;
  if (!dur || words.length < 8) return { cuts: [], removed: 0 };
  const lo = start + edgeIn;
  const hi = end - edgeOut;
  const raw = [];

  // 1. dead air: silencedetect works on the actual waveform, so anything it
  // calls a pause can be cut. Whisper's word stamps stretch across breaths, so
  // they are only used to tidy captions (see remapWords), not to veto a cut.
  for (const s of silence) {
    const a = Math.max(lo, s.start + keep / 2);
    const b = Math.min(hi, s.end - keep / 2);
    if (b - a >= 0.18) raw.push({ from: a, to: b, kind: 'pause' });
  }

  // 2. fillers, but only the ones that already sit on a breath
  const gapBefore = (i) => (i > 0 ? words[i].start - words[i - 1].end : 9);
  const gapAfter = (i) => (i + 1 < words.length ? words[i + 1].start - words[i].end : 9);
  for (let i = 2; i < words.length - 2; i++) {
    const w = words[i];
    if (w.start < lo || w.end > hi) continue;
    let n = 0;
    for (const f of FILLERS) {
      if (i + f.length >= words.length) continue;
      let ok = true;
      for (let k = 0; k < f.length; k++) {
        if (norm(words[i + k].word) !== f[k]) { ok = false; break; }
      }
      if (ok) { n = f.length; break; }
    }
    if (!n) continue;
    const last = words[i + n - 1];
    // keep the filler when the phrase flows through it ("so that we could…")
    if (gapAfter(i + n - 1) < 0.1 && gapBefore(i) < 0.1) continue;
    // no breathing room on either side means the stamp is unreliable — leave it
    if (gapAfter(i + n - 1) < 0.08 || gapBefore(i) < 0.05) continue;
    if (last.end - w.start > 1.1) continue;
    const prevEnd = i > 0 ? words[i - 1].end : lo;
    const nextStart = i + n < words.length ? words[i + n].start : hi;
    const from = Math.max(lo, prevEnd + 0.03, w.start - 0.04);
    const to = Math.min(hi, nextStart - 0.03, last.end + 0.06);
    if (to - from < 0.1) continue;
    raw.push({ from, to, kind: 'filler' });
  }

  if (!raw.length) return { cuts: [], removed: 0 };

  // merge overlapping / touching ranges
  raw.sort((x, y) => x.from - y.from);
  const merged = [];
  for (const c of raw) {
    const prev = merged[merged.length - 1];
    if (prev && c.from <= prev.to + 0.05) prev.to = Math.max(prev.to, c.to);
    else merged.push({ ...c });
  }

  // never eat more than a third of the clip: keep the longest pauses first
  let total = merged.reduce((n, c) => n + (c.to - c.from), 0);
  const budget = dur * maxShare;
  let cuts = merged;
  if (total > budget) {
    const byLen = [...merged].sort((a, b) => (b.to - b.from) - (a.to - a.from));
    const kept = [];
    let used = 0;
    for (const c of byLen) {
      if (used + (c.to - c.from) > budget) continue;
      kept.push(c);
      used += c.to - c.from;
    }
    cuts = kept.sort((a, b) => a.from - b.from);
    total = used;
  }
  return { cuts, removed: total };
}

/** Segments of the clip that survive the cut list. */
export function keptSegments(start, end, cuts) {
  const out = [];
  let cursor = start;
  for (const c of cuts) {
    if (c.from > cursor + 0.01) out.push({ start: cursor, end: Math.min(c.from, end) });
    cursor = Math.max(cursor, c.to);
  }
  if (end > cursor + 0.01) out.push({ start: cursor, end });
  return out.filter((s) => s.end - s.start > 0.02);
}

/** Source time -> time on the cut timeline (origin = first kept segment). */
export function remapTime(t, segments) {
  if (!segments.length) return t;
  const t0 = segments[0].start;
  let removed = 0;
  let prevEnd = t0;
  for (const s of segments) {
    removed += Math.max(0, s.start - prevEnd);
    prevEnd = s.end;
    if (t <= s.end) return Math.max(0, t - t0 - removed);
  }
  return Math.max(0, t - t0 - removed);
}

/** Words on the cut timeline. A word that straddles a cut keeps the surviving
 *  part instead of vanishing (Whisper stamps stretch over breaths, so dropping
 *  them would punch holes in the captions). */
export function remapWords(words, segments) {
  const out = [];
  for (const w of words) {
    const seg = segments.find((s) => Math.min(w.end, s.end) - Math.max(w.start, s.start) >= 0.05);
    if (!seg) continue;
    const a = remapTime(Math.max(w.start, seg.start), segments);
    const b = remapTime(Math.min(w.end, seg.end), segments);
    if (b - a < 0.04) continue;
    out.push({ ...w, start: a, end: b });
  }
  return out;
}
