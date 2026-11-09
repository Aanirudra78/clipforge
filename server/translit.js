import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GROQ_API_KEY, DIRS } from './config.js';

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
const BATCH = 120;

const SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u0900-\u097F\uFB50-\uFDFF\uFE70-\uFEFF]/;

const CONS = {
  क: 'k', ख: 'kh', ग: 'g', घ: 'gh', ङ: 'n', च: 'ch', छ: 'chh', ज: 'j', झ: 'jh', ञ: 'n',
  ट: 't', ठ: 'th', ड: 'd', ढ: 'dh', ण: 'n', त: 't', थ: 'th', द: 'd', ध: 'dh', न: 'n',
  प: 'p', फ: 'ph', ब: 'b', भ: 'bh', म: 'm', य: 'y', र: 'r', ल: 'l', व: 'v', श: 'sh',
  ष: 'sh', स: 's', ह: 'h', ळ: 'l', क़: 'q', ख़: 'kh', ग़: 'g', ज़: 'z', ड़: 'r', ढ़: 'rh', फ़: 'f', य़: 'y',
};
const VOW = {
  अ: 'a', आ: 'aa', इ: 'i', ई: 'ee', उ: 'u', ऊ: 'oo', ऋ: 'ri', ए: 'e', ऐ: 'ai', ओ: 'o', औ: 'au', ऑ: 'o', ऍ: 'e',
};
const MATRA = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'े': 'e', 'ै': 'ai',
  'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e', 'ॆ': 'e', 'ॊ': 'o',
};
const SIGN = { 'ं': 'n', 'ँ': 'n', 'ः': 'h', 'ऽ': '', 'ॐ': 'om', '।': '.', '॥': '.' };
const DIGITS = '०१२३४५६७८९';

// Urdu/Arabic script, as Whisper sometimes mixes it into Hindi output
const URDU = {
  'ا': 'a', 'آ': 'aa', 'أ': 'a', 'إ': 'i', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ٹ': 't', 'ث': 's',
  'ج': 'j', 'چ': 'ch', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ڈ': 'd', 'ذ': 'z', 'ر': 'r', 'ڑ': 'r',
  'ز': 'z', 'ژ': 'zh', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'z', 'ط': 't', 'ظ': 'z', 'ع': '',
  'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ک': 'k', 'گ': 'g', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ں': 'n',
  'و': 'o', 'ؤ': 'o', 'ہ': 'h', 'ھ': 'h', 'ۃ': 'h', 'ہ': 'h', 'ی': 'y', 'ئ': 'y', 'ے': 'e',
  'ۓ': 'e', 'ء': '', 'ة': 'h', 'ﻻ': 'la',
};

// common English words that arrive spelled phonetically in Devanagari
const LOAN = {
  सीन: 'scene', इन्वेस्टिगेट: 'investigate', इन्वेस्टिगेशन: 'investigation',
  डॉक्टर: 'doctor', डॉक्टर्स: 'doctors', डाक्टर: 'doctor', डाक्टर्स: 'doctors',
  ब्लड: 'blood', आर्गन: 'organ', आर्गन्स: 'organs', फार्म: 'farm', फार्म्स: 'farms',
  कैमरा: 'camera', वीडियो: 'video', सिस्टम: 'system', क्राइम: 'crime',
  बुल: 'bull', बुल्स: 'bulls', एविडेंस: 'evidence', लेजर: 'laser', प्रोसेस: 'process',
  पुलिस: 'police', रिपोर्ट: 'report', कंपनी: 'company', इंटरनेट: 'internet',
  मोबाइल: 'mobile', फोन: 'phone', कंप्यूटर: 'computer', प्रॉब्लम: 'problem',
  क्वेश्चन: 'question', आंसर: 'answer', क्लिप: 'clip', चैनल: 'channel',
  सब्सक्राइब: 'subscribe', मेडिकल: 'medical', केमिकल: 'chemical', केमिकल्स: 'chemicals',
  मेडिसिन: 'medicine', मेडिसिन्स: 'medicines', कॉस्मेटिक्स: 'cosmetics',
  ह्यूमन: 'human', ह्यूमन्स: 'humans', एनिमल: 'animal', एनिमल्स: 'animals',
};

/** Deterministic Devanagari/Urdu → Roman fallback (always works, no network). */
export function toRoman(s) {
  const src = String(s || '');
  const loan = LOAN[src.replace(/[,.;:!?]+$/, '')];
  if (loan) return loan;
  let out = '';
  let pending = false; // consonant whose inherent "a" is not written yet
  for (const ch of src) {
    if (CONS[ch]) {
      if (pending) out += 'a';
      out += CONS[ch];
      pending = true;
      continue;
    }
    if (ch === '्') {
      pending = false;
      continue;
    }
    if (MATRA[ch]) {
      if (pending) { out += MATRA[ch]; pending = false; }
      else out += MATRA[ch];
      continue;
    }
    if (VOW[ch]) {
      if (pending) { out += 'a'; pending = false; }
      out += VOW[ch];
      continue;
    }
    if (SIGN[ch] != null) {
      if (pending) { out += 'a'; pending = false; }
      out += SIGN[ch];
      continue;
    }
    if (DIGITS.includes(ch)) {
      if (pending) { out += 'a'; pending = false; }
      out += String(DIGITS.indexOf(ch));
      continue;
    }
    if (URDU[ch] != null) {
      if (pending) { out += 'a'; pending = false; }
      out += URDU[ch];
      continue;
    }
    if (SCRIPT.test(ch)) continue; // unknown mark / diacritic
    if (pending) { out += 'a'; pending = false; }
    out += ch;
  }
  if (pending) out += 'a';
  return out.replace(/\s+/g, ' ').trim();
}

function needsRoman(w) {
  return SCRIPT.test(String(w || ''));
}

/**
 * Rewrite Devanagari transcript words as Hinglish (Roman script), keeping the
 * original timings. The LLM picks natural spellings; the deterministic map is
 * the safety net.
 */
export async function transliterate(words = [], { onLog } = {}) {
  const targets = words.filter((w) => needsRoman(w.word));
  if (!targets.length) return { words, source: 'none' };

  const unique = [...new Set(targets.map((w) => String(w.word).trim()))].filter(Boolean);
  const key = crypto.createHash('sha1').update('v3|' + unique.slice().sort().join('|')).digest('hex').slice(0, 16);
  const cachePath = path.join(DIRS.cache, `ro-${key}.json`);

  let map = null;
  let source = 'map';
  if (fs.existsSync(cachePath)) {
    try {
      map = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      source = 'cache';
    } catch {}
  }
  if (!map) {
    map = await askWords(unique, onLog);
    if (map) source = 'ai';
  }
  if (!map) {
    map = {};
    for (const u of unique) map[u] = toRoman(u);
  }
  // always fill gaps with the deterministic map
  for (const u of unique) if (!map[u] || SCRIPT.test(map[u])) map[u] = toRoman(u);

  if (source === 'ai') {
    try {
      fs.writeFileSync(cachePath, JSON.stringify(map));
    } catch {}
  }
  onLog?.(`Transcript Romanised (${source === 'map' ? 'local map' : 'AI spelling'})`);
  return {
    words: words.map((w) => (needsRoman(w.word) ? { ...w, word: map[String(w.word).trim()] || toRoman(w.word) } : w)),
    source,
  };
}

const PROMPT = `You convert Hinglish (Hindi/Urdu speech written in Devanagari or Arabic script) into the Roman script that Indian creators use in Instagram captions.

Rules:
1. Output is ALWAYS Latin letters only, no diacritics, no original script.
2. Hindi/Urdu words keep their sound: पैसा=paisa, नहीं=nahin, क्योंकि=kyonki, سوال=sawal.
3. English words that were written phonetically in Devanagari/Urdu must be RESTORED to real English spelling: सीन/سین=scene, इन्वेस्टिगेट/انویسٹیئٹ=investigate, डॉक्टर/ڈاکٹر=doctor, ब्लड/بلڈ=blood, आर्गन/آرگن=organ, फार्म/فارم=farm, कैमरा/کیمرہ=camera, वीडियो/ویڈیو=video, सिस्टम/سسٹم=system, क्राइम/کرائم=crime, बुल/بل=bull, बुल्स/بلز=bulls, एविडेंस=evidence, लेजर=laser, प्रोसेस=process, ग्रुप=group, पॉइंट=point, कंट्री=country.
4. Keep English words that are already in Latin script unchanged.
5. One output per input, same order. Never translate meaning.

Return only JSON: {"words":["..."]}`;

async function askWords(unique, onLog) {
  if (!GROQ_API_KEY) return null;
  const out = {};
  let lastErr = '';
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    let done = false;
    for (const model of MODELS) {
      try {
        const res = await fetch(CHAT_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 3200,
            reasoning_effort: 'low',
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: PROMPT,
              },
              {
                role: 'user',
                content: JSON.stringify(batch),
              },
            ],
          }),
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) {
          lastErr = `${model} HTTP ${res.status} ${(await res.text()).slice(0, 120)}`;
          continue;
        }
        const j = await res.json();
        const raw = j?.choices?.[0]?.message?.content || '';
        const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
        const list = obj.words || obj.roman || obj.output;
        if (!Array.isArray(list) || list.length !== batch.length) {
          lastErr = `${model} returned ${Array.isArray(list) ? list.length : 'no'} entries for ${batch.length} words`;
          continue;
        }
        batch.forEach((w, k) => {
          const roman = String(list[k] || '').trim();
          if (roman && !SCRIPT.test(roman)) out[w] = roman;
        });
        done = true;
        break;
      } catch (err) {
        lastErr = String(err.message || err);
      }
    }
    if (!done) {
      onLog?.(`Roman spelling model unavailable (${lastErr.slice(0, 90)}) — using the local map`);
      return null;
    }
  }
  return Object.keys(out).length ? out : null;
}
