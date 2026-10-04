import { defineEffect, z } from '../../../plugin/api.js';
import { rgbaOf, smoothstep, color } from '../util.js';

/** BT.709 chroma (Cb, Cr) of 0..255 RGB, scaled so the largest possible distance is about 1. */
const CB = (r: number, g: number, b: number) => (b - (0.2126 * r + 0.7152 * g + 0.0722 * b)) / (1.8556 * 255 * 0.7071);
const CR = (r: number, g: number, b: number) => (r - (0.2126 * r + 0.7152 * g + 0.0722 * b)) / (1.5748 * 255 * 0.7071);

export default defineEffect({
  type: 'chroma-key',
  describe: 'Makes pixels close to the key colour transparent (green/blue screen) and removes colour spill.',
  params: z.object({
    color: color('#00ff00'),
    tolerance: z.number().min(0).max(1).default(0.3).describe('chroma distance keyed fully transparent'),
    softness: z.number().min(0).max(1).default(0.1).describe('chroma distance over which alpha ramps back to opaque'),
    spill: z.number().min(0).max(1).default(1).describe('how much key-colour spill to remove from kept pixels (1 = cap the key channel at the other two)'),
  }),
  draw({ src, dst, params: p }) {
    const [kr, kg, kb] = rgbaOf(src, p.color);
    const kcb = CB(kr, kg, kb), kcr = CR(kr, kg, kb);
    const dom = kg >= kr && kg >= kb ? 1 : kr >= kb ? 0 : 2;
    const o1 = (dom + 1) % 3, o2 = (dom + 2) % 3;
    const lo = p.tolerance, hi = p.tolerance + Math.max(p.softness, 1e-3);
    const s = src.pixels(), d = dst.pixels(), lo2 = lo * lo, hi2 = hi * hi;
    for (let i = 0; i < s.length; i += 4) {
      const a = s[i + 3]!;
      if (a === 0) continue;
      const r = s[i]!, g = s[i + 1]!, b = s[i + 2]!;
      const db = CB(r, g, b) - kcb, dr = CR(r, g, b) - kcr, dist2 = db * db + dr * dr;
      if (dist2 <= lo2) continue;
      const k = dist2 >= hi2 ? 1 : smoothstep(lo, hi, Math.sqrt(dist2));
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a * k;
      if (p.spill > 0) {
        const cap = Math.max(s[i + o1]!, s[i + o2]!), v = s[i + dom]!;
        if (v > cap) d[i + dom] = v - p.spill * (v - cap);
      }
    }
    dst.commit();
  },
});
