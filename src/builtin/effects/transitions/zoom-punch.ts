import { defineTransition, z, type Surface } from '../../../plugin/api.js';
import { put } from '../util.js';

/**
 * A zoom blur: copies of src scaled from `scale` to `scale·(1 + spread)` about the centre, averaged (copy i is drawn
 * with alpha 1/(i+1) over the running result, which is the mean). A blurred frame is built at half resolution with
 * enough copies that they sit ≤ 2 px apart at the frame edge (no ghosting), then scaled up.
 */
export function zoomBlur(dst: Surface, src: Surface, scale: number, spread: number): void {
  const W = dst.width, H = dst.height;
  const draw = (c: Surface['ctx'], w: number, h: number, n: number) => {
    c.save();
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    for (let i = 0; i < n; i++) {
      const s = scale * (1 + (n > 1 ? (spread * i) / (n - 1) : 0));
      c.globalAlpha = 1 / (i + 1);
      c.setTransform(s * (w / W), 0, 0, s * (h / H), (w * (1 - s)) / 2, (h * (1 - s)) / 2);
      c.drawImage(src.canvas, 0, 0);
    }
    c.restore();
  };
  if (!(spread > 0.002)) { draw(dst.ctx, W, H, 1); return; }
  const w = Math.max(1, Math.round(W / 2)), h = Math.max(1, Math.round(H / 2));
  const n = Math.min(32, Math.max(3, Math.ceil((spread * Math.hypot(w, h)) / 2 / 2)));
  const half = dst.scratch(w, h);
  draw(half.ctx, w, h, n);
  const c = dst.ctx;
  c.save();
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(half.canvas, 0, 0, w, h, 0, 0, W, H);
  c.restore();
}

export default defineTransition({
  type: 'zoom-punch',
  describe: 'Punch cut: the outgoing clip rushes into the centre with a zoom blur, hard-cuts on a short flash, and the incoming clip punches out from zoomed-in to rest (e.g. transition.set shot-2 type=zoom-punch len=0.35s; 0.25–0.5 s, made for beat-synced cuts).',
  params: z.object({
    scale: z.number().min(1).max(4).default(1.6).describe('zoom factor at the cut'),
    blur: z.number().min(0).max(1).default(0.6).describe('zoom blur strength (0 = sharp)'),
    flash: z.number().min(0).max(1).default(0.35).describe('brightness of the white flash at the cut (0 = none)'),
  }),
  draw({ from, to, dst, progress: p, params }) {
    if (p <= 0 || p >= 1) { put(dst, p <= 0 ? from : to); return; }
    const out = p < 0.5;
    // in: accelerate into the cut (inCubic); out: decelerate from it (outExpo-like quart)
    const q = out ? (p / 0.5) ** 3 : 1 - (1 - (p - 0.5) / 0.5) ** 4;
    const scale = out ? 1 + (params.scale - 1) * q : params.scale - (params.scale - 1) * q;
    const spread = params.blur * 0.25 * (out ? q : 1 - q);
    zoomBlur(dst, out ? from : to, scale, spread);
    // a white flash peaking at the cut (narrow: 25% of the transition)
    const k = Math.max(0, 1 - Math.abs(p - 0.5) / 0.125);
    if (params.flash > 0 && k > 0) {
      const c = dst.ctx;
      c.save();
      c.globalAlpha = params.flash * k * k;
      c.globalCompositeOperation = 'lighter';
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, dst.width, dst.height);
      c.restore();
    }
  },
});
