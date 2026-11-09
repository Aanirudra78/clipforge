#!/usr/bin/env node
/**
 * Upload a source video to a GitHub release from the PC (no CORS, no 100 MB
 * temp-host limit). The phone page can then take the printed link, or the
 * workflow can take the asset id.
 *
 *   $env:GITHUB_TOKEN = 'github_pat_...'
 *   node scripts/push-source.mjs --repo owner/clipforge --file .\podcast.mp4
 *
 * Creates tag `source-<timestamp>`, uploads the file, and prints:
 *   asset url      https://api.github.com/repos/.../releases/assets/<id>
 *   release tag    source-<timestamp>   (pass as source_release_tag to delete it after the render)
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);

const TOKEN = args.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const REPO = args.repo || process.env.GITHUB_REPO || '';
const FILE = path.resolve(args.file || '');
if (!TOKEN || !REPO || !FILE || !fs.existsSync(FILE)) {
  console.error('usage: GITHUB_TOKEN=... node scripts/push-source.mjs --repo owner/name --file video.mp4');
  process.exit(2);
}

const API = 'https://api.github.com';
const tag = args.tag || `source-${Math.floor(Date.now() / 1000)}`;
const name = path.basename(FILE);
const size = fs.statSync(FILE).size;
if (size > 2 * 1024 * 1024 * 1024) {
  console.error(`${name} is over GitHub's 2 GB per-asset limit — use a direct link instead.`);
  process.exit(1);
}

const headers = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'clipforge-push-source',
};

async function call(method, url, body, extra = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; } }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data?.message || ''}`);
  return data;
}

try {
  console.log(`repo ${REPO} · ${name} · ${(size / 1e6).toFixed(1)} MB`);
  const release = await call('POST', `${API}/repos/${REPO}/releases`, {
    tag_name: tag,
    name: `source · ${name}`,
    body: 'Temporary source video. Delete after the render.',
    draft: false,
    prerelease: true,
  });

  const body = fs.readFileSync(FILE);
  const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      accept: 'application/vnd.github+json',
    },
    body,
  });
  const asset = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`upload → ${res.status} ${asset?.message || ''}`);

  console.log('');
  console.log('done.');
  console.log(`  asset id      ${asset.id}`);
  console.log(`  asset url     ${asset.url}`);
  console.log(`  browser link  ${asset.browser_download_url}`);
  console.log(`  release tag   ${tag}`);
  console.log('');
  console.log('Phone page → "Link paste karo" me asset url ya browser link daalo.');
  console.log(`Workflow input source_release_tag = ${tag} (render ke baad apne aap delete).`);
} catch (err) {
  console.error(`push-source failed: ${err.message}`);
  process.exit(1);
}
