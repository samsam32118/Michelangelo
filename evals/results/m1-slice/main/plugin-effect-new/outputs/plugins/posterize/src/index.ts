import { definePlugin, defineEffect, z } from 'michelangelo/plugin';

/** Reduces each colour channel (R, G, B) to `levels` evenly spaced values; alpha is kept. */
const posterize = defineEffect({
  type: 'posterize',
  describe: 'Posterizes the layer: each colour channel is reduced to `levels` evenly spaced values (alpha kept).',
  params: z.object({
    levels: z.number().min(2).max(256).default(4).describe('values per colour channel (2-256)'),
  }),
  draw({ src, dst, params: p }) {
    const n = Math.max(2, Math.min(256, Math.round(p.levels)));
    const step = 255 / (n - 1);
    // lookup table: 0..255 -> nearest of the n levels
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.round(Math.round(v / step) * step);
    const s = src.pixels(), d = dst.pixels();
    for (let i = 0; i < s.length; i += 4) {
      d[i] = lut[s[i]!]!;
      d[i + 1] = lut[s[i + 1]!]!;
      d[i + 2] = lut[s[i + 2]!]!;
      d[i + 3] = s[i + 3]!;
    }
    dst.commit();
  },
});

export default definePlugin({ name: 'posterize', version: '0.1.0', effects: [posterize] });
