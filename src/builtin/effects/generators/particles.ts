import { defineGenerator, z } from '../../../plugin/api.js';
import { color, direction, dirVec, hash32, rng } from '../util.js';

export default defineGenerator({
  type: 'particles',
  describe: 'Deterministic drifting particles (dust, snow, bubbles, embers) that wrap around the frame.',
  params: z.object({
    count: z.number().int().min(1).max(5000).default(80),
    color: color('#ffffff'),
    size: z.number().min(0.5).max(200).default(6).describe('particle diameter in px'),
    speed: z.number().min(0).max(5000).default(120).describe('px per second'),
    direction: direction.default('up'),
    seed: z.number().int().default(0),
    shape: z.enum(['circle', 'square']).default('circle'),
    jitter: z.number().min(0).max(1).default(0.5).describe('variation of size and speed between particles'),
    twinkle: z.number().min(0).max(1).default(0.3).describe('how much each particle\'s opacity pulses'),
  }),
  draw({ dst, params: p, time, seed }) {
    const c = dst.ctx, W = dst.width, H = dst.height, [vx, vy] = dirVec(p.direction);
    const r = rng(hash32(seed, p.seed));
    c.save();
    c.fillStyle = p.color;
    for (let i = 0; i < p.count; i++) {
      const x0 = r() * W, y0 = r() * H, rs = r(), rv = r(), ph = r(), fr = r(), sway = r();
      const sz = p.size * (1 - p.jitter * rs * 0.7), m = sz + 2;
      const travel = p.speed * (1 - p.jitter * rv * 0.6) * time;
      const wob = Math.sin(2 * Math.PI * (ph + time * (0.2 + 0.3 * sway))) * sz * 1.5;
      const wrap = (v: number, L: number) => ((((v + m) % (L + 2 * m)) + (L + 2 * m)) % (L + 2 * m)) - m;
      const x = wrap(x0 + vx * travel + (vx ? 0 : wob), W), y = wrap(y0 + vy * travel + (vy ? 0 : wob), H);
      c.globalAlpha = 1 - p.twinkle * (0.5 + 0.5 * Math.sin(2 * Math.PI * (ph + time * (0.5 + fr))));
      if (p.shape === 'square') c.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      else { c.beginPath(); c.arc(x, y, sz / 2, 0, 2 * Math.PI); c.fill(); }
    }
    c.restore();
  },
});
