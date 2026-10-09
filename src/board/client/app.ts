/** The page's shared context: store, camera, selection, tool, playhead, and a small event bus the modules listen on. */
import type { BoardOp, OpsResult, Point, Shape, StillShape, Who } from '../shared/types.js';
import type { Ctx2D } from '../shared/canvas.js';
import { unionBoxes, type Box } from '../shared/geometry.js';
import { compOf } from '../shared/outline.js';
import { hitTest, STILL_W } from '../shared/shapes.js';
import { CameraCtl } from './camera.js';
import { Store } from './store.js';

export type ToolName = 'select' | 'hand' | 'note' | 'text' | 'rect' | 'ellipse' | 'arrow' | 'draw' | 'still' | 'pin' | 'frame';
export type AppEvent = 'selection' | 'tool' | 'camera' | 'playhead' | 'theme' | 'layout';

export class App {
  readonly store: Store;
  readonly camera: CameraCtl;
  theme: 'light' | 'dark' = 'light';
  selection: string[] = [];
  tool: ToolName = 'select';
  /** playhead in frames of the main comp */
  playhead = 0;
  hover?: string;
  /** shape being edited in the textarea (its text is not drawn) */
  editing?: string;
  /** shapes highlighted by focus() until a time */
  highlight = new Map<string, number>();
  /** what the active tool draws on top, in board coordinates (marquee, previews) */
  overlay?: (ctx: Ctx2D, zoom: number) => void;
  /** how much of the canvas is covered by floating UI (right, bottom), CSS px; the panel and timeline sit beside it */
  covered = { right: 0, bottom: 0 };
  private bus = new Map<AppEvent, Set<() => void>>();
  private redraw: () => void = () => {};
  private toaster: (text: string, kind: Who | 'error' | 'info') => void = () => {};
  private editor: (id: string) => void = () => {};

  constructor(readonly canvas: HTMLCanvasElement, base = '') {
    this.store = new Store(base);
    this.camera = new CameraCtl(() => { this.invalidate(); this.emit('camera'); });
  }

  on(e: AppEvent, fn: () => void): void { (this.bus.get(e) ?? this.bus.set(e, new Set()).get(e)!).add(fn); }
  emit(e: AppEvent): void { for (const fn of this.bus.get(e) ?? []) fn(); }

  setRedraw(fn: () => void): void { this.redraw = fn; }
  invalidate(): void { this.redraw(); }
  setToaster(fn: App['toaster']): void { this.toaster = fn; }
  toast(text: string, kind: Who | 'error' | 'info' = 'info'): void { this.toaster(text, kind); }
  setEditor(fn: (id: string) => void): void { this.editor = fn; }
  editText(id: string): void { this.editor(id); }

  select(ids: string[]): void {
    const known = ids.filter((id, i) => this.store.get(id) && ids.indexOf(id) === i);
    if (known.length === this.selection.length && known.every((id, i) => id === this.selection[i])) return;
    this.selection = known;
    this.invalidate();
    this.emit('selection');
  }
  setTool(t: ToolName): void { if (t !== this.tool) { this.tool = t; this.emit('tool'); this.invalidate(); } }
  setPlayhead(f: number): void { const n = Math.max(0, Math.round(f)); if (n !== this.playhead) { this.playhead = n; this.emit('playhead'); } }

  /** human edits: ops by the person, errors as a toast */
  async send(ops: BoardOp[], by: Who = 'human'): Promise<OpsResult> {
    const r = await this.store.send(ops, by);
    if (!r.ok) this.toast(`${r.error.message}${r.error.fix ? ` · ${r.error.fix}` : ''}`, 'error');
    return r;
  }

  boundsOf(ids: string[]): Box | undefined { return unionBoxes(ids.map((id) => this.store.bounds(id)).filter((b): b is Box => !!b)); }
  /** animate to the shapes and highlight them */
  focus(ids: string[], highlight = true): void {
    const b = this.boundsOf(ids);
    if (!b) return;
    this.camera.animateTo(this.camera.fitCamera({ x: b.x, y: b.y - 30, w: b.w, h: b.h + 30 }, { max: 1.5, right: this.covered.right, bottom: this.covered.bottom }));
    if (highlight) { const until = performance.now() + 1800; for (const id of ids) this.highlight.set(id, until); this.invalidate(); }
  }
  /** fit everything (⌘0) */
  fit(): void {
    const b = this.boundsOf(this.store.shapes().map((s) => s.id));
    if (!b) { this.camera.animateTo({ x: -80, y: -80, zoom: 1 }); return; }
    this.camera.animateTo(this.camera.fitCamera({ x: b.x, y: b.y - 30, w: b.w, h: b.h + 30 }, { max: 1, right: this.covered.right, bottom: this.covered.bottom }));
  }

  /** topmost shape under a board point: pins, then shapes top-down, frames last */
  hitAt(p: Point, opts: { skip?: (s: Shape) => boolean } = {}): Shape | undefined {
    const tol = 4 / this.camera.cam.zoom;
    const shapes = this.store.shapes();
    const ok = (s: Shape) => !opts.skip?.(s) && hit(this, s, p, tol);
    for (let i = shapes.length - 1; i >= 0; i--) { const s = shapes[i]!; if (s.type === 'pin' && ok(s)) return s; }
    for (let i = shapes.length - 1; i >= 0; i--) { const s = shapes[i]!; if (s.type !== 'pin' && s.type !== 'frame' && ok(s)) return s; }
    for (let i = shapes.length - 1; i >= 0; i--) { const s = shapes[i]!; if (s.type === 'frame' && ok(s)) return s; }
    return undefined;
  }

  /** main comp fps / length, or defaults without a project */
  comp(): { id?: string; fps: number; length: number; size: [number, number] } {
    const c = compOf(this.store.project);
    return c ? { id: c.id, fps: c.fps || 30, length: c.length, size: c.size } : { fps: 30, length: 0, size: [1080, 1920] };
  }
  /** /api/still URL for a still shape at its fidelity (the investment the person chose) */
  stillUrl(s: Pick<StillShape, 't' | 'comp' | 'fidelity' | 'project'>): string {
    const c = compOf(this.store.project, s.comp);
    const w = s.fidelity === 'full' ? c?.size[0] ?? 1080 : s.fidelity === 'half' ? Math.round((c?.size[0] ?? 1080) / 2) : STILL_W.thumb!;
    const q = new URLSearchParams({ t: String(s.t), w: String(w), by: 'human' });
    if (s.comp) q.set('comp', s.comp);
    if (s.project) q.set('project', s.project); // a variant (an option pictured as a sibling project)
    return `/api/still?${q}`;
  }
}

const hit = (app: App, s: Shape, p: Point, tol: number) => hitTest(s, p, (id) => app.store.get(id), tol, app.store.project);
