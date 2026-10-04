/** clock-wipe: a transition where a clock hand sweeps around the centre, revealing the incoming clip. */
import { definePlugin, defineTransition, z } from 'michelangelo/plugin';

const clockWipe = defineTransition({
  type: 'clock-wipe',
  describe: 'A clock hand sweeps a full turn around a centre point, revealing the incoming clip behind it.',
  params: z.object({
    start: z.number().min(-360).max(360).default(0).describe('angle where the sweep starts, degrees (0 = 12 o\'clock)'),
    clockwise: z.boolean().default(true),
    cx: z.number().min(0).max(1).default(0.5).describe('centre x as a fraction of the width'),
    cy: z.number().min(0).max(1).default(0.5).describe('centre y as a fraction of the height'),
  }),
  draw({ from, to, dst, progress, params: p }) {
    const c = dst.ctx, W = dst.width, H = dst.height;
    c.drawImage(from.canvas, 0, 0);
    if (progress <= 0) return;
    if (progress >= 1) { c.clearRect(0, 0, W, H); c.drawImage(to.canvas, 0, 0); return; }
    const x = p.cx * W, y = p.cy * H, R = Math.hypot(Math.max(x, W - x), Math.max(y, H - y)) + 2;
    const a0 = ((p.start - 90) * Math.PI) / 180, sweep = progress * 2 * Math.PI * (p.clockwise ? 1 : -1);
    c.save();
    c.beginPath();
    c.moveTo(x, y);
    c.arc(x, y, R, a0, a0 + sweep, !p.clockwise);
    c.closePath();
    c.clip();
    c.clearRect(0, 0, W, H);
    c.drawImage(to.canvas, 0, 0);
    c.restore();
  },
});

export default definePlugin({ name: 'clock-wipe', version: '1.0.0', transitions: [clockWipe] });
