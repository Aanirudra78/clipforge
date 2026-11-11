#!/usr/bin/env node
/**
 * Download the source video for a cloud render.
 *
 *   node scripts/fetch-source.mjs --url <url> --out source.mp4 [--token $GITHUB_TOKEN]
 *
 * Understands four kinds of input:
 *   - a direct file URL
 *   - a tmpfiles.org *page* URL (the phone uploads there; the real file link is
 *     a tokenised /dl/... path that only exists inside the page HTML)
 *   - a GitHub release asset API URL (needs --token for private repos)
 *   - a video-site URL (YouTube, TikTok, Twitch, ...) - routed through yt-dlp
 *     when a binary is available (YTDLP_PATH or on PATH)
 *
 * Fails loudly instead of handing ffmpeg an HTML error page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);

const URL_IN = String(args.url || '').trim();
const OUT = path.resolve(args.out || 'source.mp4');
const TOKEN = args.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const MAX_HEIGHT = Number(args.height || args['max-height'] || 0) || 0; // yt-dlp only
if (!URL_IN) {
  console.error('missing --url');
  process.exit(2);
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
const log = (m) => console.log(m);

/** Sites yt-dlp understands better than a plain HTTP GET. */
const SITE_HOSTS = /(youtube\.com|youtu\.be|youtube-nocookie\.com|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|twitter\.com|x\.com|vimeo\.com|dailymotion\.com|twitch\.tv|reddit\.com|streamable\.com)$/i;

function isSiteUrl(u) {
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (/\.(mp4|mkv|webm|mov|m4v)$/i.test(parsed.pathname)) return false;
    return SITE_HOSTS.test(host);
  } catch { return false; }
}

function findYtDlp() {
  const bin = process.env.YTDLP_PATH || 'yt-dlp';
  return new Promise((resolve) => {
    const p = spawn(bin, ['--version'], { windowsHide: true });
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 ? bin : null));
  });
}

const FF_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

/**
 * yt-dlp leaves `name.f###.mp4` + `name.f###.m4a` behind when its internal
 * merge cannot run. Consolidate those into `out` ourselves so the render step
 * always sees one file.
 */
async function consolidateOutput(out) {
  if (fs.existsSync(out)) return true;
  const dir = path.dirname(out);
  const base = path.basename(out);
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.`) && !f.endsWith('.part') && /\.(mp4|mkv|webm|m4a|opus|aac)$/i.test(f));
  if (!files.length) return false;
  // an audio-only sidecar: .m4a/.opus/.aac, or a .webm next to an .mp4 twin
  const isAudio = (f) => /\.(m4a|opus|aac)$/i.test(f)
    || (/\.webm$/i.test(f) && files.some((g) => /\.f\d+\.(mp4|mkv)$/i.test(g)));
  const video = files.find((f) => /\.(mp4|mkv)$/i.test(f) && !isAudio(f));
  const audio = files.find((f) => f !== video && isAudio(f));
  if (video && audio) {
    await new Promise((resolve, reject) => {
      const p = spawn(FF_BIN, [
        '-y', '-v', 'error',
        '-i', path.join(dir, video),
        '-i', path.join(dir, audio),
        '-c', 'copy', '-movflags', '+faststart', out,
      ], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`merge exited ${code}: ${err.slice(-300)}`))));
    });
    for (const f of files) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
    return fs.existsSync(out);
  }
  if (video) {
    fs.renameSync(path.join(dir, video), out);
    for (const f of files) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
    return true;
  }
  return false;
}

/**
 * yt-dlp download. Several passes: 1080p if it fits ~1.5 GB (a better upscale
 * for a 9:16 crop), then 720p / 480p for anything bigger. --no-playlist keeps a
 * channel link from pulling a whole library into the runner.
 */
async function downloadWithYtDlp(bin, url, out) {
  let lastErr = null;
  const tries = MAX_HEIGHT
    ? [{ h: MAX_HEIGHT, size: 1500 }]
    : [{ h: 1080, size: 1500 }, { h: 720, size: 700 }, { h: 480, size: 500 }];
  for (const t of tries) {
    try {
      log(`yt-dlp: trying height<=${t.h}`);
      await new Promise((resolve, reject) => {
        const p = spawn(bin, [
          '--no-playlist', '--no-mtime',
          '--merge-output-format', 'mp4',
          '--ffmpeg-location', FF_BIN,
          '-f', `bv*[height<=${t.h}]+ba/b[height<=${t.h}]/b`,
          '--max-filesize', `${t.size}M`,
          '--retries', '4', '--fragment-retries', '10',
          '-o', out, url,
        ], { windowsHide: true });
        let err = '';
        p.stderr.on('data', (d) => {
          const s = d.toString();
          if (err.length < 4000) err += s;
          process.stderr.write(s);
        });
        p.stdout.on('data', (d) => process.stdout.write(d));
        p.on('error', reject);
        p.on('close', (code) => {
          if (code !== 0) {
            if (/larger than max-filesize/i.test(err)) return reject(new Error(`TOOBIG:${t.h}`));
            if (/sign in to confirm|not a bot|cookies|private video|members-only/i.test(err)) {
              return reject(new Error(`the site blocked this downloader (bot check / login needed). Upload the video from your phone instead, or use a direct mp4 link. ${err.slice(-300)}`));
            }
            return reject(new Error(`yt-dlp exited ${code}: ${err.slice(-400)}`));
          }
          consolidateOutput(out)
            .then((ok) => (ok ? resolve() : reject(new Error('yt-dlp produced no video file'))))
            .catch(reject);
        });
      });
      return out;
    } catch (err) {
      const msg = String(err.message || err);
      lastErr = err;
      if (msg.startsWith('TOOBIG:')) { log(`too big for ${msg.slice(7)}p cap, dropping quality`); continue; }
      if (/blocked this downloader/i.test(msg)) throw err; // no point retrying other heights
      log(`yt-dlp attempt failed: ${msg.slice(0, 200)}`);
      continue;
    }
  }
  throw lastErr || new Error('yt-dlp failed');
}

async function resolveTmpfiles(url) {
  const u = new URL(url);
  if (!/^tmpfiles\.org$/i.test(u.hostname)) return null;
  if (u.pathname.startsWith('/dl/')) return url;
  log(`tmpfiles page: ${url}`);
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`tmpfiles page ${res.status}`);
  const html = await res.text();
  const m = /class="download"[^>]*href="(https:\/\/tmpfiles\.org\/dl\/[^"]+)"/i.exec(html)
    || /(https:\/\/tmpfiles\.org\/dl\/[^"'\s]+)/.exec(html);
  if (!m) throw new Error('tmpfiles page has no /dl/ link (expired?)');
  return m[1].replace(/&amp;/g, '&');
}

async function download(url, out) {
  const headers = { 'user-agent': UA, accept: '*/*' };
  if (/tmpfiles\.org/.test(url)) headers.referer = 'https://tmpfiles.org/';
  if (/api\.github\.com\/.*\/releases\/assets\//.test(url)) {
    headers.accept = 'application/octet-stream';
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  }

  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const type = res.headers.get('content-type') || '';
      const len = Number(res.headers.get('content-length') || 0);
      if (/text\/html/i.test(type)) {
        const peek = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
        throw new Error(`got an HTML page instead of a video (${peek.slice(0, 120)})`);
      }
      const tmp = `${out}.part`;
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      const size = fs.statSync(tmp).size;
      if (size < 100 * 1024) throw new Error(`file too small (${size} bytes) — link probably expired`);
      if (len && Math.abs(size - len) > 1024 * 1024) throw new Error(`short read ${size}/${len}`);
      fs.renameSync(tmp, out);
      log(`downloaded ${(size / 1e6).toFixed(1)} MB (${type || 'unknown type'})`);
      return size;
    } catch (err) {
      lastErr = err;
      log(`attempt ${attempt} failed: ${err.message}`);
      // Permanent failures: a webpage instead of a file, or a 4xx that more
      // retries cannot fix. Only network/5xx problems deserve another attempt.
      const permanent = /HTML page|too small|HTTP 4(?!29)/.test(err.message);
      if (attempt < 4 && !permanent) await new Promise((r) => setTimeout(r, attempt * 8000));
      else if (permanent) break;
    }
  }
  throw lastErr;
}

try {
  let direct = null;
  let ytdlpHit = false;
  if (isSiteUrl(URL_IN)) {
    const bin = await findYtDlp();
    if (bin) {
      log(`video site link: ${URL_IN.replace(/[?&](token|sig|jwt)=[^&]+/g, '$1=***')}`);
      await downloadWithYtDlp(bin, URL_IN, OUT);
      ytdlpHit = true;
    } else {
      throw new Error('video-site link (YouTube etc.) needs yt-dlp, which is not installed on this runner. Upload the video from your phone or paste a direct mp4 link.');
    }
  } else {
    direct = (await resolveTmpfiles(URL_IN)) || URL_IN;
    log(`source: ${direct.replace(/[?&](token|sig|jwt)=[^&]+/g, '$1=***')}`);
  }
  const size = ytdlpHit ? fs.statSync(OUT).size : await download(direct, OUT);
  const head = Buffer.alloc(12);
  const fd = fs.openSync(OUT, 'r');
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  const ascii = head.toString('latin1');
  const looksMp4 = ascii.slice(4, 8) === 'ftyp';
  const looksMkv = ascii.slice(0, 4).toString('hex') === '1a45dfa3';
  if (!looksMp4 && !looksMkv) throw new Error(`not a video container (${ascii.slice(0, 8).replace(/[^\x20-\x7e]/g, '.')})`);
  log(`ok: ${OUT} ${(size / 1e6).toFixed(1)} MB`);
} catch (err) {
  console.error(`fetch-source failed: ${err.message}`);
  process.exit(1);
}
