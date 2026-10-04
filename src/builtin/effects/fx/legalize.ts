import { defineEffect, z } from '../../../plugin/api.js';

// BT.709 luma weights
const KR = 0.2126, KB = 0.0722, KG = 1 - KR - KB;

export interface LegalizeParams { mode: 'clamp' | 'limit'; range: 'tv' | 'pc'; black: number; white: number; chroma: number }

/**
 * Keep one RGB pixel (0..255, full range, as rendered) inside legal video levels: luma code in [black, white] and
 * chroma codes in [256 - chroma, chroma], in the 8-bit Y'CbCr the encoder writes for `range` (tv: Y = 16 + 219·Y',
 * pc: Y = 255·Y'). `clamp` clips only out-of-range values; `limit` scales the whole range into the legal one.
 */
export function legalizePixel(r: number, g: number, b: number, p: LegalizeParams): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  let y = KR * R + KG * G + KB * B;
  let cb = (B - y) / (2 * (1 - KB)), cr = (R - y) / (2 * (1 - KR));
  const [y0, ys, cs] = p.range === 'tv' ? [16, 219, 224] : [0, 255, 255];
  let Y = y0 + ys * y, Cb = 128 + cs * cb, Cr = 128 + cs * cr;
  const cMax = p.chroma, cMin = 256 - p.chroma;
  if (p.mode === 'limit') {
    // map the code range a full-range frame can produce onto the legal range
    Y = p.black + ((Y - y0) / ys) * (p.white - p.black);
    const k = (cMax - 128) / (cs / 2);
    if (k < 1) { Cb = 128 + (Cb - 128) * k; Cr = 128 + (Cr - 128) * k; }
  }
  Y = Math.min(p.white, Math.max(p.black, Y));
  Cb = Math.min(cMax, Math.max(cMin, Cb));
  Cr = Math.min(cMax, Math.max(cMin, Cr));
  y = (Y - y0) / ys; cb = (Cb - 128) / cs; cr = (Cr - 128) / cs;
  const R2 = y + 2 * (1 - KR) * cr, B2 = y + 2 * (1 - KB) * cb, G2 = (y - KR * R2 - KB * B2) / KG;
  const to8 = (v: number) => Math.min(255, Math.max(0, Math.round(v * 255)));
  return [to8(R2), to8(G2), to8(B2)];
}

export default defineEffect({
  type: 'legalize',
  describe: 'Broadcast-safe levels: keeps luma within black..white (16–235) and chroma within 16..chroma (240) in the delivered video (mode=clamp clips only illegal pixels, mode=limit compresses the whole range; set range=pc for full-range deliveries, or raise black / lower white for a safety margin with the default tv-range encode).',
  params: z.object({
    mode: z.enum(['clamp', 'limit']).default('clamp'),
    range: z.enum(['tv', 'pc']).default('tv').describe('the colour range of the delivery (render colorRange; tv is the default)'),
    black: z.number().min(0).max(128).default(16).describe('lowest legal 8-bit luma code'),
    white: z.number().min(128).max(255).default(235).describe('highest legal 8-bit luma code'),
    chroma: z.number().min(129).max(255).default(240).describe('highest legal 8-bit chroma code (lowest = 256 - chroma)'),
  }),
  draw({ src, dst, params: p }) {
    const s = src.pixels(), d = dst.pixels();
    let last = -1, out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < s.length; i += 4) {
      const a = s[i + 3]!;
      if (a === 0) continue;
      const key = (s[i]! << 16) | (s[i + 1]! << 8) | s[i + 2]!;
      if (key !== last) { out = legalizePixel(s[i]!, s[i + 1]!, s[i + 2]!, p); last = key; }
      d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; d[i + 3] = a;
    }
    dst.commit();
  },
});
