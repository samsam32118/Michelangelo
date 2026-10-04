import { defineEffect, z } from '../../../plugin/api.js';

export default defineEffect({
  type: 'lut',
  describe: 'Applies a 3D colour lookup table (.cube) to a media clip while it is decoded.',
  params: z.object({
    file: z.string().regex(/\.(cube|3dl|dat|m3d|csp)$/i, 'must be a LUT file (.cube, .3dl, .dat, .m3d or .csp)').describe('path to the LUT, relative to the project file'),
    interp: z.enum(['nearest', 'trilinear', 'tetrahedral']).default('tetrahedral'),
  }),
  source: (p) => [{ filter: 'lut3d', args: { file: p.file, interp: p.interp } }],
});
