import { defineEffect, z } from '../../../plugin/api.js';
import { rgbaOf, color } from '../util.js';

const INF = 1e20;

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher) of f[off + i·stride], i < n, in place. */
function edt1(f: Float32Array, off: number, stride: number, n: number, d: Float32Array, v: Int32Array, z: Float32Array): void {
  const F = (i: number) => f[off + i * stride]!;
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const fq = F(q) + q * q;
    let p = v[k]!, s = (fq - (F(p) + p * p)) / (2 * (q - p));
    while (s <= z[k]!) { k--; p = v[k]!; s = (fq - (F(p) + p * p)) / (2 * (q - p)); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    d[q] = (q - p) * (q - p) + F(p);
  }
  for (let q = 0; q < n; q++) f[off + q * stride] = d[q]!;
}

/** Squared Euclidean distance of every pixel to the nearest pixel with alpha ≥ 128. */
export function distanceField(alpha: Uint8ClampedArray, w: number, h: number): Float32Array {
  const f = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = alpha[i * 4 + 3]! >= 128 ? 0 : INF;
  const n = Math.max(w, h), d = new Float32Array(n), v = new Int32Array(n), z = new Float32Array(n + 1);
  for (let x = 0; x < w; x++) edt1(f, x, w, h, d, v, z);
  for (let y = 0; y < h; y++) edt1(f, y * w, 1, w, d, v, z);
  return f;
}

export default defineEffect({
  type: 'stroke',
  describe: 'Outline around the layer\'s visible shape (its alpha), width px outside the edge.',
  params: z.object({
    width: z.number().min(0).max(200).default(4),
    color: color('#ffffff'),
    opacity: z.number().min(0).max(1).default(1),
  }),
  margin: (p) => Math.ceil(p.width) + 1,
  draw({ src, dst, params: p }) {
    if (p.width > 0 && p.opacity > 0) {
      const w = src.width, h = src.height, [r, g, b, ca] = rgbaOf(src, p.color);
      const f = distanceField(src.pixels(), w, h), d = dst.pixels(), k = (ca / 255) * p.opacity * 255, lim = (p.width + 1) ** 2;
      for (let i = 0; i < f.length; i++) {
        const dd = f[i]!;
        if (dd > lim) continue;
        const a = Math.min(1, Math.max(0, p.width + 0.5 - Math.sqrt(dd)));
        if (a <= 0) continue;
        const j = i * 4;
        d[j] = r; d[j + 1] = g; d[j + 2] = b; d[j + 3] = a * k;
      }
      dst.commit();
    }
    dst.ctx.drawImage(src.canvas, 0, 0);
  },
});
