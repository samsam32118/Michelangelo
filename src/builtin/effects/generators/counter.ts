import { defineGenerator, z } from '../../../plugin/api.js';
import { color } from '../util.js';

type P = { from: number; to: number; decimals: number; prefix: string; suffix: string; separator: string };

export function formatCounter(p: P, v: number): string {
  const [int, dec] = Math.abs(v).toFixed(p.decimals).split('.') as [string, string | undefined];
  const grouped = p.separator ? int.replace(/\B(?=(\d{3})+(?!\d))/g, p.separator) : int;
  const neg = v < 0 && Number(v.toFixed(p.decimals)) !== 0;
  return `${p.prefix}${neg ? '-' : ''}${grouped}${dec ? '.' + dec : ''}${p.suffix}`;
}

const EASE = {
  linear: (t: number) => t,
  'ease-out': (t: number) => 1 - (1 - t) ** 3,
  'ease-in-out': (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
};

export default defineGenerator({
  type: 'counter',
  describe: 'A number that counts from `from` to `to` over duration frames (stats, prices, countdowns).',
  params: z.object({
    from: z.number().default(0),
    to: z.number().default(100),
    duration: z.number().int().min(1).max(10_000_000).default(60).describe('frames to reach `to`; it then holds'),
    decimals: z.number().int().min(0).max(6).default(0),
    prefix: z.string().max(40).default(''),
    suffix: z.string().max(40).default(''),
    separator: z.string().max(3).default('').describe('thousands separator, e.g. ","'),
    easing: z.enum(['linear', 'ease-out', 'ease-in-out']).default('ease-out'),
    font: z.string().min(1).default('Inter'),
    weight: z.number().int().min(100).max(900).default(700),
    color: color('#ffffff'),
    size: z.number().min(4).max(2000).default(160).describe('font size in px'),
  }),
  size(p) {
    const chars = Math.max(formatCounter(p, p.from).length, formatCounter(p, p.to).length);
    return [Math.ceil(p.size * (0.62 * chars + 0.4)), Math.ceil(p.size * 1.3)];
  },
  draw({ dst, params: p, frame }) {
    const t = Math.min(1, Math.max(0, frame / Math.max(1, p.duration - 1)));
    const text = formatCounter(p, p.from + (p.to - p.from) * EASE[p.easing](t));
    const c = dst.ctx, W = dst.width, H = dst.height;
    c.save();
    c.font = `${p.weight} ${p.size}px "${p.font}"`;
    c.fillStyle = p.color;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const tw = c.measureText(text).width;
    // shrink to fit when a font is wider than the box estimate (keeps the layer box stable)
    if (tw > W) { c.translate(W / 2, H / 2); c.scale(W / tw, W / tw); c.translate(-W / 2, -H / 2); }
    c.fillText(text, W / 2, H / 2);
    c.restore();
  },
});
