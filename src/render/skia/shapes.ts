/** Shape layers: rect, ellipse, line, polygon, star, SVG path; fill, stroke, gradient, trim (dash). */
import { Path2D, type SKRSContext2D, type CanvasGradient } from '@napi-rs/canvas';
import type { ShapeSpec } from '../../core/schema/index.js';
import { flattenPath, pathBounds, pathLength, pointsBounds } from '../path.js';

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

/**
 * The trimmed windows of an outline as fractions of its length (the same window and wrap as trimDash): null = the
 * whole outline, 'none' = nothing.
 */
export function trimWindows(start: number, end: number, offset: number): [number, number][] | null | 'none' {
  let a = Math.min(start, end), b = Math.max(start, end);
  if (b - a >= 1 - 1e-9) return null;
  if (b - a <= 1e-9) return 'none';
  const o = offset - Math.floor(offset);
  a += o; b += o;
  if (a >= 1) { a -= 1; b -= 1; }
  return b <= 1 + 1e-9 ? [[a, Math.min(1, b)]] : [[0, b - 1], [a, 1]];
}

/** The points of a polyline (closing segment included when closed) between arc lengths la and lb. */
function slicePolyline(pts: Pt[], closed: boolean, la: number, lb: number): Pt[] {
  const all = closed && pts.length > 1 ? [...pts, pts[0]!] : pts;
  const out: Pt[] = [];
  let at = 0;
  const lerp = (p: Pt, q: Pt, t: number): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  for (let i = 1; i < all.length; i++) {
    const p = all[i - 1]!, q = all[i]!, seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const s0 = at, s1 = at + seg;
    at = s1;
    if (s1 < la || s0 > lb || seg === 0) continue;
    if (!out.length) out.push(lerp(p, q, Math.max(0, (la - s0) / seg)));
    out.push(lerp(p, q, Math.min(1, (lb - s0) / seg)));
    if (s1 >= lb) break;
  }
  return out;
}

/**
 * The trimmed outline of SVG path data with several subpaths, as one Path2D: the trim window runs along all
 * contours in order (Skia restarts a dash pattern at every contour, so a dash cannot trim across them).
 * null when the path has a single contour (the dash is exact there).
 */
export function trimmedMultiPath(d: string, windows: [number, number][]): Path2D | null {
  const subs = flattenPath(d).filter((x) => x.points.length > 1);
  if (subs.length < 2) return null;
  const lens = subs.map((x) => { let l = 0; const all = x.closed ? [...x.points, x.points[0]!] : x.points; for (let i = 1; i < all.length; i++) l += Math.hypot(all[i]![0] - all[i - 1]![0], all[i]![1] - all[i - 1]![1]); return l; });
  const L = lens.reduce((a, b) => a + b, 0);
  const out = new Path2D();
  let c = 0;
  subs.forEach((sub, k) => {
    const l = lens[k]!;
    for (const [wa, wb] of windows) {
      const la = Math.max(wa * L, c) - c, lb = Math.min(wb * L, c + l) - c;
      if (!(lb > la + 1e-9)) continue;
      if (sub.closed && la <= 1e-9 && lb >= l - 1e-9) {
        sub.points.forEach((pt, i) => (i ? out.lineTo(pt[0], pt[1]) : out.moveTo(pt[0], pt[1])));
        out.closePath();
        continue;
      }
      slicePolyline(sub.points, sub.closed, la, lb).forEach((pt, i) => (i ? out.lineTo(pt[0], pt[1]) : out.moveTo(pt[0], pt[1])));
    }
    c += l;
  });
  return out;
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
    const wins = dash && s.type === 'path' ? trimWindows(trimStart, t, trimOffset) : null;
    const multi = Array.isArray(wins) ? trimmedMultiPath(s.d ?? '', wins) : null;
    if (multi) ctx.stroke(multi);
    else {
      if (dash) { ctx.setLineDash(dash.dash); ctx.lineDashOffset = dash.offset; }
      ctx.stroke(path);
    }
  }
  ctx.restore();
}
