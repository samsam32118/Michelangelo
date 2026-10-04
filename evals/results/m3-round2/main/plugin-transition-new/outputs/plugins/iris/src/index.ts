import { definePlugin, defineTransition, z } from 'michelangelo/plugin';

/** An iris: a circle grows from a centre point (default the frame centre) revealing the incoming clip. */
const iris = defineTransition({
  type: 'iris',
  describe: 'A circle that grows from the centre of the frame, revealing the incoming clip.',
  params: z.object({
    x: z.number().min(0).max(1).default(0.5).describe('centre of the circle, fraction of the width'),
    y: z.number().min(0).max(1).default(0.5).describe('centre of the circle, fraction of the height'),
    feather: z.number().min(0).default(0).describe('soft edge width in px (0 = hard edge)'),
  }),
  draw({ from, to, dst, progress, params: p }) {
    const c = dst.ctx, w = dst.width, h = dst.height;
    const cx = w * p.x, cy = h * p.y;
    // the radius that reaches the farthest corner, so progress 1 covers the whole frame
    const maxR = Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy));
    const r = (maxR + p.feather) * progress;
    c.drawImage(from.canvas, 0, 0);
    if (progress <= 0 || r <= 0) return;
    if (progress >= 1) {
      c.clearRect(0, 0, w, h);
      c.drawImage(to.canvas, 0, 0);
      return;
    }
    if (p.feather > 0) {
      // draw the incoming clip through a radial alpha mask on a scratch surface
      const s = dst.scratch(w, h), sc = s.ctx;
      sc.clearRect(0, 0, w, h);
      sc.drawImage(to.canvas, 0, 0);
      const g = sc.createRadialGradient(cx, cy, Math.max(0, r - p.feather), cx, cy, r);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      sc.globalCompositeOperation = 'destination-in';
      sc.fillStyle = g;
      sc.fillRect(0, 0, w, h);
      sc.globalCompositeOperation = 'source-over';
      c.drawImage(s.canvas, 0, 0);
      return;
    }
    c.save();
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.clip();
    c.clearRect(0, 0, w, h);
    c.drawImage(to.canvas, 0, 0);
    c.restore();
  },
});

export default definePlugin({ name: 'iris', version: '0.1.0', transitions: [iris] });
