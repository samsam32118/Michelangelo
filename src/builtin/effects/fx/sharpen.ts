import { defineEffect, z } from '../../../plugin/api.js';

/** Unsharp mask: out = v + amount·(v − blur(v)), with a 5×5 neighbourhood on both stages. */
export default defineEffect({
  type: 'sharpen',
  describe: 'Sharpens detail with an unsharp mask (ffmpeg unsharp on media; the same maths on other layers).',
  params: z.object({ amount: z.number().min(0).max(1.5).default(0.8) }),
  source: (p) => (p.amount > 0 ? [{ filter: 'unsharp', args: { luma_msize_x: 5, luma_msize_y: 5, luma_amount: p.amount, chroma_msize_x: 5, chroma_msize_y: 5, chroma_amount: p.amount } }] : []),
  draw({ src, dst, params: { amount } }) {
    if (amount <= 0) { dst.ctx.drawImage(src.canvas, 0, 0); return; }
    const w = src.width, h = src.height, s = src.pixels(), d = dst.pixels();
    // separable 5×5 box mean (edge pixels repeated), as ffmpeg unsharp does
    const R = 2, hs = new Uint16Array(w * h * 3), m = new Uint16Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) {
      const row = y * w;
      let acc = 0;
      for (let k = -R; k <= R; k++) acc += s[(row + Math.min(w - 1, Math.max(0, k))) * 4 + c]!;
      for (let x = 0; x < w; x++) {
        hs[(row + x) * 3 + c] = acc;
        acc += s[(row + Math.min(w - 1, x + R + 1)) * 4 + c]! - s[(row + Math.max(0, x - R)) * 4 + c]!;
      }
    }
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -R; k <= R; k++) acc += hs[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + c]!;
      for (let y = 0; y < h; y++) {
        m[(y * w + x) * 3 + c] = acc;
        acc += hs[(Math.min(h - 1, y + R + 1) * w + x) * 3 + c]! - hs[(Math.max(0, y - R) * w + x) * 3 + c]!;
      }
    }
    const k = amount, n = 1 / 25;
    for (let i = 0, j = 0; i < s.length; i += 4, j += 3) {
      const a = s[i + 3]!;
      if (a === 0) continue;
      d[i] = s[i]! + k * (s[i]! - m[j]! * n);
      d[i + 1] = s[i + 1]! + k * (s[i + 1]! - m[j + 1]! * n);
      d[i + 2] = s[i + 2]! + k * (s[i + 2]! - m[j + 2]! * n);
      d[i + 3] = a;
    }
    dst.commit();
  },
});
