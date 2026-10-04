import { defineTransition, z, type Surface } from '../../../plugin/api.js';
import { put, direction, dirVec } from '../util.js';

/** Fill `s` with the region the incoming clip covers (opaque), softened over `soft` (fraction of the travel length). */
function mask(s: Surface, dir: z.infer<typeof direction>, p: number, soft: number, op: 'destination-in' | 'destination-out'): void {
  const W = s.width, H = s.height, [vx, vy] = dirVec(dir);
  const len = vx ? W : H;
  // u = distance from the side the edge starts on; the edge (centre) travels from −soft/2 to 1 + soft/2
  const e = (-soft / 2 + p * (1 + soft)) * len;
  const start = { x: vx < 0 ? W : 0, y: vy < 0 ? H : 0 };
  const at = (u: number) => [start.x + vx * u, start.y + vy * u] as const;
  const c = s.ctx;
  c.save();
  c.globalCompositeOperation = op;
  // a hard edge is a 1 px ramp (anti-aliased); the mask always covers the whole surface
  const half = Math.max(soft * len, 1) / 2;
  const [x0, y0] = at(e - half), [x1, y1] = at(e + half);
  const g = c.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  c.restore();
}

export default defineTransition({
  type: 'wipe',
  describe: 'A moving edge reveals the incoming clip; direction is where the edge travels.',
  params: z.object({
    direction: direction.default('left'),
    softness: z.number().min(0).max(1).default(0).describe('width of the soft edge as a fraction of the frame'),
  }),
  draw({ from, to, dst, progress: p, params }) {
    const a = from.scratch(), b = to.scratch();
    put(a, from);
    mask(a, params.direction, p, params.softness, 'destination-out');
    put(b, to);
    mask(b, params.direction, p, params.softness, 'destination-in');
    put(dst, a);
    put(dst, b, { op: 'lighter' });
  },
});
