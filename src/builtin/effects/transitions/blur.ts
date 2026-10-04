import { defineTransition, z } from '../../../plugin/api.js';
import { blurInto } from '../util.js';

export default defineTransition({
  type: 'blur',
  describe: 'Blurs the outgoing clip, dissolves at peak blur, and unblurs the incoming clip.',
  params: z.object({ radius: z.number().min(0).max(500).default(30).describe('blur radius in px at the cut') }),
  draw({ from, to, dst, progress: p, params }) {
    const r = params.radius * (1 - Math.abs(2 * p - 1));
    blurInto(dst, from, r, { extend: true, alpha: 1 - p });
    blurInto(dst, to, r, { extend: true, alpha: p, op: 'lighter' });
  },
});
