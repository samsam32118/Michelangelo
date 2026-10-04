import { defineTransition, z } from '../../../plugin/api.js';
import { putTransformed } from '../util.js';

export default defineTransition({
  type: 'zoom',
  describe: 'Zooms into the outgoing clip while the incoming one settles from zoomed-in to normal, dissolving between them.',
  params: z.object({ scale: z.number().min(1).max(10).default(1.5).describe('zoom factor at the cut') }),
  draw({ from, to, dst, progress: p, params: { scale } }) {
    putTransformed(dst, from, 1 + (scale - 1) * p, 0, { alpha: 1 - p });
    putTransformed(dst, to, scale - (scale - 1) * p, 0, { alpha: p, op: 'lighter' });
  },
});
