import { defineEffect, z } from '../../../plugin/api.js';

export default defineEffect({
  type: 'mirror',
  describe: 'Flips the layer (flip), or reflects its first half onto the second (reflect), along an axis.',
  params: z.object({
    axis: z.enum(['horizontal', 'vertical', 'both']).default('horizontal').describe('horizontal swaps left and right; vertical swaps top and bottom'),
    mode: z.enum(['flip', 'reflect']).default('flip'),
  }),
  draw({ src, dst, params: { axis, mode } }) {
    const c = dst.ctx, w = src.width, h = src.height;
    const fx = axis !== 'vertical', fy = axis !== 'horizontal';
    c.save();
    if (mode === 'flip') {
      c.translate(fx ? w : 0, fy ? h : 0);
      c.scale(fx ? -1 : 1, fy ? -1 : 1);
      c.drawImage(src.canvas, 0, 0);
    } else {
      c.drawImage(src.canvas, 0, 0);
      const hw = fx ? Math.floor(w / 2) : w, hh = fy ? Math.floor(h / 2) : h;
      const t = src.scratch();
      t.ctx.drawImage(src.canvas, 0, 0, hw, hh, 0, 0, hw, hh);
      // clear the second half(s) and draw the mirrored first half there
      if (fx) c.clearRect(w - hw, 0, hw, h);
      if (fy) c.clearRect(0, h - hh, w, hh);
      if (fx) { c.save(); c.translate(w, 0); c.scale(-1, 1); c.drawImage(t.canvas, 0, 0, hw, fy ? hh : h, 0, 0, hw, fy ? hh : h); c.restore(); }
      if (fy) { c.save(); c.translate(0, h); c.scale(1, -1); c.drawImage(t.canvas, 0, 0, fx ? hw : w, hh, 0, 0, fx ? hw : w, hh); c.restore(); }
      if (fx && fy) { c.save(); c.translate(w, h); c.scale(-1, -1); c.drawImage(t.canvas, 0, 0, hw, hh, 0, 0, hw, hh); c.restore(); }
    }
    c.restore();
  },
});
