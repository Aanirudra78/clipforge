import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GROQ_API_KEY, DIRS } from './config.js';
import { fitSentenceRange } from './select.js';

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS = process.env.CURATE_MODEL
  ? [process.env.CURATE_MODEL]
  : ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
const WINDOW = 130;   // sentences per request
const OVERLAP = 8;    // shared sentences between windows (keeps stories intact)

const SYSTEM = `You are a senior short-form editor who cuts viral clips from long Hinglish (Hindi + English) podcasts and interviews.

You get a numbered transcript. Each number is one sentence.

Pick the moments that would actually stop someone scrolling. A good clip:
- is ONE complete idea with a real beginning and end: setup -> point -> punch line or takeaway;
- works with zero context. If the clip is an ANSWER, start it on the QUESTION it answers (the interviewer's question is cheap context and makes the clip make sense). If the first sentence starts with a back-reference or connector — un, us, in, inke, uska, wo, ye, isko, that, this, it, those, lekin, aur, phir, toh, matlab, yaani, isliye, so, and, but, they — move the start 1-2 sentences earlier until the clip can stand alone;
- never opens on a filler: Well, So, You know, I mean, Like, Okay, Right, Yeah, Actually, Basically, Um, Uh, matlab, yaani, dekho — cut on the content word right after it;
- never starts or ends mid-explanation, mid-list, or mid-story. The last sentence must close the thought;
- is 18 to 42 seconds when read at normal speaking pace;
- is a strong insight, a specific story, a contrarian take, a number/fact, or an emotional line — not filler, not intro, not ads, not "subscribe karo", not small talk;
- does not overlap another clip.

For each clip also write:
- "start": the first 5-8 words of the clip, copied exactly from the transcript, at the exact point the clip should begin — the start of a complete clause, never mid-phrase;
- "end": the last 5-8 words of the clip, copied exactly from the transcript, where the thought closes;
- "hook": a scroll-stopper title, max 7 words, Roman script only (Hindi words in English letters, never Devanagari), no emojis, no quotes, no full stop. It must be true to the clip, not clickbait.
- "why": max 14 words on why this moment works.

Return ONLY JSON:
{"clips":[{"from":12,"to":18,"start":"...","end":"...","hook":"...","why":"..."}]}
"from" and "to" are inclusive sentence numbers. "start" and "end" must be exact quotes from the transcript — the editor cuts on those words, which is more precise than a sentence edge.`;

const clipText = (sentences, a, b) => sentences.slice(a, b + 1).map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Function words that must never open a clip. */
const STOP = /^(ko|ke|ki|ka|se|saath|mein|me|par|pe|un|us|in|is|ye|yeh|wo|woh|jo|jinko|jis|jiske|bhi|hi|aur|lekin|magar|toh|to|ab|ek|kuch|aise|aisi|aisa|hai|hain|tha|thi|the|gaya|gayi|gaye|kara|karke|kar|karte|karta|band|wala|wali|baat|jahan|wahan|yahan|baad|phir|fir|matlab|yaani|isliye|unke|uske|inke|iski|uski|unki|raha|rahe|rahi|aata|aati|aate|jata|jati|jate|hota|hoti|hote|sakta|sakti|sakte|hoga|hogi|honge|chahiye|pada|pade|padi|aaya|aayi|aaye|and|but|that|this|it|so|or|of|to|the|a|an|is|are|was|were|has|have|had|just|then|also|because|for|on|at|with|from|as)$/i;

/**
 * A run-on transcript gives cuts in the middle of a clause; when the chosen
 * first word is a connector or a bare verb, move forward onto the first word
 * that carries meaning ("baad wahan ke farmers ko" -> "wahan ke farmers ko").
 */
function skipLead(allWords, idx, steps = 5) {
  let i = idx;
  for (let n = 0; n < steps && i < allWords.length - 1; n++) {
    const w = norm(allWords[i].word);
    if (!w || !STOP.test(w)) break;
    i++;
  }
  return i;
}

/**
 * Standalone discourse fillers. A clip that opens on one of these sounds like
 * it started mid-conversation, which is exactly what viewers bounce on.
 */
const FILLERS = [
  ['you', 'know'], ['i', 'mean'], ['i', 'think'], ['i', 'guess'], ['you', 'see'],
  ['well'], ['so'], ['like'], ['okay'], ['ok'], ['right'], ['yeah'], ['yep'],
  ['actually'], ['basically'], ['honestly'], ['anyway'], ['um'], ['uh'], ['hmm'],
  ['matlab'], ['yaani'], ['yani'], ['toh'], ['dekho'], ['suno'], ['arre'],
];

/** Move the cut past "Well, you know," so the clip opens on the actual claim. */
function stripFillers(allWords, idx) {
  let i = idx;
  for (let guard = 0; guard < 6; guard++) {
    let moved = false;
    for (const f of FILLERS) {
      if (i + f.length >= allWords.length - 8) continue;
      let ok = true;
      for (let k = 0; k < f.length; k++) {
        if (norm(allWords[i + k].word) !== f[k]) { ok = false; break; }
      }
      if (ok) { i += f.length; moved = true; break; }
    }
    if (!moved) break;
  }
  return i;
}

/**
 * Podcast answers start a beat after the question, so a word-level cut often
 * lands a sentence in. The closest pause end before the cut is where the
 * speaker actually started.
 */
function snapStart(allWords, start, silence, maxBack = 3.2) {
  if (!silence?.length || !allWords.length) return start;
  let best = null;
  for (const s of silence) {
    const gap = start - s.end;
    if (gap < 0.18 || gap > maxBack) continue;
    if (s.end - s.start < 0.28) continue;
    if (!best || s.end > best) best = s.end;
  }
  return best == null ? start : Math.max(0, best + 0.04);
}

/** Keep the end inside the length window without touching the cleaned opening. */
function fitEnd(allWords, start, end, minLen, maxLen) {
  const lastEnd = allWords.length ? allWords[allWords.length - 1].end + 0.25 : end;
  if (end - start > maxLen + 3) {
    const kept = allWords.filter((w) => w.start >= start - 0.05 && w.end - start <= maxLen);
    if (kept.length >= 8) return kept[kept.length - 1].end + 0.25;
  }
  if (end - start < minLen) {
    const stop = allWords.find((w) => w.start >= end - 0.05 && w.end - start >= minLen);
    if (stop) return Math.min(lastEnd, stop.end + 0.25);
  }
  return Math.min(end, lastEnd);
}

/**
 * A clip that answers a question is twice as clear when the question is in it.
 * Only prepend short, real questions that sit right before the cut.
 */
const QUESTION = /^(why|how|what|what's|when|where|who|which|do|does|did|is|are|was|were|can|could|would|should|will|kya|kaise|kyun|kyu|kab|kahan|kaun|kitna|kitne|aap|tum)\b/i;

/** First words that reliably open an answer. */
const ANSWER_OPEN = /^(well|so|yeah|yes|no|i|i'm|i've|i'd|we|we're|we've|my|our|actually|look|okay|honestly|basically|it|it's|they|the|this|that|toh|matlab|dekho|haan|nahi|main|hum)\b/i;

/** Sentence index whose start is at/before t (small tolerance for cut padding). */
function sentenceIndexAt(sentences, t, tol = 0.2) {
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (sentences[i].start <= t + tol) return i;
  }
  return -1;
}

/**
 * Words inside [start, end). Whisper re-decodes leave overlapping runs, so a
 * word that starts just inside the cut may be the first word of the NEXT
 * sentence ("…at age 13. by,") — stop at the word that closes the cut.
 */
function wordsIn(allWords, start, end) {
  const out = [];
  for (const w of allWords) {
    if (w.start < start - 0.02) continue;
    if (w.end > end + 0.06) break;
    out.push(w);
  }
  if (out.length) return out;
  return allWords.filter((w) => w.start >= start - 0.001 && w.start < end);
}

/** Openings that only work with the sentence before them. */
const WEAK_OPEN = /^(and|but|so|or|because|that|this|it|those|these|they|them|which|who|then|also|plus|un|us|is|in|ye|wo|woh|lekin|aur|phir|toh|matlab|yaani)$/i;

/**
 * A clip must start at a clause boundary, not on the word "really" in the
 * middle of someone else's sentence. Pull the cut back to that sentence start
 * when it is short and does not open on a connector.
 */
function sentenceSnap(sentences, start, end, maxLen) {
  const a = sentenceIndexAt(sentences, start);
  if (a < 0) return start;
  const cur = sentences[a];
  const into = start - cur.start;
  if (into < 0.3) return start;          // already on the boundary
  if (into <= 1.2) return start;         // just a beat in: the pause landing is right
  const next = sentences[a + 1];
  // mid-sentence: opening on the next full sentence beats opening on a tail
  if (next && next.start - start <= 4.5 && end - next.start >= 8) return next.start - 0.05;
  // otherwise pull back to this sentence's own start when it is short
  if (cur.end - cur.start <= 9 && end - cur.start <= maxLen + 5) {
    const first = norm(String(cur.text || '').split(/\s+/)[0] || '');
    if (!WEAK_OPEN.test(first)) return Math.max(0, cur.start - 0.05);
  }
  return start;
}

/** The transcript's questions are often a rambling false start. Skip to the answer. */
function answerStart(sentences, a) {
  const first = String(sentences[a]?.text || '').trim();
  if (!QUESTION.test(first) || !/\?/.test(first)) return a;
  for (let i = a + 1, n = 0; i < sentences.length && n < 6; i++, n++) {
    const t = String(sentences[i].text || '').trim();
    if (ANSWER_OPEN.test(t)) return i;
    if (sentences[i].start - sentences[a].end > 20) break;
  }
  return a;
}

function questionStart(sentences, start, end, maxLen) {
  const a = sentenceIndexAt(sentences, start);
  if (a <= 0) return start;
  const prev = sentences[a - 1];
  const txt = String(prev.text || '').trim();
  if (!txt) return start;
  if (!QUESTION.test(txt)) return start;
  if (prev.end - prev.start > 7.5) return start;
  if (start - prev.end > 1.4) return start;
  if (end - prev.start > maxLen + 6) return start;
  return Math.max(0, prev.start - 0.05);
}

const PUNCT_END = /[.!?…]["')\]]?$/;
const endsWithPunct = (s) => PUNCT_END.test(String(s?.text || '').trim());

/** Close the clip on a punctuated sentence end, inside the length window. */
function endSnap(sentences, start, end, { minLen, maxLen }) {
  if (!sentences.length) return end;
  const cap = maxLen + 3;
  // nearest sentence end to the current cut (past the opening only)
  let a = -1, bd = Infinity;
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].end < start + 4) continue;
    const d = Math.abs(sentences[i].end - end);
    if (d < bd) { bd = d; a = i; }
  }
  if (a < 0 || bd > 3) return end;
  const near = sentences[a];
  if (bd <= 0.6) {
    if (endsWithPunct(near)) return near.end + 0.2;
    // chopped run-on chunk: only continue when the next chunk continues the sentence
    const nx = sentences[a + 1];
    if (!nx || nx.end - start > cap) return end;
    if (!/^\p{Ll}/u.test(String(nx.text || '').trim())) return end;
    a++;
  } else if (near.end < end) {
    return end;  // the cut is already past this boundary: leave it
  }
  // walk forward through unpunctuated chunks while the window still allows it
  for (let n = 0; n < 4; n++) {
    if (endsWithPunct(sentences[a])) break;
    const nx = sentences[a + 1];
    if (!nx || nx.end - start > cap || nx.end - end > 8) break;
    if (!/^\p{Ll}/u.test(String(nx.text || '').trim())) break;
    a++;
  }
  let e = sentences[a].end + 0.2;
  if (e - start > cap) {
    let i = a;
    while (i >= 0 && (sentences[i].end - start > cap || !endsWithPunct(sentences[i]))) i--;
    if (i >= 0 && sentences[i].end - start >= minLen - 2) return sentences[i].end + 0.2;
    return end;
  }
  if (e - start < minLen - 2) {
    let i = a;
    while (i + 1 < sentences.length && sentences[i + 1].end - start <= cap) i++;
    e = sentences[i].end + 0.2;
  }
  return e;
}

/** Deterministic final pass: clause boundary, question context, pause edges, clean opening. */
export function finishCut(sentences, allWords, start, end, { minLen, maxLen, silence }) {
  let s = snapStart(allWords, start, silence);
  s = sentenceSnap(sentences, s, end, maxLen);
  const a = sentenceIndexAt(sentences, s);
  if (a >= 0) {
    const b = answerStart(sentences, a);
    if (b > a) {
      s = Math.max(s, sentences[b].start - 0.05);
      if (end < s + minLen) end = Math.min(allWords[allWords.length - 1].end, s + minLen + 6);
    }
  }
  s = questionStart(sentences, s, end, maxLen);
  let li = allWords.findIndex((w) => w.start >= s - 0.02);
  if (li < 0) li = Math.max(0, allWords.length - 1);
  li = stripFillers(allWords, skipLead(allWords, li));
  s = Math.max(0, allWords[li].start - 0.05);

  let e = endSnap(sentences, s, end, { minLen, maxLen });
  e = fitEnd(allWords, s, e, minLen, maxLen);
  return { start: s, end: e };
}

/** Find a quoted phrase in the word stream, nearest to an anchor time. */
function findPhrase(allWords, phrase, anchorT) {
  const p = norm(phrase);
  if (!p) return null;
  const pw = p.split(' ');
  if (pw.length < 3) return null;
  const nw = allWords.map((w) => norm(w.word));
  let best = null;
  for (let i = 0; i <= nw.length - pw.length; i++) {
    let ok = true;
    for (let j = 0; j < pw.length; j++) {
      if (nw[i + j] !== pw[j]) { ok = false; break; }
    }
    if (!ok) continue;
    const d = Math.abs(allWords[i].start - anchorT);
    if (!best || d < best.d) best = { i, n: pw.length, d };
  }
  return best;
}

function promptFor(sentences, from, to, want) {
  const lines = [];
  for (let i = from; i <= to; i++) {
    const s = sentences[i];
    const dur = Math.max(0.1, s.dur ?? (s.end - s.start));
    lines.push(`${s.i}: (${dur.toFixed(1)}s) ${s.text}`);
  }
  return `Transcript sentences ${from}-${to} of ${sentences.length}. The number in brackets is how long that sentence takes to say.\nPick the best ${want} clips from this section only. Use sentence numbers in that range. Add up the bracket seconds: the clip must total 18-42 seconds.\n\n${lines.join('\n')}`;
}

async function chat(body) {
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Groq chat ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

async function askOnce(messages, want) {
  let lastErr = null;
  for (const model of MODELS) {
    try {
      const j = await chat({
        model,
        messages,
        temperature: 0.2,
        max_tokens: 700 + want * 240,
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
      });
      const raw = j?.choices?.[0]?.message?.content || '';
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('model did not return JSON');
        parsed = JSON.parse(m[0]);
      }
      const list = Array.isArray(parsed) ? parsed : parsed.clips || parsed.moments || [];
      if (!Array.isArray(list)) throw new Error('model returned no clip list');
      return { clips: list, raw, model };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no model available');
}

/**
 * Ask an LLM which parts of the transcript are actually worth clipping.
 * Returns null when there is nothing to work with, so callers can fall back
 * to the heuristic picker.
 */
export async function curate({
  sentences = [], count = 6, minLen = 14, maxLen = 58, title = '', silence = [], onLog,
} = {}) {
  if (!GROQ_API_KEY || sentences.length < 4) return null;
  const text = sentences.map((s) => s.text).join(' ');
  if (text.length < 220) return null;

  const cacheKey = crypto.createHash('sha1')
    .update(`v7|${MODELS[0]}|${count}|${minLen}|${maxLen}|${text}`)
    .digest('hex').slice(0, 16);
  const cachePath = path.join(DIRS.cache, `cur-${cacheKey}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      onLog?.('Moment picks loaded from cache');
      return hydrate(cached, sentences, count, minLen, maxLen, silence);
    } catch {}
  }

  const windows = [];
  if (sentences.length <= WINDOW + OVERLAP) {
    windows.push({ from: 0, to: sentences.length - 1, want: count });
  } else {
    const n = Math.ceil((sentences.length - OVERLAP) / (WINDOW - OVERLAP));
    const per = Math.max(2, Math.ceil(count / n) + 1);
    for (let w = 0; w < n; w++) {
      const from = w * (WINDOW - OVERLAP);
      const to = Math.min(sentences.length - 1, from + WINDOW - 1);
      windows.push({ from, to, want: per });
      if (to === sentences.length - 1) break;
    }
  }

  const intro = title ? `Video: "${title}". ` : '';
  const picks = [];
  const collect = (out) => {
    (out.clips || []).forEach((c) => {
      const from = Number(c.from ?? c.i ?? c.sentence_from);
      const to = Number(c.to ?? c.j ?? c.sentence_to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return;
      picks.push({
        from, to,
        startPhrase: typeof c.start === 'string' ? c.start : '',
        endPhrase: typeof c.end === 'string' ? c.end : '',
        hook: cleanHook(c.hook || c.title || ''),
        why: String(c.why || c.reason || '').slice(0, 160),
        score: Math.max(20, 92 - picks.length * 3),
        order: picks.length,
      });
    });
  };
  for (let w = 0; w < windows.length; w++) {
    const win = windows[w];
    if (windows.length > 1) onLog?.(`Reading section ${w + 1}/${windows.length} with the model…`);
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: intro + promptFor(sentences, win.from, win.to, win.want) },
    ];
    let out = null;
    for (let attempt = 0; attempt < 2 && !out; attempt++) {
      try {
        out = await askOnce(messages, win.want);
      } catch (err) {
        if (attempt === 1) {
          onLog?.(`AI moment picking failed (${String(err.message).slice(0, 120)})`);
          return null;
        }
        await new Promise((r) => setTimeout(r, 1400));
      }
    }
    collect(out);
  }

  let chosen = settle(picks, sentences, { count, minLen, maxLen, silence });

  // the model sometimes returns fewer than asked — ask again for the gap
  for (let attempt = 0; attempt < 2 && chosen.length < count && sentences.length <= 200; attempt++) {
    const left = count - chosen.length;
    const taken = chosen.map((c) => `${c.start.toFixed(0)}-${c.end.toFixed(0)}s`).join(', ');
    const messages = [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `${intro}${promptFor(sentences, 0, sentences.length - 1, count)}\n\n`
          + `You already picked these moments: ${taken}. Do not repeat them or overlap them. `
          + `Pick ${left} MORE different clip${left > 1 ? 's' : ''} from other parts of the transcript.`,
      },
    ];
    try {
      collect(await askOnce(messages, left));
      chosen = settle(picks, sentences, { count, minLen, maxLen, silence });
    } catch {
      break;
    }
  }

  if (!chosen.length) {
    onLog?.('AI returned no usable moments — using the audio heuristic');
    return null;
  }
  const allWords = sentences.flatMap((s) => s.words);
  const fixed = await refine(chosen, sentences, allWords, { minLen, maxLen, silence, onLog });
  try {
    fs.writeFileSync(cachePath, JSON.stringify(fixed.map(({ words, ...rest }) => rest)));
  } catch {}
  onLog?.(`AI picked ${fixed.length} moments`);
  return fixed;
}

/**
 * Second pass: the transcript is often one long run-on, so a clip can open on
 * a back-reference ("I'm still very committed to that") that only makes sense
 * after the sentence before it. Show the model the words around each cut and
 * let it move the edges; then run the deterministic finish pass.
 */
async function refine(clips, sentences, allWords, { minLen, maxLen, silence, onLog }) {
  if (!clips.length || !allWords.length) return clips;
  const idxOf = (t) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < allWords.length; i++) {
      const d = Math.abs(allWords[i].start - t);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const txt = (a, b) => allWords.slice(Math.max(0, a), Math.min(allWords.length, b)).map((w) => w.word).join(' ');

  const blocks = clips.map((c, i) => {
    const si = idxOf(c.cut ?? c.start);
    const ei = idxOf(c.end);
    return [
      `CLIP ${i}`,
      `WORDS BEFORE THE CUT: ${txt(si - 40, si)}`,
      `CURRENT OPENING: ${txt(si, si + 14)}`,
      `CURRENT ENDING: ${txt(ei - 12, ei + 1)}`,
      `WORDS AFTER THE CUT: ${txt(ei + 1, ei + 14)}`,
    ].join('\n');
  }).join('\n\n');

  const SYS = `You are a senior short-form editor fixing clip cut points in a podcast transcript.

Each CLIP below shows the words just before the current cut, the opening, the ending, and the words after.

Make every clip understandable with zero context:
- OPEN on the first word of the answer, or on the QUESTION it answers when that question is in WORDS BEFORE THE CUT. A clip that opens on "that", "this", "it", "those", "they", "uske", "iska", "wahan" is broken: move the opening back to the sentence that names the thing.
- If the opening is a question and the words after it are another question or a false start (Because…, And…, So… repeating the question), do NOT keep the question — open on the answer instead (Well…, I…, We…, The…).
- NEVER open on a discourse marker: Well, So, You know, I mean, Like, Okay, Right, Yeah, Actually, Basically, Um, Uh, matlab, yaani, dekho, arre. Move forward past it.
- Move the opening EARLIER (up to 28 words) when the current opening continues an earlier thought, and only earlier when that is what makes it self-contained.
- CLOSE where the thought closes. If the ending runs into a new idea, move it earlier.
- Never change the topic of the clip. Same story, same point.
- Copy words EXACTLY from the transcript text. 5 to 10 words each.
- Changing the opening is far more likely to be needed than the ending.

Return ONLY JSON:
{"clips":[{"i":0,"start":"exact opening words","end":"exact closing words"}]}`;

  let out = null;
  if (GROQ_API_KEY && allWords.length >= 20) {
    try {
      out = await askOnce([
        { role: 'system', content: SYS },
        { role: 'user', content: blocks },
      ], clips.length);
    } catch (err) {
      onLog?.(`Cut refinement skipped (${String(err.message).slice(0, 80)})`);
    }
  }

  const byIndex = new Map();
  (out?.clips || []).forEach((r) => {
    const i = Number(r.i ?? r.index ?? r.clip);
    if (Number.isFinite(i) && i >= 0 && i < clips.length) byIndex.set(i, r);
  });

  let moved = 0;
  const fixed = clips.map((c, i) => {
    const r = byIndex.get(i);
    const origStart = Number.isFinite(c.cut) ? c.cut : c.start;
    let start = origStart;
    let end = c.end;
    if (r) {
      const startM = typeof r.start === 'string' ? findPhrase(allWords, r.start, start) : null;
      const endM = typeof r.end === 'string' ? findPhrase(allWords, r.end, end) : null;
      if (startM && startM.d <= 30) start = Math.max(0, allWords[startM.i].start - 0.05);
      if (endM && endM.d <= 24) {
        const last = allWords[Math.min(allWords.length - 1, endM.i + endM.n - 1)];
        if (last && last.end > start + 8) end = last.end + 0.25;
      }
    }
    const fin = finishCut(sentences, allWords, start, end, { minLen, maxLen, silence });
    start = fin.start;
    end = fin.end;
    const len = end - start;
    if (len < minLen - 3 || len > maxLen + 8) return c;
    if (Math.abs(start - origStart) < 0.05 && Math.abs(end - c.end) < 0.05) {
      // no edge moved: keep the original object (it already has words/text)
      return c;
    }
    moved++;
    const words = wordsIn(allWords, start, end);
    return {
      ...c,
      start: Math.max(0, start - 0.06),
      cut: start,
      end: end + 0.25,
      words,
      text: words.map((w) => w.word).join(' '),
    };
  });
  if (moved) onLog?.(`Refined ${moved} cut point${moved > 1 ? 's' : ''} for a cleaner opening`);
  return fixed;
}

function cleanHook(s) {
  return String(s || '')
    .replace(/["'`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => !/^(shocking|unbelievable|insane|100%|must watch)$/i.test(w.replace(/[^\w%]/g, '')))
    .slice(0, 6)
    .join(' ')
    .slice(0, 44)
    .replace(/[.!?…,;:\-–—]+$/g, '')
    .trim();
}

function hydrate(list, sentences, count, minLen, maxLen, silence) {
  return settle(
    (list || []).map((c, i) => ({ ...c, order: i, score: c.score ?? 70 })),
    sentences, { count, minLen, maxLen, silence },
  );
}

/** Words that show a sentence is continuing an earlier thought. */
const BACKREF = /^(aur|par|lekin|magar|phir|fir|toh|to|ki|ke|ka|ko|un|us|in|is|ye|yeh|wo|woh|vah|vo|isliye|islie|matlab|yaani|yani|ab|so|and|but|that|this|it|they|those|these|because|also|plus|kyunki|kyonki|jiske|jiski|jiska|uske|uski|uska|iske|iski|iska|inke|inki|inka|unke|unki|unka|inme|unme|isme|usme|jaha|waha|or|ya|jo|ek)$/i;

/** "…investigate kara to…" = the sentence only makes sense with the one before it. */
const DEPENDENT = /^(kar|kara|karke|karkar|hokar|hoke|hone|karte|karte|karke|pehle|baad)$/i;

/** A demonstrative that points backwards, not a determiner ("that vaccine"). */
const DEMONSTR = /^(that|this|it|these|those|they|them|uske|uska|uski|unke|unki|unka|iske|iska|iski|inke|inka)$/i;
const PRONOUN_NEXT = /^(is|was|are|were|has|have|had|will|would|can|could|does|did|takes|taking|means|matters|helps|helped|changed|worked|keeps|goes|stays|needs|needed|and|but|so|because)$/i;

/** Walk back until the clip opens on something self-contained. */
function coldStart(sentences, a) {
  let i = a;
  for (let step = 0; step < 2 && i > 0; step++) {
    const text = String(sentences[i].text || '').trim();
    const words = text.split(/\s+/).filter(Boolean);
    const first = (words[0] || '').toLowerCase().replace(/[^\p{L}]/gu, '');
    const short = words.length <= 4;
    const dependent = words.slice(1, 6).some((w) => DEPENDENT.test(w.replace(/[^\p{L}]/gu, '')));
    // "I'm still very committed to that" only makes sense after the sentence
    // that names the thing "that" points at.
    const question = /\?\s*$/.test(text);
    const backref = !question && words.slice(0, 8).some((w, k) => {
      const t = w.replace(/[^\p{L}]/gu, '');
      if (!DEMONSTR.test(t)) return false;
      const next = (words[k + 1] || '').replace(/[^\p{L}]/gu, '');
      return !next || PRONOUN_NEXT.test(next);
    });
    if (!(short || dependent || backref || (first && BACKREF.test(first)))) break;
    i--;
  }
  return i;
}

/** Validate, snap, dedupe and rank model picks, keeping coverage of the source. */
function settle(picks, sentences, { count, minLen, maxLen, silence }) {
  const allWords = sentences.flatMap((s) => s.words);
  const cands = [];
  for (const p of picks) {
    const fit = fitSentenceRange(sentences, coldStart(sentences, p.from), p.to, { minLen, maxLen });
    if (!fit) continue;
    const sentStart = sentences[fit.a].start;
    const sentEnd = sentences[fit.b].end;
    let start = sentStart;
    let end = sentEnd;

    // the model quotes the exact words it wants to cut on — snap to their timestamps
    if (p.startPhrase) {
      const m = findPhrase(allWords, p.startPhrase, sentStart);
      if (m && m.d <= 20) start = Math.max(0, allWords[m.i].start - 0.05);
    }
    if (p.endPhrase) {
      const m = findPhrase(allWords, p.endPhrase, sentEnd);
      if (m && m.d <= 20) {
        const last = allWords[Math.min(allWords.length - 1, m.i + m.n - 1)];
        if (last && last.end > start + 5) end = last.end + 0.25;
      }
    }
    // keep the sentence-aligned version whenever a snap breaks the length window
    if (end - start < minLen - 4 || end - start > maxLen + 4) {
      start = sentStart;
      end = sentEnd;
    }
    // question context, pause edges, then a filler-free opening
    const fin = finishCut(sentences, allWords, start, end, { minLen, maxLen, silence });
    start = fin.start;
    end = fin.end;
    const len = end - start;
    if (len < 8 || len > maxLen + 8) continue;
    const words = wordsIn(allWords, start, end);
    cands.push({
      start: Math.max(0, start - 0.06),
      cut: start,
      end: end + 0.3,
      score: Number.isFinite(p.score) ? p.score : 70,
      hook: p.hook,
      reason: p.why ? `AI: ${p.why}` : 'AI pick',
      text: words.map((w) => w.word).join(' '),
      words,
      from: fit.a,
      to: fit.b,
      startPhrase: p.startPhrase,
      endPhrase: p.endPhrase,
      source: 'ai',
    });
  }
  if (!cands.length) return [];

  // dedupe: same story picked by two overlapping windows → keep the better one
  cands.sort((a, b) => b.score - a.score);
  const uniq = [];
  for (const c of cands) {
    const dup = uniq.some((o) => {
      const ov = Math.min(o.end, c.end) - Math.max(o.start, c.start);
      return ov > 0.35 * Math.min(o.end - o.start, c.end - c.start);
    });
    if (!dup) uniq.push(c);
  }

  const dur = Math.max(1, sentences[sentences.length - 1].end);
  const chosen = [];
  const fits = (c) => !chosen.some((o) => {
    const ov = Math.min(o.end, c.end) - Math.max(o.start, c.start);
    return ov > 0.25 * Math.min(o.end - o.start, c.end - c.start);
  });

  // one pick per slice of the video, best first inside each slice
  for (let i = 0; i < count; i++) {
    const lo = (dur * i) / count;
    const hi = (dur * (i + 1)) / count;
    let best = null;
    for (const c of uniq) {
      if (!fits(c) || chosen.includes(c)) continue;
      if (Math.min(c.end, hi) - Math.max(c.start, lo) <= 0) continue;
      if (!best || c.score > best.score) best = c;
    }
    if (best) chosen.push(best);
  }
  for (const c of uniq) {
    if (chosen.length >= count) break;
    if (fits(c)) chosen.push(c);
  }
  return chosen.sort((a, b) => a.start - b.start);
}
