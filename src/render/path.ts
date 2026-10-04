/**
 * SVG path data without a canvas (pure): flattening to polylines, for the outline length (shape trim) and the
 * bounding box (the layer box of a path shape without a `size`).
 */

type Pt = [number, number];

/** Flatten SVG path data into subpaths of points (curves sampled, arcs converted to their centre form). */
export function flattenPath(d: string, steps = 16): { points: Pt[]; closed: boolean }[] {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const subs: { points: Pt[]; closed: boolean }[] = [];
  let cur: { points: Pt[]; closed: boolean } | null = null;
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, lcx = 0, lcy = 0;
  const num = () => { const v = Number(toks[i++]); return Number.isFinite(v) ? v : 0; };
  const push = (p: Pt) => { if (!cur) { cur = { points: [[x, y]], closed: false }; subs.push(cur); } cur.points.push(p); x = p[0]; y = p[1]; };
  const curve = (ctrl: Pt[]) => {
    const all: Pt[] = [[x, y], ...ctrl];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      let q = all.map((p) => [...p] as Pt);
      while (q.length > 1) q = q.slice(1).map((p, k) => [q[k]![0] + (p[0] - q[k]![0]) * t, q[k]![1] + (p[1] - q[k]![1]) * t] as Pt);
      push(q[0]!);
    }
  };
  const arc = (rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, ex: number, ey: number) => {
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx === 0 || ry === 0 || (ex === x && ey === y)) { push([ex, ey]); return; }
    const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x - ex) / 2, dy = (y - ey) / 2;
    const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
    const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
    const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx;
    const cx = cos * cxp - sin * cyp + (x + ex) / 2, cy = sin * cxp + cos * cyp + (y + ey) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.max(2, Math.ceil((Math.abs(dt) / (Math.PI / 2)) * steps));
    for (let s = 1; s <= n; s++) {
      const a = t1 + (dt * s) / n;
      push(s === n ? [ex, ey] : [cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos]);
    }
  };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i]!)) cmd = toks[i++]!;
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    const C = cmd.toUpperCase();
    switch (C) {
      case 'M': {
        x = sx = num() + ox; y = sy = num() + oy;
        cur = { points: [[x, y]], closed: false }; subs.push(cur);
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': push([num() + ox, num() + oy]); break;
      case 'H': push([num() + ox, y]); break;
      case 'V': push([x, num() + oy]); break;
      case 'C': { const c1: Pt = [num() + ox, num() + oy], c2: Pt = [num() + ox, num() + oy], e: Pt = [num() + ox, num() + oy]; [lcx, lcy] = c2; curve([c1, c2, e]); break; }
      case 'S': { const c1: Pt = [2 * x - lcx, 2 * y - lcy], c2: Pt = [num() + ox, num() + oy], e: Pt = [num() + ox, num() + oy]; [lcx, lcy] = c2; curve([c1, c2, e]); break; }
      case 'Q': { const c: Pt = [num() + ox, num() + oy], e: Pt = [num() + ox, num() + oy]; [lcx, lcy] = c; curve([c, e]); break; }
      case 'T': { const c: Pt = [2 * x - lcx, 2 * y - lcy], e: Pt = [num() + ox, num() + oy]; [lcx, lcy] = c; curve([c, e]); break; }
      case 'A': { const rx = num(), ry = num(), rot = num(), la = num() !== 0, sw = num() !== 0; arc(rx, ry, rot, la, sw, num() + ox, num() + oy); break; }
      case 'Z': {
        if (cur) { (cur as { closed: boolean }).closed = true; }
        x = sx; y = sy; cur = null;
        break;
      }
      default: i++;
    }
    if (!'CSQT'.includes(C)) { lcx = x; lcy = y; }
  }
  return subs;
}

/** Approximate outline length of SVG path data (closing segments included). */
export function pathLength(d: string): number {
  let L = 0;
  for (const s of flattenPath(d)) {
    const p = s.points;
    for (let k = 1; k < p.length; k++) L += Math.hypot(p[k]![0] - p[k - 1]![0], p[k]![1] - p[k - 1]![1]);
    if (s.closed && p.length > 1) L += Math.hypot(p[0]![0] - p.at(-1)![0], p[0]![1] - p.at(-1)![1]);
  }
  return L;
}

/** Bounding box of SVG path data in its own px, or null when it draws nothing. */
export function pathBounds(d: string): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of flattenPath(d)) for (const [px, py] of s.points) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Bounds of a point list. */
export function pointsBounds(pts: readonly (readonly [number, number])[]): { x: number; y: number; w: number; h: number } | null {
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
