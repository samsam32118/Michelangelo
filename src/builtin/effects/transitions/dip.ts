import { defineTransition, z } from '../../../plugin/api.js';
import { put, color } from '../util.js';

export default defineTransition({
  type: 'dip',
  describe: 'Fades the outgoing clip to a colour (black by default), then the colour to the incoming clip.',
  params: z.object({ color: color('black').describe('black, white or any CSS colour such as #1a1a1a') }),
  draw({ from, to, dst, progress: p, params }) {
    const half = p < 0.5;
    put(dst, half ? from : to);
    const c = dst.ctx;
    c.save();
    c.globalAlpha = half ? p * 2 : (1 - p) * 2;
    c.fillStyle = params.color;
    c.fillRect(0, 0, dst.width, dst.height);
    c.restore();
  },
});
