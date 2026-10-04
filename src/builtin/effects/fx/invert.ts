import { defineEffect, z } from '../../../plugin/api.js';

export default defineEffect({
  type: 'invert',
  describe: 'Inverts the layer\'s colours (amount 1 = full negative), keeping its alpha.',
  params: z.object({ amount: z.number().min(0).max(1).default(1) }),
  draw({ src, dst, params: { amount } }) {
    dst.ctx.save();
    dst.ctx.filter = `invert(${amount})`;
    dst.ctx.drawImage(src.canvas, 0, 0);
    dst.ctx.restore();
  },
});
