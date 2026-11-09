#!/usr/bin/env node
/**
 * Download the source video for a cloud render.
 *
 *   node scripts/fetch-source.mjs --url <url> --out source.mp4 [--token $GITHUB_TOKEN]
 *
 * Understands three kinds of input:
 *   - a direct file URL
 *   - a tmpfiles.org *page* URL (the phone uploads there; the real file link is
 *     a tokenised /dl/... path that only exists inside the page HTML)
 *   - a GitHub release asset API URL (needs --token for private repos)
 *
 * Fails loudly instead of handing ffmpeg an HTML error page.
 */
import fs from 'node:fs';
import path from 'node:path';
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
const TOKEN = args.token || process.env.GITHUB_TOKEN || '';
if (!URL_IN) {
  console.error('missing --url');
  process.exit(2);
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
const log = (m) => console.log(m);

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
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 8000));
    }
  }
  throw lastErr;
}

try {
  const direct = (await resolveTmpfiles(URL_IN)) || URL_IN;
  log(`source: ${direct.replace(/[?&](token|sig|jwt)=[^&]+/g, '$1=***')}`);
  const size = await download(direct, OUT);
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
