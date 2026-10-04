import { defineEffect, z } from '../../../plugin/api.js';
import { blurInto, put, silhouette, smoothstep, colorValue } from '../util.js';

export default defineEffect({
  type: 'glow',
  describe: 'Soft light around the bright parts of the layer (screen-blended blur on top of it).',
  params: z.object({
    radius: z.number().min(0).max(500).default(20),
    strength: z.number().min(0).max(5).default(1),
    threshold: z.number().min(0).max(1).default(0).describe('only pixels brighter than this (0..1 luma) glow'),
    color: colorValue.optional().describe('tint the glow with this colour (default: the layer\'s own colours)'),
  }),
  margin: (p) => Math.ceil(p.radius * 2.5),
  draw({ src, dst, params: { radius, strength, threshold, color: tint } }) {
    put(dst, src);
    if (strength <= 0) return;
    let g = src;
    if (threshold > 0) {
      g = src.scratch();
      const s = src.pixels(), d = g.pixels();
      d.set(s);
      for (let i = 0; i < d.length; i += 4) {
        const l = (0.2126 * s[i]! + 0.7152 * s[i + 1]! + 0.0722 * s[i + 2]!) / 255;
        d[i + 3] = s[i + 3]! * smoothstep(threshold - 0.04, threshold + 0.04, l);
      }
      g.commit();
    }
    if (tint) g = silhouette(g, tint);
    const halo = src.scratch();
    blurInto(halo, g, radius);
    for (let k = strength; k > 0; k--) put(dst, halo, { op: 'screen', alpha: Math.min(1, k) });
  },
});
