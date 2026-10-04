// Decoding with plain ffmpeg: RGB frames, frame sequences, mono PCM, loudness.
import { ff, ffLog, isFile, probe } from './proc.mjs';

/** One RGB frame at time t (seconds), optionally scaled; null when it cannot be decoded. */
export async function frameAt(file, t, { width, height } = {}) {
  if (!isFile(file)) return null;
  const vf = [width ? `scale=${width}:${height}:flags=area` : null, 'format=rgb24'].filter(Boolean).join(',');
  try {
    const args = [...(t > 0 ? ['-ss', String(t)] : []), '-i', file, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-'];
    const r = await ff(args, { timeoutMs: 120_000 });
    const size = await dims(file, width, height);
    if (!size || r.stdout.length < size.w * size.h * 3) return null;
    return { width: size.w, height: size.h, data: r.stdout.subarray(0, size.w * size.h * 3) };
  } catch { return null; }
}

/** A still image file (PNG/JPEG) as RGB, optionally scaled. */
export async function imageRGB(file, opts) { return frameAt(file, 0, opts); }

const dimCache = new Map();
async function dims(file, width, height) {
  if (width && height) return { w: width, h: height };
  if (!dimCache.has(file)) {
    const p = await probe(file);
    dimCache.set(file, p?.video ? { w: p.video.width, h: p.video.height } : null);
  }
  return dimCache.get(file);
}

/**
 * Consecutive frames from t0 for dur seconds, resampled to `fps`, scaled to w x h, as gray (Uint8Array per
 * frame) or rgb. Returns [] when the file cannot be decoded.
 */
export async function frameSeq(file, { t0 = 0, dur, fps, width, height, gray = true } = {}) {
  if (!isFile(file)) return [];
  const vf = [fps ? `fps=${fps}` : null, `scale=${width}:${height}:flags=area`, gray ? 'format=gray' : 'format=rgb24'].filter(Boolean).join(',');
  try {
    const r = await ff([...(t0 ? ['-ss', String(t0)] : []), '-i', file, ...(dur ? ['-t', String(dur)] : []), '-vf', vf, '-an', '-f', 'rawvideo', '-'], { timeoutMs: 300_000 });
    const n = width * height * (gray ? 1 : 3), out = [];
    for (let o = 0; o + n <= r.stdout.length; o += n) out.push(gray ? r.stdout.subarray(o, o + n) : { width, height, data: r.stdout.subarray(o, o + n) });
    return out;
  } catch { return []; }
}

/** Mono float PCM at `rate` (default 48 kHz), or null. */
export async function pcm(file, { rate = 48000, t0, dur } = {}) {
  if (!isFile(file)) return null;
  try {
    const r = await ff([...(t0 ? ['-ss', String(t0)] : []), '-i', file, ...(dur ? ['-t', String(dur)] : []), '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { timeoutMs: 300_000 });
    const b = r.stdout;
    if (b.length < 4) return null;
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.length - (b.length % 4))));
  } catch { return null; }
}

/** Integrated loudness (LUFS) via ebur128, or -Infinity / null on failure. */
export async function loudness(file) {
  if (!isFile(file)) return null;
  try {
    const log = await ffLog(['-i', file, '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { timeoutMs: 300_000 });
    const m = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/i.exec(log);
    if (!m) return null;
    return m[1] === '-inf' ? -Infinity : Number(m[1]);
  } catch { return null; }
}
