import { defineTransition, z, type Surface } from '../../../plugin/api.js';
import { put, direction, dirVec } from '../util.js';

/** inOutCubic: eases out of the first shot, races through the cut and lands softly, like a whip pan. */
const ease = (p: number) => (p < 0.5 ? 4 * p ** 3 : 1 - (2 - 2 * p) ** 3 / 2);
/** its speed relative to the peak (1 at p = 0.5) */
const speedOf = (p: number) => (p < 0.5 ? 4 * p * p : 4 * (1 - p) ** 2);

/**
 * Motion blur of `src` along x (horizontal) or y into `dst`, `len` px long (a box blur along one axis). Long blurs
 * run on a copy squeezed along the axis (at most 4×, so diagonals stay smooth) and average up to 20 shifted copies,
 * then stretch back. Edge rows/columns are repeated outward first so the borders do not darken.
 */
export function motionBlur(dst: Surface, src: Surface, len: number, horizontal: boolean): void {
  if (!(len > 1)) { put(dst, src); return; }
  const k = Math.min(4, Math.max(1, len / 16));
  const { width: W, height: H } = src;
  // pad (repeated edges) only along the blur axis: across it the stretch-back must not sample empty rows
  const pad = Math.ceil(len / 2) + 2, px = horizontal ? pad : 0, py = horizontal ? 0 : pad;
  const fx = horizontal ? 1 / k : 1, fy = horizontal ? 1 : 1 / k;
  const sw = Math.max(1, Math.round((W + 2 * px) * fx)), sh = Math.max(1, Math.round((H + 2 * py) * fy));
  const X = (x: number) => x * fx, Y = (y: number) => y * fy;
  // 1. the frame with repeated edges, squeezed along the axis
  const small = src.scratch(sw, sh);
  const s = small.ctx;
  s.imageSmoothingEnabled = true;
  s.imageSmoothingQuality = 'high';
  s.drawImage(src.canvas, 0, 0, W, H, X(px), Y(py), X(W), Y(H));
  if (horizontal) {
    s.drawImage(src.canvas, 0, 0, 1, H, 0, 0, X(px), Y(H));
    s.drawImage(src.canvas, W - 1, 0, 1, H, X(px + W), 0, X(px), Y(H));
  } else {
    s.drawImage(src.canvas, 0, 0, W, 1, 0, 0, X(W), Y(py));
    s.drawImage(src.canvas, 0, H - 1, W, 1, 0, Y(py + H), X(W), Y(py));
  }
  // 2. average n copies spread over the blur length (in squeezed px); copy i is drawn at alpha 1/(i+1) = running mean
  const span = len / k, n = Math.min(20, Math.max(2, Math.ceil(span / 1.2)));
  const blurred = small.scratch();
  const b = blurred.ctx;
  b.imageSmoothingEnabled = true;
  for (let i = 0; i < n; i++) {
    const o = (i / (n - 1) - 0.5) * span;
    b.globalAlpha = 1 / (i + 1);
    b.drawImage(small.canvas, horizontal ? o : 0, horizontal ? 0 : o);
  }
  b.globalAlpha = 1;
  const c = dst.ctx;
  c.save();
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(blurred.canvas, X(px), Y(py), X(W), Y(H), 0, 0, W, H);
  c.restore();
}

export default defineTransition({
  type: 'whip',
  describe: 'Whip pan: both clips fly in the given direction like a fast camera pan, smeared by motion blur that peaks at the cut (e.g. transition.set shot-2 type=whip len=0.4s direction=left; 0.3–0.5 s reads best).',
  params: z.object({
    direction: direction.default('left').describe('where the picture moves'),
    blur: z.number().min(0).max(1).default(1).describe('motion blur strength (1 = a smear of about 15% of the frame at the cut)'),
  }),
  draw({ from, to, dst, progress: p, params }) {
    const [vx, vy] = dirVec(params.direction), W = dst.width, H = dst.height;
    const e = ease(p);
    if (p <= 0 || p >= 1) { put(dst, p <= 0 ? from : to); return; }
    const frame = dst.scratch();
    put(frame, from, { dx: vx * e * W, dy: vy * e * H });
    put(frame, to, { dx: -vx * (1 - e) * W, dy: -vy * (1 - e) * H });
    const horizontal = vx !== 0;
    motionBlur(dst, frame, params.blur * speedOf(p) * 0.15 * (horizontal ? W : H), horizontal);
  },
});
