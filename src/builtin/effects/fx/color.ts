import { defineEffect, z, type FilterSpec } from '../../../plugin/api.js';
import { clamp } from '../util.js';

type ColorParams = { brightness: number; contrast: number; saturation: number; hue: number; temperature: number; tint: number };

/**
 * The colour correction is defined once, as (1) a per-channel curve v → (v − 127.5)·contrast + 127.5 + brightness·255
 * and (2) a 3×3 RGB matrix (white balance gains · saturation · hue rotation). The layer stage applies them per
 * pixel; the source stage emits the same maths as lutrgb + colorchannelmixer, so media and other layers match.
 */
export function colorMatrix(p: ColorParams): number[] {
  const L = [0.2126, 0.7152, 0.0722];
  const gains = [1 + 0.2 * p.temperature, 1 - 0.2 * p.tint, 1 - 0.2 * p.temperature];
  const s = p.saturation;
  const S = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (1 - s) * L[j]! + (i === j ? s : 0)));
  const a = (p.hue * Math.PI) / 180, c = Math.cos(a), n = Math.sin(a);
  const H = [
    [0.213 + c * 0.787 - n * 0.213, 0.715 - c * 0.715 - n * 0.715, 0.072 - c * 0.072 + n * 0.928],
    [0.213 - c * 0.213 + n * 0.143, 0.715 + c * 0.285 + n * 0.14, 0.072 - c * 0.072 - n * 0.283],
    [0.213 - c * 0.213 - n * 0.787, 0.715 - c * 0.715 + n * 0.715, 0.072 + c * 0.928 + n * 0.072],
  ];
  const m: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let v = 0;
    for (let k = 0; k < 3; k++) v += H[i]![k]! * S[k]![j]!;
    // colorchannelmixer accepts −2..2; clamp in both stages so they stay identical
    m.push(Math.round(clamp(v * gains[j]!, -2, 2) * 1e4) / 1e4);
  }
  return m;
}

const curve = (p: ColorParams, v: number) => clamp(Math.round((v - 127.5) * p.contrast + 127.5 + p.brightness * 255), 0, 255);
const isIdentity = (p: ColorParams) => p.brightness === 0 && p.contrast === 1 && p.saturation === 1 && p.hue === 0 && p.temperature === 0 && p.tint === 0;

export default defineEffect({
  type: 'color',
  describe: 'Colour correction: brightness, contrast, saturation, hue rotation, temperature and tint.',
  params: z.object({
    brightness: z.number().min(-1).max(1).default(0),
    contrast: z.number().min(0).max(3).default(1),
    saturation: z.number().min(0).max(2).default(1),
    hue: z.number().min(-180).max(180).default(0).describe('hue rotation in degrees'),
    temperature: z.number().min(-1).max(1).default(0).describe('-1 cool (blue) .. 1 warm (orange)'),
    tint: z.number().min(-1).max(1).default(0).describe('-1 green .. 1 magenta'),
  }),
  source(p) {
    if (isIdentity(p)) return [];
    const out: FilterSpec[] = [];
    if (p.brightness !== 0 || p.contrast !== 1) {
      const e = `clip(round((val-127.5)*${p.contrast}+127.5+${p.brightness * 255}),0,255)`;
      out.push({ filter: 'lutrgb', args: { r: e, g: e, b: e } });
    }
    const m = colorMatrix(p), k = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
    if (m.some((v, i) => v !== (i % 4 === 0 ? 1 : 0))) out.push({ filter: 'colorchannelmixer', args: Object.fromEntries(k.map((n, i) => [n, m[i]!])) });
    return out;
  },
  draw({ src, dst, params: p }) {
    if (isIdentity(p)) { dst.ctx.drawImage(src.canvas, 0, 0); return; }
    const lut = new Uint8Array(256).map((_, v) => curve(p, v));
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = colorMatrix(p) as [number, number, number, number, number, number, number, number, number];
    const s = src.pixels(), d = dst.pixels();
    for (let i = 0; i < s.length; i += 4) {
      const a = s[i + 3]!;
      if (a === 0) continue;
      const r = lut[s[i]!]!, g = lut[s[i + 1]!]!, b = lut[s[i + 2]!]!;
      d[i] = m0 * r + m1 * g + m2 * b;
      d[i + 1] = m3 * r + m4 * g + m5 * b;
      d[i + 2] = m6 * r + m7 * g + m8 * b;
      d[i + 3] = a;
    }
    dst.commit();
  },
});
