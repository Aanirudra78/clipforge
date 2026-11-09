import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * OpenFilm grade -> ffmpeg converter.
 *
 * OpenFilm stores a look as an SVG filter: a 3x4 colour matrix, a saturation
 * amount, and 17-point transfer curves (a master curve feeding per-channel
 * curves). This module reproduces that exact composition with native ffmpeg
 * filters, so a look costs no browser and no extra render pass.
 *
 * Order matters and follows the SVG: matrix -> saturation -> curves.
 * Offsets in the matrix have no ffmpeg equivalent, so they are applied with a
 * `lutrgb` add straight after the matrix (only 3 of the 66 filters use them).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.join(here, 'data', 'openfilm-filters.json');

let catalog = null;
function items() {
  if (catalog) return catalog;
  try {
    const j = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
    catalog = Array.isArray(j.items) ? j.items : [];
  } catch {
    catalog = [];
  }
  return catalog;
}

/** The grade block for a filter id ("teal-orange" or "filters/teal-orange"). */
export function filterGrade(id) {
  const key = String(id || '').replace(/^filters\//, '');
  return items().find((it) => it.id === `filters/${key}`)?.grade || null;
}

export function filterById(id) {
  const key = String(id || '').replace(/^filters\//, '');
  return items().find((it) => it.id === `filters/${key}`) || null;
}

export function filterCount() {
  return items().length;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Linear read of a point table, identity when the table is missing. */
function valueAt(points, x) {
  if (!Array.isArray(points) || !points.length) return x;
  if (points.length === 1) return points[0];
  const n = clamp01(x) * (points.length - 1);
  const i = Math.min(points.length - 2, Math.floor(n));
  return points[i] + (points[i + 1] - points[i]) * (n - i);
}

/**
 * The 17-point curve OpenFilm draws for a channel: master first, then channel.
 * `amount` blends the curve back toward identity (exact for a channel without
 * its own table; a close approximation once a channel curve sits on top).
 */
function channelCurve(grade, channel, amount = 1) {
  const master = Array.isArray(grade.all) && grade.all.length ? grade.all : null;
  const own = channel !== 'all' && Array.isArray(grade[channel]) ? grade[channel] : null;
  const a = clamp01(amount);
  const out = [];
  for (let i = 0; i < 17; i++) {
    const x = i / 16;
    const m = master ? valueAt(master, x) : x;
    const mb = x + (m - x) * a;
    out.push(clamp01(own ? valueAt(own, mb) : mb));
  }
  return out;
}

/** ffmpeg curves wants at most 16 points; sample the 17-point curve at 16. */
function curvePoints(points) {
  const out = [];
  for (let i = 0; i < 16; i++) {
    const x = i / 15;
    const pos = x * 16;
    const lo = Math.min(15, Math.floor(pos));
    const hi = Math.min(16, lo + 1);
    const y = points[lo] + (points[hi] - points[lo]) * (pos - lo);
    out.push(`${r3(x)}/${r3(clamp01(y))}`);
  }
  return out.join(' ');
}

/**
 * ffmpeg filter chain for one OpenFilm grade, or '' when there is nothing to do.
 * Returned as a comma-separated list, ready to put in a filtergraph.
 */
export function gradeToFilters(grade, amount = 1) {
  if (!grade) return '';
  const out = [];
  const a = clamp01(amount);

  // 1. 3x4 colour matrix (rows: R, G, B; 4th entry is the offset).
  if (Array.isArray(grade.mix) && grade.mix.length === 12) {
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    const m = grade.mix.map((v, i) => id[i] + ((Number(v) || 0) - id[i]) * a);
    const opts = [
      ['rr', m[0]], ['rg', m[1]], ['rb', m[2]],
      ['gr', m[4]], ['gg', m[5]], ['gb', m[6]],
      ['br', m[8]], ['bg', m[9]], ['bb', m[10]],
    ].map(([k, v]) => `${k}=${r3(v)}`);
    out.push(`colorchannelmixer=${opts.join(':')}`);

    const off = [m[3] * 255, m[7] * 255, m[11] * 255];
    if (off.some((v) => Math.abs(v) > 0.5)) {
      const add = (v) => (v >= 0 ? `val+${r3(v)}` : `val-${r3(-v)}`);
      out.push(`lutrgb=r='clip(${add(off[0])},0,255)':g='clip(${add(off[1])},0,255)':b='clip(${add(off[2])},0,255)'`);
    }
  }

  // 2. Saturation.
  if (grade.sat != null) {
    const sat = 1 + ((Number(grade.sat) || 1) - 1) * a;
    if (Math.abs(sat - 1) > 0.001) out.push(`eq=saturation=${r3(sat)}`);
  }

  // 3. Per-channel curves. OpenFilm builds ONE table per channel that already
  // contains the master curve (channel(master(x))). ffmpeg's `master` option
  // would apply the master a second time, so the composed table goes in alone.
  const hasCurves = ['all', 'r', 'g', 'b'].some((k) => Array.isArray(grade[k]) && grade[k].length);
  if (hasCurves) {
    const opts = [];
    for (const [key, ch] of [['red', 'r'], ['green', 'g'], ['blue', 'b']]) {
      const pts = channelCurve(grade, ch, a);
      const identity = pts.every((v, i) => Math.abs(v - i / 16) < 0.001);
      if (!identity) opts.push(`${key}='${curvePoints(pts)}'`);
    }
    if (opts.length) out.push(`curves=${opts.join(':')}`);
  }

  return out.join(',');
}
