import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ff, probe } from './media.js';
import { DIRS, GROQ_API_KEY } from './config.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_CHUNK_BYTES = 23 * 1024 * 1024;

export async function extractAudio(file, outBase) {
  const out = `${outBase}.mp3`;
  await ff(['-y', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', out]);
  return out;
}

function distribuyeWords(segments) {
  const out = [];
  for (const seg of segments) {
    const text = (seg.text || '').trim();
    if (!text) continue;
    const parts = text.split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const s = Number(seg.start ?? 0), e = Number(seg.end ?? s + 1);
    const per = (e - s) / parts.length;
    parts.forEach((w, i) => out.push({ word: w, start: +(s + i * per).toFixed(3), end: +(s + (i + 1) * per).toFixed(3) }));
  }
  return out;
}

async function postGroq(filePath) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(filePath));
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('temperature', '0');

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Groq ${res.status}: ${txt.slice(0, 500)}`);
  }
  return res.json();
}

export async function transcribe(file, { onProgress, onLog } = {}) {
  const cacheKey = crypto.createHash('sha1').update(`${file}:${fs.statSync(file).size}`).digest('hex').slice(0, 16);
  const cachePath = path.join(DIRS.cache, `tr-${cacheKey}.json`);
  if (fs.existsSync(cachePath)) {
    try { return { ...JSON.parse(fs.readFileSync(cachePath, 'utf8')), cached: true }; } catch {}
  }
  if (!GROQ_API_KEY) {
    onLog?.('No GROQ_API_KEY set — skipping transcript, using audio-silence detection only.');
    return { words: [], text: '', language: null, source: 'none' };
  }

  const audio = await extractAudio(file, path.join(DIRS.cache, `audio-${cacheKey}`));
  onProgress?.(0.12);
  const st = fs.statSync(audio);
  const info = await probe(audio).catch(() => ({ duration: 0 }));

  let chunks = [audio];
  if (st.size > MAX_CHUNK_BYTES) {
    const totalDur = info.duration || 3600;
    const chunksCount = Math.ceil(st.size / MAX_CHUNK_BYTES);
    const segLen = Math.ceil(totalDur / chunksCount) + 1;
    const pattern = path.join(DIRS.cache, `chunk-${cacheKey}-%03d.mp3`);
    await ff(['-y', '-v', 'error', '-i', audio, '-f', 'segment', '-segment_time', String(segLen), '-c', 'copy', pattern]);
    chunks = fs.readdirSync(DIRS.cache).filter((f) => f.startsWith(`chunk-${cacheKey}-`)).sort()
      .map((f) => path.join(DIRS.cache, f));
  }

  const words = [];
  let text = '';
  let language = null;
  for (let i = 0; i < chunks.length; i++) {
    onLog?.(`Transcribing part ${i + 1}/${chunks.length}…`);
    const j = await postGroq(chunks[i]);
    language = language || j.language || null;
    const w = Array.isArray(j.words) && j.words.length
      ? j.words.map((x) => ({ word: x.word, start: x.start, end: x.end }))
      : distribuyeWords(j.segments || []);
    const offset = chunks.length === 1 ? 0 : i * (info.duration ? info.duration / chunks.length : 0);
    for (const x of w) words.push({ word: x.word, start: +(x.start + offset).toFixed(3), end: +(x.end + offset).toFixed(3) });
    text += (j.text || '') + ' ';
    onProgress?.(0.12 + 0.6 * ((i + 1) / chunks.length));
  }

  const result = { words, text: text.trim(), language, source: 'groq', at: Date.now() };
  fs.writeFileSync(cachePath, JSON.stringify(result));
  for (const c of chunks) if (c !== audio) { try { fs.unlinkSync(c); } catch {} }
  try { fs.unlinkSync(audio); } catch {}
  onProgress?.(1);
  return result;
}
