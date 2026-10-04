/** Easing functions and keyframe interpolation (pure). Keyframes are [frame, value, easing?]; a key's easing shapes the segment that starts at it. */
import type { Easing } from '../core/schema/index.js';

type EaseFn = (t: number) => number;

const PI = Math.PI;
const c1 = 1.70158, c2 = c1 * 1.525, c3 = c1 + 1, c4 = (2 * PI) / 3, c5 = (2 * PI) / 4.5;
const pow = Math.pow;

function outBounce(t: number): number {
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

export const EASING_FUNCTIONS: Record<string, EaseFn> = {
  linear: (t) => t,
  hold: () => 0,
  inSine: (t) => 1 - Math.cos((t * PI) / 2),
  outSine: (t) => Math.sin((t * PI) / 2),
  inOutSine: (t) => -(Math.cos(PI * t) - 1) / 2,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2),
  inQuart: (t) => t * t * t * t,
  outQuart: (t) => 1 - pow(1 - t, 4),
  inOutQuart: (t) => (t < 0.5 ? 8 * pow(t, 4) : 1 - pow(-2 * t + 2, 4) / 2),
  inExpo: (t) => (t === 0 ? 0 : pow(2, 10 * t - 10)),
  outExpo: (t) => (t === 1 ? 1 : 1 - pow(2, -10 * t)),
  inOutExpo: (t) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? pow(2, 20 * t - 10) / 2 : (2 - pow(2, -20 * t + 10)) / 2),
  inBack: (t) => c3 * t * t * t - c1 * t * t,
  outBack: (t) => 1 + c3 * pow(t - 1, 3) + c1 * pow(t - 1, 2),
  inOutBack: (t) => (t < 0.5 ? (pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2 : (pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2),
  inElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : -pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4)),
  outElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1),
  inOutElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5
    ? -(pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
    : (pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1),
  inBounce: (t) => 1 - outBounce(1 - t),
  outBounce,
  inOutBounce: (t) => (t < 0.5 ? (1 - outBounce(1 - 2 * t)) / 2 : (1 + outBounce(2 * t - 1)) / 2),
};

/** CSS cubic-bezier(x1, y1, x2, y2): solve x(s) = t for s, return y(s). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  const bez = (a: number, b: number, s: number) => 3 * a * (1 - s) * (1 - s) * s + 3 * b * (1 - s) * s * s + s * s * s;
  const dbez = (a: number, b: number, s: number) => 3 * a * (1 - s) * (1 - s) + 6 * (b - a) * (1 - s) * s + 3 * (1 - b) * s * s;
  return (t) => {
    if (t <= 0 || t >= 1) return t <= 0 ? 0 : 1;
    let s = t;
    for (let i = 0; i < 8; i++) {
      const err = bez(x1, x2, s) - t;
      if (Math.abs(err) < 1e-7) return bez(y1, y2, s);
      const d = dbez(x1, x2, s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0, hi = 1;
    s = t;
    for (let i = 0; i < 40; i++) {
      const x = bez(x1, x2, s);
      if (Math.abs(x - t) < 1e-7) break;
      if (x < t) lo = s; else hi = s;
      s = (lo + hi) / 2;
    }
    return bez(y1, y2, s);
  };
}

/** The easing function for a name or a bezier [x1, y1, x2, y2] (unknown names are linear). */
export function easingFn(e: Easing | string | undefined): EaseFn {
  if (Array.isArray(e)) return cubicBezier(e[0], e[1], e[2], e[3]);
  return EASING_FUNCTIONS[e ?? 'linear'] ?? EASING_FUNCTIONS.linear!;
}

export function ease(e: Easing | string | undefined, t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return easingFn(e)(c);
}

export function isKeyframeList(v: unknown): v is [number, unknown, Easing?][] {
  return Array.isArray(v) && v.length > 0 && v.every((k) => Array.isArray(k) && (k.length === 2 || k.length === 3) && typeof k[0] === 'number');
}

function lerpValue(a: unknown, b: unknown, t: number): unknown {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (Array.isArray(a) || Array.isArray(b)) {
    const av = Array.isArray(a) ? a as number[] : [a as number, a as number];
    const bv = Array.isArray(b) ? b as number[] : [b as number, b as number];
    return av.map((x, i) => x + ((bv[i] ?? x) - x) * t);
  }
  return t < 1 ? a : b;
}

/** The value of a constant or keyframe list at a (clip-local) frame. Before the first / after the last key the edge value holds. */
export function interpolate<V>(v: V | [number, V, Easing?][], frame: number): V {
  if (!isKeyframeList(v)) return v as V;
  const keys = v as [number, V, Easing?][];
  if (frame <= keys[0]![0]) return keys[0]![1];
  const last = keys[keys.length - 1]!;
  if (frame >= last[0]) return last[1];
  let i = 0;
  while (i < keys.length - 2 && frame >= keys[i + 1]![0]) i++;
  const [f0, v0, e] = keys[i]!;
  const [f1, v1] = keys[i + 1]!;
  if (e === 'hold') return v0;
  const t = easingFn(e)((frame - f0) / (f1 - f0));
  return lerpValue(v0, v1, t) as V;
}
