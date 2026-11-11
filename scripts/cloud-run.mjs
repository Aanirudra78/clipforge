#!/usr/bin/env node
/**
 * Drive the cloud render from the PC - same flow the phone page uses.
 * Handy for testing the workflow before trusting the phone with it.
 *
 *   $env:GITHUB_TOKEN = 'github_pat_...'
 *   node scripts/cloud-run.mjs --repo you/clipforge --url https://.../video.mp4 --out downloads
 *
 * Options: --count 4 --template pop --look none --music auto --broll on
 *          --title "..." --source-release-tag source-... --keep (do not delete)
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
const SOURCE = args.url || '';
const OUT = path.resolve(args.out || 'downloads');
if (!TOKEN || !REPO || !SOURCE) {
  console.error('usage: GITHUB_TOKEN=... node scripts/cloud-run.mjs --repo owner/name --url <video url>');
  process.exit(2);
}

const API = 'https://api.github.com';
const headers = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'clipforge-cloud-run',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; } }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${data?.message || ''}`);
  return data;
}

try {
  const repo = await api(`/repos/${REPO}`);
  const before = await api(`/repos/${REPO}/actions/runs?per_page=5`);
  // Run numbers are per-workflow (pages and render both start at 1); ids are
  // unique across the repo, so the newest id is the reliable watermark.
  const maxBefore = Math.max(0, ...(before.workflow_runs || []).map((r) => r.id));

  const inputs = {
    source_url: SOURCE,
    mode: args.mode || 'podcast',
    count: String(args.count || '4'),
    template: args.template || 'pop',
    look: args.look || 'none',
    music: args.music || 'auto',
    title: args.title || '',
    broll: args.broll || 'on',
    fps: args.fps || '30',
    source_release_tag: args['source-release-tag'] || '',
  };
  console.log(`dispatch -> ${repo.full_name} (${repo.default_branch})`);
  await api(`/repos/${REPO}/actions/workflows/render.yml/dispatches`, {
    method: 'POST',
    body: { ref: repo.default_branch, inputs },
  });

  let run = null;
  for (let i = 0; i < 40 && !run; i++) {
    await sleep(3000);
    const runs = await api(`/repos/${REPO}/actions/runs?event=workflow_dispatch&per_page=10`);
    run = (runs.workflow_runs || []).find((r) => /render\.yml$/.test(r.path || '') && r.id > maxBefore) || null;
  }
  if (!run) throw new Error('run not found - check the Actions tab');
  console.log(`run #${run.run_number} -> ${run.html_url}`);

  const t0 = Date.now();
  let last = '';
  for (;;) {
    await sleep(10000);
    run = await api(`/repos/${REPO}/actions/runs/${run.id}`);
    const line = `${run.status}${run.conclusion ? ` (${run.conclusion})` : ''} - ${Math.round((Date.now() - t0) / 1000)}s`;
    if (line !== last) { console.log(line); last = line; }
    if (run.status === 'completed') break;
  }
  if (run.conclusion !== 'success') throw new Error(`run ${run.conclusion} - see ${run.html_url}`);

  const rel = await api(`/repos/${REPO}/releases/tags/render-${run.run_number}`);
  fs.mkdirSync(OUT, { recursive: true });
  for (const asset of rel.assets || []) {
    if (!/\.(mp4|jpg|zip|json)$/i.test(asset.name)) continue;
    const file = path.join(OUT, asset.name);
    process.stdout.write(`download ${asset.name} ... `);
    const res = await fetch(asset.url, { headers: { ...headers, accept: 'application/octet-stream' } });
    if (!res.ok) { console.log(`failed ${res.status}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(file, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
  }
  console.log(`saved to ${OUT}`);

  if (args.keep !== 'true') {
    await api(`/repos/${REPO}/releases/${rel.id}`, { method: 'DELETE' });
    await api(`/repos/${REPO}/git/refs/tags/${encodeURIComponent(rel.tag_name)}`, { method: 'DELETE' }).catch(() => {});
    console.log(`release ${rel.tag_name} deleted`);
  }
} catch (err) {
  console.error(`cloud-run failed: ${err.message}`);
  process.exit(1);
}

