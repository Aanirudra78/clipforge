import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './config.js';

const ACCENTS = {
  yellow: { rgb: '#FFD400', a6: '&H00D4FF&', a8: '&H0000D4FF' },
  cyan: { rgb: '#00E5FF', a6: '&HFFE500&', a8: '&H00FFE500' },
  green: { rgb: '#7CFF6B', a6: '&H6BFF7C&', a8: '&H006BFF7C' },
  pink: { rgb: '#FF4D9D', a6: '&H9D4DFF&', a8: '&H009D4DFF' },
  orange: { rgb: '#FF8A3D', a6: '&H3D8AFF&', a8: '&H003D8AFF' },
  white: { rgb: '#FFFFFF', a6: '&H00FFFFFF&', a8: '&H00FFFFFF' },
  gold: { rgb: '#E8C36A', a6: '&H006AC3E8&', a8: '&H006AC3E8' },
  red: { rgb: '#FF3B30', a6: '&H00303BFF&', a8: '&H00303BFF' },
};

export const TEMPLATES = [
  { id: 'pop', name: 'Bold Pop', hint: 'Hormozi style · 2-3 words · active word pops' },
  { id: 'karaoke', name: 'Karaoke Clean', hint: 'full line · word-by-word fill' },
  { id: 'box', name: 'Minimal Box', hint: 'quiet lower-third · podcast clean' },
  { id: 'neon', name: 'Neon Punch', hint: 'glow + punchy scale' },
];

const SYSTEM_FONTS = {
  Anton: 'anton-regular.ttf',
  Montserrat: 'montserrat-extrabold.ttf',
  'Arial Black': 'arial-black.ttf',
  Arial: 'arial.ttf',
  Impact: 'impact.ttf',
  'Bebas Neue': 'bebasneue-regular.ttf',
  Cinzel: 'cinzel-variable.ttf',
};

const installed = () => {
  try { return new Set(fs.readdirSync(DIRS.fonts).map((f) => f.toLowerCase())); } catch { return new Set(); }
};

function fontFor(want, fallback) {
  const files = installed();
  const f = SYSTEM_FONTS[want];
  return f && files.has(f) ? want : fallback;
}

const fontCache = { pop: null, karaoke: null, box: null, neon: null, card: null };
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const ts = (t) => {
  t = Math.max(0, t);
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};

const esc = (s) => String(s)
  .replace(/\\/g, '/')
  .replace(/[{}]/g, '')
  .replace(/\r?\n/g, ' ')
  .replace(/&/g, 'and')
  .trim();

function chunkWords(words, { maxWords = 4, maxChars = 22, gap = 0.5, targetDur = 0.9 } = {}) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  const flush = () => {
    if (!cur.length) return;
    chunks.push(cur);
    cur = [];
    chars = 0;
  };
  for (const w of words) {
    const text = (w.word || '').trim();
    if (!text) continue;
    const prev = cur[cur.length - 1];
    if (prev) {
      const breakGap = w.start - prev.end > gap;
      const tooBig = cur.length >= maxWords || chars + text.length + 1 > maxChars;
      // keep one chunk on screen for roughly a beat, however fast people talk
      const enough = cur.length >= 2 && w.end - cur[0].start >= targetDur;
      if (breakGap || tooBig || enough) flush();
    }
    cur.push({ ...w, word: text });
    chars += text.length + 1;
    if (/[.!?…]$/.test(text)) flush();
  }
  flush();
  return chunks.filter((c) => c.length);
}

/** Merge chunks that would flash for a fraction of a second. */
function mergeTiny(chunks, { minDur = 0.72, maxWords = 6, maxChars = 40 } = {}) {
  const out = [];
  const chars = (c) => c.reduce((n, w) => n + w.word.length + 1, 0);
  for (const c of chunks) {
    const dur = c[c.length - 1].end - c[0].start;
    const prev = out[out.length - 1];
    if (
      dur < minDur && prev
      && prev.length + c.length <= maxWords
      && chars(prev) + chars(c) <= maxChars
    ) {
      prev.push(...c);
      continue;
    }
    out.push([...c]);
  }
  return out;
}

/**
 * Give every chunk its own slice of the timeline. A chunk ends where the next
 * one starts, so two caption lines can never be on screen at once.
 */
function layoutChunks(chunks, clipDur) {
  const out = [];
  let cursor = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const next = chunks[i + 1];
    const speechStart = Math.max(0, chunk[0].start - 0.03);
    const start = Math.max(cursor + (i ? 0.01 : 0), speechStart);
    const nextSpeech = next ? Math.max(start + 0.05, next[0].start - 0.05) : clipDur;
    const naturalEnd = chunk[chunk.length - 1].end + (next ? 0.28 : 0.5);
    let end = Math.min(clipDur, nextSpeech, Math.max(start + 0.2, naturalEnd));
    if (end <= start) end = Math.min(clipDur, start + 0.2);
    cursor = end;
    out.push({ chunk, start, end });
  }
  return out;
}

/** Split a chunk's on-screen window into monotonic, non-overlapping word slots. */
function wordSlots(chunk, cStart, cEnd, minDur = 0.12) {
  const n = chunk.length;
  if (!n) return [];
  const span = Math.max(0.06, cEnd - cStart);
  const gap = Math.min(minDur, span / n);
  const bounds = [0];
  for (let i = 1; i < n; i++) {
    const lo = bounds[i - 1] + gap;
    const hi = Math.max(lo, span - (n - i) * gap);
    const want = chunk[i].start - cStart;
    bounds.push(Math.min(Math.max(want, lo), hi));
  }
  bounds.push(span);
  return Array.from({ length: n }, (_, i) => ({ s: cStart + bounds[i], e: cStart + bounds[i + 1] }));
}

/** Sort by time and drop words that start inside the previous word's span. */
function tidy(list, tol = 0.12) {
  const out = [];
  let cursor = 0;
  for (const w of list.slice().sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (w.start < cursor - tol) continue;
    out.push(w);
    cursor = Math.max(cursor, w.end);
  }
  return out;
}

/** Words of the clip on the local (cut) timeline, with a stable index. */
function localWords(words, start, end, duration) {
  const clipDur = Math.max(0.5, (end || duration) - start);
  const local = tidy((words || [])
    .filter((w) => w.start >= start + 0.01 && w.start < (end || duration) - 0.02)
    .map((w) => ({ word: w.word, start: Math.max(0, w.start - start), end: Math.max(0, w.end - start) })));
  local.forEach((w, i) => { w.idx = i; });
  return { clipDur, local };
}

function chunkPlan(local, template) {
  const pop = template === 'pop' || template === 'neon';
  const raw = pop
    ? chunkWords(local, { maxWords: 4, maxChars: 22, gap: 0.5, targetDur: 0.95 })
    : chunkWords(local, {
      maxWords: template === 'box' ? 8 : 6,
      maxChars: template === 'box' ? 32 : 26,
      gap: 0.8,
      targetDur: template === 'box' ? 2.4 : 1.7,
    });
  return pop
    ? mergeTiny(raw, { minDur: 0.75, maxWords: 5, maxChars: 26 })
    : mergeTiny(raw, { minDur: 0.9, maxWords: template === 'box' ? 9 : 7, maxChars: template === 'box' ? 40 : 32 });
}

/** The caption lines as the editor sees them (stable key = first word index). */
export function captionChunks({ words = [], start = 0, end = 0, duration = 0, template = 'pop', edits = {} }) {
  const { clipDur, local } = localWords(words, start, end, duration);
  const chunks = chunkPlan(local, template);
  return layoutChunks(chunks, clipDur).map(({ chunk, start: s, end: e }) => {
    const key = String(chunk[0].idx);
    const original = chunk.map((w) => w.word).join(' ');
    return { key, original, text: edits[key] ?? original, start: s, end: e };
  });
}

export function buildCaptions({
  words = [], start = 0, end = 0, duration = 0,
  template = 'pop', position = 0.78, size = 1, accent = 'yellow',
  title = '', outW = 1080, outH = 1920, showBar = true, hookTop = 0, edits = {},
  lookStyle = null, cards = null, cardWindows = [],
}) {
  const ls = lookStyle || {};
  const acc = ACCENTS[accent] || ACCENTS.yellow;
  const { clipDur, local } = localWords(words, start, end, duration);

  const isPop = template === 'pop' || template === 'neon';
  const upper = ls.upper ?? isPop;

  if (!fontCache.pop) {
    fontCache.pop = fontFor('Anton', 'Arial Black');
    fontCache.neon = fontFor('Montserrat', 'Arial Black');
    fontCache.karaoke = fontFor('Montserrat', 'Arial');
    fontCache.box = fontFor('Montserrat', 'Arial');
  }

  let fontName = template === 'pop' ? fontCache.pop : template === 'neon' ? fontCache.neon : template === 'box' ? fontCache.box : fontCache.karaoke;
  // A look may swap the face without changing the caption layout.
  if (ls.font) fontName = fontFor(ls.font, fontName);
  const bold = template === 'pop' ? 0 : 1;
  const base = outH * 0.046;
  const fontSize = Math.round(base * (template === 'box' ? 0.8 : template === 'karaoke' ? 0.92 : 1.0) * size * (ls.size ?? 1));
  const outline = ls.outline ?? (template === 'box' ? 3 : template === 'neon' ? 6 : 9);
  const shadow = template === 'box' ? 0 : 3;
  const spacing = ls.spacing ?? (template === 'box' ? 0 : 1);
  const marginV = Math.max(60, Math.round(outH * (1 - position)) - Math.round(fontSize * 0.35));
  const titleFont = fontFor(ls.titleFont || 'Anton', 'Impact');

  const style = (name, font, sz, primary, secondary, back, ol, sh, sp, align, mv, bd, borderStyle = 1) =>
    `Style: ${name},${font},${sz},${primary},${secondary},&H00000000,${back},${bd},0,0,0,100,100,${sp},0,${borderStyle},${ol},${sh},${align},72,72,${mv},1`;

  // b-roll text cards: a dark panel that fills the video card when no footage
  // was found, with the phrase that carries the topic. Only emitted when asked.
  const hasCards = !!(cards && cards.frame && Array.isArray(cardWindows) && cardWindows.length);
  if (hasCards && !fontCache.card) fontCache.card = fontFor('Anton', 'Arial Black');

  const styles = [
    style('Cap', fontName, fontSize, '&H00FFFFFF', acc.a8, template === 'box' ? '&H8C000000' : '&HB4000000', outline, shadow, spacing, 2, marginV, bold, template === 'box' ? 3 : 1),
    style('Title', titleFont, Math.round(outH * 0.037 * size), '&H00FFFFFF', acc.a8, '&H90000000', 6, 2, 1, 8, Math.round(outH * 0.075), 0),
    style('Bar', 'Arial', 20, acc.a8, acc.a8, '&H00000000', 0, 0, 0, 7, 0, 0),
    ...(hasCards ? [
      style('CardBox', 'Arial', 20, '&H00140B18', '&H00140B18', '&H00000000', 0, 0, 0, 7, 0, 0),
      style('Card', fontCache.card, Math.round(outH * 0.048), '&H00FFFFFF', acc.a8, '&H00000000', 7, 3, 1, 5, 0, 0),
    ] : []),
  ].join('\n');

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${outW}
PlayResY: ${outH}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
${styles}

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

  const events = [];
  const push = (s, e, st, text, effect = '') => {
    let ee = Math.min(e, clipDur);
    if (ee - s < 0.05) ee = Math.min(clipDur, s + 0.05);
    events.push(`Dialogue: 0,${ts(s)},${ts(ee)},${st},,0,0,0,,${effect}${text}`);
  };

  if (title && title.trim()) {
    const hook = title.trim().split(/\s+/).filter(Boolean).slice(0, 6);
    const tEnd = Math.min(clipDur - 0.2, Math.max(1.8, Math.min(4.4, clipDur * 0.42)));
    const fs0 = Math.round(outH * 0.033 * size * (hook.length > 4 ? 0.88 : 1));
    // Anton is wide: shrink until the hook is one line, never two
    const chars = hook.join(' ').length + hook.length - 1;
    const fs = Math.max(34, Math.min(fs0, Math.floor((outW * 0.9) / (chars * 0.6))));
    const y = Math.max(18, Math.round((hookTop || outH * 0.15) - fs * 1.3 - 16));
    // the one word that carries the hook gets the accent colour
    const hot = hook.reduce((best, w, i) => (
      (/[\d%$₹]/.test(w) || w.replace(/[^\p{L}]/gu, '').length > (hook[best] || '').replace(/[^\p{L}]/gu, '').length)
        ? i : best
    ), hook.length - 1);
    const body = hook.map((w, i) => {
      const t = i * 85;
      const color = i === hot ? `\\c${acc.a6}` : '';
      return `{\\alpha&HFF&\\fscx84\\fscy84\\t(${t},${t + 170},\\alpha&H00&\\fscx100\\fscy100)${color}}${esc(w.toUpperCase())}{\\c&HFFFFFF&}`;
    }).join(' ');
    push(0.04, tEnd, 'Title', body,
      `{\\an8\\pos(${Math.round(outW / 2)},${y})\\fs${fs}\\fad(140,340)}`);
  }

  if (showBar) {
    const barMs = Math.max(400, Math.round(clipDur * 1000));
    events.push(`Dialogue: 0,${ts(0)},${ts(clipDur)},Bar,,0,0,0,,{\\an7\\pos(0,${outH - 36})\\p1\\bord0\\shad0\\1c${acc.a6}\\fscx2\\t(0,${barMs},\\fscx100)}m 0 0 l ${outW} 0 l ${outW} 10 l 0 10{\\p0}`);
  }

  if (hasCards && cards.frame) {
    const f = cards.frame;
    const x0 = Math.max(0, Math.round(f.x));
    const y0 = Math.max(0, Math.round(f.y));
    const w = Math.min(Math.round(f.w), outW - x0);
    const h = Math.min(Math.round(f.h), outH - y0);
    if (w > 60 && h > 60) {
      const cx = Math.round(clampN(x0 + w / 2, w * 0.35, outW - w * 0.35));
      const cy = Math.round(clampN(y0 + h / 2, h * 0.35, outH - h * 0.35));
      for (const cw of cardWindows) {
        const s0 = Math.max(0, Math.min(cw.start, clipDur));
        const e0 = Math.min(cw.end, clipDur);
        if (e0 - s0 < 0.3) continue;
        const label = String(cw.label || cw.query || '').split(/\s+/).slice(0, 5).join(' ');
        if (!label) continue;
        const text = esc(label.toUpperCase());
        const fs = Math.max(30, Math.min(Math.round(outH * 0.05), Math.floor((Math.max(200, w) * 0.86) / (Math.max(6, text.length) * 0.56))));
        // opaque panel INSTEAD of the speaker card + the phrase with a pop-in
        events.push(`Dialogue: 0,${ts(s0)},${ts(e0)},CardBox,,0,0,0,,{\\an7\\pos(${x0},${y0})\\p1\\bord0\\shad0\\1c&H140B18&\\1a&H20&\\fad(110,140)}m 0 0 l ${w} 0 l ${w} ${h} l 0 ${h}{\\p0}`);
        events.push(`Dialogue: 0,${ts(s0)},${ts(e0)},Card,,0,0,0,,{\\an5\\pos(${cx},${cy})\\fs${fs}\\fad(120,160)\\fscx86\\fscy86\\t(0,160,\\fscx100\\fscy100)}${text}`);
      }
    }
  }

  if (isPop) {
    const chunks = chunkPlan(local, template);
    for (const { chunk, start: cStart, end: cEnd } of layoutChunks(chunks, clipDur)) {
      const key = String(chunk[0].idx);
      const edit = (edits[key] || '').trim();
      if (edit) {
        const text = esc(upper ? edit.toUpperCase() : edit);
        const fs = Math.max(26, Math.min(fontSize, Math.floor((outW * 0.9) / (Math.max(1, text.length) * 0.56))));
        push(cStart + 0.01, cEnd, 'Cap', text, `{\\an2\\fad(60,60)\\fs${fs}}`);
        continue;
      }
      const slots = wordSlots(chunk, cStart, cEnd);
      for (let i = 0; i < chunk.length; i++) {
        const s = slots[i].s;
        const e = slots[i].e;
        if (e - s < 0.05) continue;
        const body = chunk.map((x, j) => {
          const t = esc(upper ? x.word.toUpperCase() : x.word);
          if (j !== i) return t;
          return template === 'neon'
            ? `{\\c${acc.a6}\\fscx109\\fscy109\\blur2.6\\3c&H000000&\\t(0,110,\\fscx100\\fscy100\\blur1.1)}${t}{\\c&HFFFFFF&\\blur0.9}`
            : `{\\c${acc.a6}\\fscx109\\fscy109\\t(0,110,\\fscx100\\fscy100)}${t}{\\c&HFFFFFF&}`;
        }).join(' ');
        push(s, e, 'Cap', body, '{\\an2\\fad(35,0)\\fscx103\\fscy103\\t(0,80,\\fscx100\\fscy100)}');
      }
    }
  } else {
    const chunks = chunkPlan(local, template);
    for (const { chunk, start: s, end: e } of layoutChunks(chunks, clipDur)) {
      const key = String(chunk[0].idx);
      const edit = (edits[key] || '').trim();
      if (edit) {
        const text = esc(upper ? edit.toUpperCase() : edit);
        const fs = Math.max(26, Math.min(fontSize, Math.floor((outW * 0.9) / (Math.max(1, text.length) * 0.56))));
        push(s, e, 'Cap', text, `{\\fad(70,70)\\fs${fs}}`);
        continue;
      }
      const slots = wordSlots(chunk, s, e);
      const parts = chunk.map((w, i) => {
        const cs = Math.max(5, Math.round(Math.max(0.06, slots[i].e - slots[i].s) * 100));
        return `{\\kf${cs}}${esc(upper ? w.word.toUpperCase() : w.word)} `;
      }).join('');
      push(s, e, 'Cap', parts, '{\\fad(70,70)}');
    }
  }

  return header + events.join('\n') + '\n';
}

export function writeASS(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}
