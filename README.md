# ClipForge

Long landscape videos in (podcasts, lectures, streams) → vertical 1080×1920 shorts
with tracked speaker + word-by-word Hinglish captions out. Everything renders on
your own machine; nothing is uploaded except audio for transcription.

## Run it

```powershell
cd C:\Users\sanir\Music\web\clipping
npm start
```

Open <http://localhost:4400>. From your phone on the same Wi-Fi use the LAN URL
printed in the console (`http://<your-ip>:4400`) — rendering still happens on the PC.

First boot takes a moment: it probes ffmpeg/nvenc and opens `data/clipforge.db`.

## Phone / cloud (free, PC off)

`CLOUD.md` explains the zero-cost route: the page in `cloud/` is published to
GitHub Pages, the phone uploads a source video (or pastes a YouTube / TikTok /
Twitch link — the runner downloads it with yt-dlp), `render.yml` renders it on a
GitHub Actions runner (public repo = unlimited minutes) and publishes a
`render-<run_number>` release the page downloads and deletes. The same pipeline
runs headless: `node scripts/cloud-render.mjs --src video.mp4 --out out`.

Two modes, chosen on the page or with `--mode`:

- **podcast** (default) — speech-driven highlights, b-roll cards, music bed.
- **gaming** — `server/highlights.js` picks the loudest action windows (RMS
  energy vs the 60 s neighbourhood, scene-cut density, snapped to cuts/silence,
  2 s padding), the whole frame stays on the card (facecam + HUD), and a
  `zoompan` punch-in fires on each audio peak. Music and b-roll are off;
  captions render only when the transcript looks like real commentary — pure
  gameplay (sparse or garbled ASR) comes out caption-free. Output fps follows
  the source but is capped by `--max-fps` (default 30).

## What happens on a run

1. **probe** — duration, resolution, fps, rotation.
2. **audio analysis** — 100 ms RMS energy + silence detection (`silencedetect`).
3. **transcription** — Groq `whisper-large-v3-turbo`, word timestamps, chunked for
   long files, cached in `data/cache`. Whisper sometimes re-decodes a stretch of a
   pause-free file, leaving two overlapping word runs — those are deduped so the
   timeline is monotonic.
4. **romanisation** — every Devanagari/Urdu word becomes the Roman Hinglish spelling
   creators use (`पैसा → paisa`, `سین → scene`), word order and timings untouched.
   English loanwords written in Hindi/Urdu script are restored to real English
   spelling, so captions never show Devanagari or Arabic script.
5. **speaker tracking** — skin-tone blob detection at 4 fps, blobs ranked by
   face-likeness (height in frame, aspect, brightness, solidity) so warm furniture
   doesn't win; smoothed into ~1 node/second and turned into a crop `x`/`y` expression.
   Low confidence ⇒ that run falls back to blur-pad framing automatically.
6. **moment picking** — an LLM reads a numbered transcript index and returns
   self-contained 18–42 s moments (`from`/`to` sentences plus the exact opening and
   closing words), a hook title and a one-line reason. Picks are snapped to word
   timestamps, cold-start-walked so a clip never opens on "aur / us / lekin", moved
   forward off a leading connector, deduped and spread across the source. A second
   pass re-reads the words *around* every cut and fixes bad openings. If the model
   fails, the audio-energy heuristic takes over.
7. **topic b-roll** — per clip, the words the speaker actually says are mined for
   concrete topics. The planner lays out 2–4 deterministic slots over the speech
   (evenly spread, 2.4 s each), and Groq answers "what should we see here?" for
   every slot; a word-frequency pass answers slots the model leaves blank. Queries
   are validated against a filmable-noun vocabulary (`broll/nouns.js`) so garbled
   ASR words are refused instead of returning random footage. Each slot gets a
   licensed asset from Coverr (video), Openverse (CC photos) or Pexels (with
   `PEXELS_API_KEY`), cached in `data/broll` with its ledger of source/licence. The
   blurb bed stays untouched: inside the window the **video card itself** shows the
   topic for 1.3–3.4 s (stills get a slow push-in), then the speaker comes back. No
   usable footage ⇒ an opaque text card with the spoken phrase is drawn in the same
   slot, never just the blur.
8. **punch framing** — the sharp video card (`punch`, default 1.3× output width)
   floats over a blurred, darkened copy of the frame and follows the tracked face, so
   nothing is hard-cropped and the captions sit in the bed underneath.
9. **render** — card + bed → 1080×1920 → ASS captions (libass, relative `fontsdir`)
   → H.264 (`h264_nvenc` when it actually works, libx264 fallback) + AAC, faststart.
   Caption chunks get monotonic, non-overlapping word slots (≥120 ms each) so text
   never flickers or double-draws.
10. **thumbnails** + SQLite records, live progress over SSE.

## Options

| Setting | Values |
| --- | --- |
| caption style | `pop` (2–3 words, active word pops), `karaoke` (line fills word by word), `box` (quiet lower third), `neon` (glow punch) |
| accent | yellow, cyan, green, pink, orange |
| framing | `auto` (tracked punch-in), `blur` (blur-pad), `stack` (split-screen), `center` |
| punch-in | 1.1–1.6× card size over the blurred bed (default 1.3) |
| Ken Burns | off by default; slider adds a slow push-in |
| caption height / size | 0.55–0.92 of frame height, 70–140% |
| hook title | static top title with fade, auto-filled from the model's hook |
| clip count | 3–12 (`minLen` 18 s / `maxLen` 42 s per clip) |

B-roll is on by default and rides on the `punch`/`blur` card (`stack`/`center`
framing have no card slot). `CLIPFORGE_BROLL=off` in `.env` turns it off; adding
a `PEXELS_API_KEY` upgrades video quality (Coverr + Openverse need no key).

## API

```
GET    /api/health
GET    /api/projects
POST   /api/projects                 multipart: video, options, name
GET    /api/projects/:id
POST   /api/projects/:id/rerun
DELETE /api/projects/:id
GET    /api/projects/:id/zip         all finished clips as one .zip
POST   /api/clips/:id/render         re-render with new settings
DELETE /api/clips/:id
GET    /api/clips/:id/file           range-streamed mp4
GET    /api/clips/:id/download
GET    /api/thumbs/:id
GET    /api/events                   SSE: progress / project / clip / log / done
```

## Layout

```
server/
  index.js      express routes, upload, range streaming, zip, SSE
  config.js     paths, ffmpeg discovery, .env
  media.js      spawn wrapper, probe, encoder pick, progress parser
  db.js         node:sqlite schema + queries (no native build)
  analyze.js    audio energy/silence, scene cuts, subject tracker
  transcribe.js Groq chunked transcription + cache
  translit.js   Devanagari/Urdu → Roman Hinglish (LLM + deterministic fallback)
  select.js     speech units, dedupe, scoring, heuristic clip picking
  curate.js     LLM moment picking, phrase snapping, cut refinement
  captions.js   ASS templates (styles, karaoke tags, animated progress bar, text cards)
  render.js     ffmpeg filter graph, crop/pan expressions, b-roll overlays, thumbnail
  broll/
    keywords.js deterministic slots + Groq slot labels (+ word-frequency fallback)
    nouns.js    filmable-noun vocabulary that validates every search query
    index.js    asset search/download/cache (Coverr, Openverse, Pexels, Commons)
  jobs.js       queue worker + pipeline orchestration
  zip.js        streaming store-only zip writer
public/         index.html, styles.css, app.js (no build step)
assets/fonts/   Anton, Montserrat ExtraBold, Arial Black, Arial, Impact, Segoe UI Bold
data/           uploads, clips, thumbs, cache, work (gitignored)
```

## Notes / gotchas baked in

- `ffmpeg-static`'s binary must be executable — if npm ships a broken one, copy a
  known-good build over `node_modules/ffmpeg-static/ffmpeg.exe`.
- `fontsdir` must be **relative** to the render workdir (`../../../assets/fonts`);
  absolute `C\:` paths get eaten by the filter parser.
- ffmpeg output path must be **absolute** when running with `cwd` set.
- `drawbox`'s `t` is thickness, not time — the progress bar is drawn in ASS with
  `\t(...\fscx)` instead.
- Failed ffmpeg runs dump their full command + stderr to `data/work/_errors/`.
- Fonts with `.woff2` in `assets/fonts` break libass (`Error opening memory font`).
- `h264_nvenc` is test-encoded on boot; if CUDA is unavailable the encoder falls back
  to libx264 and the run is re-tried once on CPU.
- Word timestamps from ASR can overlap by a few frames; caption slots are rebuilt so
  each word owns a strictly increasing window (this is what stops flashing text).

## Deploy later (VPS)

```bash
docker compose up -d --build
```

The image installs Debian's ffmpeg (CPU encode, `HWACCEL=cpu`), mounts `./data`, and
reads the same `.env`. Set `CLIPFORGE_PASSWORD` before exposing it publicly — the
app then requires the `x-clipforge-key` header (or `?k=`).
