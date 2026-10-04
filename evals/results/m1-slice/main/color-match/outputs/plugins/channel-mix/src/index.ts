import { definePlugin, defineEffect, z } from 'michelangelo/plugin';

const row = (r: number, g: number, b: number) =>
  z.array(z.number()).length(4).default([r, g, b, 0]).describe('[from red, from green, from blue, offset 0..1]');

/** Channel mixer: each output channel = r·R + g·G + b·B + offset (a 3×4 colour matrix), alpha kept. */
const channelMix = defineEffect({
  type: 'channel-mix',
  describe: 'Channel mixer / colour matrix: each output channel is a weighted sum of the input R, G, B plus an offset.',
  params: z.object({
    red: row(1, 0, 0),
    green: row(0, 1, 0),
    blue: row(0, 0, 1),
  }),
  draw({ src, dst, params: p }) {
    const m = [p.red, p.green, p.blue];
    const s = src.pixels(), d = dst.pixels();
    for (let i = 0; i < s.length; i += 4) {
      const r = s[i]!, g = s[i + 1]!, b = s[i + 2]!, a = s[i + 3]!;
      for (let c = 0; c < 3; c++) {
        const w = m[c]!;
        // offset is in straight-colour units; scale by alpha in case pixels are premultiplied
        const v = w[0]! * r + w[1]! * g + w[2]! * b + w[3]! * a;
        d[i + c] = v < 0 ? 0 : v > a ? a : v;
      }
      d[i + 3] = a;
    }
    dst.commit();
  },
});

export default definePlugin({ name: 'channel-mix', version: '0.1.0', effects: [channelMix] });
