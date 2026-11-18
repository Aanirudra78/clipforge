#!/usr/bin/env node
/**
 * Bridge: YouTube link -> local download -> direct source URL for ClipForge.
 *
 * GitHub's datacenter IPs are bot-blocked by YouTube, so the cloud runner
 * cannot download YouTube links. This helper runs on YOUR PC (residential IP,
 * where you are logged in to YouTube), downloads the video with yt-dlp using
 * cookies straight from your browser - no manual cookie export - uploads it to
 * tmpfiles.org, and prints the direct source URL for the render dispatch.
 *
 *   node scripts/youtube-to-source.mjs --url https://youtu.be/VIDEO_ID
 *
 * stdout: {"source_url":"https://tmpfiles.org/...","file":"source.mp4","size":123}
 * logs go to stderr so stdout can be parsed by an automation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);
const URL_IN = String(args.url || '').trim();
const log = (m) => process.stderr.write(`${m}\n`);
if (!URL_IN) { log('missing --url'); process.exit(2); }

const YT_VERSION = '2026.10.26';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-ytsrc-'));

async function ytDlp() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const name = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
  const local = path.join(DIR, name);
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_VERSION}/${name}`;
  log(`downloading yt-dlp ${YT_VERSION}...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`yt-dlp download ${res.status}`);
  fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()));
  if (process.platform !== 'win32') fs.chmodSync(local, 0o755);
  return local;
}

function run(bin, cmdArgs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, cmdArgs, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { const s = d.toString(); if (err.length < 3000) err += s; log(s.trimEnd()); });
    p.stdout.on('data', (d) => log(d.toString().trimEnd()));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, err }));
  });
}

const bin = await ytDlp();
const out = path.join(DIR, 'source.%(ext)s');
const base = [
  '--no-playlist', '--no-mtime', '--merge-output-format', 'mp4',
  '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
  '--retries', '3', '--fragment-retries', '6',
  '-o', out, URL_IN,
];
// Your own browser on your own PC: no exported cookie file, no secret to rotate.
const browsers = (args.browser && args.browser !== 'none' ? [args.browser] : ['chrome', 'edge', 'firefox', 'brave']);
let got = null;
for (const browser of [...browsers, 'none']) {
  try {
    log(`trying yt-dlp (${browser === 'none' ? 'no cookies' : `cookies from ${browser}`})...`);
    const extra = browser === 'none' ? [] : ['--cookies-from-browser', browser];
    const r = await run(bin, [...extra, ...base]);
    if (r.code !== 0) continue;
    const file = fs.readdirSync(DIR).find((f) => /^source\.(mp4|mkv|webm)$/i.test(f));
    if (file) { got = path.join(DIR, file); break; }
  } catch (e) { log(`attempt failed: ${e.message}`); }
}
if (!got) {
  log('Download failed. If a browser reported a locked cookie database, close that browser completely and run this again.');
  process.exit(1);
}
log(`downloaded ${path.basename(got)} (${(fs.statSync(got).size / 1e6).toFixed(1)} MB) - uploading...`);

// tmpfiles accepts browser uploads without auth (same lane the phone page uses).
const fd = new FormData();
fd.append('file', new Blob([fs.readFileSync(got)]), path.basename(got));
const res = await fetch('https://tmpfiles.org/api/v1/upload?expire=86400', { method: 'POST', body: fd });
const j = await res.json().catch(() => ({}));
if (!res.ok || j.status !== 'success' || !j.data?.url) throw new Error(`tmpfiles upload failed: ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
console.log(JSON.stringify({ source_url: j.data.url, file: path.basename(got), size: fs.statSync(got).size }));
fs.rmSync(DIR, { recursive: true, force: true });
