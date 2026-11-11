#!/usr/bin/env node
/**
 * Turn out/manifest.json into the release body the phone page reads.
 *
 *   node scripts/release-notes.mjs --manifest out/manifest.json --out body.md --title "Bill Gates"
 *
 * The body is human readable markdown plus one machine block:
 *   <!--CF:{...}-->
 * The page fetches the release, grabs that JSON, and renders the clip cards.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);

const manifest = JSON.parse(fs.readFileSync(args.manifest || 'out/manifest.json', 'utf8'));
const title = (args.title || '').trim() || manifest.source?.name || 'clips';
const mode = manifest.options?.mode || 'podcast';
const fps = manifest.stats?.fps || 30;
const clips = (manifest.clips || []).map((c) => ({
  file: c.file,
  thumb: c.thumb,
  hook: c.hook || '',
  duration: Math.round((c.duration || 0) * 10) / 10,
  visuals: c.visuals || 0,
  music: c.music || '',
  captions: c.captions !== false,
}));

const compact = {
  v: 1,
  title,
  mode,
  created: manifest.created,
  source: {
    name: manifest.source?.name,
    duration: Math.round(manifest.source?.duration || 0),
    w: manifest.source?.width,
    h: manifest.source?.height,
  },
  stats: { clips: clips.length, words: manifest.stats?.words || 0, seconds: manifest.stats?.seconds || 0, fps },
  clips,
};

const lines = [
  `**${title}**`,
  '',
  `${clips.length} clip${clips.length === 1 ? '' : 's'} · mode \`${mode}\` · ${fps} fps · ${compact.stats.seconds}s render`,
  '',
];
for (const c of clips) {
  lines.push(`- \`${c.file}\` · ${c.duration}s${c.visuals ? ` · ${c.visuals} visual${c.visuals === 1 ? '' : 's'}` : ''}${c.captions ? '' : ' · no captions'}${c.hook ? ` · ${c.hook}` : ''}`);
}
lines.push('', `<!--CF:${JSON.stringify(compact)}-->`, '');

const out = args.out || 'body.md';
fs.writeFileSync(out, lines.join('\n'));
console.log(`notes: ${out} (${clips.length} clips)`);
