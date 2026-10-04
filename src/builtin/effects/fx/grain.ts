import { defineEffect, z } from '../../../plugin/api.js';
import { hash32 } from '../util.js';

export default defineEffect({
  type: 'grain',
  describe: 'Film grain: seeded random noise that changes every frame (deterministic for a seed and frame).',
  params: z.object({
    amount: z.number().min(0).max(1).default(0.15),
    size: z.number().int().min(1).max(16).default(1).describe('grain size in px'),
    mono: z.boolean().default(true).describe('same noise on all channels (false = coloured grain)'),
    seed: z.number().int().default(0),
  }),
  draw({ src, dst, params: p, frame, seed }) {
    const w = src.width, h = src.height, s = src.pixels(), d = dst.pixels();
    if (p.amount <= 0) { d.set(s); dst.commit(); return; }
    const gw = Math.ceil(w / p.size), gh = Math.ceil(h / p.size), ch = p.mono ? 1 : 3;
    // triangular noise in −1..1 per grain cell: the two 16-bit halves of one xorshift32 draw
    const n = new Float32Array(gw * gh * ch);
    let x32 = hash32(seed, p.seed, frame) || 1;
    for (let i = 0; i < n.length; i++) {
      x32 ^= x32 << 13; x32 ^= x32 >>> 17; x32 ^= x32 << 5;
      n[i] = ((x32 & 0xffff) + ((x32 >>> 16) & 0xffff)) / 65535 - 1;
    }
    const k = p.amount * 255;
    for (let y = 0; y < h; y++) {
      const row = ((y / p.size) | 0) * gw;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, a = s[i + 3]!;
        if (a === 0) continue;
        const c = (row + ((x / p.size) | 0)) * ch;
        const nr = n[c]! * k, ng = p.mono ? nr : n[c + 1]! * k, nb = p.mono ? nr : n[c + 2]! * k;
        d[i] = s[i]! + nr; d[i + 1] = s[i + 1]! + ng; d[i + 2] = s[i + 2]! + nb; d[i + 3] = a;
      }
    }
    dst.commit();
  },
});
