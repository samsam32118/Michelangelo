import { defineEffect, z } from '../../../plugin/api.js';

export default defineEffect({
  type: 'pixelate',
  describe: 'Mosaic: averages the layer into square blocks of size px.',
  params: z.object({ size: z.number().min(1).max(1024).default(16) }),
  draw({ src, dst, params: { size } }) {
    const w = src.width, h = src.height, sw = Math.max(1, Math.ceil(w / size)), sh = Math.max(1, Math.ceil(h / size));
    const small = src.scratch(sw, sh);
    small.ctx.imageSmoothingEnabled = true;
    small.ctx.imageSmoothingQuality = 'high';
    small.ctx.drawImage(src.canvas, 0, 0, sw * size, sh * size, 0, 0, sw, sh);
    dst.ctx.save();
    dst.ctx.imageSmoothingEnabled = false;
    dst.ctx.drawImage(small.canvas, 0, 0, sw * size, sh * size);
    dst.ctx.restore();
  },
});
