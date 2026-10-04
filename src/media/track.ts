/** Low-resolution motion-centroid tracking (for comp.reframe with track: true). */
import { fail } from '../core/errors.js';
import type { Rate } from '../core/time.js';
import { getFfmpeg } from './ffmpeg.js';
import { probe } from './probe.js';
import { run } from './proc.js';

export interface TrackOptions {
  /** samples per second (default 5) */
  fps?: number;
  /** source in-point and length, in frames at `rate` */
  inFrames: number;
  lenFrames: number;
  rate: Rate;
  /** analysis size (default 64x36) */
  size?: [number, number];
  /** smoothing radius in samples (default 2) */
  smooth?: number;
}

export interface TrackPoint { /** clip-local frame at `rate` */ frame: number; x: number; y: number }

/** Weighted centroid of one grey frame: motion (difference to the previous frame) weighted by brightness, falling back to brightness. */
export function centroid(cur: Uint8Array, prev: Uint8Array | null, w: number, h: number): { x: number; y: number; weight: number } {
  let sx = 0, sy = 0, sw = 0, bx = 0, by = 0, bw = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const lum = cur[i]! / 255;
      const b = lum * lum;
      bx += (x + 0.5) * b; by += (y + 0.5) * b; bw += b;
      if (prev) {
        const d = Math.abs(cur[i]! - prev[i]!) / 255;
        if (d > 0.04) { const wgt = d * (0.5 + lum); sx += (x + 0.5) * wgt; sy += (y + 0.5) * wgt; sw += wgt; }
      }
    }
  }
  if (sw > 0.002 * w * h) return { x: sx / sw / w, y: sy / sw / h, weight: sw };
  if (bw > 0) return { x: bx / bw / w, y: by / bw / h, weight: 0 };
  return { x: 0.5, y: 0.5, weight: 0 };
}

export function smoothPoints(pts: { x: number; y: number }[], r: number): { x: number; y: number }[] {
  return pts.map((_, i) => {
    let sx = 0, sy = 0, sw = 0;
    for (let k = -r; k <= r; k++) {
      const p = pts[i + k];
      if (!p) continue;
      const wgt = r + 1 - Math.abs(k);
      sx += p.x * wgt; sy += p.y * wgt; sw += wgt;
    }
    return { x: sx / sw, y: sy / sw };
  });
}

/** Normalised (0..1) centroid of the moving / bright subject, sampled `fps` times a second over the clip's source range. */
export async function trackMotion(file: string, opts: TrackOptions): Promise<TrackPoint[]> {
  const ff = await getFfmpeg();
  const info = await probe(file);
  if (!info.hasVideo) fail('E_MEDIA', `${file} has no video to track.`, 'track a video asset.');
  const fps = opts.fps ?? 5;
  const [w, h] = opts.size ?? [64, 36];
  const start = (opts.inFrames * opts.rate.den) / opts.rate.num;
  const dur = (opts.lenFrames * opts.rate.den) / opts.rate.num;
  if (!(dur > 0)) return [];
  const r = await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-threads', '2', ...(start > 0 ? ['-ss', start.toFixed(6)] : []), '-t', dur.toFixed(6), '-i', file,
    '-an', '-vf', `fps=${fps},scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { what: `tracking motion in ${file}` });
  const n = Math.floor(r.stdout.length / (w * h));
  const raw: { x: number; y: number }[] = [];
  let prev: Uint8Array | null = null;
  for (let i = 0; i < n; i++) {
    const cur = new Uint8Array(r.stdout.buffer, r.stdout.byteOffset + i * w * h, w * h);
    raw.push(centroid(cur, prev, w, h));
    prev = cur;
  }
  // the first sample has no previous frame: borrow the second's motion estimate
  if (raw.length > 1) raw[0] = raw[1]!;
  const sm = smoothPoints(raw, opts.smooth ?? 2);
  return sm.map((p, i) => ({
    frame: Math.min(opts.lenFrames - 1, Math.round((i / fps) * opts.rate.num / opts.rate.den)),
    x: Math.round(p.x * 1000) / 1000,
    y: Math.round(p.y * 1000) / 1000,
  }));
}
