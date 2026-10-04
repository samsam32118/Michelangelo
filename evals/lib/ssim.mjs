// SSIM through ffmpeg's ssim filter: between frames of videos/images, or between decoded RGBA images.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegLog } from './util.mjs';
import { probe } from './probe.mjs';

const parse = (log) => {
  const m = /All:([0-9.]+)/.exec(log);
  return m ? Number(m[1]) : 0;
};

/**
 * SSIM (0..1, luma+chroma "All") between `a` at time ta and `b` at time tb (images ignore the time),
 * both scaled to `width` x `height` (default: b's size). Returns 0 when either input cannot be decoded.
 */
export async function ssim(a, b, { ta = 0, tb = 0, width, height } = {}) {
  const [pa, pb] = await Promise.all([probe(a), probe(b)]);
  if (!pa?.video || !pb?.video) return 0;
  const W = width ?? pb.displayWidth, H = height ?? (width ? Math.round((width / pb.displayWidth) * pb.displayHeight / 2) * 2 : pb.displayHeight);
  const seek = (p, t) => (p.duration > 0.1 && !/^(png|mjpeg)$/.test(p.video.codec) ? ['-ss', String(t)] : []);
  try {
    const log = await ffmpegLog([...seek(pa, ta), '-i', a, ...seek(pb, tb), '-i', b, '-filter_complex',
      `[0:v]scale=${W}:${H}:flags=bicubic,format=yuv444p[x];[1:v]scale=${W}:${H}:flags=bicubic,format=yuv444p[y];[x][y]ssim`, '-frames:v', '1', '-f', 'null', '-']);
    return parse(log);
  } catch { return 0; }
}

/** SSIM between two in-memory RGBA images of the same size. */
export async function ssimImages(x, y) {
  if (!x || !y || x.width !== y.width || x.height !== y.height) return 0;
  const dir = mkdtempSync(join(tmpdir(), 'mgl-ssim-'));
  try {
    const fa = join(dir, 'a.rgba'), fb = join(dir, 'b.rgba');
    writeFileSync(fa, x.data); writeFileSync(fb, y.data);
    const raw = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${x.width}x${x.height}`];
    const log = await ffmpegLog([...raw, '-i', fa, ...raw, '-i', fb, '-filter_complex', '[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim', '-frames:v', '1', '-f', 'null', '-']);
    return parse(log);
  } catch { return 0; } finally { rmSync(dir, { recursive: true, force: true }); }
}
