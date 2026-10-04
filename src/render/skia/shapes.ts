/** Shape layers: rect, ellipse, line, polygon, star, SVG path; fill, stroke, gradient, trim (dash). */
import { Path2D, type SKRSContext2D, type CanvasGradient } from '@napi-rs/canvas';
import type { ShapeSpec } from '../../core/schema/index.js';

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

/** Approximate length of SVG path data (curves flattened, arcs as chords). */
export function pathLength(d: string): number {
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, L = 0, lcx = 0, lcy = 0;
  const num = () => Number(toks[i++]);
  const seg = (nx: number, ny: number) => { L += Math.hypot(nx - x, ny - y); x = nx; y = ny; };
  const curve = (pts: Pt[]) => {
    const p0: Pt = [x, y];
    const all = [p0, ...pts];
    let px = x, py = y;
    for (let s = 1; s <= 16; s++) {
      const t = s / 16;
      let q = all.map((p) => [...p] as Pt);
      while (q.length > 1) q = q.slice(1).map((p, k) => [q[k]![0] + (p[0] - q[k]![0]) * t, q[k]![1] + (p[1] - q[k]![1]) * t] as Pt);
      L += Math.hypot(q[0]![0] - px, q[0]![1] - py);
      [px, py] = q[0]!;
    }
    x = px; y = py;
  };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i]!)) cmd = toks[i++]!;
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M': x = sx = num() + ox; y = sy = num() + oy; cmd = rel ? 'l' : 'L'; break;
      case 'L': seg(num() + ox, num() + oy); break;
      case 'H': seg(num() + ox, y); break;
      case 'V': seg(x, num() + oy); break;
      case 'C': { const c1: Pt = [num() + ox, num() + oy], c2: Pt = [num() + ox, num() + oy], e: Pt = [num() + ox, num() + oy]; [lcx, lcy] = c2; curve([c1, c2, e]); break; }
      case 'S': { const c1: Pt = [2 * x - lcx, 2 * y - lcy], c2: Pt = [num() + ox, num() + oy], e: Pt = [num() + ox, num() + oy]; [lcx, lcy] = c2; curve([c1, c2, e]); break; }
      case 'Q': { const c: Pt = [num() + ox, num() + oy], e: Pt = [num() + ox, num() + oy]; [lcx, lcy] = c; curve([c, e]); break; }
      case 'T': { const c: Pt = [2 * x - lcx, 2 * y - lcy], e: Pt = [num() + ox, num() + oy]; [lcx, lcy] = c; curve([c, e]); break; }
      case 'A': { i += 5; seg(num() + ox, num() + oy); break; }
      case 'Z': seg(sx, sy); break;
      default: i++;
    }
    if (!'CSQT'.includes(cmd.toUpperCase())) { lcx = x; lcy = y; }
  }
  return L;
}

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

/** Margin a shape draws outside its box (half the stroke). */
export function shapeOverhang(s: ShapeSpec): number {
  return s.stroke || s.type === 'line' ? Math.ceil((s.strokeWidth ?? 4) / 2) + 1 : 0;
}

/** Draw a shape in layer px (0,0)-(w,h) on a context already transformed to layer px. */
export function drawShape(ctx: SKRSContext2D, s: ShapeSpec, w: number, h: number, trim?: number): void {
  const { path, length } = shapePath(s, w, h);
  const t = trim ?? 1;
  ctx.save();
  if (s.type !== 'line' && s.fill !== 'none') {
    ctx.fillStyle = s.gradient ? gradientOf(ctx, s.gradient, w, h) : (s.fill ?? '#ffffff');
    ctx.fill(path);
  }
  const strokeColor = s.stroke ?? (s.type === 'line' ? (s.fill && s.fill !== 'none' ? s.fill : '#ffffff') : undefined);
  if (strokeColor && t > 0) {
    ctx.strokeStyle = s.type === 'line' && s.gradient ? gradientOf(ctx, s.gradient, w, h) : strokeColor;
    ctx.lineWidth = s.strokeWidth ?? 4;
    ctx.lineJoin = 'round';
    ctx.lineCap = t < 1 ? 'butt' : 'round';
    if (t < 1) ctx.setLineDash([length * t, length + 1]);
    ctx.stroke(path);
  }
  ctx.restore();
}
