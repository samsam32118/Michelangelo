import { defineTransition, z } from '../../../plugin/api.js';
import { put, direction, dirVec } from '../util.js';

export default defineTransition({
  type: 'push',
  describe: 'The incoming clip pushes the outgoing one out of frame, both moving in the given direction.',
  params: z.object({ direction: direction.default('left') }),
  draw({ from, to, dst, progress: p, params }) {
    const [vx, vy] = dirVec(params.direction), W = dst.width, H = dst.height;
    put(dst, from, { dx: vx * p * W, dy: vy * p * H });
    put(dst, to, { dx: -vx * (1 - p) * W, dy: -vy * (1 - p) * H });
  },
});
