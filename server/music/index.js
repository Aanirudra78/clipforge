import fs from 'node:fs';
import path from 'node:path';
import { DATA } from '../config.js';

/**
 * Background music.
 *
 * The tracks are OpenFilm's CC0 library (MIT code, CC0 audio): the repo ships
 * `library/audio.json` with a catalog but not the audio itself, so tracks are
 * fetched once from https://openfilm.dev/library/<id> and cached under
 * `data/music/`. A clip then renders offline like everything else.
 *
 * The picker is deterministic per clip: same project + look + clip id always
 * resolves to the same track, so re-renders do not silently change the song.
 */

const MUSIC_DIR = path.join(DATA, 'music');
const UPLOAD_DIR = path.join(MUSIC_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const CATALOG = JSON.parse(
  fs.readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'),
); // { source, license, tracks: [...] }
const TRACKS = CATALOG.tracks;
const BY_ID = new Map(TRACKS.map((t) => [t.id, t]));

/** Moods a look can ask for, mapped to the catalog groups that fit them. */
const MOOD_GROUPS = {
  cinematic: ['cinematic', 'emotional'],
  dark: ['tense', 'cinematic'],
  tense: ['tense'],
  warm: ['warm', 'emotional'],
  hype: ['upbeat', 'electronic'],
  energetic: ['upbeat', 'electronic'],
  nostalgic: ['lofi', 'warm'],
  calm: ['calm'],
  luxury: ['corporate', 'calm'],
  electronic: ['electronic'],
  filmi: ['emotional', 'warm'],
  desi: ['emotional', 'festive'],
  gaming: ['electronic', 'upbeat'],
  playful: ['playful'],
};

export function musicCatalog() {
  return {
    source: CATALOG.source,
    license: CATALOG.license,
    moods: Object.keys(MOOD_GROUPS),
    tracks: TRACKS.map((t) => ({
      id: t.id, name: t.name, group: t.group, energy: t.energy, bpm: t.bpm, durationMs: t.durationMs,
    })),
    uploads: listUploads(),
  };
}

export function listUploads() {
  try {
    return fs.readdirSync(UPLOAD_DIR)
      .filter((f) => /\.(mp3|m4a|wav|aac|ogg|opus|flac)$/i.test(f))
      .map((f) => ({ id: `upload:${f}`, name: f.replace(/\.[^.]+$/, ''), file: f }));
  } catch { return []; }
}

export function uploadPath(name) {
  const base = path.basename(String(name || ''));
  return base ? path.join(UPLOAD_DIR, base) : null;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function groupsFor(mood) {
  return MOOD_GROUPS[mood] || MOOD_GROUPS.warm;
}

/**
 * Choose a track for a mood/energy pair. `seed` (project + clip) varies the
 * pick between clips without making it random across re-renders.
 */
export function pickTrack({ mood = 'warm', energy = [2, 3], seed = '' } = {}) {
  const groups = groupsFor(mood);
  const band = Array.isArray(energy) ? energy : [Number(energy) || 2, Number(energy) || 3];
  const lo = Math.min(...band), hi = Math.max(...band);
  const scored = TRACKS.map((t) => {
    const gi = groups.indexOf(t.group);
    const groupPenalty = gi < 0 ? 6 : gi * 0.4;
    const energyPenalty = t.energy < lo ? lo - t.energy : t.energy > hi ? t.energy - hi : 0;
    const jitter = hash(`${seed}:${t.id}`);
    return { t, score: groupPenalty + energyPenalty * 1.6 + jitter * 0.9 };
  }).sort((a, b) => a.score - b.score);
  if (!scored.length) return null;
  // Top handful are interchangeable; the hash decides within them so two
  // clips of the same mood do not both get the "best" track.
  const shortlist = scored.slice(0, 4);
  return shortlist[Math.floor(hash(seed) * shortlist.length) % shortlist.length].t;
}

const inflight = new Map();

/** Download a catalog track to the cache if it is not there yet. */
export async function ensureTrack(track, onLog) {
  if (!track?.id) return null;
  const file = path.join(MUSIC_DIR, path.basename(track.id));
  if (fs.existsSync(file) && fs.statSync(file).size > 8192) return file;
  if (inflight.has(track.id)) return inflight.get(track.id);

  const url = `${CATALOG.source}${track.id}`;
  const job = (async () => {
    onLog?.(`Downloading music: ${track.name || path.basename(track.id)}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`music download ${res.status} for ${track.id}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 8192) throw new Error(`music download too small for ${track.id}`);
    const tmp = `${file}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    onLog?.(`Music cached: ${path.basename(file)} (${(buf.length / 1e6).toFixed(1)} MB)`);
    return file;
  })().finally(() => inflight.delete(track.id));

  inflight.set(track.id, job);
  return job;
}

/**
 * Resolve a clip's music choice to something ffmpeg can read.
 *
 * `mode`: 'none' | 'auto' | 'upload' | 'track'
 * `track`: an upload file name for 'upload', or a catalog id for 'track'.
 */
export async function resolveMusic({ mode = 'none', track = '', look = 'none', seed = '', mood, energy, onLog } = {}) {
  if (!mode || mode === 'none') return null;

  if (mode === 'upload') {
    const file = uploadPath(track);
    if (file && fs.existsSync(file)) return { path: file, name: path.basename(file), id: `upload:${path.basename(file)}`, bpm: 0 };
    return null;
  }

  if (mode === 'track') {
    const t = BY_ID.get(track) || TRACKS.find((x) => x.id === track || path.basename(x.id) === track);
    if (!t) return null;
    const file = await ensureTrack(t, onLog);
    return file ? { path: file, name: t.name, id: t.id, bpm: t.bpm, group: t.group, energy: t.energy } : null;
  }

  // auto: the look carries the default mood; callers may override it.
  const t = pickTrack({ mood: mood || 'warm', energy: energy || [2, 3], seed });
  if (!t) return null;
  const file = await ensureTrack(t, onLog);
  return file ? { path: file, name: t.name, id: t.id, bpm: t.bpm, group: t.group, energy: t.energy } : null;
}
