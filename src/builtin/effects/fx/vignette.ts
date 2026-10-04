import { defineEffect, z } from '../../../plugin/api.js';
import { put, rgbaOf, color } from '../util.js';

export default defineEffect({
  type: 'vignette',
  describe: 'Darkens (or tints) the layer towards its corners with an elliptical falloff.',
  params: z.object({
    amount: z.number().min(0).max(1).default(0.5).describe('opacity of the colour at the corners'),
    softness: z.number().min(0).max(1).default(0.5).describe('0 = hard edge near the corners, 1 = falloff from the centre'),
    color: color('#000000'),
  }),
  draw({ src, dst, params: p }) {
    put(dst, src);
    if (p.amount <= 0) return;
    const [r, g, b] = rgbaOf(src, p.color), c = dst.ctx, w = dst.width, h = dst.height;
    const outer = Math.SQRT2, inner = Math.min(outer - 0.01, outer * (1 - p.softness) * 0.98);
    const grad = c.createRadialGradient(0, 0, inner, 0, 0, outer);
    grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},${p.amount})`);
    c.save();
    c.globalCompositeOperation = 'source-atop';
    c.translate(w / 2, h / 2);
    c.scale(w / 2, h / 2);
    c.fillStyle = grad;
    c.fillRect(-1, -1, 2, 2);
    c.restore();
  },
});
