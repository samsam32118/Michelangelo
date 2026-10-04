import { defineGenerator, z } from '../../../plugin/api.js';
import { colorList } from '../util.js';

export default defineGenerator({
  type: 'gradient',
  describe: 'Linear or radial colour gradient background, optionally rotating over time.',
  params: z.object({
    colors: colorList(['#1e3c72', '#2a5298']).describe('two or more colours, evenly spaced'),
    angle: z.number().min(-360).max(360).default(90).describe('direction of a linear gradient in degrees (0 = left to right, 90 = top to bottom)'),
    type: z.enum(['linear', 'radial']).default('linear'),
    animate: z.number().min(-3600).max(3600).default(0).describe('degrees per second: rotates a linear gradient, orbits a radial one'),
  }),
  draw({ dst, params: p, time }) {
    const c = dst.ctx, w = dst.width, h = dst.height;
    const a = ((p.angle + p.animate * time) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    let g;
    if (p.type === 'linear') {
      const half = (Math.abs(w * cos) + Math.abs(h * sin)) / 2;
      g = c.createLinearGradient(w / 2 - cos * half, h / 2 - sin * half, w / 2 + cos * half, h / 2 + sin * half);
    } else {
      const orbit = p.animate ? 0.15 * Math.min(w, h) : 0;
      const cx = w / 2 + orbit * cos, cy = h / 2 + orbit * sin;
      g = c.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(w, h) / 2 + orbit);
    }
    p.colors.forEach((col, i) => g.addColorStop(i / (p.colors.length - 1), col));
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  },
});
