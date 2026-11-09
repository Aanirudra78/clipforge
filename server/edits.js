import fs from 'node:fs';
import { clips, projects } from './db.js';

/**
 * Manual caption edits ("Edits" tab).
 *
 * A clip stores the current edits in `data.captionEdits` (key = chunk index) and
 * the edits that the last finished render actually burned in as
 * `data.renderedEdits`. An edit is pending when the two differ — that is the
 * only reliable way to know a caption change is not in the MP4 yet without
 * re-encoding anything.
 */

function pendingList(current, rendered) {
  const a = current || {};
  const b = rendered || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => String(a[k] ?? '') !== String(b[k] ?? ''));
}

export function listEdits() {
  const out = [];
  for (const c of clips.all()) {
    const d = c.data || {};
    const current = d.captionEdits || {};
    const count = Object.keys(current).length;
    if (!count) continue; // only reels that were actually edited show up
    const p = projects.get(c.project_id);
    const changed = pendingList(current, d.renderedEdits);
    out.push({
      clipId: c.id,
      projectId: c.project_id,
      projectName: p?.name || 'Untitled',
      start: c.start,
      end: c.end,
      duration: c.duration,
      score: c.score,
      status: c.status,
      thumb: c.thumb || '',
      hasFile: Boolean(c.path && fs.existsSync(c.path)),
      look: d.look || 'none',
      template: d.template || 'pop',
      music: d.music || 'auto',
      musicName: d.musicName || '',
      edits: count,
      changed: changed.length,
      changedKeys: changed,
      pending: changed.length > 0,
    });
  }
  return out.sort((x, y) => (Number(y.pending) - Number(x.pending))
    || String(x.projectName).localeCompare(String(y.projectName))
    || x.start - y.start);
}

/** Clips whose captions changed after the last finished render. */
export function pendingClipIds() {
  return listEdits().filter((e) => e.pending && e.status !== 'rendering').map((e) => e.clipId);
}

/** Ready clips with caption edits, for the edited-clips ZIP. */
export function editedFiles() {
  const out = [];
  for (const e of listEdits()) {
    if (e.status !== 'ready' || !e.hasFile) continue;
    const c = clips.get(e.clipId);
    if (c?.path) out.push({ ...e, path: c.path });
  }
  return out;
}
