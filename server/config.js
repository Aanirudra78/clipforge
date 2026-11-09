import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile?.(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')); } catch {}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
export const DIRS = {
  uploads: path.join(DATA, 'uploads'),
  clips: path.join(DATA, 'clips'),
  preview: path.join(DATA, 'preview'),
  thumbs: path.join(DATA, 'thumbs'),
  cache: path.join(DATA, 'cache'),
  broll: path.join(DATA, 'broll'),
  work: path.join(DATA, 'work'),
  fonts: path.join(ROOT, 'assets', 'fonts'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

function pick(bin, candidates) {
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return bin;
}

export const FFMPEG = process.env.FFMPEG_PATH || pick('ffmpeg', [
  path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
  path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg'),
  'C:\\Users\\sanir\\song-video\\node_modules\\ffmpeg-static\\ffmpeg.exe',
]);

export const FFPROBE = process.env.FFPROBE_PATH || pick('ffprobe', [
  path.join(ROOT, 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
  path.join(ROOT, 'node_modules', '@ffprobe-installer', 'ffprobe.exe'),
]);

export const PORT = Number(process.env.PORT || 4400);
export const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
export const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '';
export const BROLL = process.env.CLIPFORGE_BROLL !== 'off';
export const PASSWORD = process.env.CLIPFORGE_PASSWORD || '';

export const OUT_W = 1080;
export const OUT_H = 1920;
export const FPS = 30;
