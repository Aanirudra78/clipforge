/**
 * Topic mining for b-roll.
 *
 * The rule that keeps b-roll engaging is relevance: only show footage for
 * things that were actually SAID, at the moment they are said. Two engines
 * cooperate:
 *
 * 1. LLM (Groq): reads the clip's words and returns windows where a concrete
 *    visualisable topic is discussed, each with an English stock-search query.
 * 2. Deterministic fallback: frequency-scored non-stopword tokens plus a
 *    number/money detector, so an offline run still gets something sensible.
 *
 * Times are CLIP RELATIVE seconds (0 = clip start). render.js maps them
 * through the jump-cut timeline.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GROQ_API_KEY, DIRS } from '../config.js';
import { cleanQuery } from './nouns.js';

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];

/** Hinglish + English stopwords that make bad search queries. */
const STOP = new Set(('the a an and or but if then so like you know i me my we our it is are was were be been am do does did done have has had '
  + 'of in on at to from for with by about into over after before while during out up down off again more most some any every each other another same '
  + 'not no nor just only own too very can cannot cant will would should could shall may might must dare need lets let us get got getting go goes going gone '
  + 'yeah yep yup okay ok oh oho hmm hmmm right wrong true truth because since until till when where what why how which who whom whose that this these those '
  + 'they them their theirs he him his she her hers it its as also even still yet lot lots much many little few '
  + 'matlab yaani yani toh to na nahi nai hai hai hain ho hota hoti hote hua hui hue tha thi the ka ki ke ko kya kyu kyun kab kahan kis kisi kisko '
  + 'jo jab agar lekin par magar phir fir abhi ab aaj kal rozz roz bas sirf bilkul zaroor zaruri dekho suno sun arre arey bhai bhaiya yaar bandi '
  + 'bata batao bataya kahani samajh samjha samjho chalo mera meri mere ham hum humara tum tumhara apna apni aap'
).split(/\s+/));

/**
 * Words that carry concrete imagery even in Hinglish. Used by the fallback to
 * lift the signal when the clip is short on English nouns.
 */
const VISUAL = new Set([
  'gita', 'quran', 'bible', 'quran', 'vaccine', 'polio', 'malaria', 'hospital', 'doctor',
  'money', 'crore', 'lakh', 'million', 'billion', 'trillion', 'percent', 'loan', 'debt',
  'election', 'parliament', 'court', 'judge', 'police', 'army', 'soldier', 'war', 'border',
  'india', 'bharat', 'delhi', 'mumbai', 'bombay', 'america', 'china', 'russia', 'pakistan',
  'microsoft', 'google', 'apple', 'openai', 'youtube', 'instagram', 'internet', 'phone',
  'farmer', 'factory', 'school', 'college', 'student', 'teacher', 'exam', 'job', 'salary',
  'rocket', 'moon', 'mars', 'isro', 'nasa', 'space', 'satellite', 'computer', 'robot',
  'cricket', 'match', 'team', 'gold', 'silver', 'oil', 'water', 'river', 'mountain', 'forest',
  'temple', 'mosque', 'church', 'city', 'village', 'traffic', 'train', 'road', 'flight',
]);

/**
 * The planner works on PRE-CUT slots instead of asking the model to invent
 * timestamps: four model runs gave four different windows, which made the count
 * random. Slots are deterministic (evenly spread, every 2.4s window sits inside
 * the clip's speech), so the render always gets its 3-4 inserts; the model only
 * answers "what should we see here?".
 */
const SLOT_PROMPT = `You choose the b-roll visual for fixed slots of a short-form podcast clip. Each slot is a 2-3s stretch of speech; the viewer must SEE what the speaker means in that stretch.

Input JSON: {"clip":{"hook":"clip hook","start":<clip start in source>},"slots":[{"i":0,"t0":<source second>,"t1":<source second>,"words":"what is said around this slot"}],"words":[["word",start,end],...] with SOURCE-absolute seconds.

Return one row for EVERY slot:
{"i":<slot i>,"topic":["<2-3 word English stock-footage search>","<a DIFFERENT shot for the same moment>"],"label":"<<=4 word Hinglish/Roman phrase for a text card>"}
Hard rules:
1. topic must name something a camera can film: "petrol pump", "police van", "wheat field", "stock chart", "server room", "smartphone".
2. NEVER abstract or mood words: "success", "next time", "thread looks", "vibes", "growth", "idea", "life", "change". Never guess a noun from a garbled or unclear word.
3. If the slot has no exact object, use the clip's overall theme noun ("smartphone" for an app rant, "wheat field" for a farming story).
4. If even the theme does not fit, return "topic": [] and still give a label with the spoken phrase; the render draws a text card for that slot.
5. label is Hinglish in Roman script, at most 4 words, and must not copy the caption verbatim.
6. Give TWO different queries per slot (primary, then a different shot of the same idea). No two slots may reuse the same primary query; when several slots share one theme, vary the SHOT: "smartphone", "phone screen", "hand holding phone", "phone cover". A repeated visual looks lazy.
Return only JSON: {"rows":[...]}`;

const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

/**
 * Queries a stock library cannot answer: they return unrelated footage, which
 * is worse than a clean text card. A lone "next" or "dark" is never a topic;
 * "dark web" is, so the rule is strict for single words and lenient for phrases.
 */
const WEAK_WORD = new Set([
  'next', 'time', 'times', 'look', 'looks', 'looked', 'dark', 'light', 'make', 'made', 'take',
  'takes', 'want', 'wants', 'need', 'needs', 'talk', 'talks', 'said', 'says', 'goes', 'going',
  'come', 'comes', 'know', 'knows', 'think', 'thing', 'things', 'stuff', 'people', 'person',
  'guys', 'girls', 'boys', 'good', 'best', 'better', 'worst', 'great', 'big', 'small', 'more',
  'most', 'much', 'many', 'very', 'really', 'actually', 'literally', 'basically', 'first',
  'last', 'same', 'other', 'life', 'love', 'success', 'growth', 'idea', 'ideas', 'mindset',
  'energy', 'respect', 'journey', 'story', 'truth', 'value', 'future', 'past', 'change',
  'power', 'freedom', 'happiness', 'motivation', 'vibe', 'vibes', 'feeling', 'emotion',
]);
const isWeakQuery = (q) => {
  const n = String(q || '').trim().toLowerCase();
  if (n.length < 4) return true;
  if (!n.includes(' ')) return WEAK_WORD.has(n);
  // a phrase is only rejected when it is pure mood, not a filmable subject
  return /^(vibes?|feelings?|energy|mindset|motivation|happiness|freedom)$/i.test(n);
};

/** Clip-relative windows the render can map through the cut timeline. */
function sanitizeRows(rows, { start, end, max = 4 }) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const t0 = clampN(r?.t0, start, end);
    // The render only shows inserts of 1.3s+; a 0.9s sliver reads as a glitch,
    // so pad the window instead of dropping an otherwise good topic.
    const t1 = Math.min(end, Math.max(clampN(r?.t1, t0 + 0.5, end), t0 + 1.3));
    if (t1 - t0 < 1.2) continue;
    // A query is only usable when a filmable noun survives cleaning: garbage
    // words must never reach a stock search, they return unrelated footage.
    const topic = [...new Set((Array.isArray(r?.topic) ? r.topic : [r?.topic])
      .map((q) => cleanQuery(q))
      .filter((q) => q && !isWeakQuery(q)))].slice(0, 3);
    const label = String(r?.label || '').split(/\s+/).slice(0, 4).join(' ').trim();
    if (!topic.length) continue;
    out.push({ t0, t1, topic, label, where: r?.where || 'llm' });
  }
  // keep the strongest, non-overlapping, time-ordered windows with breathing
  // room between them (a 0.5s sliver of the speaker is worse than no insert)
  out.sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0));
  const kept = [];
  for (const row of out) {
    if (kept.every((k) => row.t1 + 2 <= k.t0 || row.t0 >= k.t1 + 2)) kept.push(row);
    if (kept.length >= max) break;
  }
  return kept.sort((a, b) => a.t0 - b.t0);
}

/** Frequency + imagery-scored fallback news search. */
function fallbackTopics(words = [], start, end, max = 4) {
  const usable = (words || []).filter((w) => w.start >= start - 0.01 && w.end <= end + 0.01);
  if (!usable.length) return [];
  const chunkW = 5;
  const rows = [];
  for (let t = start; t < end - 2; t += chunkW) {
    const hi = Math.min(end, t + chunkW);
    const span = usable.filter((w) => w.start >= t - 0.01 && w.start < hi);
    if (!span.length) continue;
    const freq = new Map();
    for (const w of span) {
      const tok = String(w.word || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (tok.length < 4 || STOP.has(tok)) continue;
      const score = 1 + (VISUAL.has(tok) ? 2 : 0) + (/\d/.test(tok) ? 1.5 : 0) + Math.min(2, tok.length / 10);
      freq.set(tok, (freq.get(tok) || 0) + score);
    }
    // cleanQuery() is the junk gate downstream, so take the best nouns here and
    // let it drop anything that is not a filmable thing. ASR noise still scores
    // low because it is rarely in the visual vocabulary or repeated.
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map((e) => e[0]);
    if (!top.length) continue;
    const first = span[0], last = span[span.length - 1];
    rows.push({
      t0: Math.max(start, first.start), t1: Math.min(end, last.end),
      topic: top.slice(0, 2), label: top.map((s) => s[0].toUpperCase() + s.slice(1)).join(' '),
      where: 'words',
    });
  }
  return sanitizeRows(rows, { start, end, max });
}

const cachePath = (key) => path.join(DIRS.cache, `broll-topics-${key}.json`);

/**
 * Deterministic, evenly spaced windows inside the clip's speech. The render
 * trims them to its own 1.3–3.4s / 2s-gap / 42% rules, so one slot may be
 * skipped where a jump cut lands; asking for `max + 1` slots keeps the visual
 * count stable.
 */
function slotWindows(usable, start, end, max) {
  const lo = start + 1.2;
  const hi = end - 0.8;
  if (hi - lo < 2.6 || !usable.length) return [];
  const budget = Math.max(2, Math.min(4, Math.floor((end - start) / 8)));
  const count = Math.min(max, budget) + 1;
  const out = [];
  for (let i = 0; i < count; i++) {
    const target = lo + ((hi - lo) * (i + 0.5)) / count;
    const w = usable.find((x) => x.start >= target - 0.01) || usable[usable.length - 1];
    const t0 = clampN(w.start, lo, Math.max(lo, hi - 2.4));
    const t1 = Math.min(hi, t0 + 2.4);
    if (t1 - t0 < 1.3) continue;
    if (out.length && t0 < out[out.length - 1].t1 + 1.5) continue;
    const words = usable.filter((x) => x.start >= t0 - 0.6 && x.start < t1 + 0.6).map((x) => x.word).join(' ');
    out.push({ i: out.length, t0, t1, words });
  }
  return out;
}

/** Spoken phrase for a text card: up to 4 content-ish words, never empty. */
/** Filler sounds: a card that just says "uh uh" is worse than no insert. */
const FILLER = new Set('uh uhh uhm um umm erm er ah ahh eh oh ooh mm mmm hmm hmmm hm mhm euh'.split(' '));

function cardLabel(slot) {
  const words = String(slot.words || '').split(/\s+/).filter(Boolean);
  const clean = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '');
  const meat = words.filter((w) => {
    const c = clean(w);
    return c && !STOP.has(c) && !FILLER.has(c);
  });
  // Stop words and filler alone do not make a caption; skip the slot instead.
  if (!meat.length) return '';
  return meat.slice(0, 4).join(' ');
}

/** One slot → one render row (asset query, or a text card when nothing fits). */
function slotRow(slot, answers = []) {
  const hit = answers.find((a) => Number(a?.i) === slot.i)
    || answers.find((a) => Math.abs(Number(a?.t0) - slot.t0) < 0.6);
  const topic = [...new Set((Array.isArray(hit?.topic) ? hit.topic : [hit?.topic])
    .map((q) => cleanQuery(q)).filter((q) => q && !isWeakQuery(q)))].slice(0, 3);
  const label = String(hit?.label || '').split(/\s+/).slice(0, 4).join(' ').trim();
  const spoken = cardLabel(slot);
  // A text card shows what was actually said; the model's label is a caption
  // idea and often drifts into mood words ("badlaav ka vibe").
  return { t0: slot.t0, t1: slot.t1, topic, label: topic.length ? label || spoken : spoken, where: hit ? 'llm' : 'slot' };
}

/** Two inserts of the same shot read as a mistake: vary it, then give up. */
const SHOT_VARIANTS = ['closeup', 'aerial', 'night', 'street'];
function varyShots(plan) {
  const used = new Set();
  let extra = 0;
  return plan.map((row) => {
    if (!row.topic.length) return row;
    const pick = row.topic.find((t) => !used.has(t))
      || (extra < SHOT_VARIANTS.length ? `${row.topic[0]} ${SHOT_VARIANTS[extra++]}` : '');
    if (!pick) return { ...row, topic: [] }; // no more variations: a spoken card is better
    used.add(pick);
    return { ...row, topic: [pick, ...row.topic.filter((t) => t !== pick)] };
  });
}

/**
 * Topic windows for one clip. Never throws: without a model every slot still
 * becomes a text card, so the format keeps its cutaways.
 */
export async function mineTopics({ words = [], start, end, hook = '', max = 4, onLog } = {}) {
  let usable = [];
  try {
    usable = (words || []).filter((w) => w.start >= start - 0.01 && w.end <= end + 0.01);
    const text = usable.map((w) => w.word).join(' ');
    if (!text.trim()) return [];
    const key = crypto.createHash('sha1').update(`v17|${start}|${end}|${hook}|${text}`).digest('hex').slice(0, 16);
    const file = cachePath(key);
    if (fs.existsSync(file)) {
      try {
        const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(cached) && cached.length) return cached;
      } catch {}
    }
    const slots = slotWindows(usable, start, end, max);
    if (!slots.length) return [];
    let answers = [];
    if (GROQ_API_KEY) {
      const payload = JSON.stringify({
        clip: { hook, start, end },
        slots: slots.map((s) => ({ i: s.i, t0: Number(s.t0.toFixed(2)), t1: Number(s.t1.toFixed(2)), words: s.words.slice(0, 200) })),
        words: usable.map((w) => [w.word, w.start, w.end]),
      });
      answers = (await askLlm(payload, { onLog, system: SLOT_PROMPT })) || [];
      onLog?.(`b-roll slots: ${slots.length} asked, ${answers.length} answered`);
    }
    // A slot the model left blank can still hold a spoken noun: the word pass
    // answers it before the text card does.
    let plan = slots.map((s) => {
      const row = slotRow(s, answers);
      if (row.topic.length) return row;
      const guess = fallbackTopics(usable, s.t0, s.t1, 1)[0];
      if (guess?.topic?.length) return { ...row, topic: guess.topic, where: 'words' };
      return row;
    });
    // Filler windows ("uh uh") have no label left after cardLabel: drop them
    // rather than draw a card that says nothing.
    plan = plan.filter((r) => r.t1 > r.t0 && (r.topic.length || r.label)).sort((a, b) => a.t0 - b.t0);
    plan = varyShots(plan);
    try { fs.writeFileSync(file, JSON.stringify(plan)); } catch {}
    return plan;
  } catch (err) {
    onLog?.(`b-roll topics: ${String(err.message || err).slice(0, 120)}`);
  }
  return fallbackTopics(usable, start, end, max);
}

async function askLlm(payload, { onLog, system = SLOT_PROMPT } = {}) {
  for (const model of MODELS) {
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, temperature: 0.2, max_tokens: 1400, reasoning_effort: 'low',
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: payload },
          ],
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) continue;
      const j = await res.json();
      const raw = j?.choices?.[0]?.message?.content || '';
      const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
      if (Array.isArray(obj.rows)) return obj.rows;
    } catch (err) {
      onLog?.(`b-roll topic model ${model}: ${String(err.message || err).slice(0, 80)}`);
    }
  }
  onLog?.('b-roll topic model unavailable — word-frequency fallback');
  return null;
}
