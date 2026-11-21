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

/**
 * YouTube serves one video at /watch, /live, /shorts, /embed and youtu.be.
 * Feed yt-dlp the canonical watch URL: /live links occasionally resolve to a
 * live-only format set ("Requested format is not available") even after the
 * broadcast has ended, and tracking params (?si=...) change nothing but do
 * make the same video look like a different source upstream.
 */
function canonicalVideoUrl(u) {
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let id = '';
    if (host === 'youtu.be') id = parsed.pathname.slice(1).split('/')[0];
    else if (/(^|\.)youtube\.com$/.test(host)) {
      const m = /^\/(?:live|shorts|embed|v)\/([^/?#]+)/.exec(parsed.pathname);
      id = m ? m[1] : parsed.searchParams.get('v') || '';
    }
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return u;
    const out = new URL('https://www.youtube.com/watch');
    out.searchParams.set('v', id);
    const t = parsed.searchParams.get('t');
    if (t) out.searchParams.set('t', t);
    return out.toString();
  } catch {
    return u;
  }
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
 * Optional YouTube cookies (repo secret YTDLP_COOKIES, netscape format).
 * Google demands login cookies from datacenter IPs - player-client tricks no
 * longer bypass the bot check. The file lives on the ephemeral runner disk
 * only, and is deleted right after the download.
 */
async function cookieArgs(out) {
  const raw = process.env.YTDLP_COOKIES || '';
  if (!raw.trim()) return [];
  const file = path.join(path.dirname(out), 'yt-cookies.txt');
  await fs.promises.writeFile(file, raw.endsWith('\n') ? raw : `${raw}\n`);
  log('using YouTube cookies from the YTDLP_COOKIES secret');

  // Diagnose the cookie jar: YouTube answers a stale/partial export with the
  // same "Sign in to confirm you're not a bot" it gives an anonymous client,
  // which makes a bad export look like an IP block. Log what we actually have.
  const rows = raw.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const now = Math.floor(Date.now() / 1000);
  const names = new Set();
  let expired = 0;
  let session = 0;
  for (const row of rows) {
    const f = row.split('\t');
    if (f.length < 7) continue;
    names.add(f[5]);
    const exp = Number(f[4]) || 0;
    if (!exp) session++;
    else if (exp < now) expired++;
  }
  const KEY = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO', '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID'];
  const have = KEY.filter((n) => names.has(n));
  const missing = KEY.filter((n) => !names.has(n));
  log(`cookies: ${rows.length} entries · ${expired} expired · ${session} session-only · auth cookies: ${have.length}/${KEY.length}`);
  if (missing.length) log(`cookies: MISSING ${missing.join(',')}`);
  if (expired > 0 || missing.length) {
    log('cookies: the jar looks stale/partial - re-export it while logged in (Include session cookies) or YouTube will keep bot-checking');
  }

  return ['--cookies', file, '--no-cookies-from-browser'];
}

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
  // Long live streams are 2-4 GB even at 480p. Fixed caps kept aborting healthy
  // downloads a few MB short, and every aborted attempt made YouTube more likely
  // to bot-check the runner. GitHub runners have ~14 GB free, so let the first
  // (cookie + proxy, best-tested) attempt finish whatever the source size is.
  // Override with YTDLP_MAX_MB_* only if a runner ever gets tight on disk.
  const capHigh = Number(process.env.YTDLP_MAX_MB_HIGH) || 12000;
  const cap720 = Number(process.env.YTDLP_MAX_MB_720) || 8000;
  const cap480 = Number(process.env.YTDLP_MAX_MB_480) || 6000;
  const tries = MAX_HEIGHT
    ? [{ h: MAX_HEIGHT, size: capHigh }]
    : [{ h: 720, size: cap720 }, { h: 480, size: cap480 }];
  // Keep this list SHORT. YouTube treats a burst of client switches from one IP
  // as bot traffic: 18 attempts in five minutes used to get the whole runner
  // range throttled for hours. Three clients, one cookie mode, human-ish pauses.
  const CLIENTS = [
    { name: 'default', args: [] },
    { name: 'ios', args: ['--extractor-args', 'youtube:player_client=ios'] },
    { name: 'tv', args: ['--extractor-args', 'youtube:player_client=tv'] },
  ];
  const JS = ['--js-runtimes', 'node'];
  const BOT = /sign in to confirm|not a bot|HTTP Error 403|video data: HTTP 403|member|private video/i;
  const AGE = /age-restricted|confirm your age|age verification/i;
  const STALE_COOKIES = /cookies are no longer valid|cookie.*rotated/i;
  const RATE = /HTTP Error 429|too many requests/i;
  let ageBlocked = false;
  let staleCookies = false;
  let rateLimited = false;

  const withCookies = await cookieArgs(out);
  const rounds = withCookies.length ? [withCookies] : [[]];
  const PROXY = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];
  const proxySets = PROXY.length ? [PROXY, []] : [[]];

  heights: for (const t of tries) {
    let attempts = 0;
    let blocked = 0;

    for (const cookieSet of rounds) {
      for (const proxySet of proxySets) {
        for (const client of CLIENTS) {
          attempts++;
          const kind = `${client.name}${cookieSet.length ? ' +cookies' : ' (no cookies)'}${proxySet.length ? ' +proxy' : ''}`;
          try {
            log(`yt-dlp: trying height<=${t.h} (client: ${kind})`);
            await new Promise((resolve, reject) => {
              const p = spawn(bin, [
                '--no-playlist', '--no-mtime',
                '--merge-output-format', 'mp4',
                '--ffmpeg-location', FF_BIN,
                '-f', `bv*[height<=${t.h}]+ba/b[height<=${t.h}]/b`,
                '--max-filesize', `${t.size}M`,
                '--retries', '4', '--fragment-retries', '10',
                '--sleep-requests', '2', '--retry-sleep', '5',
                ...proxySet,
                ...cookieSet,
                ...JS,
                ...client.args,
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
                  if (RATE.test(err)) {
                    rateLimited = true;
                    return reject(new Error(`RATE:too many requests (429) ${err.slice(-160)}`));
                  }
                  if (AGE.test(err)) {
              ageBlocked = true;
              return reject(new Error(`AGEBLOCK: age-restricted video (${err.slice(-160)})`));
            }
            if (STALE_COOKIES.test(err)) staleCookies = true;
            if (BOT.test(err)) {
                  return reject(new Error(`BOTCHECK:${client.name} the site blocked this downloader (bot check / login needed). ${err.slice(-200)}`));
                }
                if (/private video|members-only/i.test(err)) {
                  return reject(new Error('BOTCHECK:final this video is private or members-only; only public videos can be downloaded. Upload the file from your phone instead.'));
                }
                return reject(new Error(`yt-dlp exited ${code}: ${err.slice(-400)}`));
              }
              consolidateOutput(out)
                .then((ok) => (ok ? resolve() : reject(new Error('yt-dlp produced no video file'))))
                .catch(reject);
            });
          });
          log(`yt-dlp: worked with client ${kind} at ${t.h}p`);
          return out;
        } catch (err) {
          const msg = String(err.message || err);
          lastErr = err;
          if (msg.startsWith('TOOBIG:')) {
            log(`too big for ${msg.slice(7)}p cap, dropping quality`);
            break heights; // next height
          }
          if (msg.startsWith('AGEBLOCK:')) {
            blocked++;
            log('age-restricted video - trying remaining clients (fresh, age-verified cookies can help)');
            continue;
          }
          if (msg.startsWith('BOTCHECK:')) {
            const who = msg.slice(9, msg.indexOf(' ', 9) || undefined);
            if (who === 'final') throw new Error(msg.slice(msg.indexOf(' ') + 1));
            blocked++;
            log(`${client.name} client is bot-blocked, trying the next player client`);
            continue;
          }
          if (msg.startsWith('RATE:')) {
            blocked++;
            log(`${client.name} client hit a 429 rate-limit`);
            continue;
          }
          log(`yt-dlp attempt failed: ${msg.slice(0, 200)}`);
        }
      }
        }
      }
      // every client/proxy combination was blocked for this height

    // A bot check does not depend on the height cap, so do not repeat the whole
    // matrix for 720p/480p when every single attempt was blocked.
    if (attempts > 0 && blocked === attempts) {
      const cookieHint = staleCookies
        ? ' The YTDLP_COOKIES secret is invalid/rotated - re-export cookies from a logged-in browser.'
        : '';
      if (ageBlocked) {
        throw new Error(
          'This video is age-restricted (18+): YouTube demands a signed-in, age-verified browser session, ' +
            'which a cloud runner cannot provide.' + cookieHint +
            ' Use a non-age-restricted video, or download this one on your PC and upload the file here.'
        );
      }
      throw new Error(
        `YouTube is blocking this runner for every player client (bot check, ${attempts} attempts).` + cookieHint +
          (rateLimited ? ' YouTube is also rate-limiting this IP (429) - a later retry usually works.' : '') +
          ' Upload the video from your phone instead, or paste a direct mp4 link.'
      );
    }
  }
  throw lastErr || new Error('yt-dlp failed');
}

// Google Drive share links are what the phone produces ("Share -> copy link").
// The /view page is HTML; this is the endpoint that actually serves the bytes.
function driveId(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)(drive|docs)\.google\.com$/i.test(u.hostname)) return null;
  const m = /^\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname);
  if (m) return m[1];
  return u.searchParams.get('id');
}

async function resolveDrive(url) {
  const id = driveId(url);
  if (!id) return null;
  log(`google drive file id: ${id}`);
  // confirm=t skips the "Google can't scan this file for viruses" interstitial
  // that large files get; the endpoint streams the original bytes.
  return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
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
      if (size < 1024) throw new Error(`file too small (${size} bytes) — download failed`);
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
  let stitched = false;
  if (isSiteUrl(URL_IN)) {
    const bin = await findYtDlp();
    if (bin) {
      const SITE_URL = canonicalVideoUrl(URL_IN);
      log(`video site link: ${URL_IN.replace(/[?&](token|sig|jwt)=[^&]+/g, '$1=***')}`);
      if (SITE_URL !== URL_IN) log(`canonical url: ${SITE_URL}`);
      await downloadWithYtDlp(bin, SITE_URL, OUT);
      ytdlpHit = true;
      // never leave the cookie file lying around
      try { fs.rmSync(path.join(path.dirname(OUT), 'yt-cookies.txt'), { force: true }); } catch {}
    } else {
      throw new Error('video-site link (YouTube etc.) needs yt-dlp, which is not installed on this runner. Upload the video from your phone or paste a direct mp4 link.');
    }
  } else if (URL_IN.includes(',')) {
    // The phone page splits uploads over 100 MB into ~95 MB parts (tmpfiles
    // caps a single file there) and sends them as a comma-separated URL list.
    // Download every part, concatenate in order, verify the container once.
    stitched = true;
    const parts = URL_IN.split(',').map((s) => s.trim()).filter(Boolean);
    log(`multi-part source: ${parts.length} part(s)`);
    const partFiles = [];
    try {
      for (let i = 0; i < parts.length; i++) {
        const resolved = (await resolveTmpfiles(parts[i])) || parts[i];
        const pf = `${OUT}.cfpart-${String(i).padStart(3, '0')}`;
        log(`part ${i + 1}/${parts.length}: ${resolved.replace(/[?&](token|sig|jwt)=[^&]+/g, '$1=***')}`);
        await download(resolved, pf);
        partFiles.push(pf);
      }
      await pipeline(
        fs.createReadStream(partFiles[0]),
        // append every remaining part, then the first is already in the chain
        fs.createWriteStream(OUT),
      );
      for (const pf of partFiles.slice(1)) {
        await pipeline(fs.createReadStream(pf), fs.createWriteStream(OUT, { flags: 'a' }));
      }
    } finally {
      for (const pf of partFiles) { try { fs.unlinkSync(pf); } catch {} }
    }
    log(`stitched ${partFiles.length} part(s) into ${OUT}`);
  } else {
    direct =
      (await resolveTmpfiles(URL_IN)) || (await resolveDrive(URL_IN)) || URL_IN;
    log(`source: ${direct.replace(/[?&](token|sig|jwt)=[^&]+/g, '$1=***')}`);
  }
  const size = (ytdlpHit || stitched) ? fs.statSync(OUT).size : await download(direct, OUT);
  const head = Buffer.alloc(12);
  const fd = fs.openSync(OUT, 'r');
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  const ascii = head.toString('latin1');
  const looksMp4 = ascii.slice(4, 8) === 'ftyp';
  const looksMkv = ascii.slice(0, 4).toString('hex') === '1a45dfa3';
  if (!looksMp4 && !looksMkv) {
    const hint = /^</.test(ascii)
      ? ' (got an HTML page - for Google Drive set sharing to "Anyone with the link", or use a direct mp4 link)'
      : '';
    throw new Error(
      `not a video container (${ascii.slice(0, 8).replace(/[^\x20-\x7e]/g, '.')})${hint}`
    );
  }
  log(`ok: ${OUT} ${(size / 1e6).toFixed(1)} MB`);
} catch (err) {
  console.error(`fetch-source failed: ${err.message}`);
  process.exit(1);
}
