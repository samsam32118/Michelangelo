import { defineEffect, z } from '../../../plugin/api.js';
import { blurInto } from '../util.js';

export default defineEffect({
  type: 'denoise',
  describe: 'Reduces video noise on media clips (ffmpeg hqdn3d); other layers get a light smoothing blur.',
  params: z.object({ strength: z.number().min(0).max(1).default(0.5) }),
  source: (p) => (p.strength > 0 ? [{ filter: 'hqdn3d', args: { luma_spatial: 8 * p.strength, chroma_spatial: 6 * p.strength, luma_tmp: 12 * p.strength, chroma_tmp: 9 * p.strength } }] : []),
  draw({ src, dst, params }) { blurInto(dst, src, params.strength * 1.2, { extend: true }); },
});
