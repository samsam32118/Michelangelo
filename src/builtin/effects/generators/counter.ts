import { defineGenerator, z } from '../../../plugin/api.js';
import { color, EASE, EASE_NAMES } from '../util.js';

type P = { from: number; to: number; decimals: number; prefix: string; suffix: string; separator: string };

export function formatCounter(p: P, v: number): string {
  const [int, dec] = Math.abs(v).toFixed(p.decimals).split('.') as [string, string | undefined];
  const grouped = p.separator ? int.replace(/\B(?=(\d{3})+(?!\d))/g, p.separator) : int;
  const neg = v < 0 && Number(v.toFixed(p.decimals)) !== 0;
  return `${p.prefix}${neg ? '-' : ''}${grouped}${dec ? '.' + dec : ''}${p.suffix}`;
}

/** older names, kept: ease-out = outCubic, ease-in-out = inOutCubic */
const ALIASES: Record<string, string> = { 'ease-out': 'outCubic', 'ease-in-out': 'inOutCubic', 'ease-in': 'inCubic' };
const easeFn = (name: string) => EASE[ALIASES[name] ?? name] ?? EASE.linear!;

export type Rounding = 'round' | 'floor' | 'ceil' | 'step';
type V = { from: number; to: number; duration: number; decimals: number; easing: string; rounding: Rounding };

/**
 * The counter's value at clip frame `frame`. `round`/`floor`/`ceil` round the eased value at `decimals`;
 * `step` gives every value from `from` to `to` (in steps of 10^-decimals) an equal hold, so a 3-2-1 countdown over
 * 90 frames shows each number for 30 frames.
 */
export function counterValue(p: V, frame: number): number {
  const m = 10 ** p.decimals, e = easeFn(p.easing);
  if (p.rounding === 'step') {
    const n = Math.round(Math.abs(p.to - p.from) * m) + 1;
    const t = Math.min(1, Math.max(0, frame / Math.max(1, p.duration)));
    const i = Math.min(n - 1, Math.max(0, Math.floor(e(t) * n + 1e-9)));
    return p.from + (Math.sign(p.to - p.from) * i) / m;
  }
  const t = Math.min(1, Math.max(0, frame / Math.max(1, p.duration - 1)));
  const v = p.from + (p.to - p.from) * e(t);
  // (+ 0 turns -0 into 0)
  if (p.rounding === 'floor') return Math.floor(v * m + 1e-9) / m + 0;
  if (p.rounding === 'ceil') return Math.ceil(v * m - 1e-9) / m + 0;
  return v;
}

export default defineGenerator({
  type: 'counter',
  describe: 'A number that counts from `from` to `to` over duration frames (stats, prices; countdowns with easing=linear rounding=step).',
  params: z.object({
    from: z.number().default(0),
    to: z.number().default(100),
    duration: z.number().int().min(1).max(10_000_000).default(60).describe('frames to reach `to`; it then holds'),
    decimals: z.number().int().min(0).max(6).default(0),
    prefix: z.string().max(40).default(''),
    suffix: z.string().max(40).default(''),
    separator: z.string().max(3).default('').describe('thousands separator, e.g. ","'),
    easing: z.enum([...EASE_NAMES, ...Object.keys(ALIASES)] as [string, ...string[]]).default('outCubic').describe('keyframe easing names (linear, outCubic, outBack, inOutQuad, ...)'),
    rounding: z.enum(['round', 'floor', 'ceil', 'step']).default('round').describe('round/floor/ceil the eased value; step = equal holds per value (countdowns: from=3 to=1 easing=linear rounding=step)'),
    font: z.string().min(1).default('Inter').describe('a font family, or the id of a font asset'),
    weight: z.number().int().min(100).max(900).default(700),
    color: color('#ffffff'),
    size: z.number().min(4).max(2000).default(160).describe('font size in px'),
  }),
  size(p) {
    const chars = Math.max(formatCounter(p, p.from).length, formatCounter(p, p.to).length);
    return [Math.ceil(p.size * (0.62 * chars + 0.4)), Math.ceil(p.size * 1.3)];
  },
  draw({ dst, params: p, frame }) {
    const text = formatCounter(p, counterValue(p as V, frame));
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
