import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG, FFPROBE, DIRS } from './config.js';

export function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: opts.cwd, windowsHide: true });
    let out = '';
    let err = '';
    let outBytes = 0;
    p.stdout.on('data', (d) => {
      outBytes += d.length;
      if (opts.onStdout) opts.onStdout(d);
      else if (out.length < 5e6) out += d.toString();
    });
    p.stderr.on('data', (d) => {
      const s = d.toString();
      if (err.length < 5e6) err += s;
      if (opts.onStderr) opts.onStderr(s);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0 || opts.allowFail) return resolve({ code, stdout: out, stderr: err, bytes: outBytes });
      try {
        const dir = path.join(DIRS.work, '_errors');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `err-${Date.now()}.log`), `cmd: ${bin} ${args.join(' ')}\n\n${err}`);
      } catch {}
      reject(new Error(`${bin.split(/[\\/]/).pop()} exited ${code}\n${err.slice(-1800)}`));
    });
  });
}

export const ff = (args, opts) => run(FFMPEG, ['-hide_banner', '-nostdin', ...args], opts);

export async function probe(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  let fps = 30;
  if (v?.avg_frame_rate && v.avg_frame_rate !== '0/0') {
    const [n, d] = v.avg_frame_rate.split('/').map(Number);
    if (n && d && n / d > 1) fps = n / d;
  }
  const rotation = Math.abs(Number(v?.tags?.rotate || 0)) % 180;
  const rotated = rotation === 90;
  return {
    duration: Number(j.format?.duration || 0),
    width: Number((rotated ? v?.height : v?.width) || 0),
    height: Number((rotated ? v?.width : v?.height) || 0),
    fps: Math.min(60, Math.round(fps * 100) / 100),
    bitrate: Number(j.format?.bit_rate || 0),
    hasAudio: Boolean(a),
    hasVideo: Boolean(v),
    codec: v?.codec_name || '',
    size: Number(j.format?.size || 0),
  };
}

let encoderCache = null;
let cpuSticky = false;
let probeFailedAt = 0;
const PROBE_RETRY_MS = 60_000;

const CPU = {
  name: 'libx264',
  args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'],
  previewArgs: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p'],
};

// Hardware encoders, best first. The probe below only trusts one that actually
// encodes a frame — every build lists GPUs it cannot use (no NVIDIA here).
//
// AMF (Radeon iGPU) is deliberately NOT in this list: measured on this laptop
// with the real 1080x1920 graph it is *slower* than x264 veryfast
// (13.6s vs 9.0s for a 21.5s clip, and 25 % bigger files) because every frame
// has to be uploaded to the GPU first. Opt in with HWACCEL=amf if a machine
// turns out to be faster that way.
const HARDWARE = [
  {
    name: 'h264_nvenc', // NVIDIA
    args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '21',
      '-maxrate', '12M', '-bufsize', '24M', '-pix_fmt', 'yuv420p'],
    previewArgs: ['-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'vbr', '-cq', '30', '-pix_fmt', 'yuv420p'],
  },
  {
    name: 'h264_qsv', // Intel Quick Sync
    args: ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '20', '-pix_fmt', 'yuv420p'],
    previewArgs: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '30', '-pix_fmt', 'yuv420p'],
  },
  {
    name: 'h264_amf', // AMD Radeon — opt-in only, see note above
    args: ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'quality',
      '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22', '-qp_b', '24', '-pix_fmt', 'yuv420p'],
    previewArgs: ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'speed',
      '-rc', 'cqp', '-qp_i', '28', '-qp_p', '30', '-qp_b', '32', '-pix_fmt', 'yuv420p'],
    optIn: true,
  },
];

/** Forget a broken GPU encoder (driver reset, VM without a device, …). */
export function useCpuEncoder() {
  // A render that just died on the GPU stays on the CPU for this process; a
  // failed startup probe is only temporary (driver still waking up, GPU busy).
  cpuSticky = true;
  encoderCache = CPU;
  return encoderCache;
}

export async function videoEncoder() {
  if (encoderCache) return encoderCache;
  if (process.env.HWACCEL === 'cpu') return useCpuEncoder();
  if (cpuSticky) return CPU;
  // a failed probe is retried later instead of downgrading the whole session
  if (probeFailedAt && Date.now() - probeFailedAt < PROBE_RETRY_MS) return CPU;
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-encoders'], { allowFail: true });
  const want = String(process.env.HWACCEL || '').toLowerCase();
  const listed = HARDWARE
    .filter((h) => stdout.includes(h.name))
    .filter((h) => (h.optIn ? want === h.name.replace('h264_', '') : true));
  if (!listed.length) { probeFailedAt = Date.now(); return CPU; }
  for (const enc of listed) {
    // listed ≠ usable: a wrong-vendor GPU still shows the encoder
    const test = await run(FFMPEG, [
      '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1',
      '-frames:v', '1', ...enc.args, '-f', 'null', '-',
    ], { allowFail: true });
    if (test.code === 0) {
      probeFailedAt = 0;
      encoderCache = enc;
      return encoderCache;
    }
  }
  probeFailedAt = Date.now();
  return CPU;
}

const parseTime = (s) => {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
};

export function progressTracker(totalSeconds, onProgress) {
  let last = 0;
  return {
    onStderr(s) {
      const t = parseTime(s);
      if (t != null && totalSeconds > 0) {
        const p = Math.min(0.999, t / totalSeconds);
        if (p - last > 0.01) { last = p; onProgress?.(p); }
      }
    },
    done() { onProgress?.(1); },
  };
}

export function escFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}
