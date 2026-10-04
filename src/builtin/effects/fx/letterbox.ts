import { defineEffect, z } from '../../../plugin/api.js';
import { put, color } from '../util.js';

/** The two matte bars [x, y, w, h] for a frame of w×h shown at `ratio` (letterbox when wider, pillarbox when narrower). */
export function matteBars(w: number, h: number, ratio: number): [number, number, number, number][] {
  if (w / h < ratio) {
    const bar = Math.max(0, Math.round((h - w / ratio) / 2));
    return bar ? [[0, 0, w, bar], [0, h - bar, w, bar]] : [];
  }
  const bar = Math.max(0, Math.round((w - h * ratio) / 2));
  return bar ? [[0, 0, bar, h], [w - bar, 0, bar, h]] : [];
}

export default defineEffect({
  type: 'letterbox',
  describe: 'Aspect-ratio matte: bars that show the layer (or, on an adjustment layer, everything below) at `ratio` (2.39, 1.85, 4/3 = 1.333; a ratio narrower than the frame gives side bars).',
  params: z.object({
    ratio: z.number().min(0.2).max(10).default(2.39).describe('visible width / height'),
    color: color('#000000'),
    opacity: z.number().min(0).max(1).default(1),
  }),
  draw({ src, dst, params: p }) {
    put(dst, src);
    if (p.opacity <= 0) return;
    const c = dst.ctx;
    c.save();
    c.globalAlpha = p.opacity;
    c.fillStyle = p.color;
    for (const [x, y, w, h] of matteBars(dst.width, dst.height, p.ratio)) c.fillRect(x, y, w, h);
    c.restore();
  },
});
