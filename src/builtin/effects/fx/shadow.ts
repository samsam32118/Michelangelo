import { defineEffect, z } from '../../../plugin/api.js';
import { blurInto, put, silhouette, color } from '../util.js';

export default defineEffect({
  type: 'shadow',
  describe: 'Drop shadow behind the layer, offset by x/y px and softened by blur px.',
  params: z.object({
    x: z.number().min(-2000).max(2000).default(8),
    y: z.number().min(-2000).max(2000).default(8),
    blur: z.number().min(0).max(500).default(16),
    color: color('#000000'),
    opacity: z.number().min(0).max(1).default(0.6),
  }),
  margin: (p) => Math.ceil(Math.max(Math.abs(p.x), Math.abs(p.y)) + p.blur * 1.5),
  draw({ src, dst, params: p }) {
    // blur is the CSS box-shadow blur length (2 standard deviations)
    blurInto(dst, silhouette(src, p.color), p.blur / 2, { alpha: p.opacity, dx: p.x, dy: p.y });
    put(dst, src);
  },
});
