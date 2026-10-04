/**
 * glitch: a layer effect. Splits the red and blue channels apart and shifts horizontal slices of the
 * layer sideways. Slices change every `hold` frames; everything is derived from (seed, frame), so a
 * frame always renders the same.
 */
import { definePlugin, defineEffect, z } from 'michelangelo/plugin';

/** mulberry32 seeded by a hash of the inputs: deterministic randomness. */
function random(...ns: number[]): () => number {
  let a = 0x9e3779b9;
  for (const n of ns) a = Math.imul(a ^ (n | 0), 0x85ebca6b) ^ (a >>> 13);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const glitch = defineEffect({
  type: 'glitch',
  describe: 'Digital glitch: RGB channel split plus horizontal slices shifted sideways, re-rolled every `hold` frames (seeded).',
  params: z.object({
    amount: z.number().min(0).max(1).default(0.5).describe('strength: 0 = off, 1 = heavy'),
    slices: z.number().int().min(1).max(64).default(8).describe('number of horizontal bands'),
    split: z.number().min(0).max(100).default(6).describe('RGB split in px at amount 1'),
    hold: z.number().int().min(1).max(60).default(3).describe('frames each glitch pattern is held'),
    seed: z.number().int().default(1),
  }),
  margin: (p) => Math.ceil(p.split * p.amount),
  draw({ src, dst, params: p, frame, seed }) {
    const w = src.width, h = src.height, s = src.pixels(), d = dst.pixels();
    if (p.amount <= 0) { d.set(s); dst.commit(); return; }
    const r = random(seed, p.seed, Math.floor(frame / p.hold));
    // per-row horizontal offsets: random band boundaries, about half the bands shifted
    const rowShift = new Int32Array(h);
    const cuts = Array.from({ length: p.slices - 1 }, () => Math.floor(r() * h)).sort((a, b) => a - b);
    const max = p.amount * w * 0.08;
    let y0 = 0;
    for (const y1 of [...cuts, h]) {
      const dx = r() < 0.5 * p.amount + 0.25 ? Math.round((r() * 2 - 1) * max) : 0;
      rowShift.fill(dx, y0, y1);
      y0 = y1;
    }
    const split = Math.round(p.split * p.amount);
    const idx = (x: number, y: number) => (x < 0 || x >= w ? -1 : (y * w + x) * 4);
    for (let y = 0; y < h; y++) {
      const sh = rowShift[y]!;
      for (let x = 0; x < w; x++) {
        const ir = idx(x - sh - split, y), ig = idx(x - sh, y), ib = idx(x - sh + split, y);
        const ar = ir < 0 ? 0 : s[ir + 3]!, ag = ig < 0 ? 0 : s[ig + 3]!, ab = ib < 0 ? 0 : s[ib + 3]!;
        const A = Math.max(ar, ag, ab);
        if (A === 0) continue;
        const o = (y * w + x) * 4;
        d[o] = ir < 0 ? 0 : (s[ir]! * ar) / A;
        d[o + 1] = ig < 0 ? 0 : (s[ig + 1]! * ag) / A;
        d[o + 2] = ib < 0 ? 0 : (s[ib + 2]! * ab) / A;
        d[o + 3] = A;
      }
    }
    dst.commit();
  },
});

export default definePlugin({ name: 'glitch', version: '1.0.0', effects: [glitch] });
