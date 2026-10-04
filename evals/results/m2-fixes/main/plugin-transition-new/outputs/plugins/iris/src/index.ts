import { definePlugin, defineTransition, z } from 'michelangelo/plugin';

/** An iris wipe: a circle grows from a centre point, revealing the incoming clip. */
const iris = defineTransition({
  type: 'iris',
  describe: 'A circle that grows from the centre (or a chosen point), revealing the incoming clip.',
  params: z.object({
    cx: z.number().min(0).max(1).default(0.5).describe('circle centre x, as a fraction of the width'),
    cy: z.number().min(0).max(1).default(0.5).describe('circle centre y, as a fraction of the height'),
    feather: z.number().min(0).default(0).describe('soft edge width in px (0 = hard edge)'),
  }),
  draw({ from, to, dst, progress, params: p }) {
    const c = dst.ctx, w = dst.width, h = dst.height;
    const x = p.cx * w, y = p.cy * h;
    // Radius that just covers the farthest corner, so progress 1 shows only the incoming clip.
    const maxR = Math.hypot(Math.max(x, w - x), Math.max(y, h - y)) + p.feather;
    const r = maxR * progress;
    c.drawImage(from.canvas, 0, 0);
    if (progress <= 0) return;
    if (progress >= 1) {
      c.clearRect(0, 0, w, h);
      c.drawImage(to.canvas, 0, 0);
      return;
    }
    if (p.feather > 0) {
      // Soft edge: mask the incoming clip with a radial gradient on a scratch surface.
      const s = dst.scratch(w, h);
      const sc = s.ctx;
      sc.clearRect(0, 0, w, h);
      sc.drawImage(to.canvas, 0, 0);
      sc.globalCompositeOperation = 'destination-in';
      const inner = Math.max(0, r - p.feather);
      const g = sc.createRadialGradient(x, y, inner, x, y, Math.max(r, inner + 0.001));
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      sc.fillStyle = g;
      sc.fillRect(0, 0, w, h);
      sc.globalCompositeOperation = 'source-over';
      c.drawImage(s.canvas, 0, 0);
      return;
    }
    c.save();
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.clip();
    c.clearRect(0, 0, w, h);
    c.drawImage(to.canvas, 0, 0);
    c.restore();
  },
});

export default definePlugin({ name: 'iris', version: '0.1.0', transitions: [iris] });
