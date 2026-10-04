import { defineEffect, z } from '../../../plugin/api.js';

export default defineEffect({
  type: 'rgb-split',
  describe: 'Chromatic aberration: shifts the red channel one way and blue the other by amount px.',
  params: z.object({
    amount: z.number().min(0).max(200).default(6),
    angle: z.number().min(-360).max(360).default(0).describe('direction of the red shift in degrees (0 = right)'),
  }),
  margin: (p) => Math.ceil(p.amount),
  draw({ src, dst, params: p }) {
    const w = src.width, h = src.height, s = src.pixels(), d = dst.pixels();
    const a = (p.angle * Math.PI) / 180, dx = Math.round(Math.cos(a) * p.amount), dy = Math.round(Math.sin(a) * p.amount);
    if (dx === 0 && dy === 0) { d.set(s); dst.commit(); return; }
    // premultiplied channel sample at (x, y) − offset, 0 outside
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : (y * w + x) * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const ir = at(x - dx, y - dy), ig = (y * w + x) * 4, ib = at(x + dx, y + dy);
      const ar = ir < 0 ? 0 : s[ir + 3]!, ag = s[ig + 3]!, ab = ib < 0 ? 0 : s[ib + 3]!;
      const A = Math.max(ar, ag, ab);
      if (A === 0) continue;
      d[ig] = ir < 0 ? 0 : (s[ir]! * ar) / A;
      d[ig + 1] = (s[ig + 1]! * ag) / A;
      d[ig + 2] = ib < 0 ? 0 : (s[ib + 2]! * ab) / A;
      d[ig + 3] = A;
    }
    dst.commit();
  },
});
