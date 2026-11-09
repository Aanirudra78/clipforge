import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';

const dbPath = path.join(DATA, 'clipforge.db');
export const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT, original TEXT, meta TEXT,
    status TEXT, progress REAL DEFAULT 0, step TEXT,
    created INTEGER, updated INTEGER
  );
  CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY, project_id TEXT, start REAL, end REAL, duration REAL,
    score REAL, reason TEXT, path TEXT, thumb TEXT, data TEXT,
    status TEXT, created INTEGER
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, project_id TEXT, type TEXT, payload TEXT,
    status TEXT, progress REAL DEFAULT 0, log TEXT, created INTEGER, updated INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id);
`);

export const row = (r) => {
  if (!r) return null;
  const o = { ...r };
  for (const k of ['meta', 'payload', 'data']) {
    if (typeof o[k] === 'string') { try { o[k] = JSON.parse(o[k]); } catch {} }
  }
  return o;
};

export const projects = {
  insert(p) {
    db.prepare(`INSERT OR REPLACE INTO projects (id,name,original,meta,status,progress,step,created,updated)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      p.id, p.name ?? '', p.original ?? '', JSON.stringify(p.meta ?? {}),
      p.status ?? 'queued', p.progress ?? 0, p.step ?? '', p.created ?? Date.now(), Date.now(),
    );
  },
  get(id) { return row(db.prepare(`SELECT * FROM projects WHERE id=?`).get(id)); },
  all() { return db.prepare(`SELECT * FROM projects ORDER BY created DESC LIMIT 200`).all().map(row); },
  upd(id, patch) {
    const cur = this.get(id);
    if (!cur) return;
    const n = { ...cur, ...patch };
    db.prepare(`UPDATE projects SET name=?,original=?,meta=?,status=?,progress=?,step=?,updated=? WHERE id=?`).run(
      n.name, n.original, JSON.stringify(n.meta ?? {}), n.status, n.progress ?? 0, n.step ?? '', Date.now(), id,
    );
  },
  del(id) {
    db.prepare(`DELETE FROM clips WHERE project_id=?`).run(id);
    db.prepare(`DELETE FROM jobs WHERE project_id=?`).run(id);
    db.prepare(`DELETE FROM projects WHERE id=?`).run(id);
  },
};

export const clips = {
  insert(c) {
    db.prepare(`INSERT OR REPLACE INTO clips (id,project_id,start,end,duration,score,reason,path,thumb,data,status,created)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      c.id, c.project_id, c.start, c.end, c.duration, c.score ?? 0, c.reason ?? '',
      c.path ?? '', c.thumb ?? '', JSON.stringify(c.data ?? {}), c.status ?? 'queued', c.created ?? Date.now(),
    );
  },
  byProject(id) { return db.prepare(`SELECT * FROM clips WHERE project_id=? ORDER BY start ASC`).all(id).map(row); },
  all() { return db.prepare(`SELECT * FROM clips ORDER BY created DESC LIMIT 1000`).all().map(row); },
  get(id) { return row(db.prepare(`SELECT * FROM clips WHERE id=?`).get(id)); },
  upd(id, patch) {
    const cur = this.get(id);
    if (!cur) return;
    const n = { ...cur, ...patch };
    db.prepare(`UPDATE clips SET project_id=?,start=?,end=?,duration=?,score=?,reason=?,path=?,thumb=?,data=?,status=? WHERE id=?`).run(
      n.project_id, n.start, n.end, n.duration, n.score ?? 0, n.reason ?? '', n.path ?? '', n.thumb ?? '',
      JSON.stringify(n.data ?? {}), n.status ?? 'queued', id,
    );
  },
  del(id) { db.prepare(`DELETE FROM clips WHERE id=?`).run(id); },
};

export const jobs = {
  insert(j) {
    db.prepare(`INSERT OR REPLACE INTO jobs (id,project_id,type,payload,status,progress,log,created,updated)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      j.id, j.project_id, j.type, JSON.stringify(j.payload ?? {}),
      j.status ?? 'queued', j.progress ?? 0, j.log ?? '', Date.now(), Date.now(),
    );
  },
  next() {
    // Interactive jobs (draft preview / single re-render) jump ahead of a batch
    // run, otherwise tweaking captions during a 6-clip job means waiting.
    return row(db.prepare(`SELECT * FROM jobs WHERE status='queued'
      ORDER BY CASE type WHEN 'preview' THEN 0 WHEN 'render' THEN 1 ELSE 2 END, created ASC
      LIMIT 1`).get());
  },
  upd(id, patch) {
    const cur = row(db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id));
    if (!cur) return;
    const n = { ...cur, ...patch };
    db.prepare(`UPDATE jobs SET status=?,progress=?,log=?,updated=? WHERE id=?`).run(
      n.status, n.progress ?? 0, (n.log ?? '').slice(-4000), Date.now(), id,
    );
  },
  pending() { return db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status IN ('queued','running')`).get().c; },
  // A crash or `node --watch` restart leaves jobs mid-flight; on boot they go
  // back to queued and the worker picks them up again.
  requeueRunning() {
    return db.prepare(`UPDATE jobs SET status='queued', progress=0, updated=? WHERE status='running'`).run(Date.now()).changes;
  },
};

export function nukeProject(projectId) {
  const p = projects.get(projectId);
  if (p?.original) { try { fs.unlinkSync(p.original); } catch {} }
  for (const c of clips.byProject(projectId)) {
    if (c.path) { try { fs.unlinkSync(c.path); } catch {} }
    if (c.thumb) { try { fs.unlinkSync(c.thumb); } catch {} }
    try { fs.unlinkSync(path.join(DATA, 'preview', `${c.id}.mp4`)); } catch {}
  }
  projects.del(projectId);
}
