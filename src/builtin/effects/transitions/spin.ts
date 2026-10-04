import { defineTransition, z } from '../../../plugin/api.js';
import { putTransformed } from '../util.js';

export default defineTransition({
  type: 'spin',
  describe: 'The outgoing clip spins and shrinks away while the incoming clip spins and grows in.',
  params: z.object({ turns: z.number().min(-10).max(10).default(1).describe('total turns over the transition (negative = counter-clockwise)') }),
  draw({ from, to, dst, progress: p, params: { turns } }) {
    const ease = p * p * (3 - 2 * p), a = turns * 2 * Math.PI;
    putTransformed(dst, from, 1 - ease, a * ease, { alpha: 1 - p });
    putTransformed(dst, to, ease, -a * (1 - ease), { alpha: p, op: 'lighter' });
  },
});
