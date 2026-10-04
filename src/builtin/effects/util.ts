/** Shared helpers for the built-in effects, transitions and generators (public plugin API only). */
import { z, type Surface, type Canvas2D } from '../../plugin/api.js';

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => clamp(v, 0, 1);
export const smoothstep = (a: number, b: number, v: number) => {
  if (a === b) return v < a ? 0 : 1;
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const COLOR_RE = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgba?|hsla?)\([^()]*\)|[a-z]+)$/i;
/** A CSS colour parameter: "#ff0000", "red", "rgba(0,0,0,0.5)". */
export const colorValue = z.string().trim().regex(COLOR_RE, 'is not a colour (use "#rrggbb", a CSS name or rgba(...))');
export const color = (def: string) => colorValue.default(def);
export const colorList = (def: string[]) => z.array(colorValue).min(2).max(16).default(def);
export const direction = z.enum(['left', 'right', 'up', 'down']);
export type Direction = z.infer<typeof direction>;
/** unit vector of a direction (y down) */
export const dirVec = (d: Direction): [number, number] => (d === 'left' ? [-1, 0] : d === 'right' ? [1, 0] : d === 'up' ? [0, -1] : [0, 1]);

/** A colour as straight RGBA bytes, resolved by the canvas itself (so any CSS colour works). */
export function rgbaOf(s: Surface, c: string): [number, number, number, number] {
  const t = s.scratch(1, 1);
  t.ctx.fillStyle = c;
  t.ctx.fillRect(0, 0, 1, 1);
  const p = t.pixels();
  return [p[0]!, p[1]!, p[2]!, p[3]!];
}

/** 32-bit integer hash of several numbers (deterministic seeds from seed, frame, index). */
export function hash32(...ns: number[]): number {
  let h = 0x811c9dc5;
  for (const n of ns) {
    h = Math.imul(h ^ (n | 0), 0x01000193);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  return h >>> 0;
}

/** mulberry32: a seeded PRNG in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DrawOpts { alpha?: number; op?: Canvas2D['globalCompositeOperation']; dx?: number; dy?: number }

/** Draw a surface into dst with alpha / composite op / offset, leaving dst's state untouched. */
export function put(dst: Surface, src: Surface, o: DrawOpts = {}): void {
  const c = dst.ctx;
  c.save();
  c.globalAlpha = o.alpha ?? 1;
  c.globalCompositeOperation = o.op ?? 'source-over';
  c.drawImage(src.canvas, o.dx ?? 0, o.dy ?? 0);
  c.restore();
}

/** Draw src scaled by `scale` and rotated by `rad` about the centre. */
export function putTransformed(dst: Surface, src: Surface, scale: number, rad: number, o: DrawOpts = {}): void {
  if (scale <= 0) return;
  const c = dst.ctx;
  c.save();
  c.globalAlpha = o.alpha ?? 1;
  c.globalCompositeOperation = o.op ?? 'source-over';
  c.translate(dst.width / 2 + (o.dx ?? 0), dst.height / 2 + (o.dy ?? 0));
  c.rotate(rad);
  c.scale(scale, scale);
  c.drawImage(src.canvas, -src.width / 2, -src.height / 2);
  c.restore();
}

/** A copy of src filled with `c` wherever src has alpha (a silhouette). */
export function silhouette(src: Surface, c: string): Surface {
  const t = src.scratch();
  t.ctx.drawImage(src.canvas, 0, 0);
  t.ctx.globalCompositeOperation = 'source-in';
  t.ctx.fillStyle = c;
  t.ctx.fillRect(0, 0, t.width, t.height);
  t.ctx.globalCompositeOperation = 'source-over';
  return t;
}

/** Largest blur radius drawn at full resolution; larger radii blur a downscaled copy (same look, far cheaper). */
const FULL_RES_RADIUS = 12;

/**
 * Gaussian blur (CSS blur radius = standard deviation, px) of src into dst.
 * `extend` repeats the edge pixels outward first, so an opaque frame does not darken at its borders.
 */
export function blurInto(dst: Surface, src: Surface, radius: number, o: DrawOpts & { extend?: boolean } = {}): void {
  if (!(radius > 0.05)) return put(dst, src, o);
  const { width: w, height: h } = src;
  const f = radius > FULL_RES_RADIUS ? radius / FULL_RES_RADIUS : 1;
  const sw = w / f, sh = h / f, r = radius / f;
  const pad = o.extend ? Math.ceil(3 * r) + 1 : 0;
  const small = src.scratch(Math.ceil(sw) + 2 * pad, Math.ceil(sh) + 2 * pad);
  const s = small.ctx;
  s.imageSmoothingEnabled = true;
  s.imageSmoothingQuality = 'high';
  s.drawImage(src.canvas, 0, 0, w, h, pad, pad, sw, sh);
  if (pad) {
    const R = pad + sw, B = pad + sh;
    // edge strips and corners, stretched from the outermost row/column
    s.drawImage(src.canvas, 0, 0, 1, h, 0, pad, pad, sh);
    s.drawImage(src.canvas, w - 1, 0, 1, h, R, pad, pad, sh);
    s.drawImage(src.canvas, 0, 0, w, 1, pad, 0, sw, pad);
    s.drawImage(src.canvas, 0, h - 1, w, 1, pad, B, sw, pad);
    s.drawImage(src.canvas, 0, 0, 1, 1, 0, 0, pad, pad);
    s.drawImage(src.canvas, w - 1, 0, 1, 1, R, 0, pad, pad);
    s.drawImage(src.canvas, 0, h - 1, 1, 1, 0, B, pad, pad);
    s.drawImage(src.canvas, w - 1, h - 1, 1, 1, R, B, pad, pad);
  }
  const blurred = small.scratch();
  blurred.ctx.filter = `blur(${r}px)`;
  blurred.ctx.drawImage(small.canvas, 0, 0);
  const c = dst.ctx;
  c.save();
  c.globalAlpha = o.alpha ?? 1;
  c.globalCompositeOperation = o.op ?? 'source-over';
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(blurred.canvas, pad, pad, sw, sh, o.dx ?? 0, o.dy ?? 0, w, h);
  c.restore();
}
