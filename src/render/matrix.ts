/** 2D affine matrices in canvas order [a, b, c, d, e, f]: (x, y) → (a·x + c·y + e, b·x + d·y + f). */
import type { Matrix } from './types.js';

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 · m2 (m2 applies first). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1, [a2, b2, c2, d2, e2, f2] = m2;
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1];
}

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [0, 0, 0, 0, 0, 0];
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function translate(x: number, y: number): Matrix { return [1, 0, 0, 1, x, y]; }
export function scaling(sx: number, sy: number): Matrix { return [sx, 0, 0, sy, 0, 0]; }
/** Clockwise on screen (y down), in degrees. */
export function rotation(deg: number): Matrix {
  const r = (deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  return [cos, sin, -sin, cos, 0, 0];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Axis-aligned bounds [x, y, w, h] of the box (0,0)-(w,h) under m. */
export function bounds(m: Matrix, w: number, h: number): [number, number, number, number] {
  const pts = [apply(m, 0, 0), apply(m, w, 0), apply(m, 0, h), apply(m, w, h)];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
}
