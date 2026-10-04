import { defineEffect, z } from '../../../plugin/api.js';
import { blurInto } from '../util.js';

export default defineEffect({
  type: 'blur',
  describe: 'Gaussian blur of the layer (radius in px).',
  params: z.object({
    radius: z.number().min(0).max(500).default(10),
    edges: z.enum(['extend', 'transparent']).default('extend').describe('extend repeats edge pixels so full-frame video keeps solid borders; transparent lets the blur spread past the layer box'),
  }),
  margin: (p) => (p.edges === 'transparent' ? Math.ceil(p.radius * 2.5) : 0),
  draw({ src, dst, params }) {
    blurInto(dst, src, params.radius, { extend: params.edges === 'extend' });
  },
});
