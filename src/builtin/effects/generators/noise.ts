import { defineGenerator, z } from '../../../plugin/api.js';
import { colorList, hash32, rgbaOf } from '../util.js';

const lattice = (seed: number, x: number, y: number, t: number) => hash32(seed, x, y, t) / 4294967296;
const fade = (t: number) => t * t * (3 - 2 * t);

/** Smooth 3-D value noise in 0..1. */
function valueNoise(seed: number, x: number, y: number, t: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), t0 = Math.floor(t);
  const fx = fade(x - x0), fy = fade(y - y0), ft = fade(t - t0);
  const plane = (tt: number) => {
    const a = lattice(seed, x0, y0, tt), b = lattice(seed, x0 + 1, y0, tt);
    const c = lattice(seed, x0, y0 + 1, tt), d = lattice(seed, x0 + 1, y0 + 1, tt);
    return a + (b - a) * fx + (c - a + (d - c - b + a) * fx) * fy;
  };
  const p0 = plane(t0);
  return p0 + (plane(t0 + 1) - p0) * ft;
}

export default defineGenerator({
  type: 'noise',
  describe: 'Animated smooth noise field (clouds, smoke, grain-field backgrounds) mapped onto a colour ramp.',
  params: z.object({
    scale: z.number().min(2).max(4000).default(160).describe('feature size in px'),
    speed: z.number().min(0).max(20).default(0.5).describe('how fast the field evolves (cycles per second)'),
    seed: z.number().int().default(0),
    octaves: z.number().int().min(1).max(6).default(3),
    colors: colorList(['#000000', '#ffffff']),
  }),
  draw({ dst, params: p, time, seed }) {
    const w = dst.width, h = dst.height;
    // the field is smooth at `scale`, so sample it on a coarse grid and let the upscale interpolate
    const step = Math.max(1, Math.min(8, Math.floor(p.scale / 12)));
    const gw = Math.ceil(w / step) + 1, gh = Math.ceil(h / step) + 1;
    const small = dst.scratch(gw, gh), d = small.pixels();
    const ramp = p.colors.map((c) => rgbaOf(dst, c)), n = ramp.length - 1;
    const s = hash32(seed, p.seed), t = time * p.speed;
    let norm = 0;
    for (let o = 0; o < p.octaves; o++) norm += 0.5 ** o;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let v = 0, f = 1 / p.scale, amp = 1;
      for (let o = 0; o < p.octaves; o++) {
        v += amp * valueNoise(s + o, x * step * f, y * step * f, t + o * 7.31);
        f *= 2; amp *= 0.5;
      }
      const q = Math.min(0.99999, Math.max(0, v / norm)) * n, k = Math.floor(q), u = q - k, A = ramp[k]!, B = ramp[k + 1]!;
      const i = (y * gw + x) * 4;
      for (let ch = 0; ch < 4; ch++) d[i + ch] = A[ch]! + (B[ch]! - A[ch]!) * u;
    }
    small.commit();
    dst.ctx.save();
    dst.ctx.imageSmoothingEnabled = true;
    dst.ctx.imageSmoothingQuality = 'high';
    dst.ctx.drawImage(small.canvas, 0, 0, gw * step, gh * step);
    dst.ctx.restore();
  },
});
