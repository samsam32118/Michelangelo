import { defineTransition, z } from '../../../plugin/api.js';
import { put, color } from '../util.js';

export default defineTransition({
  type: 'flash',
  describe: 'A bright flash of colour (white by default) that peaks at the cut.',
  params: z.object({ color: color('white') }),
  draw({ from, to, dst, progress: p, params }) {
    put(dst, p < 0.5 ? from : to);
    const k = 1 - Math.abs(2 * p - 1);
    const c = dst.ctx;
    c.save();
    c.globalAlpha = k * k * Math.sqrt(k) || 0;
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = params.color;
    c.fillRect(0, 0, dst.width, dst.height);
    if (k > 0.999) { c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.fillRect(0, 0, dst.width, dst.height); }
    c.restore();
  },
});
