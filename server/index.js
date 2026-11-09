import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PORT, DATA, DIRS, GROQ_API_KEY, PASSWORD, FFMPEG } from './config.js';
import { projects, clips, nukeProject } from './db.js';
import { enqueue, kick, bus, emit, recover } from './jobs.js';
import { videoEncoder, probe } from './media.js';
import { TEMPLATES, captionChunks } from './captions.js';
import { looksInfo } from './looks/index.js';
import { musicCatalog, uploadPath } from './music/index.js';
import { listEdits, pendingClipIds, editedFiles } from './edits.js';
import { keptSegments, remapWords } from './cuts.js';
import { zipStream } from './zip.js';
import os from 'node:os';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// No explicit maxAge here: index/app/styles carry no version hash, so a
// cached index.html would hide UI updates from the phone for an hour. ETag
// revalidation keeps it fast enough on LAN.
app.use(express.static(PUB));
app.use('/assets', express.static(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets'), { maxAge: '7d' }));

function keyGate(req, res, next) {
  if (!PASSWORD) return next();
  const k = req.headers['x-clipforge-key'] || req.query.k;
  if (k === PASSWORD) return next();
  res.status(401).json({ error: 'locked', needsKey: true });
}
app.use('/api', keyGate);

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(`http://${n.address}:${PORT}`);
    }
  }
  return out;
}

const storage = multer.diskStorage({
  destination: DIRS.uploads,
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.mp4').toLowerCase().slice(0, 6);
    cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 * 1024 } });

// Music uploads are small and reused across projects, so they live in their own
// folder under data/music/uploads instead of the per-run uploads folder.
const musicUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA, 'music', 'uploads'),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.mp3').toLowerCase().slice(0, 6);
      const base = path.basename(file.originalname, path.extname(file.originalname))
        .replace(/[^\w\-. ]+/g, '').trim().slice(0, 60) || 'music';
      cb(null, `${base}-${randomUUID().slice(0, 6)}${ext}`);
    },
  }),
  limits: { fileSize: 96 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(audio\/|video\/mp4)/i.test(file.mimetype)),
});

app.get('/api/health', async (req, res) => {
  const enc = await videoEncoder();
  const catalog = musicCatalog();
  res.json({
    ok: true,
    ffmpeg: FFMPEG,
    encoder: enc.name,
    groq: Boolean(GROQ_API_KEY),
    locked: Boolean(PASSWORD),
    templates: TEMPLATES,
    accents: ['yellow', 'cyan', 'green', 'pink', 'orange', 'white', 'gold', 'red'],
    looks: looksInfo(),
    music: { moods: catalog.moods, tracks: catalog.tracks.length, uploads: catalog.uploads.length },
    dataDir: DATA,
    lanUrls: lanUrls(),
  });
});

app.get('/api/music', (req, res) => res.json(musicCatalog()));

app.post('/api/music', musicUpload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no audio uploaded' });
  res.json({ ok: true, id: `upload:${req.file.filename}`, name: req.file.filename });
});

app.delete('/api/music/:name', (req, res) => {
  const file = uploadPath(req.params.name);
  if (file && fs.existsSync(file)) { try { fs.unlinkSync(file); } catch {} }
  res.json({ ok: true });
});

// ---- Caption edits ("Edits" tab) -----------------------------------------

app.get('/api/edits', (req, res) => {
  const edits = listEdits();
  res.json({
    edits,
    edited: edits.length,
    pending: edits.filter((e) => e.pending).length,
    ready: edits.filter((e) => e.status === 'ready' && e.hasFile).length,
  });
});

app.post('/api/edits/render', (req, res) => {
  const wanted = Array.isArray(req.body?.clipIds) && req.body.clipIds.length
    ? req.body.clipIds
    : pendingClipIds();
  const jobIds = [];
  for (const id of wanted) {
    const c = clips.get(id);
    if (!c) continue;
    jobIds.push(enqueue(c.project_id, 'render', { clipId: c.id }));
  }
  res.json({ ok: true, queued: jobIds.length, jobIds });
});

app.get('/api/edits/zip', (req, res) => {
  const files = editedFiles();
  if (!files.length) return res.status(409).json({ error: 'no edited clips yet' });
  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="clipforge-edits-${stamp}.zip"`,
    'Cache-Control': 'no-store',
  });
  const stream = zipStream(files.map((f, i) => {
    const safe = String(f.projectName || 'clips').replace(/[^\w\-. ]+/g, '').trim().slice(0, 40) || 'clips';
    return {
      name: `${String(i + 1).padStart(2, '0')}-${safe}-${Math.round(f.start)}s-${f.clipId.slice(0, 4)}.mp4`,
      path: f.path,
    };
  }));
  stream.on('error', () => { try { res.end(); } catch {} });
  stream.pipe(res);
});

app.get('/api/projects', (req, res) => {
  res.json(projects.all().map((p) => ({
    ...p,
    meta: p.meta ? {
      duration: p.meta.duration, width: p.meta.width, height: p.meta.height,
      transcriptSource: p.meta.transcriptSource, wordCount: p.meta.wordCount,
      autoCrop: p.meta.autoCrop, language: p.meta.language, options: p.meta.options,
    } : {},
  })));
});

app.get('/api/projects/:id', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json({ project: p, clips: clips.byProject(p.id) });
});

app.post('/api/projects', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no video uploaded' });
    const file = req.file.path;
    const meta = await probe(file).catch(() => null);
    if (!meta?.hasVideo) {
      try { fs.unlinkSync(file); } catch {}
      return res.status(400).json({ error: 'that file has no video stream' });
    }
    let options = {};
    if (req.body.options) { try { options = JSON.parse(req.body.options); } catch {} }
    const id = randomUUID();
    projects.insert({
      id,
      name: (req.body.name || path.parse(req.file.originalname).name || 'Untitled').slice(0, 90),
      original: file,
      meta: { ...meta, options, filename: req.file.originalname, size: req.file.size },
      status: 'queued',
      progress: 0,
      step: 'Queued',
    });
    enqueue(id, 'full', options);
    res.json({ project: projects.get(id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/rerun', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const options = { ...(p.meta?.options || {}), ...(req.body || {}) };
  projects.upd(p.id, { meta: { ...p.meta, options }, status: 'queued', progress: 0, step: 'Queued' });
  enqueue(p.id, 'full', options);
  res.json({ project: projects.get(p.id) });
});

app.delete('/api/projects/:id', (req, res) => {
  nukeProject(req.params.id);
  emit('deleted', { projectId: req.params.id });
  res.json({ ok: true });
});

app.get('/api/clips/:id/captions', (req, res) => {
  const c = clips.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const d = c.data || {};
  const cuts = (d.cuts || [])
    .map((x) => ({ from: Math.max(c.start, x.from), to: Math.min(c.end, x.to) }))
    .filter((x) => x.to - x.from > 0.08);
  const segs = cuts.length ? keptSegments(c.start, c.end, cuts) : [];
  const words = cuts.length ? remapWords(d.words || [], segs) : (d.words || []);
  const start = cuts.length ? 0 : c.start;
  const end = cuts.length ? c.duration : c.end;
  const template = String(req.query.template || d.template || 'pop');
  res.json({
    template,
    lines: captionChunks({ words, start, end, duration: c.duration, template, edits: d.captionEdits || {} }),
  });
});

app.post('/api/clips/:id/preview', (req, res) => {
  const c = clips.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  // Drop the old draft first: the editor polls the file, and a leftover one
  // would be shown as if it were the new preview.
  try { fs.unlinkSync(path.join(DIRS.preview, `${c.id}.mp4`)); } catch {}
  const payload = { clipId: c.id, ...req.body };
  const jobId = enqueue(c.project_id, 'preview', payload);
  res.json({ ok: true, jobId });
});

app.get('/api/clips/:id/preview', (req, res) => {
  sendFileWithRange(req, res, path.join(DIRS.preview, `${req.params.id}.mp4`));
});

app.post('/api/clips/:id/render', (req, res) => {
  const c = clips.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const payload = { clipId: c.id, ...req.body };
  const jobId = enqueue(c.project_id, 'render', payload);
  res.json({ ok: true, jobId });
});

app.delete('/api/clips/:id', (req, res) => {
  const c = clips.get(req.params.id);
  if (c) {
    try { fs.unlinkSync(c.path); } catch {}
    try { fs.unlinkSync(c.thumb); } catch {}
    try { fs.unlinkSync(path.join(DIRS.preview, `${c.id}.mp4`)); } catch {}
    clips.del(c.id);
    emit('deleted', { projectId: c.project_id, clipId: c.id });
  }
  res.json({ ok: true });
});

function sendFileWithRange(req, res, file, downloadName) {
  if (!fs.existsSync(file)) return res.status(404).end();
  const stat = fs.statSync(file);
  const range = req.headers.range;
  const type = file.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg';
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName}"`;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    // `bytes=-500` is a suffix range; `bytes=N-` is open-ended. Clamp both
    // ends to the file so a player asking for the byte just past EOF (common
    // after a seek) gets 416 instead of crashing the stream.
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (m && !m[1] && m[2]) start = Math.max(0, stat.size - Number(m[2]));
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end > stat.size - 1) end = stat.size - 1;
    if (start >= stat.size || end < start) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(file).pipe(res);
}

app.get('/api/projects/:id/zip', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const ready = clips.byProject(p.id).filter((c) => c.status === 'ready' && c.path && fs.existsSync(c.path));
  if (!ready.length) return res.status(409).json({ error: 'no finished clips yet' });
  const safe = String(p.name || 'clips').replace(/[^\w\-. ]+/g, '').trim().slice(0, 50) || 'clips';
  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${safe}-${stamp}.zip"`,
    'Cache-Control': 'no-store',
  });
  const files = ready.map((c, i) => ({
    name: `${String(i + 1).padStart(2, '0')}-${Math.round(c.start)}s-${Math.round(c.score)}score.mp4`,
    path: c.path,
  }));
  const stream = zipStream(files);
  stream.on('error', () => { try { res.end(); } catch {} });
  stream.pipe(res);
});

app.get('/api/clips/:id/file', (req, res) => {
  const c = clips.get(req.params.id);
  if (!c?.path) return res.status(404).end();
  sendFileWithRange(req, res, c.path);
});

app.get('/api/clips/:id/download', (req, res) => {
  const c = clips.get(req.params.id);
  if (!c?.path) return res.status(404).end();
  const name = `clip-${c.id}-${Math.round(c.start)}s.mp4`;
  sendFileWithRange(req, res, c.path, name);
});

app.get('/api/thumbs/:id', (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9-]/g, '');
  sendFileWithRange(req, res, path.join(DIRS.thumbs, `${id}.jpg`));
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': hello\n\n');
  const onEvent = (e) => {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); bus.off('event', onEvent); });
});

app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(PUB, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err); // stream already started; nothing sane left to send
  res.status(500).json({ error: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ClipForge  →  http://localhost:${PORT}`);
  const lan = lanUrls();
  for (const u of lan) console.log(`  on phone   →  ${u}`);
  console.log(`  data       →  ${DATA}`);
  recover();
});
