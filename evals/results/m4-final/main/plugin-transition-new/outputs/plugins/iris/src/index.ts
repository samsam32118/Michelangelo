import { definePlugin, defineTransition, z } from 'michelangelo/plugin';

/** An iris: a circle grows from a point (the centre by default) and reveals the incoming clip. */
const iris = defineTransition({
  type: 'iris',
  describe: 'A circle that grows from the centre, revealing the incoming clip.',
  params: z.object({
    cx: z.number().min(0).max(1).default(0.5).describe('centre of the circle, fraction of the width'),
    cy: z.number().min(0).max(1).default(0.5).describe('centre of the circle, fraction of the height'),
  }),
  draw({ from, to, dst, progress, params: p }) {
    const c = dst.ctx, w = dst.width, h = dst.height;
    const x = p.cx * w, y = p.cy * h;
    // Radius that reaches the farthest corner, so progress 1 shows only the incoming clip.
    const max = Math.hypot(Math.max(x, w - x), Math.max(y, h - y)) + 1;
    c.drawImage(from.canvas, 0, 0);
    if (progress <= 0) return;
    c.save();
    if (progress < 1) {
      c.beginPath();
      c.arc(x, y, max * progress, 0, Math.PI * 2);
      c.clip();
    }
    c.clearRect(0, 0, w, h);
    c.drawImage(to.canvas, 0, 0);
    c.restore();
  },
});

export default definePlugin({ name: 'iris', version: '0.1.0', transitions: [iris] });
