/** Plain geometry in board coordinates: boxes, points, rotation, distances. */
import type { Point } from './types.js';

export interface Box { x: number; y: number; w: number; h: number }

export function unionBoxes(bs: readonly Box[]): Box | undefined {
  if (!bs.length) return undefined;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of bs) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const pointInRect = (p: Point, b: Box, tol = 0): boolean =>
  p[0] >= b.x - tol && p[0] <= b.x + b.w + tol && p[1] >= b.y - tol && p[1] <= b.y + b.h + tol;

export const boxesIntersect = (a: Box, b: Box): boolean => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
/** a fully inside b */
export const boxInside = (a: Box, b: Box): boolean => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
export const expandBox = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });
export const center = (b: Box): Point => [b.x + b.w / 2, b.y + b.h / 2];
/** box from two corners in any order */
export const boxFrom = (a: Point, b: Point): Box => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) });

export const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** rotate p around c by `deg` degrees (clockwise on screen, y down) */
export function rotatePoint(p: Point, c: Point, deg: number): Point {
  if (!deg) return p;
  const a = toRad(deg), cos = Math.cos(a), sin = Math.sin(a), dx = p[0] - c[0], dy = p[1] - c[1];
  return [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos];
}

/** axis-aligned bounds of a box rotated by `deg` around its centre */
export function rotatedBounds(b: Box, deg: number): Box {
  if (!deg) return b;
  const c = center(b);
  const pts = ([[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]] as Point[]).map((p) => rotatePoint(p, c, deg));
  return unionBoxes(pts.map((p) => ({ x: p[0], y: p[1], w: 0, h: 0 })))!;
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** where the ray from the box centre towards `toward` leaves the box (the centre when toward is inside / equal) */
export function edgePoint(b: Box, toward: Point, pad = 0): Point {
  const [cx, cy] = center(b), dx = toward[0] - cx, dy = toward[1] - cy;
  const hw = b.w / 2 + pad, hh = b.h / 2 + pad;
  if (!dx && !dy) return [cx, cy];
  const s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return s >= 1 ? [cx, cy] : [cx + dx * s, cy + dy * s];
}

/** where the ray from an ellipse's centre towards `toward` leaves it */
export function ellipseEdgePoint(b: Box, toward: Point, pad = 0): Point {
  const [cx, cy] = center(b), dx = toward[0] - cx, dy = toward[1] - cy;
  const rx = b.w / 2 + pad, ry = b.h / 2 + pad;
  if ((!dx && !dy) || !rx || !ry) return [cx, cy];
  const s = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
  return s >= 1 ? [cx, cy] : [cx + dx * s, cy + dy * s];
}
