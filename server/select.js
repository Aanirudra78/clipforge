const HOOKS = [
  'paisa', 'paise', 'paisa', 'secret', 'asli', 'sach', 'sachai', 'kyun', 'kyu', 'kaise', 'matlab',
  'dekho', 'suno', 'problem', 'galti', 'billion', 'crore', 'lakh', 'bina', 'free', 'trick',
  'formula', 'fact', 'truth', 'scam', 'system', 'life', 'why', 'how', 'never', 'always', 'best',
  'worst', 'biggest', 'mistake', 'money', 'rich', 'poor', 'growth', 'business', 'startup', 'risk',
  'exposed', 'shocking', 'samjho', 'yaad', 'important', 'zaroori', 'faayda', 'nuksan', 'haal',
];

const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '');

export function energyAt(energy, step, t, span = 1) {
  if (!energy.length) return -45;
  const a = Math.max(0, Math.floor(t / step));
  const b = Math.min(energy.length, Math.ceil((t + span) / step));
  if (b <= a) return energy[Math.min(energy.length - 1, a)] ?? -45;
  let sum = 0;
  for (let i = a; i < b; i++) sum += energy[i];
  return sum / (b - a);
}

const endsSentence = (t) => /[.!?…]["')\]]?$/.test(String(t || '').trim());

/**
 * Whisper re-decodes some stretches of a long, pause-free file (often twice,
 * once per script), so the same moment arrives as two overlapping word runs.
 * Keep one monotonic stream: sorted, and no word inside another one's span.
 */
export function dedupeWords(words, tol = 0.15) {
  const list = (words || [])
    .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end) && String(w.word || '').trim())
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let cursor = -Infinity;
  for (const w of list) {
    if (w.start < cursor - tol) continue;
    out.push(w);
    cursor = Math.max(cursor, w.end);
  }
  return out;
}

export function speechUnits(words, silence, duration) {
  const units = [];
  if (words && words.length > 3) {
    let cur = null;
    for (const w of words) {
      if (!cur) cur = { start: w.start, end: w.end, words: [w] };
      else {
        const gap = w.start - cur.end;
        const breakHere = (gap > 0.55 && cur.words.length >= 3) || (endsSentence(cur.words[cur.words.length - 1].word) && cur.words.length >= 3);
        if (breakHere || cur.words.length >= 18) {
          units.push(cur);
          cur = { start: w.start, end: w.end, words: [w] };
        } else {
          cur.end = w.end;
          cur.words.push(w);
        }
      }
    }
    if (cur) units.push(cur);
  }
  if (!units.length) {
    let t = 0;
    const sil = [...silence].sort((a, b) => a.start - b.start);
    for (const s of sil) {
      if (s.start - t > 1.2) units.push({ start: t, end: s.start, words: [] });
      t = Math.max(t, s.end);
    }
    if (duration - t > 1.2) units.push({ start: t, end: duration, words: [] });
  }
  return units.map((u) => ({
    ...u,
    text: u.words.map((w) => w.word).join(' ').trim(),
    dur: u.end - u.start,
  }));
}

/**
 * Sentence-level index of the transcript. Every entry is a self-contained
 * thought (punctuation or a real pause ends it), so clip edges can snap to it.
 */
export function sentences(words, silence = [], duration = 0) {
  if (!words || words.length < 1) return [];
  const raw = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((w) => w.word).join(' ').replace(/\s+/g, ' ').trim();
    raw.push({ start: cur[0].start, end: cur[cur.length - 1].end, text, words: cur });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || !String(w.word || '').trim()) continue;
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = w.start - prev.end;
      const sentenceEnd = endsSentence(prev.word);
      const longPause = gap > (sentenceEnd ? 0.42 : 0.72);
      if ((sentenceEnd && cur.length >= 2) || longPause || cur.length >= 28) flush();
    }
    cur.push(w);
  }
  flush();
  return raw.map((s, i) => ({ ...s, i, dur: s.end - s.start }));
}

/** Merge/trim sentence ranges so they respect the clip length window. */
export function fitSentenceRange(sentences, from, to, { minLen = 14, maxLen = 58 } = {}) {
  if (!sentences.length) return null;
  let a = Math.max(0, Math.min(sentences.length - 1, from | 0));
  let b = Math.max(a, Math.min(sentences.length - 1, to | 0));
  const span = () => sentences[b].end - sentences[a].start;
  while (span() < minLen && b + 1 < sentences.length) b++;
  while (span() < minLen && a > 0) a--;
  while (span() > maxLen && b > a) b--;
  if (sentences[b].end - sentences[a].start < 4) return null;
  return { a, b };
}

/** Closest sentence index to a timestamp (for heuristic → sentence snapping). */
export function sentenceAt(sentences, t) {
  if (!sentences.length) return 0;
  let lo = 0, hi = sentences.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sentences[mid].start < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function pickClips({ units, energy, step, silence, duration, count = 6, minLen = 16, maxLen = 46, keyMoments = true }) {
  if (!units.length) return [];
  const p = [...energy].sort((a, b) => a - b);
  const p10 = p[Math.floor(p.length * 0.1)] ?? -50;
  const p90 = p[Math.floor(p.length * 0.9)] ?? -20;

  const candidates = [];
  for (let i = 0; i < units.length; i++) {
    let end = units[i].end, j = i;
    let text = units[i].text;
    while (j + 1 < units.length && end - units[i].start < minLen) {
      j++; end = units[j].end; text += ' ' + units[j].text;
    }
    // allow stopping at any later unit while inside the max length
    for (let k = i; k <= Math.min(units.length - 1, j + 2); k++) {
      const s = units[i].start, e = units[k].end;
      const len = e - s;
      if (len < Math.min(12, minLen - 1) || len > maxLen) continue;
      const prev = units[i - 1];
      const cleanStart = !prev || endsSentence(prev.text) || units[i].start - prev.end > 0.7;
      const cleanEnd = endsSentence(units[k].text) || !units[k + 1] || units[k + 1].start - units[k].end > 0.7;
      const wordsIn = units.slice(i, k + 1).flatMap((u) => u.words);
      const wps = len > 0 ? wordsIn.length / len : 0;
      const mid = s + len / 2;
      const en = energyAt(energy, step, s, len);
      const eNorm = Math.max(0, Math.min(1, (en - p10) / Math.max(1, p90 - p10)));
      const txt = norm(units.slice(i, k + 1).map((u) => u.text).join(' '));
      const hits = HOOKS.filter((h) => txt.includes(h));
      const silInside = silence
        .filter((x) => x.end > s && x.start < e)
        .reduce((a, x) => a + (Math.min(x.end, e) - Math.max(x.start, s)), 0) / Math.max(1, len);
      const silOutside = silence.some((x) => Math.abs(x.start - e) < 0.6 || Math.abs(x.end - s) < 0.6);
      const lenPref = 1 - Math.abs(len - 30) / 40;
      let score = 0;
      score += Math.min(1, wps / 3.4) * 34;
      score += eNorm * 24;
      score += Math.min(3, hits.length) * 9;
      score += silOutside ? 8 : 0;
      score += cleanStart ? 10 : 0;
      score += cleanEnd ? 4 : 0;
      score += Math.max(0, lenPref) * 12;
      score -= Math.min(28, silInside * 70);
      if (keyMoments && !hits.length && wps < 1.6) score -= 6;
      candidates.push({
        start: Math.max(0, s - 0.15),
        end: Math.min(duration, e + 0.25),
        score: Math.round(score * 10) / 10,
        reason: [
          hits.length ? `hooks: ${[...new Set(hits)].slice(0, 3).join(', ')}` : null,
          `speech ${wps.toFixed(1)} w/s`,
          `energy ${Math.round(eNorm * 100)}%`,
        ].filter(Boolean).join(' · '),
        text: units.slice(i, k + 1).map((u) => u.text).join(' ').trim(),
        words: wordsIn,
      });
    }
  }
  if (!candidates.length) {
    return [{ start: 0, end: Math.min(duration, 30), score: 10, reason: 'fallback window', text: '', words: [] }];
  }

  candidates.sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const c of candidates) {
    if (chosen.length >= count) break;
    const overlap = chosen.some((o) => {
      const ov = Math.min(o.end, c.end) - Math.max(o.start, c.start);
      return ov > 0.12 * Math.min(o.end - o.start, c.end - c.start);
    });
    if (!overlap && c.end - c.start >= 8) chosen.push(c);
  }
  return chosen.sort((a, b) => a.start - b.start);
}
