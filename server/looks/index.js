import { filterGrade, gradeToFilters, filterCount } from './grade.js';
import { LOOKS, LOOK_FAMILIES, resolveLook, lookName, lookCatalog } from './presets.js';

export { LOOKS, LOOK_FAMILIES, resolveLook, lookName, lookCatalog };

/**
 * ffmpeg chain for a look, or '' for Normal. Applied after framing, before
 * captions. The vignette is deliberately not in here: `vignette` at 1080x1920
 * costs ~0.26s per second of video, so render.js applies it at quarter size and
 * multiplies it back (same look, ~5x cheaper).
 */
export function lookFilters(id, { outH = 1920 } = {}) {
  const look = resolveLook(id);
  if (!look) return '';
  const parts = [];

  const grade = look.grade?.filter ? filterGrade(look.grade.filter) : null;
  if (grade) parts.push(gradeToFilters(grade, look.grade.amount ?? 1));

  if (look.sharpen) {
    const a = Math.round(look.sharpen * 100) / 100;
    // 3x3, not 5x5: at 1080x1920 the wider kernel costs ~2s per 24s clip and
    // the difference on phone screens is invisible.
    parts.push(`unsharp=3:3:${a}:3:3:${Math.round(a * 0.5 * 100) / 100}`);
  }
  for (const extra of look.extras || []) if (extra) parts.push(extra);

  if (look.grain) parts.push(`noise=alls=${Math.round(look.grain)}:allf=t+u`);
  if (look.bars) {
    const px = Math.max(2, Math.round(outH * look.bars));
    parts.push(`drawbox=x=0:y=0:w=iw:h=${px}:color=black:t=fill`);
    parts.push(`drawbox=x=0:y=ih-${px}:w=iw:h=${px}:color=black:t=fill`);
  }
  return parts.filter(Boolean).join(',');
}

/** Vignette strength for a look (radians), or 0 for none. */
export function lookVignette(id) {
  return Math.max(0, Number(resolveLook(id)?.vignette) || 0);
}

/**
 * Camera motion was part of the original look bundle, but `zoompan` at
 * 1080x1920 costs ~0.3s per second of video — more than the whole grade — for
 * a 2% push nobody can see on a phone. The Punch-in slider stays available for
 * anyone who wants movement; looks no longer add their own.
 */
export function lookPush() {
  return 0;
}

/** Caption overrides for a look (font / casing / tracking / size / outline). */
export function lookCaption(id) {
  const look = resolveLook(id);
  return look ? { ...look.caption } : null;
}

/** Mood profile for the future music picker. */
export function lookMusic(id) {
  return resolveLook(id)?.music || null;
}

export function looksInfo() {
  return { families: LOOK_FAMILIES, presets: lookCatalog(), filters: filterCount() };
}
