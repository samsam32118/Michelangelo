/** Shape layers: rect, ellipse, line, polygon, star, SVG path; fill, stroke, gradient, trim (dash). */
import { Path2D, type SKRSContext2D, type CanvasGradient } from '@napi-rs/canvas';
import type { ShapeSpec } from '../../core/schema/index.js';
import { pathBounds, pathLength, pointsBounds } from '../path.js';

type Pt = [number, number];

function regular(n: number, w: number, h: number, inner?: number): Pt[] {
  const pts: Pt[] = [];
  const count = inner === undefined ? n : n * 2;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const r = inner !== undefined && i % 2 ? inner : 1;
    pts.push([w / 2 + (Math.cos(a) * r * w) / 2, h / 2 + (Math.sin(a) * r * h) / 2]);
  }
  return pts;
}

function polyLength(pts: Pt[], closed: boolean): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  if (closed && pts.length > 1) L += Math.hypot(pts[0]![0] - pts.at(-1)![0], pts[0]![1] - pts.at(-1)![1]);
  return L;
}

export { pathLength } from '../path.js';

function shapePath(s: ShapeSpec, w: number, h: number): { path: Path2D; length: number; closed: boolean } {
  const p = new Path2D();
  const poly = (pts: Pt[], closed: boolean) => {
    pts.forEach((pt, i) => (i ? p.lineTo(pt[0], pt[1]) : p.moveTo(pt[0], pt[1])));
    if (closed) p.closePath();
    return { path: p, length: polyLength(pts, closed), closed };
  };
  switch (s.type) {
    case 'rect': {
      const r = Math.min(s.radius ?? 0, w / 2, h / 2);
      if (r > 0) p.roundRect(0, 0, w, h, r); else p.rect(0, 0, w, h);
      return { path: p, length: 2 * (w + h) - (8 - 2 * Math.PI) * r, closed: true };
    }
    case 'ellipse': {
      // start at the top (for trim) by rotating the ellipse instead of the angles (Skia drops -π/2..3π/2)
      p.ellipse(w / 2, h / 2, h / 2, w / 2, -Math.PI / 2, 0, 2 * Math.PI);
      const a = w / 2, b = h / 2;
      return { path: p, length: Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))), closed: true };
    }
    case 'line': return poly(s.points?.length ? s.points : [[0, h / 2], [w, h / 2]], false);
    case 'polygon': return poly(s.points?.length ? s.points : regular(s.sides ?? 6, w, h), true);
    case 'star': return poly(regular(s.sides ?? 5, w, h, 0.5), true);
    case 'path': {
      const d = s.d ?? '';
      return { path: new Path2D(d), length: pathLength(d), closed: /z\s*$/i.test(d) };
    }
  }
}

function gradientOf(ctx: SKRSContext2D, g: NonNullable<ShapeSpec['gradient']>, w: number, h: number): CanvasGradient {
  let grad: CanvasGradient;
  if (g.type === 'radial') grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) / 2);
  else {
    const a = ((g.angle ?? 0) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const half = Math.abs((w / 2) * cos) + Math.abs((h / 2) * sin);
    grad = ctx.createLinearGradient(w / 2 - cos * half, h / 2 - sin * half, w / 2 + cos * half, h / 2 + sin * half);
  }
  for (const [o, c] of g.stops) grad.addColorStop(Math.min(1, Math.max(0, o)), c);
  return grad;
}

/** Stroke styling and partial outlines added to shapes (fields may be absent from older schemas). */
export interface ShapeStroke { lineCap?: 'butt' | 'round' | 'square'; lineJoin?: 'miter' | 'round' | 'bevel' }

/** Margin a shape draws outside its box: half the stroke (more for miter joins), and path/point geometry at negative coordinates. */
export function shapeOverhang(s: ShapeSpec): number {
  const st = s as ShapeSpec & ShapeStroke;
  const half = s.stroke || s.type === 'line' ? Math.ceil(((s.strokeWidth ?? 4) / 2) * (st.lineJoin === 'miter' ? 4 : st.lineCap === 'square' ? Math.SQRT2 : 1)) + 1 : 0;
  let neg = 0;
  const b = s.type === 'path' && s.d ? pathBounds(s.d) : (s.type === 'line' || s.type === 'polygon') && s.points?.length ? pointsBounds(s.points) : null;
  if (b) neg = Math.ceil(Math.max(0, -b.x, -b.y));
  return half + neg;
}

/**
 * Dash pattern + offset that strokes only the fraction [start, end) of an outline of length L, shifted by `offset`
 * (fractions; the window wraps around the start of the path, as After Effects' trim paths offset does).
 * null = the whole outline; 'none' = nothing.
 */
export function trimDash(L: number, start: number, end: number, offset: number): { dash: number[]; offset: number } | null | 'none' {
  let a = Math.min(start, end), b = Math.max(start, end);
  if (b - a >= 1 - 1e-9) return null;
  if (b - a <= 1e-9 || !(L > 0)) return 'none';
  const o = offset - Math.floor(offset);
  a += o; b += o;
  if (a >= 1) { a -= 1; b -= 1; }
  if (b <= 1 + 1e-9) return { dash: [(b - a) * L, 2 * L + 1], offset: -a * L };
  // wraps: on [0, b-1), off, on [a, 1)
  return { dash: [(b - 1) * L, (a - (b - 1)) * L, (1 - a) * L + 1, 2 * L], offset: 0 };
}

/** Draw a shape in layer px (0,0)-(w,h) on a context already transformed to layer px. */
export function drawShape(ctx: SKRSContext2D, s: ShapeSpec, w: number, h: number, trim?: number, trimStart = 0, trimOffset = 0): void {
  const { path, length } = shapePath(s, w, h);
  const st = s as ShapeSpec & ShapeStroke;
  const t = trim ?? 1;
  const dash = trimDash(length, trimStart, t, trimOffset);
  const trimmed = dash !== null;
  ctx.save();
  if (s.type !== 'line' && s.fill !== 'none') {
    ctx.fillStyle = s.gradient ? gradientOf(ctx, s.gradient, w, h) : (s.fill ?? '#ffffff');
    ctx.fill(path);
  }
  const strokeColor = s.stroke ?? (s.type === 'line' ? (s.fill && s.fill !== 'none' ? s.fill : '#ffffff') : undefined);
  if (strokeColor && dash !== 'none') {
    ctx.strokeStyle = s.type === 'line' && s.gradient ? gradientOf(ctx, s.gradient, w, h) : strokeColor;
    ctx.lineWidth = s.strokeWidth ?? 4;
    ctx.lineJoin = st.lineJoin ?? 'round';
    ctx.lineCap = st.lineCap ?? (trimmed ? 'butt' : 'round');
    if (dash) { ctx.setLineDash(dash.dash); ctx.lineDashOffset = dash.offset; }
    ctx.stroke(path);
  }
  ctx.restore();
}
