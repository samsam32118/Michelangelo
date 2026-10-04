import { defineTransition, z } from '../../../plugin/api.js';
import { put, direction, dirVec } from '../util.js';

export default defineTransition({
  type: 'slide',
  describe: 'The incoming clip slides in over the outgoing one, moving in the given direction.',
  params: z.object({ direction: direction.default('left') }),
  draw({ from, to, dst, progress: p, params }) {
    const [vx, vy] = dirVec(params.direction), q = 1 - p;
    put(dst, from);
    put(dst, to, { dx: -vx * q * dst.width, dy: -vy * q * dst.height });
  },
});
