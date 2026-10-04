import { defineTransition, z } from '../../../plugin/api.js';
import { put } from '../util.js';

/** Weighted sum (additive, premultiplied): from·(1−p) + to·p, exact for transparent layers too. */
export default defineTransition({
  type: 'crossfade',
  describe: 'Dissolves the outgoing clip into the incoming one.',
  params: z.object({}),
  draw({ from, to, dst, progress: p }) {
    put(dst, from, { alpha: 1 - p });
    put(dst, to, { alpha: p, op: 'lighter' });
  },
});
