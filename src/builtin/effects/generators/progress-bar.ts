import { defineGenerator, z } from '../../../plugin/api.js';
import { color } from '../util.js';

export default defineGenerator({
  type: 'progress-bar',
  describe: 'A bar along the top or bottom edge that fills from 0 to 100% over duration frames.',
  params: z.object({
    duration: z.number().int().min(1).max(10_000_000).default(300).describe('frames to go from empty to full (usually the clip length)'),
    color: color('#ffffff'),
    background: color('rgba(255,255,255,0.25)'),
    height: z.number().min(1).max(400).default(12),
    position: z.enum(['top', 'bottom']).default('bottom'),
    inset: z.number().min(0).max(2000).default(0).describe('distance from the edge in px'),
  }),
  draw({ dst, params: p, frame }) {
    const c = dst.ctx, W = dst.width;
    const y = p.position === 'top' ? p.inset : dst.height - p.inset - p.height;
    const k = Math.min(1, Math.max(0, frame / Math.max(1, p.duration - 1)));
    c.fillStyle = p.background;
    c.fillRect(0, y, W, p.height);
    c.fillStyle = p.color;
    c.fillRect(0, y, W * k, p.height);
  },
});
