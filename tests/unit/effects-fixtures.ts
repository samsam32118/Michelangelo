/** Helpers for the built-in effects / transitions / generators tests. */
import { createSurface } from '../../src/plugin/surface.js';
import type { Surface, EffectDef, TransitionDef, GeneratorDef } from '../../src/plugin/api.js';
import builtin from '../../src/builtin/effects/index.js';

export { createSurface };
export type RGBA = [number, number, number, number];

const find = <T extends { type: string }>(items: T[] | undefined, type: string): T => {
  const d = items?.find((x) => x.type === type);
  if (!d) throw new Error(`no built-in ${type}`);
  return d;
};
export const effect = (t: string): EffectDef => find(builtin.effects, t);
export const transition = (t: string): TransitionDef => find(builtin.transitions, t);
export const generator = (t: string): GeneratorDef => find(builtin.generators, t);

export const info = (frame = 0, seed = 1, fps = 30) => ({ frame, time: frame / fps, fps, seed, comp: { width: 1080, height: 1920 } });

export function px(s: Surface, x: number, y: number): RGBA {
  const d = s.ctx.getImageData(x, y, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!, d[3]!];
}

/** A surface filled by `paint`. */
export function surface(w: number, h: number, paint: (ctx: Surface['ctx'], w: number, h: number) => void): Surface {
  const s = createSurface(w, h);
  paint(s.ctx, w, h);
  return s;
}
export const solid = (w: number, h: number, c: string) => surface(w, h, (x) => { x.fillStyle = c; x.fillRect(0, 0, w, h); });
/** black frame with a white square in the middle (half the size) */
export const square = (n = 64, bg: string | null = '#000') => surface(n, n, (x) => {
  if (bg) { x.fillStyle = bg; x.fillRect(0, 0, n, n); }
  x.fillStyle = '#fff'; x.fillRect(n / 4, n / 4, n / 2, n / 2);
});
/** colour bars: 8 vertical bars with varied hues, plus a luma ramp in the bottom quarter */
export const bars = (w = 128, h = 128) => surface(w, h, (x) => {
  const cols = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0', '#202020'];
  cols.forEach((c, i) => { x.fillStyle = c; x.fillRect((i * w) / 8, 0, w / 8, (h * 3) / 4); });
  const g = x.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
  x.fillStyle = g; x.fillRect(0, (h * 3) / 4, w, h / 4);
});

export function runEffect(type: string, src: Surface, params: Record<string, unknown> = {}, frame = 0, seed = 1): Surface {
  const def = effect(type), dst = src.scratch();
  def.draw!({ src, dst, params: def.params.parse(params) as never, ...info(frame, seed) });
  return dst;
}

export function runTransition(type: string, from: Surface, to: Surface, progress: number, params: Record<string, unknown> = {}): Surface {
  const def = transition(type), dst = from.scratch();
  def.draw({ from, to, dst, progress, params: def.params.parse(params) as never, ...info() });
  return dst;
}

export function runGenerator(type: string, w: number, h: number, params: Record<string, unknown> = {}, frame = 0, seed = 1): Surface {
  const def = generator(type), dst = createSurface(w, h);
  def.draw({ dst, params: def.params.parse(params) as never, ...info(frame, seed) });
  return dst;
}

export const close = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
export const luma = (p: RGBA) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

/** mean absolute difference of RGBA bytes */
export function diff(a: Surface, b: Surface): number {
  const x = a.pixels(), y = b.pixels();
  let s = 0;
  for (let i = 0; i < x.length; i++) s += Math.abs(x[i]! - y[i]!);
  return s / x.length;
}
