/**
 * Shape kinds (BOARD.md §3.1): default size, bounds, hit test and draw for every shape type, as one table. The same draw
 * code runs on the page (browser canvas) and in the snapshot (Skia): it only uses the Ctx2D subset, draws in board
 * coordinates (the caller sets the camera transform) and keeps hairlines 1 screen px through env.zoom.
 */
import type { Ctx2D, DrawEnv } from './canvas.js';
import type { ArrowShape, DrawShape, Outline, PaletteName, Point, Shape, ShapeType, StillShape, TextShape, TimelineShape } from './types.js';
import { center, distToSegment, edgePoint, ellipseEdgePoint, pointInRect, rotatePoint, rotatedBounds, type Box } from './geometry.js';
import { chrome, font, MONO, palette, whoColor, type Theme } from './palette.js';
import { ellipsize, wrapText } from './text.js';
import { formatTime, tryTime } from './time.js';
import { compOf } from './outline.js';

export { palette } from './palette.js';
export type Lookup = (id: string) => Shape | undefined;

export const STILL_W: Record<string, number> = { thumb: 270, half: 540, full: 1080 };
export const TITLE_H = 24;
const PIN_R = 11, PIN_TIP = 30;

export const SHAPE_DEFS: Record<ShapeType, { defaults: Partial<Shape>; size: [number, number] }> = {
  frame: { defaults: {}, size: [800, 500] },
  note: { defaults: { color: 'yellow' }, size: [200, 200] },
  text: { defaults: { size: 24 } as Partial<Shape>, size: [200, 40] },
  rect: { defaults: { fill: 'none' } as Partial<Shape>, size: [200, 120] },
  ellipse: { defaults: { fill: 'none' } as Partial<Shape>, size: [200, 120] },
  arrow: { defaults: {}, size: [0, 0] },
  draw: { defaults: {}, size: [0, 0] },
  image: { defaults: {}, size: [320, 240] },
  still: { defaults: { fidelity: 'thumb' } as Partial<Shape>, size: [270, 480] },
  timeline: { defaults: {}, size: [1200, 160] },
  pin: { defaults: { u: 0.5, v: 0.5, status: 'open' } as Partial<Shape>, size: [0, 0] },
};

/** the linked comp (the shape's or the main one) */
export const compFor = compOf;
/** h / w of the linked comp; 16/9 (portrait) without a project, as the model assumes */
export const stillAspect = (o: Outline | null | undefined, comp?: string): number => { const c = compFor(o, comp); return c && c.size[0] ? c.size[1] / c.size[0] : 16 / 9; };

const lineCount = (t: string | undefined) => (t ?? '').split('\n');
/** text shape box without a context: ~0.56 em per character */
function textBox(s: TextShape): Box {
  const size = s.size ?? 24, lines = lineCount(s.text ?? s.label ?? '');
  const est = (l: string) => Math.max(1, l.length) * size * 0.56;
  const w = s.w ?? Math.max(40, ...lines.map(est)) + 4;
  const n = s.w ? lines.reduce((k, l) => k + Math.max(1, Math.ceil(est(l) / s.w!)), 0) : lines.length;
  return { x: s.x, y: s.y, w, h: s.h ?? Math.max(size * 1.3, n * size * 1.3) };
}

/** where an arrow end is: a bound shape's edge (towards the other end) or a point */
export function arrowEnds(s: ArrowShape, box: (id: string) => Box | undefined, kind?: (id: string) => ShapeType | undefined): [Point, Point] {
  const raw = (v: ArrowShape['from']): Point | Box | undefined => (typeof v === 'string' ? box(v) : Array.isArray(v) ? v : undefined);
  const a0 = raw(s.from) ?? [s.x, s.y], b0 = raw(s.to) ?? [s.x + 100, s.y];
  const pt = (v: Point | Box): Point => (Array.isArray(v) ? v : center(v));
  const edge = (v: Point | Box, other: Point, id: unknown): Point => (Array.isArray(v) ? v : kind?.(id as string) === 'ellipse' ? ellipseEdgePoint(v, other, 6) : edgePoint(v, other, 6));
  const ca = pt(a0), cb = pt(b0);
  return [edge(a0, cb, s.from), edge(b0, ca, s.to)];
}

/** the board point a pin marks (its tip), or undefined when the target is gone */
export function pinPoint(s: Extract<Shape, { type: 'pin' }>, box: (id: string) => Box | undefined): Point | undefined {
  const b = box(s.target);
  return b ? [b.x + b.w * clamp01(s.u ?? 0.5), b.y + b.h * clamp01(s.v ?? 0.5)] : undefined;
}
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Axis-aligned bounds in board px (rotation included). `outline` gives stills their comp's aspect. */
export function shapeBounds(s: Shape, lookup: Lookup, outline?: Outline | null, depth = 0): Box {
  const sub = (id: string): Box | undefined => { const t = depth < 4 ? lookup(id) : undefined; return t ? shapeBounds(t, lookup, outline, depth + 1) : undefined; };
  let b: Box;
  switch (s.type) {
    case 'text': b = textBox(s); break;
    case 'still': { const w = s.w ?? STILL_W[s.fidelity ?? 'thumb'] ?? 270; b = { x: s.x, y: s.y, w, h: s.h ?? Math.round(w * stillAspect(outline, s.comp)) }; break; }
    case 'arrow': {
      const [a, c] = arrowEnds(s, sub, (id) => lookup(id)?.type);
      return { x: Math.min(a[0], c[0]), y: Math.min(a[1], c[1]), w: Math.abs(a[0] - c[0]), h: Math.abs(a[1] - c[1]) };
    }
    case 'draw': {
      if (!s.points.length) return { x: s.x, y: s.y, w: 0, h: 0 };
      const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]);
      b = { x: s.x + Math.min(...xs), y: s.y + Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      break;
    }
    case 'pin': {
      const p = pinPoint(s, sub) ?? [s.x, s.y];
      return { x: p[0] - PIN_R - 1, y: p[1] - PIN_TIP, w: 2 * PIN_R + 2, h: PIN_TIP };
    }
    default: { const [dw, dh] = SHAPE_DEFS[s.type].size; b = { x: s.x, y: s.y, w: s.w ?? dw, h: s.h ?? dh }; }
  }
  return s.rot ? rotatedBounds(b, s.rot) : b;
}

/** Does board point p touch the shape (tolerance in board px)? Frames hit on their title tab and border only. */
export function hitTest(s: Shape, p: Point, lookup: Lookup, tol = 0, outline?: Outline | null): boolean {
  const box = (id: string) => { const t = lookup(id); return t ? shapeBounds(t, lookup, outline) : undefined; };
  if (s.type === 'arrow') { const [a, b] = arrowEnds(s, box, (id) => lookup(id)?.type); return distToSegment(p, a, b) <= tol + 6; }
  if (s.type === 'pin') {
    const tip = pinPoint(s, box) ?? [s.x, s.y];
    return Math.hypot(p[0] - tip[0], p[1] - (tip[1] - PIN_TIP + PIN_R + 1)) <= PIN_R + 2 + tol || pointInRect(p, shapeBounds(s, lookup, outline), tol);
  }
  if (s.type === 'draw') {
    const pts = s.points.map((q): Point => [s.x + q[0], s.y + q[1]]);
    if (pts.length === 1) return Math.hypot(p[0] - pts[0]![0], p[1] - pts[0]![1]) <= tol + 6;
    for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1]!, pts[i]!) <= tol + 6) return true;
    return false;
  }
  // unrotated box, point rotated into it
  const raw = { ...s, rot: 0 } as Shape;
  const b = shapeBounds(raw, lookup, outline);
  const q = s.rot ? rotatePoint(p, center(b), -s.rot) : p;
  if (s.type === 'frame') {
    const tab = { x: b.x, y: b.y - TITLE_H - 4, w: Math.min(b.w, 60 + (s.label ?? '').length * 8), h: TITLE_H + 4 };
    if (pointInRect(q, tab, tol)) return true;
    const band = tol + 6;
    return pointInRect(q, b, band) && !pointInRect(q, { x: b.x + band, y: b.y + band, w: b.w - 2 * band, h: b.h - 2 * band });
  }
  if (s.type === 'ellipse') {
    const rx = b.w / 2 + tol, ry = b.h / 2 + tol, [cx, cy] = center(b);
    return rx > 0 && ry > 0 && ((q[0] - cx) / rx) ** 2 + ((q[1] - cy) / ry) ** 2 <= 1;
  }
  return pointInRect(q, b, tol);
}

/** what draw functions see: DrawEnv plus what drawBoard works out (pin numbers) */
interface Env extends DrawEnv { pinNo?: number; kindOf?: (id: string) => ShapeType | undefined }

/** Draw one shape. */
export function drawShape(ctx: Ctx2D, s: Shape, env: DrawEnv): void {
  const e = env as Env;
  const hair = 1 / (env.zoom || 1);
  const b = localBox(s, env);
  ctx.save();
  if (s.rot && b) { const [cx, cy] = center(b); ctx.translate(cx, cy); ctx.rotate((s.rot * Math.PI) / 180); ctx.translate(-cx, -cy); }
  DRAW[s.type](ctx, s as never, e, b ?? { x: s.x, y: s.y, w: 0, h: 0 }, hair);
  if (b && s.type !== 'pin' && s.type !== 'arrow' && s.type !== 'draw') {
    if (env.flash) outline(ctx, b, whoColor(env.flash, env.theme), 2 * hair, 4 * hair);
    if (env.selected) outline(ctx, b, chrome(env.theme).selection, 1.5 * hair, 0);
  }
  ctx.restore();
}

/** Draw shapes in z-order: frames first (they hold the others), pins last. `per` adds per-shape env (selection, flash). */
export function drawBoard(ctx: Ctx2D, shapes: Shape[], env: DrawEnv, per?: (s: Shape) => Partial<DrawEnv> | undefined): void {
  let n = 0;
  const pinNo = new Map<string, number>(), kinds = new Map<string, ShapeType>();
  for (const s of shapes) { kinds.set(s.id, s.type); if (s.type === 'pin') pinNo.set(s.id, ++n); }
  const kindOf = (id: string) => kinds.get(id);
  const one = (s: Shape) => { const extra = per?.(s); drawShape(ctx, s, { kindOf, ...env, ...extra, ...(s.type === 'pin' ? { pinNo: pinNo.get(s.id) } : {}) } as Env); };
  for (const s of shapes) if (s.type === 'frame') one(s);
  for (const s of shapes) if (s.type !== 'frame' && s.type !== 'pin') one(s);
  for (const s of shapes) if (s.type === 'pin') one(s);
}

/** the shape's unrotated box using the env's lookups */
function localBox(s: Shape, env: DrawEnv): Box | undefined {
  if (s.type === 'arrow' || s.type === 'pin') return boundsVia(s, env as Env);
  return shapeBounds({ ...s, rot: 0 } as Shape, () => undefined, env.outline);
}
function boundsVia(s: Shape, env: Env): Box {
  if (s.type === 'arrow') { const [a, c] = arrowEnds(s, env.bounds, env.kindOf); return { x: Math.min(a[0], c[0]), y: Math.min(a[1], c[1]), w: Math.abs(a[0] - c[0]), h: Math.abs(a[1] - c[1]) }; }
  if (s.type === 'pin') { const p = pinPoint(s, env.bounds) ?? [s.x, s.y]; return { x: p[0] - PIN_R - 1, y: p[1] - PIN_TIP, w: 2 * PIN_R + 2, h: PIN_TIP }; }
  return { x: s.x, y: s.y, w: s.w ?? 0, h: s.h ?? 0 };
}

function outline(ctx: Ctx2D, b: Box, color: string, lw: number, pad: number): void {
  ctx.beginPath();
  ctx.roundRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad, 6 + pad);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.stroke();
}

/** a wide translucent stroke under a line shape: flash (who changed it) or selection */
function glow(ctx: Ctx2D, env: DrawEnv, hair: number, path: () => void): void {
  if (!env.flash && !env.selected) return;
  ctx.save();
  ctx.strokeStyle = env.flash ? whoColor(env.flash, env.theme) : chrome(env.theme).selection;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = Math.max(8, 8 * hair);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  path();
  ctx.stroke();
  ctx.restore();
}

/** soft drop shadow without shadowBlur (not in the Ctx2D subset): stacked translucent rounded rects */
function softShadow(ctx: Ctx2D, b: Box, r: number, color: string, depth = 1): void {
  ctx.save();
  ctx.fillStyle = color;
  const layers: [number, number, number][] = [[1, 0.06, 0], [3, 0.05, 1], [6, 0.035, 3], [10, 0.02, 6]];
  for (const [dy, a, grow] of layers) {
    ctx.globalAlpha = a * depth;
    ctx.beginPath();
    ctx.roundRect(b.x - grow, b.y + dy * depth - grow / 2, b.w + 2 * grow, b.h + grow, r + grow);
    ctx.fill();
  }
  ctx.restore();
}

function textLines(ctx: Ctx2D, lines: string[], x: number, y: number, lh: number, align: 'left' | 'center' = 'left'): void {
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, x, y + lh * i + lh / 2));
}

/** wrap text into box at the largest size in [min, max] that fits */
function fitText(ctx: Ctx2D, text: string, w: number, h: number, max: number, min: number, weight = 400): { lines: string[]; size: number } {
  for (let size = max; ; size -= 2) {
    ctx.font = font(size, weight);
    const lines = wrapText(ctx, text, w);
    if (lines.length * size * 1.3 <= h || size <= min) {
      const fit = Math.max(1, Math.floor(h / (size * 1.3)));
      if (lines.length > fit) { const cut = lines.slice(0, fit); cut[fit - 1] = ellipsize(ctx, cut[fit - 1] + ' …', w); return { lines: cut, size }; }
      return { lines, size };
    }
  }
}

type Draw<S extends Shape = Shape> = (ctx: Ctx2D, s: S, env: Env, b: Box, hair: number) => void;
const ink = (s: Shape, theme: Theme, fallback: PaletteName) => palette(s.color ?? fallback, theme);

const drawFrame: Draw = (ctx, s, env, b, hair) => {
  const c = chrome(env.theme);
  softShadow(ctx, b, 10, c.shadow, 0.5);
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, 10);
  ctx.fillStyle = s.color ? palette(s.color, env.theme).tint : c.frameFill;
  ctx.fill();
  ctx.strokeStyle = s.color ? palette(s.color, env.theme).stroke : c.frameStroke;
  ctx.lineWidth = hair;
  ctx.stroke();
  // title tab, legible when zoomed out
  const fs = Math.max(13, 11 * hair);
  ctx.font = font(fs, 600);
  const title = ellipsize(ctx, s.label ?? s.id, Math.max(40, b.w - 24));
  const tw = ctx.measureText(title).width + fs * 1.4, th = fs * 1.75;
  ctx.beginPath();
  ctx.roundRect(b.x, b.y - th - 4 * hair, tw, th, th / 2);
  ctx.fillStyle = c.panel;
  ctx.fill();
  ctx.strokeStyle = c.frameStroke;
  ctx.lineWidth = hair;
  ctx.stroke();
  ctx.fillStyle = c.frameTitle;
  textLines(ctx, [title], b.x + fs * 0.7, b.y - th - 4 * hair, th);
};

const drawNote: Draw = (ctx, s, env, b) => {
  const p = ink(s, env.theme, 'yellow'), c = chrome(env.theme);
  softShadow(ctx, b, 6, c.shadow, 1);
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, 6);
  ctx.fillStyle = p.fill;
  ctx.fill();
  const pad = 16;
  const head = s.label ? 20 : 0;
  if (s.label) { ctx.font = font(12, 600); ctx.fillStyle = p.text; ctx.globalAlpha = 0.7; textLines(ctx, [ellipsize(ctx, s.label.toUpperCase(), b.w - 2 * pad)], b.x + pad, b.y + 10, 16); ctx.globalAlpha = 1; }
  const text = ('text' in s ? s.text : undefined) ?? '';
  if (text) {
    const { lines, size } = fitText(ctx, text, b.w - 2 * pad, b.h - 2 * pad - head, 22, 11);
    ctx.fillStyle = p.text;
    textLines(ctx, lines, b.x + pad, b.y + pad + head, size * 1.3);
  }
  whoDot(ctx, s, env, b.x + b.w - 10, b.y + b.h - 10);
};

/** tiny marker of who made a shape: violet for the AI, nothing for the person (the default) */
function whoDot(ctx: Ctx2D, s: Shape, env: Env, x: number, y: number): void {
  if (s.by !== 'ai') return;
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = chrome(env.theme).ai;
  ctx.fill();
}

const drawText: Draw<TextShape> = (ctx, s, env, b) => {
  const size = s.size ?? 24;
  ctx.font = font(size, 500);
  ctx.fillStyle = s.color ? palette(s.color, env.theme).stroke : chrome(env.theme).ink;
  const text = s.text ?? s.label ?? '';
  const lines = s.w ? wrapText(ctx, text, s.w) : text.split('\n');
  textLines(ctx, lines, b.x, b.y, size * 1.3);
  if (!text) { ctx.globalAlpha = 0.4; textLines(ctx, ['Text'], b.x, b.y, size * 1.3); ctx.globalAlpha = 1; }
};

const drawGeo: Draw = (ctx, s, env, b) => {
  if (s.type !== 'rect' && s.type !== 'ellipse') return;
  const p = ink(s, env.theme, 'black');
  ctx.beginPath();
  if (s.type === 'rect') ctx.roundRect(b.x, b.y, b.w, b.h, Math.min(8, b.w / 4, b.h / 4));
  else ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(0, b.w / 2), Math.max(0, b.h / 2), 0, 0, Math.PI * 2);
  if (s.fill === 'solid' || s.fill === 'tint') { ctx.fillStyle = s.fill === 'solid' ? p.fill : p.tint; ctx.fill(); }
  ctx.strokeStyle = p.stroke;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
  const text = s.text ?? s.label;
  if (text) {
    const inset = s.type === 'ellipse' ? 0.16 : 0.06;
    const { lines, size } = fitText(ctx, text, b.w * (1 - 2 * inset) - 8, b.h * (1 - 2 * inset) - 8, 18, 10, 500);
    ctx.fillStyle = s.fill === 'solid' ? p.text : chrome(env.theme).ink;
    const lh = size * 1.3;
    textLines(ctx, lines, b.x + b.w / 2, b.y + b.h / 2 - (lines.length * lh) / 2, lh, 'center');
  }
};

const drawArrow: Draw<ArrowShape> = (ctx, s, env, _b, hair) => {
  const [a, c] = arrowEnds(s, env.bounds, env.kindOf);
  const col = s.color ? palette(s.color, env.theme).stroke : chrome(env.theme).ink;
  const ang = Math.atan2(c[1] - a[1], c[0] - a[0]), head = 12;
  const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
  glow(ctx, env, hair, () => { ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); });
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(c[0] - Math.cos(ang) * Math.min(head * 0.8, len), c[1] - Math.sin(ang) * Math.min(head * 0.8, len));
  ctx.stroke();
  if (len > 2) {
    ctx.beginPath();
    ctx.moveTo(c[0], c[1]);
    ctx.lineTo(c[0] - head * Math.cos(ang - 0.42), c[1] - head * Math.sin(ang - 0.42));
    ctx.lineTo(c[0] - head * Math.cos(ang + 0.42), c[1] - head * Math.sin(ang + 0.42));
    ctx.closePath();
    ctx.fill();
  }
  const text = s.text ?? s.label;
  if (text) {
    ctx.font = font(14, 500);
    const t = ellipsize(ctx, text, 260), w = ctx.measureText(t).width + 14, mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
    ctx.beginPath();
    ctx.roundRect(mx - w / 2, my - 12, w, 24, 12);
    ctx.fillStyle = chrome(env.theme).bg;
    ctx.fill();
    ctx.strokeStyle = chrome(env.theme).hairline;
    ctx.lineWidth = hair;
    ctx.stroke();
    ctx.fillStyle = chrome(env.theme).ink;
    textLines(ctx, [t], mx, my - 12, 24, 'center');
  }
};

/** freehand: quadratic curves through the midpoints of the samples */
const drawDraw: Draw<DrawShape> = (ctx, s, env) => {
  const pts = s.points.map((q): Point => [s.x + q[0], s.y + q[1]]);
  ctx.strokeStyle = s.color ? palette(s.color, env.theme).stroke : chrome(env.theme).ink;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (pts.length === 0) return;
  glow(ctx, env, 1 / (env.zoom || 1), () => { ctx.moveTo(pts[0]![0], pts[0]![1]); for (const q of pts) ctx.lineTo(q[0], q[1]); });
  ctx.strokeStyle = s.color ? palette(s.color, env.theme).stroke : chrome(env.theme).ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  if (pts.length < 3) {
    if (pts.length === 1) { ctx.arc(pts[0]![0], pts[0]![1], 1.5, 0, Math.PI * 2); ctx.fill(); return; }
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    ctx.lineTo(pts[1]![0], pts[1]![1]);
  } else {
    ctx.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i]!, q = pts[i + 1]!;
      ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    }
    const last = pts[pts.length - 1]!;
    ctx.lineTo(last[0], last[1]);
  }
  ctx.stroke();
};

/** draw an image to fit inside b (letterboxed), clipped to rounded corners */
function fitImage(ctx: Ctx2D, img: unknown, b: Box, r: number): void {
  const iw = (img as { width?: number }).width || b.w, ih = (img as { height?: number }).height || b.h;
  const k = Math.min(b.w / iw, b.h / ih), w = iw * k, h = ih * k;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, r);
  ctx.clip();
  ctx.drawImage(img, b.x + (b.w - w) / 2, b.y + (b.h - h) / 2, w, h);
  ctx.restore();
}

const drawImage: Draw = (ctx, s, env, b, hair) => {
  const c = chrome(env.theme), img = env.image(s.id);
  // the label goes under the picture, like a still's caption ("A golden hour", "sheet-1 · L2 sheet · QA 0 findings")
  const caption = () => { if (!s.label) return; ctx.font = font(12, 500); ctx.fillStyle = c.muted; textLines(ctx, [ellipsize(ctx, s.label, Math.max(40, b.w))], b.x, b.y + b.h + 4, 18); };
  if (img) { softShadow(ctx, b, 4, c.shadow, 0.6); fitImage(ctx, img, b, 4); caption(); return; }
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, 4);
  ctx.fillStyle = c.panel;
  ctx.fill();
  ctx.setLineDash([6 * hair, 4 * hair]);
  ctx.strokeStyle = c.hairline;
  ctx.lineWidth = hair;
  ctx.stroke();
  ctx.setLineDash([]);
  // mountains-and-sun glyph
  const [cx, cy] = center(b), u = Math.min(b.w, b.h) / 8;
  ctx.strokeStyle = c.muted;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 2 * u, cy + u); ctx.lineTo(cx - 0.6 * u, cy - 0.4 * u); ctx.lineTo(cx + 0.4 * u, cy + 0.4 * u); ctx.lineTo(cx + 1 * u, cy - 0.1 * u); ctx.lineTo(cx + 2 * u, cy + u);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(cx + 1.1 * u, cy - 0.9 * u, 0.35 * u, 0, Math.PI * 2); ctx.stroke();
  ctx.font = font(12);
  ctx.fillStyle = c.muted;
  textLines(ctx, [ellipsize(ctx, ('src' in s ? s.src : '') || 'image', b.w - 16)], cx, cy + 1.5 * u, 18, 'center');
  caption();
};

/** a still's timecode at the linked comp's rate ("t" as written without a project) */
export function stillTimecode(s: StillShape, o: Outline | null | undefined): string {
  const c = compFor(o, s.comp);
  const f = c ? tryTime(s.t, c.fps) : undefined;
  return f === undefined ? String(s.t) : formatTime(f, c!.fps);
}

const drawStill: Draw<StillShape> = (ctx, s, env, b, hair) => {
  const c = chrome(env.theme), img = env.image(s.id);
  softShadow(ctx, b, 4, c.shadow, 0.8);
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, 4);
  ctx.fillStyle = c.film;
  ctx.fill();
  const tc = stillTimecode(s, env.outline);
  if (img) fitImage(ctx, img, b, 4);
  else {
    // film-frame placeholder: sprocket strips + the timecode
    const holeW = Math.max(6, b.w / 18), holeH = holeW * 0.7, strip = holeH * 2.2;
    ctx.fillStyle = c.filmHole;
    for (let x = b.x + holeW * 0.6; x + holeW < b.x + b.w; x += holeW * 1.9) {
      ctx.beginPath(); ctx.roundRect(x, b.y + (strip - holeH) / 2, holeW, holeH, 1.5); ctx.fill();
      ctx.beginPath(); ctx.roundRect(x, b.y + b.h - strip + (strip - holeH) / 2, holeW, holeH, 1.5); ctx.fill();
    }
    ctx.strokeStyle = c.filmHole;
    ctx.lineWidth = hair;
    ctx.strokeRect(b.x + 4, b.y + strip, b.w - 8, b.h - 2 * strip);
    ctx.font = font(Math.max(12, Math.min(28, b.w / 9)), 500, MONO);
    ctx.fillStyle = '#e6e6ea';
    textLines(ctx, [tc], b.x + b.w / 2, b.y + b.h / 2 - 14, 28, 'center');
  }
  // fidelity badge
  const fid = s.fidelity ?? 'thumb';
  ctx.font = font(10, 600);
  const bw = ctx.measureText(fid).width + 10, by = img ? b.y + 6 : b.y + Math.max(6, b.w / 18) * 1.6 + 4;
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = '#000000';
  ctx.beginPath(); ctx.roundRect(b.x + 6, by, bw, 16, 8); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  textLines(ctx, [fid], b.x + 6 + bw / 2, by, 16, 'center');
  // caption: timecode + visible clips (from the host), under the frame
  const cap = env.stillCaption?.(s.id) ?? tc;
  ctx.font = font(12, 400, MONO);
  ctx.fillStyle = c.muted;
  textLines(ctx, [ellipsize(ctx, (s.label ? s.label + '  ' : '') + cap, b.w)], b.x, b.y + b.h + 4, 18);
  whoDot(ctx, s, env, b.x + b.w - 12, by + 8);
};

const KIND_COLORS: Record<string, PaletteName> = { video: 'blue', image: 'blue', comp: 'grey', text: 'violet', captions: 'violet', audio: 'green' };
const kindColor = (k: string): PaletteName => KIND_COLORS[k] ?? 'yellow';

const drawTimeline: Draw<TimelineShape> = (ctx, s, env, b, hair) => {
  const c = chrome(env.theme), o = env.outline ?? null;
  softShadow(ctx, b, 8, c.shadow, 0.6);
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, 8);
  ctx.fillStyle = c.panel;
  ctx.fill();
  ctx.strokeStyle = c.hairline;
  ctx.lineWidth = hair;
  ctx.stroke();
  const comp = compFor(o, s.comp);
  ctx.font = font(12, 600);
  ctx.fillStyle = c.muted;
  if (!o || !comp) { textLines(ctx, [s.label ?? 'timeline · no linked project'], b.x + b.w / 2, b.y + b.h / 2 - 9, 18, 'center'); return; }
  const f0 = tryTime(s.from, comp.fps) ?? 0, f1 = Math.max(f0 + 1, tryTime(s.to, comp.fps) ?? (comp.length || comp.fps * 10));
  const pad = 10, head = 22, left = b.x + pad, right = b.x + b.w - pad, top = b.y + head + 16;
  const fx = (f: number) => left + ((f - f0) / (f1 - f0)) * (right - left);
  textLines(ctx, [`${s.label ?? comp.id}  ${formatTime(f0, comp.fps)}–${formatTime(f1, comp.fps)}`], left, b.y + 2, head);
  // second ticks
  const secs = (f1 - f0) / comp.fps, step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((x) => secs / x <= 16) ?? 600;
  ctx.font = font(10, 400, MONO);
  ctx.strokeStyle = c.hairline;
  for (let t = Math.ceil(f0 / comp.fps / step) * step; t * comp.fps <= f1; t += step) {
    const x = fx(t * comp.fps);
    ctx.beginPath(); ctx.moveTo(x, top - 4); ctx.lineTo(x, b.y + b.h - pad); ctx.stroke();
    ctx.fillStyle = c.muted;
    textLines(ctx, [`${t}s`], x + 3, top - 14, 12);
  }
  const tracks = o.tracks.filter((t) => t.comp === comp.id);
  if (!tracks.length) return;
  const rowH = Math.max(8, Math.min(28, (b.y + b.h - pad - top) / tracks.length));
  tracks.forEach((t, i) => {
    const y = top + i * rowH;
    for (const cl of o.clips) {
      if (cl.track !== t.id || cl.at + cl.len <= f0 || cl.at >= f1) continue;
      const x0 = Math.max(left, fx(cl.at)), x1 = Math.min(right, fx(cl.at + cl.len));
      const p = palette(t.audio ? 'green' : kindColor(cl.kind), env.theme);
      ctx.beginPath();
      ctx.roundRect(x0, y + 1, Math.max(1, x1 - x0 - 1), rowH - 3, Math.min(4, rowH / 3));
      ctx.fillStyle = p.fill;
      ctx.fill();
      ctx.strokeStyle = p.stroke;
      ctx.lineWidth = hair;
      ctx.stroke();
      if (rowH >= 14 && x1 - x0 > 24) {
        ctx.font = font(Math.min(11, rowH - 6), 500);
        ctx.fillStyle = p.text;
        textLines(ctx, [ellipsize(ctx, cl.label || cl.id, x1 - x0 - 8)], x0 + 4, y + 1, rowH - 3);
      }
    }
  });
};

const drawPin: Draw = (ctx, s, env, _b, hair) => {
  if (s.type !== 'pin') return;
  const c = chrome(env.theme), tip = pinPoint(s, env.bounds) ?? [s.x, s.y];
  const col = s.status === 'resolved' ? c.pinDone : c.pinOpen;
  const cx = tip[0], cy = tip[1] - PIN_TIP + PIN_R + 1;
  // teardrop: circle with tangents meeting at the tip
  const d = tip[1] - cy, a = Math.asin(Math.min(1, PIN_R / d));
  ctx.beginPath();
  ctx.moveTo(tip[0], tip[1]);
  ctx.arc(cx, cy, PIN_R, Math.PI / 2 + a, Math.PI / 2 - a + Math.PI * 2, false);
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = font(11, 700);
  textLines(ctx, [s.status === 'resolved' ? '✓' : String(env.pinNo ?? '•')], cx, cy - 9, 18, 'center');
  if (env.selected || env.flash) {
    ctx.beginPath(); ctx.arc(cx, cy, PIN_R + 3, 0, Math.PI * 2);
    ctx.strokeStyle = env.flash ? whoColor(env.flash, env.theme) : c.selection; ctx.lineWidth = 2 * hair; ctx.stroke();
  }
  if (env.selected && (s.text || s.reply)) {
    // bubble with the comment (and the reply)
    const w = 240, padB = 10;
    ctx.font = font(13);
    const lines = wrapText(ctx, s.text ?? '', w - 2 * padB);
    ctx.font = font(12);
    const rl = s.reply ? wrapText(ctx, '↳ ' + s.reply, w - 2 * padB) : [];
    const h = lines.length * 18 + rl.length * 17 + 2 * padB;
    const bx = cx + PIN_R + 8, by = cy - 14;
    softShadow(ctx, { x: bx, y: by, w, h }, 8, c.shadow, 1);
    ctx.beginPath(); ctx.roundRect(bx, by, w, h, 8);
    ctx.fillStyle = c.panel; ctx.fill();
    ctx.strokeStyle = c.hairline; ctx.lineWidth = hair; ctx.stroke();
    ctx.fillStyle = c.ink; ctx.font = font(13);
    textLines(ctx, lines, bx + padB, by + padB, 18);
    ctx.fillStyle = c.muted; ctx.font = font(12);
    textLines(ctx, rl, bx + padB, by + padB + lines.length * 18, 17);
  }
};

const DRAW: Record<ShapeType, Draw<never>> = {
  frame: drawFrame, note: drawNote, text: drawText as Draw<never>, rect: drawGeo, ellipse: drawGeo, arrow: drawArrow as Draw<never>,
  draw: drawDraw as Draw<never>, image: drawImage, still: drawStill as Draw<never>, timeline: drawTimeline as Draw<never>, pin: drawPin,
};

/** the dot grid behind the board, for the visible board rect; spacing adapts to zoom so dots stay 12-48 screen px apart */
export function drawGrid(ctx: Ctx2D, view: Box, zoom: number, theme: Theme): void {
  let step = 24;
  while (step * zoom < 12) step *= 2;
  while (step * zoom > 48) step /= 2;
  const r = 1 / zoom;
  ctx.fillStyle = chrome(theme).grid;
  for (let x = Math.floor(view.x / step) * step; x <= view.x + view.w; x += step) {
    for (let y = Math.floor(view.y / step) * step; y <= view.y + view.h; y += step) ctx.fillRect(x - r * 0.75, y - r * 0.75, r * 1.5, r * 1.5);
  }
}
