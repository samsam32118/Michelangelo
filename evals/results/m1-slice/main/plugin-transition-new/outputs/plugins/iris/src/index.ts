import { definePlugin, defineTransition, z } from 'michelangelo/plugin';

/** An iris: a circle grows from a point (the centre by default) and reveals the incoming clip. */
const iris = defineTransition({
  type: 'iris',
  describe: 'A circle that grows from the centre, revealing the incoming clip.',
  params: z.object({
    x: z.number().min(0).max(1).default(0.5).describe('centre of the circle, fraction of the width'),
    y: z.number().min(0).max(1).default(0.5).describe('centre of the circle, fraction of the height'),
  }),
  draw({ from, to, dst, progress, params: p }) {
    const c = dst.ctx, W = dst.width, H = dst.height;
    const cx = p.x * W, cy = p.y * H;
    // radius that reaches the farthest corner, so progress 1 shows only the incoming clip
    const max = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) + 1;
    const r = max * Math.min(1, Math.max(0, progress));
    c.drawImage(from.canvas, 0, 0);
    if (r <= 0) return;
    c.save();
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.clip();
    c.clearRect(0, 0, W, H);
    c.drawImage(to.canvas, 0, 0);
    c.restore();
  },
});

export default definePlugin({ name: 'iris', version: '0.1.0', transitions: [iris] });
