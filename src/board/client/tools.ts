/**
 * Pointer tools: select (click, shift-add, marquee, move, resize handles, drop into frames), hand / space-pan, note,
 * text, rect, ellipse, frame (click or drag), arrow (binds to the shapes it starts and ends on), draw (smoothed
 * freehand), still (placed at the playhead time), pin (on any shape). Wheel / pinch zoom at the cursor. Every edit
 * is one op batch by the person.
 */
import type { BoardOp, Point, Shape, ShapeType } from '../shared/types.js';
import type { Ctx2D } from '../shared/canvas.js';
import { boxFrom, boxInside, boxesIntersect, center, pointInRect, type Box } from '../shared/geometry.js';
import { arrowEnds, SHAPE_DEFS, stillAspect, STILL_W } from '../shared/shapes.js';
import { chrome } from '../shared/palette.js';
import { formatSeconds } from '../shared/time.js';
import type { App } from './app.js';
import { handlePoint, HANDLES, type Handle, type Renderer } from './renderer.js';
import { ID_PREFIX, nextId } from './local-ops.js';
import { openPrompt } from './text-edit.js';

interface Gesture { move(p: Point, e: PointerEvent): void; up(p: Point, e: PointerEvent): void; cancel?(): void }

const round1 = (v: number) => Math.round(v * 10) / 10;
const CREATE: Partial<Record<string, ShapeType>> = { note: 'note', text: 'text', rect: 'rect', ellipse: 'ellipse', frame: 'frame' };

export class Tools {
  space = false;
  private g?: Gesture;
  private pointers = new Map<number, Point>();
  private pinch?: { d: number; mid: Point };

  constructor(private app: App, private canvas: HTMLCanvasElement, private r: Renderer) {
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => { this.pointers.delete(e.pointerId); this.g?.cancel?.(); this.g = undefined; this.app.overlay = undefined; this.app.store.clearOverrides(); });
    canvas.addEventListener('dblclick', (e) => this.dbl(e));
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerleave', () => { if (this.app.hover) { this.app.hover = undefined; this.app.invalidate(); } });
    app.on('tool', () => this.cursor());
  }

  screen(e: { clientX: number; clientY: number }): Point { const b = this.canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; }
  board(e: { clientX: number; clientY: number }): Point { return this.app.camera.toBoard(this.screen(e)); }

  private cursor(over?: string): void {
    const t = this.app.tool;
    this.canvas.style.cursor = this.space || t === 'hand' ? (this.g ? 'grabbing' : 'grab') : over ? over : t === 'select' ? 'default' : t === 'text' ? 'text' : 'crosshair';
  }
  setSpace(on: boolean): void { this.space = on; this.cursor(); }

  private down(e: PointerEvent): void {
    this.canvas.focus({ preventScroll: true });
    this.pointers.set(e.pointerId, this.screen(e));
    if (this.pointers.size === 2) { this.g?.cancel?.(); this.g = undefined; this.app.overlay = undefined; this.app.store.clearOverrides(); this.startPinch(); return; }
    if (this.pointers.size > 2) return;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.board(e);
    const tool = this.space || e.button === 1 ? 'hand' : this.app.tool;
    if (e.button === 2) return;
    this.g = tool === 'hand' ? this.pan(e) : tool === 'select' ? this.select(p, e) : tool === 'arrow' ? this.arrow(p) : tool === 'draw' ? this.draw(p)
      : tool === 'still' ? this.still(p) : tool === 'pin' ? this.pin(p, e) : CREATE[tool] ? this.create(CREATE[tool]!, p) : undefined;
    this.cursor();
  }
  private move(e: PointerEvent): void {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, this.screen(e));
    if (this.pinch && this.pointers.size === 2) return this.pinchMove();
    const p = this.board(e);
    if (this.g) { this.g.move(p, e); return; }
    if (this.app.tool === 'select' && !this.space) {
      const h = this.handleAt(this.screen(e));
      const hit = h ? undefined : this.app.hitAt(p);
      if (hit?.id !== this.app.hover) { this.app.hover = hit?.id; this.app.invalidate(); }
      this.cursor(h ? (h === 'n' || h === 's' ? 'ns-resize' : h === 'e' || h === 'w' ? 'ew-resize' : h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize') : hit ? 'pointer' : undefined);
    }
  }
  private up(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = undefined; return; }
    const g = this.g;
    this.g = undefined;
    if (g) g.up(this.board(e), e);
    this.cursor();
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const s = this.screen(e);
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * lines, dy = e.deltaY * lines;
    // pinch (ctrl) and mouse wheels zoom; two-finger trackpad scrolls pan
    const mouseWheel = e.deltaMode !== 0 || (dx === 0 && Math.abs(dy) >= 40 && Number.isInteger(dy));
    if (e.ctrlKey || e.metaKey || mouseWheel) this.app.camera.zoomAt(s, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022)));
    else this.app.camera.pan(-dx, -dy);
  }
  private startPinch(): void {
    const [a, b] = [...this.pointers.values()] as [Point, Point];
    this.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
  }
  private pinchMove(): void {
    const [a, b] = [...this.pointers.values()] as [Point, Point];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    this.app.camera.pan(mid[0] - this.pinch!.mid[0], mid[1] - this.pinch!.mid[1]);
    this.app.camera.zoomAt(mid, d / this.pinch!.d);
    this.pinch = { d, mid };
  }

  private pan(e: PointerEvent): Gesture {
    let last = this.screen(e);
    return {
      move: (_p, ev) => { const s = this.screen(ev); this.app.camera.pan(s[0] - last[0], s[1] - last[1]); last = s; },
      up: () => {},
    };
  }

  /** a resize handle under a screen point */
  private handleAt(s: Point): Handle | undefined {
    const box = this.r.selectionBox();
    if (!box || !this.r.canResize() || this.app.tool !== 'select') return undefined;
    const sc = (p: Point) => this.app.camera.toScreen(p);
    return HANDLES.find((h) => { const q = sc(handlePoint(box, h)); return Math.abs(q[0] - s[0]) <= 7 && Math.abs(q[1] - s[1]) <= 7; });
  }

  private select(p: Point, e: PointerEvent): Gesture | undefined {
    const app = this.app;
    const h = this.handleAt(this.screen(e));
    if (h) return this.resize(h, p, e);
    const hit = app.hitAt(p);
    if (hit) {
      if (e.shiftKey) { app.select(app.selection.includes(hit.id) ? app.selection.filter((x) => x !== hit.id) : [...app.selection, hit.id]); if (!app.selection.includes(hit.id)) return undefined; }
      else if (!app.selection.includes(hit.id)) app.select([hit.id]);
      return this.drag(p);
    }
    return this.marquee(p, e.shiftKey);
  }

  /** move the selection (frames bring their children); dropping a shape over a frame puts it in the frame */
  private drag(start: Point): Gesture {
    const app = this.app, store = app.store;
    const ids = app.selection.filter((id) => { const s = store.get(id); return s && !s.locked && s.type !== 'pin'; });
    const all = new Set(ids);
    for (let grew = true; grew;) { grew = false; for (const s of store.shapes()) if (s.parent && all.has(s.parent) && !all.has(s.id)) { all.add(s.id); grew = true; } }
    const orig = new Map([...all].map((id) => [id, store.get(id)!] as const));
    let dx = 0, dy = 0, moved = false;
    return {
      move: (p, e) => {
        dx = p[0] - start[0]; dy = p[1] - start[1];
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        if (!moved && Math.hypot(dx, dy) * app.camera.cam.zoom < 3) return;
        moved = true;
        const m = new Map<string, Shape>();
        for (const [id, s] of orig) m.set(id, shift(s, dx, dy));
        store.setOverrides(m);
      },
      up: () => {
        if (!moved || !ids.length) { store.clearOverrides(); return; }
        const rdx = Math.round(dx), rdy = Math.round(dy);
        const ops: BoardOp[] = [{ op: 'shape.move', ids, dx: rdx, dy: rdy }];
        // reparent what was dropped in / out of a frame
        for (const id of ids) {
          const s = store.get(id);
          if (!s || s.type === 'frame' || s.type === 'arrow') continue;
          const b = store.bounds(id);
          if (!b) continue;
          const f = frameAt(app, center(b), all);
          if ((f?.id ?? undefined) !== s.parent) ops.push({ op: 'shape.set', id, props: { parent: f?.id ?? null } });
        }
        void app.send(ops);
        store.clearOverrides();
      },
      cancel: () => store.clearOverrides(),
    };
  }

  private resize(h: Handle, _start: Point, e0: PointerEvent): Gesture {
    const app = this.app, store = app.store;
    const box0 = this.r.selectionBox()!;
    const ids = app.selection.filter((id) => { const s = store.get(id); return s && !s.locked && s.type !== 'pin' && s.type !== 'arrow'; });
    const orig = new Map(ids.map((id) => [id, { s: store.get(id)!, b: store.bounds(id)! }] as const));
    const single = ids.length === 1 ? orig.get(ids[0]!)!.s : undefined;
    const keep = (e: PointerEvent) => e.shiftKey || single?.type === 'still' || single?.type === 'image' || (ids.length > 1 && h.length === 2);
    let props = new Map<string, Record<string, unknown>>();
    void e0;
    return {
      move: (p, e) => {
        let x0 = box0.x, y0 = box0.y, x1 = box0.x + box0.w, y1 = box0.y + box0.h;
        if (h.includes('w')) x0 = Math.min(p[0], x1 - 8); if (h.includes('e')) x1 = Math.max(p[0], x0 + 8);
        if (h.startsWith('n')) y0 = Math.min(p[1], y1 - 8); if (h.startsWith('s')) y1 = Math.max(p[1], y0 + 8);
        let sx = (x1 - x0) / (box0.w || 1), sy = (y1 - y0) / (box0.h || 1);
        if (keep(e)) {
          const k = h === 'n' || h === 's' ? sy : h === 'e' || h === 'w' ? sx : Math.max(sx, sy);
          sx = sy = k;
          if (h.includes('w')) x0 = x1 - box0.w * k; else x1 = x0 + box0.w * k;
          if (h.startsWith('n')) y0 = y1 - box0.h * k; else y1 = y0 + box0.h * k;
        }
        const m = new Map<string, Shape>();
        props = new Map();
        for (const [id, { s, b }] of orig) {
          const nx = x0 + (b.x - box0.x) * sx, ny = y0 + (b.y - box0.y) * sy;
          const pr: Record<string, unknown> = { x: Math.round(nx + (s.x - b.x) * sx), y: Math.round(ny + (s.y - b.y) * sy) };
          if (s.type === 'draw') pr.points = s.points.map(([px, py]) => [round1(px * sx), round1(py * sy)]);
          else if (s.type === 'still') pr.w = Math.round(b.w * sx);
          else if (s.type === 'text') { pr.w = Math.round(b.w * sx); if (h.length === 2) pr.size = Math.max(6, Math.round((s.size ?? 24) * sy)); }
          else { pr.w = Math.round(b.w * sx); pr.h = Math.round(b.h * sy); }
          props.set(id, pr);
          m.set(id, { ...s, ...pr } as Shape);
        }
        store.setOverrides(m);
      },
      up: () => {
        const ops: BoardOp[] = [...props].map(([id, pr]) => ({ op: 'shape.set', id, props: pr }));
        if (ops.length) void app.send(ops);
        store.clearOverrides();
      },
      cancel: () => store.clearOverrides(),
    };
  }

  private marquee(start: Point, add: boolean): Gesture {
    const app = this.app, base = add ? [...app.selection] : [];
    if (!add) app.select([]);
    let box: Box = { x: start[0], y: start[1], w: 0, h: 0 };
    return {
      move: (p) => {
        box = boxFrom(start, p);
        const hits = app.store.shapes().filter((s) => { const b = app.store.bounds(s.id); return b && (s.type === 'frame' ? boxInside(b, box) : boxesIntersect(b, box)); }).map((s) => s.id);
        app.select([...new Set([...base, ...hits])]);
        app.overlay = (ctx, zoom) => {
          const c = chrome(app.theme);
          ctx.fillStyle = c.selectionFill; ctx.fillRect(box.x, box.y, box.w, box.h);
          ctx.strokeStyle = c.selection; ctx.lineWidth = 1 / zoom; ctx.strokeRect(box.x, box.y, box.w, box.h);
        };
        app.invalidate();
      },
      up: () => { app.overlay = undefined; app.invalidate(); },
      cancel: () => { app.overlay = undefined; },
    };
  }

  /** note / text / rect / ellipse / frame: click for the default size, drag for a box */
  private create(type: ShapeType, start: Point): Gesture {
    const app = this.app;
    let box: Box | undefined;
    return {
      move: (p) => {
        if (type === 'note' || type === 'text') return;
        if (Math.hypot(p[0] - start[0], p[1] - start[1]) * app.camera.cam.zoom < 4) return;
        box = boxFrom(start, p);
        app.overlay = (ctx, zoom) => preview(ctx, zoom, app, box!, type);
        app.invalidate();
      },
      up: () => {
        app.overlay = undefined;
        const [dw, dh] = SHAPE_DEFS[type].size;
        const b = box ?? (type === 'text' ? { x: start[0], y: start[1] - 16, w: 0, h: 0 } : type === 'frame' ? { x: start[0], y: start[1], w: dw, h: dh } : { x: start[0] - dw / 2, y: start[1] - dh / 2, w: dw, h: dh });
        const id = nextId(app.store.board, ID_PREFIX[type]);
        const shape: Record<string, unknown> = { id, type, x: Math.round(b.x), y: Math.round(b.y) };
        if (box && type !== 'text') { shape.w = Math.round(b.w); shape.h = Math.round(b.h); }
        const parent = type === 'frame' ? undefined : frameAt(app, center(b.w ? b : { ...b, w: 1, h: 1 }));
        if (parent) shape.parent = parent.id;
        const ops: BoardOp[] = [{ op: 'shape.add', shape: shape as never }];
        if (type === 'frame') {
          // adopt top-level shapes that sit wholly inside the new frame
          const fb = { x: b.x, y: b.y, w: b.w, h: b.h };
          for (const s of app.store.shapes()) { const sb = app.store.bounds(s.id); if (!s.parent && s.type !== 'arrow' && s.type !== 'pin' && sb && boxInside(sb, fb)) ops.push({ op: 'shape.set', id: s.id, props: { parent: id } }); }
        }
        void app.send(ops).then((r) => { if (r.ok && (type === 'note' || type === 'text')) app.editText(id); });
        app.setTool('select');
        app.select([id]);
        app.invalidate();
      },
      cancel: () => { app.overlay = undefined; },
    };
  }

  private arrow(start: Point): Gesture {
    const app = this.app;
    const skip = (s: Shape) => s.type === 'arrow' || s.type === 'pin';
    const from = app.hitAt(start, { skip });
    let end = start, to: Shape | undefined;
    const ends = (): [string | Point, string | Point] => [from?.id ?? start.map(Math.round) as Point, to?.id ?? end.map(Math.round) as Point];
    return {
      move: (p) => {
        end = p;
        to = app.hitAt(p, { skip: (s) => skip(s) || s.id === from?.id });
        const [f, t] = ends();
        app.overlay = (ctx, zoom) => {
          const c = chrome(app.theme);
          const [a, b] = arrowEnds({ id: '_', type: 'arrow', x: 0, y: 0, from: f, to: t }, (id) => app.store.bounds(id), (id) => app.store.get(id)?.type);
          for (const id of [from?.id, to?.id]) { const bb = id && app.store.bounds(id); if (bb) { ctx.strokeStyle = c.selection; ctx.lineWidth = 2 / zoom; ctx.strokeRect(bb.x - 4 / zoom, bb.y - 4 / zoom, bb.w + 8 / zoom, bb.h + 8 / zoom); } }
          ctx.strokeStyle = c.selection; ctx.lineWidth = 2; ctx.setLineDash([6 / zoom, 4 / zoom]);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
        };
        app.invalidate();
      },
      up: () => {
        app.overlay = undefined;
        app.invalidate();
        if (!to && Math.hypot(end[0] - start[0], end[1] - start[1]) * app.camera.cam.zoom < 10) return;
        const [f, t] = ends();
        const id = nextId(app.store.board, 'a');
        void app.send([{ op: 'shape.add', shape: { id, type: 'arrow', from: f, to: t } as never }]);
        app.setTool('select');
        app.select([id]);
      },
      cancel: () => { app.overlay = undefined; },
    };
  }

  private draw(start: Point): Gesture {
    const app = this.app, pts: Point[] = [start];
    const overlay = (ctx: Ctx2D) => {
      ctx.strokeStyle = chrome(app.theme).ink; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(pts[0]![0], pts[0]![1]); for (const q of pts) ctx.lineTo(q[0], q[1]); ctx.stroke();
    };
    app.overlay = overlay;
    return {
      move: (p) => { const l = pts[pts.length - 1]!; if (Math.hypot(p[0] - l[0], p[1] - l[1]) * app.camera.cam.zoom >= 2) { pts.push(p); app.invalidate(); } },
      up: () => {
        app.overlay = undefined;
        const x = Math.round(Math.min(...pts.map((q) => q[0]))), y = Math.round(Math.min(...pts.map((q) => q[1])));
        const points = pts.map((q): Point => [round1(q[0] - x), round1(q[1] - y)]);
        const id = nextId(app.store.board, 'd');
        const parent = frameAt(app, start);
        void app.send([{ op: 'shape.add', shape: { id, type: 'draw', x, y, points, ...(parent ? { parent: parent.id } : {}) } as never }]);
        app.invalidate();
      },
      cancel: () => { app.overlay = undefined; },
    };
  }

  private still(p: Point): Gesture {
    const app = this.app;
    return {
      move: () => {},
      up: () => {
        if (!app.store.project) { app.toast('Stills need a linked project: open the board through its project (mgl board serve video.mgl.json).', 'error'); return; }
        const c = app.comp(), w = STILL_W.thumb!, h = Math.round(w * stillAspect(app.store.project));
        const parent = frameAt(app, p);
        void app.send([{ op: 'still.add', t: formatSeconds(app.playhead, c.fps), fidelity: 'thumb', x: Math.round(p[0] - w / 2), y: Math.round(p[1] - h / 2), ...(parent ? { parent: parent.id } : {}) }]);
      },
    };
  }

  private pin(p: Point, e: PointerEvent): Gesture {
    const app = this.app;
    return {
      move: () => {},
      up: () => {
        const t = app.hitAt(p, { skip: (s) => s.type === 'pin' || s.type === 'arrow' });
        if (!t) { app.toast('Click a still (or any shape) to pin feedback on it.', 'info'); return; }
        const b = app.store.bounds(t.id)!;
        const u = Math.round(((p[0] - b.x) / (b.w || 1)) * 1000) / 1000, v = Math.round(((p[1] - b.y) / (b.h || 1)) * 1000) / 1000;
        openPrompt(app, this.screen(e), `Feedback on ${t.id}…`, (text) => { if (text.trim()) void app.send([{ op: 'pin.add', target: t.id, u: clamp01(u), v: clamp01(v), text: text.trim() }]); });
        app.setTool('select');
      },
    };
  }

  private dbl(e: MouseEvent): void {
    if (this.app.tool !== 'select') return;
    const p = this.board(e), hit = this.app.hitAt(p);
    if (hit && ['note', 'text', 'rect', 'ellipse', 'frame', 'arrow', 'pin'].includes(hit.type)) { this.app.select([hit.id]); this.app.editText(hit.id); return; }
    if (!hit) {
      const id = nextId(this.app.store.board, 't'), parent = frameAt(this.app, p);
      void this.app.send([{ op: 'shape.add', shape: { id, type: 'text', x: Math.round(p[0]), y: Math.round(p[1] - 16), ...(parent ? { parent: parent.id } : {}) } as never }]).then((r) => { if (r.ok) this.app.editText(id); });
      this.app.select([id]);
    }
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** a copy of a shape moved by dx, dy (arrows move their point ends) */
export function shift(s: Shape, dx: number, dy: number): Shape {
  if (s.type === 'arrow') return { ...s, from: Array.isArray(s.from) ? [s.from[0] + dx, s.from[1] + dy] : s.from, to: Array.isArray(s.to) ? [s.to[0] + dx, s.to[1] + dy] : s.to };
  return { ...s, x: s.x + dx, y: s.y + dy };
}

/** topmost frame containing a board point (not one of `skip`) */
export function frameAt(app: App, p: Point, skip: Set<string> = new Set()): Shape | undefined {
  const shapes = app.store.shapes();
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i]!;
    if (s.type !== 'frame' || skip.has(s.id)) continue;
    const b = app.store.bounds(s.id);
    if (b && pointInRect(p, b)) return s;
  }
  return undefined;
}

function preview(ctx: Ctx2D, zoom: number, app: App, b: Box, type: ShapeType): void {
  const c = chrome(app.theme);
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  ctx.strokeStyle = c.selection;
  ctx.lineWidth = 1.5 / zoom;
  ctx.beginPath();
  if (type === 'ellipse') ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
  else ctx.roundRect(b.x, b.y, b.w, b.h, type === 'frame' ? 10 : 6);
  ctx.stroke();
  ctx.setLineDash([]);
}
