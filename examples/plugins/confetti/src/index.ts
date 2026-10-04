/**
 * confetti: a generator. Seeded paper pieces fall, sway and tumble; positions are a pure function of
 * (params, time, seed), so any frame renders the same on its own.
 */
import { definePlugin, defineGenerator, z } from 'michelangelo/plugin';

function random(...ns: number[]): () => number {
  let a = 0x2545f491;
  for (const n of ns) a = Math.imul(a ^ (n | 0), 0x9e3779b1) ^ (a >>> 15);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const confetti = defineGenerator({
  type: 'confetti',
  describe: 'Seeded confetti: coloured paper pieces falling with sway, rotation and a 3D-like flip; loops seamlessly over the frame.',
  params: z.object({
    count: z.number().int().min(1).max(3000).default(150),
    colors: z.array(z.string()).min(1).max(16).default(['#ff3b5c', '#ffd400', '#2ee6a8', '#3fa9ff', '#b26bff', '#ffffff']),
    size: z.number().min(1).max(200).default(14).describe('piece length in px at a 1080 px tall comp'),
    speed: z.number().min(0).max(5000).default(260).describe('fall speed in px per second at a 1080 px tall comp'),
    spin: z.number().min(0).max(20).default(1.5).describe('turns per second'),
    sway: z.number().min(0).max(1).default(0.5),
    seed: z.number().int().default(1),
  }),
  draw({ dst, params: p, time, seed }) {
    const c = dst.ctx, W = dst.width, H = dst.height, u = H / 1080;
    const r = random(seed, p.seed);
    for (let i = 0; i < p.count; i++) {
      const x0 = r() * W, y0 = r() * H, v = (0.6 + 0.8 * r()) * p.speed * u, ph = r() * Math.PI * 2;
      const sz = p.size * u * (0.6 + 0.8 * r()), spin = p.spin * (0.5 + r()) * (r() < 0.5 ? -1 : 1);
      const col = p.colors[Math.floor(r() * p.colors.length)]!;
      const m = sz * 2, span = H + 2 * m;
      const y = ((((y0 + v * time + m) % span) + span) % span) - m;
      const x = x0 + Math.sin(ph + time * 2.2) * p.sway * 40 * u;
      const a = ph + time * spin * Math.PI * 2;
      c.save();
      c.translate(x, y);
      c.rotate(a);
      c.scale(1, Math.cos(a * 1.7 + ph)); // the flip
      c.fillStyle = col;
      c.fillRect(-sz / 2, -sz / 4, sz, sz / 2);
      c.restore();
    }
  },
});

export default definePlugin({ name: 'confetti', version: '1.0.0', generators: [confetti] });
