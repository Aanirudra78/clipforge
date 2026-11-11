# ClipForge Cloud (₹0)

Render clips from your phone while the PC is off.

```
phone browser ──upload──▶ tmpfiles.org (24 h)          [free, no account]
      │
      └──dispatch──▶ GitHub Actions: render.yml
                        ├─ download source
                        ├─ scripts/cloud-render.mjs  (same pipeline as the app)
                        └─ release `render-<run_number>`
      ┌──poll run / download assets / delete release──┘
      ▼
phone browser (GitHub Pages, cloud/index.html)
```

Everything is on free tiers: public repo → unlimited Actions minutes, Pages
hosting, GitHub release storage (2 GB per file, no total quota for releases),
tmpfiles.org for the phone upload (100 MB, 24 h auto-delete).

## One-time setup (10 minutes, on the PC)

1. **Create a public repo** (e.g. `clipforge`) and push this folder:

   ```powershell
   cd C:\Users\sanir\Music\web\clipping
   git init -b main
   git add .
   git commit -m "ClipForge + free cloud render"
   git remote add origin https://github.com/<you>/clipforge.git
   git push -u origin main
   ```

   `data/` is ignored except `data/music/*.mp3` (the CC0 bed the runner needs).

2. **Settings → Pages → Source = GitHub Actions.** The `pages` workflow then
   publishes `cloud/index.html` at `https://<you>.github.io/clipforge/`.

3. **Settings → Secrets and variables → Actions**
   - `GROQ_API_KEY` — required for transcription (free Groq key).
   - `PEXELS_API_KEY` — optional; better b-roll. Without it the planner falls
     back to Openverse / Wikimedia Commons.

4. **Fine-grained PAT** — <https://github.com/settings/personal-access-tokens/new>
   - Repository access: only `clipforge`
   - Permissions: **Actions: read & write**, **Contents: read & write**
     (Metadata: read is automatic)
   - Expiry: as long as you like. The token lives in the phone's localStorage.

## Daily use (phone)

1. Open `https://<you>.github.io/clipforge/`.
2. Save repo + token once, press **Test connection**.
3. Pick the video (≤ 100 MB) → it uploads to tmpfiles with a progress bar.
   Bigger files: use **Paste a link** with a direct URL (see below).
4. Pick a **Mode**:
   - **Podcast / talk** — speech-driven highlights, b-roll inserts, music bed.
   - **Gaming** — audio-peak action highlights: keeps the whole frame (facecam
     + HUD) over a blur bed, punch-ins on the loudest peaks, music and b-roll
     off by default. Captions are added only when real commentary is detected;
     pure gameplay gets none. Works with facecam + commentary and with
     voice-over-only gameplay alike.
5. Choose clips / captions / look / frame rate (30 fast, 60 smooth) →
   **Start render**.
6. Wait ~8–15 min (CPU x264; a 40-min podcast takes longer). You can close the
   page — reopen it and the run is still tracked.
7. Download the ZIP (or clips one by one), then **Delete from GitHub**.

Deleting removes the release and its tag, so the clips stop being public. The
tmpfiles copy of the source expires on its own within 24 h.

## Rendering straight from a YouTube / TikTok / Twitch link

Paste the link in **Paste a link** — no upload needed. The runner installs
[pinned yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) and downloads
(`--no-playlist`, up to 1080p; bigger videos drop to 720p/480p automatically).

- Only **public** videos work. Private, members-only, age-gated or
  login-walled videos are refused with a clear error — fall back to
  uploading the file from the phone.
- YouTube throttles datacenter IPs; the download retries, but if Google's bot
  check blocks the runner, use the upload path.
- The same works from the PC via `scripts/fetch-source.mjs` directly.

## Bigger than 100 MB

Upload from the PC to a GitHub release instead of tmpfiles:

```powershell
$env:GITHUB_TOKEN = 'github_pat_...'
node scripts/push-source.mjs --repo <you>/clipforge --file "D:\video.mp4"
```

It prints an `asset url` (paste in **Link paste karo**) and a `release tag`
(pass it as `source_release_tag` so the render deletes the source release when
it is done). Release assets allow up to **2 GB per file**.

## Running the same pipeline locally

```powershell
node scripts/cloud-render.mjs --src .\video.mp4 --out out --count 4 --title "Bill Gates"
```

Writes `out/clip-NN.mp4`, `out/clip-NN.jpg`, `out/manifest.json`, `out/log.txt`.
Useful flags: `--mode podcast|gaming`, `--broll off`, `--music none`,
`--look none`, `--template pop|karaoke|box|neon`, `--max-fps 30|60`
(output fps follows the source but never above the cap), `--captions auto|on|off`
(gaming only: `auto` drops captions when the speech looks sparse or garbled).
`CF_QUIET=1` keeps transcript-derived text out of the logs (the workflow sets
it, because the repo is public).

To test the whole cloud round-trip from the PC (dispatch → poll → download →
delete), without touching the phone:

```powershell
$env:GITHUB_TOKEN = 'github_pat_...'
node scripts/cloud-run.mjs --repo <you>/clipforge --url "https://.../video.mp4" --out downloads
```

## Limits and gotchas

- **Public repo** → unlimited Actions minutes, but the workflow file, logs and
  releases are public until deleted. `CF_QUIET=1` keeps speech phrases out of
  the log; the release body still carries short hooks. The `source_url` you
  dispatch is visible in the run's event payload while it is alive (≤ 24 h on
  tmpfiles).
- **Private repo** → 2000 minutes/month. CPU rendering a 40-min podcast can
  burn 100+ minutes, and release previews need auth, so public is the free path.
- **tmpfiles.org**: 100 MB max, 24 h retention, download link is scraped from
  the page by `scripts/fetch-source.mjs`. If the runner waits in queue for
  hours, the link can expire — re-upload and retry.
- **Groq free tier** rate-limits long audio. The script retries with backoff,
  but a 2-hour podcast may still fall back to audio-only clip picking.
- **CPU encode** on the runner is ~2–3× slower than the local NVENC path.
  `ubuntu-24.04` is pinned because `ubuntu-latest` moves to 26.04.
- Rendering a 480p source to a 1080×1920 card is soft; b-roll inserts are sharp.
  That is a source-quality limit, not a bug.
- One render at a time: the workflow has `concurrency: render` and the page
  refuses a second dispatch while a run is queued or running.
