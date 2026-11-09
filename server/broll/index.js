/**
 * B-roll fetcher: turns a topic into a licensed, cached visual asset.
 *
 * Sources, best first:
 *  - Pexels video (needs PEXELS_API_KEY, best quality, free licence)
 *  - Wikimedia Commons video (webm/ogv, CC licences, no key)
 *  - Wikimedia Commons photo (any topic, no key)
 *
 * Everything is downloaded ONCE into data/broll/<hash>.<ext> and indexed in
 * ledger.json (source page, licence, author) so repeats are instant and every
 * asset stays attributable. A caller that gets `null` falls back to the text
 * card — relevance beats quantity, so weak matches are refused, not shown.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { probe } from '../media.js';
import { DIRS, PEXELS_API_KEY } from '../config.js';
import { mineTopics } from './keywords.js';

const UA = 'ClipForge/1.0 (b-roll fetcher; local dev)';
const DIR = DIRS.broll;
const LEDGER = path.join(DIR, 'ledger.json');
const MAX_BYTES = 30 * 1024 * 1024;

let dirReady = false;
function ensureDir() {
  if (!dirReady) {
    fs.mkdirSync(DIR, { recursive: true });
    dirReady = true;
  }
}

function ledger() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

function saveLedger(j) {
  try { fs.writeFileSync(LEDGER, JSON.stringify(j, null, 1)); } catch {}
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const hashKey = (parts) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 20);

/** Single words that are never a topic on their own (bad stock results). */
const WEAK_SINGLE = new Set([
  'next', 'time', 'times', 'look', 'looks', 'make', 'made', 'take', 'takes', 'want', 'wants',
  'need', 'needs', 'talk', 'talks', 'said', 'says', 'goes', 'going', 'come', 'comes', 'know',
  'knows', 'think', 'thing', 'things', 'stuff', 'people', 'person', 'guys', 'girls', 'boys',
  'good', 'best', 'better', 'worst', 'great', 'big', 'small', 'more', 'most', 'much', 'many',
  'very', 'really', 'actually', 'literally', 'basically', 'first', 'last', 'same', 'other',
  'with', 'from', 'that', 'this', 'then', 'than', 'they', 'them', 'their', 'there', 'here',
  'what', 'when', 'where', 'which', 'while', 'will', 'would', 'could', 'should', 'about',
  'into', 'over', 'under', 'after', 'before', 'every', 'each', 'some', 'any', 'only', 'just',
  'dark', 'light', 'life', 'love', 'time', 'vibe', 'vibes', 'story', 'truth', 'future',
]);

function badQuery(q) {
  const n = norm(q);
  return n.length < 3 || /\b(two|speaker|speakers|people talking|interview)\b/.test(n);
}

async function getJson(url, headers = {}, timeout = 20000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function download(url, file, size) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('asset too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('asset too large');
  if (buf.length < 12 * 1024) throw new Error('asset too small');
  fs.writeFileSync(file, buf);
  return size ?? buf.length;
}

/* ---------- Coverr (free stock video, no key) ---------- */

const COVERR = 'https://coverr.co/api/videos';

async function coverrSearch(query) {
  const url = `${COVERR}?` + new URLSearchParams({ query, page_size: '10' });
  const j = await getJson(url, { 'User-Agent': 'Mozilla/5.0' });
  const out = [];
  for (const h of j?.hits || []) {
    if (!h || h.is_premium || !h.base_filename) continue;
    const dur = Number(h.duration || 0);
    if (dur < 2 || dur > 40) continue;
    if (Number(h.max_width || 0) < 900) continue;
    out.push({
      provider: 'coverr', kind: 'video',
      url: `https://cdn.coverr.co/videos/${h.base_filename}/720p.mp4`,
      page: `https://coverr.co/search?q=${encodeURIComponent(query)}`,
      title: String(h.title || '').slice(0, 90),
      w: Number(h.max_width || 1280), h: Number(h.max_height || 720),
      user: 'Coverr', license: 'Coverr licence (free, no attribution)',
      tags: h.tags || [],
    });
    if (out.length >= 6) break;
  }
  return out;
}

/* ---------- Openverse (CC images, no key) ---------- */

async function openverseSearch(query) {
  const url = 'https://api.openverse.org/v1/images/?' + new URLSearchParams({
    q: query, page_size: '10', license_type: 'commercial', mature: 'false',
  });
  const j = await getJson(url, { 'User-Agent': UA });
  const out = [];
  for (const r of j?.results || []) {
    if (!r?.url) continue;
    // skip obvious non-photos
    if (/\.(svg|gif|tif|tiff)(\?|$)/i.test(r.url)) continue;
    out.push({
      provider: 'openverse', kind: 'image',
      url: r.url, page: r.foreign_landing_url || '',
      title: String(r.title || '').slice(0, 90) || `Openverse ${r.id}`,
      w: Number(r.width || 0), h: Number(r.height || 0),
      user: r.creator || '', license: `${r.license || 'CC'} ${r.license_version || ''}`.trim(),
      tags: (r.tags || []).map((t) => t.name),
    });
    if (out.length >= 6) break;
  }
  return out;
}

/* ---------- Wikimedia Commons (best licensing, blocked on some ISPs) ---------- */

async function commonsSearch(query) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: `${query} filetype:video`, gsrnamespace: '6',
    gsrlimit: '6', prop: 'imageinfo', iiprop: 'url|size|mediatype',
    iiurlwidth: '1080', format: 'json', origin: '*',
  });
  const j = await getJson(url);
  const out = [];
  for (const page of Object.values(j?.query?.pages || {})) {
    const info = page?.imageinfo?.[0];
    if (!info || info.mediatype !== 'VIDEO') continue;
    const w = Number(info.width || 0), h = Number(info.height || 0);
    if (h > w || w < 480) continue;
    out.push({
      provider: 'commons', kind: 'video',
      url: info.thumburl || info.url, page: info.descriptionurl || '',
      title: String(page.title || '').replace(/^File:/, '').slice(0, 90),
      w, h, user: '', license: 'see source',
    });
    if (out.length >= 4) break;
  }
  return out;
}

async function pexelsSearch(query) {
  const j = await getJson('https://api.pexels.com/videos/search?' + new URLSearchParams({
    query, per_page: '6', orientation: 'landscape', size: 'medium',
  }), { Authorization: PEXELS_API_KEY });
  const out = [];
  for (const v of j?.videos || []) {
    if (Number(v.duration) < 2 || Number(v.duration) > 40) continue;
    const files = (v.video_files || [])
      .filter((f) => f.width >= 640 && (f.file_type || '').includes('mp4'))
      .sort((a, b) => a.width - b.width);
    const pick = files.find((f) => f.width >= 900) || files[0];
    if (!pick) continue;
    out.push({
      provider: 'pexels', kind: 'video',
      url: pick.link, page: v.url || '', title: `Pexels video ${v.id}`,
      w: Number(pick.width), h: Number(pick.height), user: v.user?.name || '',
      meta: v,
    });
    if (out.length >= 6) break;
  }
  return out;
}

/* ---------- main entry ---------- */

const memory = new Map(); // topic -> asset | null (failed topics are not retried forever)

// Host -> timestamp when it failed. Module scope, not per-call: one dead host
// must be skipped for the rest of the run, otherwise every single topic pays
// its full timeout again (that is what made CI runs look hung).
const health = new Map();
const providerStats = new Map(); // host -> { ok, fail, msg }
function stat(name) {
  let s = providerStats.get(name);
  if (!s) { s = { ok: 0, fail: 0, msg: '' }; providerStats.set(name, s); }
  return s;
}
const benched = (name) => (health.get(name) || 0) > Date.now();
function bench(name, msg) {
  health.set(name, Date.now() + 10 * 60_000);
  const s = stat(name);
  s.fail++;
  if (msg) s.msg = String(msg).slice(0, 70);
}

/** One line per provider for the run log: what worked, what timed out. */
export function brollHealth() {
  return [...providerStats.entries()]
    .map(([name, s]) => ({ provider: name, ok: s.ok, fail: s.fail, msg: s.msg }))
    .sort((a, b) => b.ok + b.fail - (a.ok + a.fail));
}

/**
 * Resolve one topic into a cached playable asset, or null when every source
 * fails. `seed` varies the offset for repeated topics instead of re-downloading.
 */
export async function findAsset(topic, { onLog } = {}) {
  const q = norm(topic);
  if (!q || badQuery(q)) return null;
  if (memory.has(q)) return memory.get(q);

  ensureDir();
  const cached = ledger()[`q:${q}`];
  if (cached && fs.existsSync(path.join(DIR, cached.file))) {
    memory.set(q, { ...cached, offset: pickOffset(cached) });
    return memory.get(q);
  }

  // Source order: keyed premium first, then the keyless hosts that are
  // actually reachable here. A host that fails is benched for 10 minutes so a
  // dead endpoint does not add a timeout to every single topic.
  const sources = [];
  if (PEXELS_API_KEY) sources.push(['pexels', pexelsSearch]);
  sources.push(['coverr', coverrSearch]);
  sources.push(['openverse', openverseSearch]);
  sources.push(['commons', commonsSearch]);

  for (const [name, search] of sources) {
    if (benched(name)) continue;
    let cands = [];
    try {
      cands = await search(q);
      stat(name).ok++;
    } catch (err) {
      bench(name, err.message);
      onLog?.(`b-roll search ${name}: ${String(err.message || err).slice(0, 70)}`);
      continue;
    }
    for (const cand of cands) {
      const key = hashKey([cand.provider, cand.url]);
      const file = path.join(DIR, `${key}.${cand.kind === 'video' ? 'clip' : 'img'}`);
      const entry = ledger()[`u:${key}`];
      if (entry && fs.existsSync(path.join(DIR, entry.file))) {
        memory.set(q, { ...entry, offset: pickOffset(entry) });
        return memory.get(q);
      }
      try {
        await download(cand.url, file);
        const info = await probe(file);
        if (!info.width || (cand.kind === 'video' && info.duration < 1.5)) throw new Error('not usable');
        const asset = {
          file: path.basename(file), kind: cand.kind, provider: cand.provider,
          title: String(cand.title || '').slice(0, 100), page: cand.page || '',
          author: cand.user || '',
          license: cand.license || (cand.provider === 'pexels' ? 'Pexels licence' : 'see source'),
          w: info.width, h: info.height, dur: info.duration,
          q,
        };
        const store = ledger();
        store[`u:${key}`] = { ...asset, at: Date.now() };
        store[`q:${q}`] = { ...asset, at: Date.now() };
        saveLedger(store);
        memory.set(q, { ...asset, offset: pickOffset(asset) });
        return memory.get(q);
      } catch (err) {
        stat(cand.provider).fail++;
        onLog?.(`b-roll ${cand.provider}: ${String(err.message || err).slice(0, 70)}`);
        try { fs.unlinkSync(file); } catch {}
      }
    }
  }
  memory.set(q, null);
  return null;
}

/** A stable pseudo-random start offset so repeated footage differs per clip. */
function pickOffset(asset) {
  const est = Number(asset.dur) || 12;
  const usable = Math.max(0, est - 6);
  return asset.kind === 'image' ? 0 : Math.round((hashKey([asset.file]).charCodeAt(0) / 255) * usable * 10) / 10;
}

export function brollDir() {
  ensureDir();
  return DIR;
}

export function brollCredits() {
  const j = ledger();
  return Object.values(j).filter((v) => v.q).map(({ q, provider, title, page, license, author }) => ({ q, provider, title, page, license, author }));
}

/** Exported for tests that want a clean slate. */
export function _resetMemory() { memory.clear(); health.clear(); providerStats.clear(); }

/**
 * Mine + fetch for one clip. Returns SOURCE-ABSOLUTE windows (the render maps
 * them through the jump-cut timeline):
 *   [{t0,t1, kind:'video'|'image'|'text', file, offset, query, label, provider, license, page}]
 */
export async function planBroll({ words, start, end, hook, max = 4, onLog } = {}) {
  const rows = await mineTopics({ words, start, end, hook, max, onLog });
  const out = [];
  const used = new Set(); // identical footage twice in one clip looks like a bug
  for (const row of rows) {
    const t0 = row.t0;
    const t1 = row.t1;
    let kind = 'text';
    let file = null, offset = 0, provider = '', page = '', title = row.label;
    // Try the specific phrase first; if the library has nothing, fall back to
    // the single strongest noun ("smartphone with case" → "smartphone") before
    // giving up and drawing a text card.
    const phrases = (row.topic && row.topic.length ? row.topic : []);
    const singles = phrases
      .flatMap((q) => String(q).split(/\s+/))
      .map((w) => w.replace(/[^a-z0-9-]/gi, ''))
      .filter((w) => w.length >= 4 && !WEAK_SINGLE.has(w.toLowerCase()))
      .sort((a, b) => b.length - a.length);
    const queries = [...new Set([...phrases, ...singles])].slice(0, 5);
    for (const q of queries) {
      const asset = await findAsset(q, { onLog });
      if (asset && used.has(asset.file)) continue; // same clip, same shot
      if (asset) {
        kind = asset.kind; file = path.join(brollDir(), asset.file);
        offset = asset.offset || 0; provider = asset.provider; page = asset.page; title = asset.title;
        used.add(asset.file);
        break;
      }
    }
    out.push({
      t0, t1, kind, file, offset, query: (row.topic?.length ? row.topic : [row.label]).filter(Boolean).join(' '), label: row.label,
      provider, page, title, where: row.where,
    });
  }
  // mineTopics already capped the candidates; keep them all so the render can
  // skip windows that land in cut pauses and still hit its per-clip budget.
  return out.slice(0, max + 2);
}

