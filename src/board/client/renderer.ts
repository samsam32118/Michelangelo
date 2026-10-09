/**
 * Draws the board on the page's canvas with the shared draw code: on requestAnimationFrame, only when something is
 * dirty (or a flash is fading). Culls to the viewport, loads still / image bitmaps lazily, and draws the selection box,
 * handles, hover and the other party's selection on top. The dot grid is CSS behind the canvas (free to pan).
 */
import type { Ctx2D, DrawEnv } from '../shared/canvas.js';
import type { Shape } from '../shared/types.js';
import { boxesIntersect, expandBox, type Box } from '../shared/geometry.js';
import { drawBoard, stillTimecode } from '../shared/shapes.js';
import { chrome } from '../shared/palette.js';
import { clipsAt, stillAt } from '../shared/outline.js';
import type { App } from './app.js';

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const RESIZABLE = new Set(['frame', 'note', 'text', 'rect', 'ellipse', 'image', 'still', 'timeline']);

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dirty = true;
  private raf = 0;
  private dpr = 1;
  private images = new Map<string, { img: HTMLImageElement; ok: boolean }>();
  /** frame times of the last draws (ms), for mgl.state().perf */
  drawMs = 0;

  constructor(private app: App, private canvas: HTMLCanvasElement, private grid: HTMLElement) {
    this.ctx = canvas.getContext('2d')!;
    app.setRedraw(() => this.request());
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
    app.store.on(() => this.request());
  }

  request(): void { this.dirty = true; if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t)); }

  private resize(): void {
    const el = this.canvas.parentElement!, r = el.getBoundingClientRect();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.app.camera.w = r.width;
    this.app.camera.h = r.height;
    this.request();
    this.app.emit('camera');
  }

  /** the bitmap for a still or image shape, loading it on first ask */
  image(s: Shape): HTMLImageElement | undefined {
    let url: string | undefined;
    // an exported page (mgl board export) carries its bitmaps as data URIs, keyed by still request or image src
    const files = (window as unknown as { MGL_EMBED_FILES?: Record<string, string> }).MGL_EMBED_FILES;
    if (s.type === 'still') {
      if (files) url = files[`still:${s.t}|${s.comp ?? ''}|${s.fidelity ?? 'thumb'}${s.project ? `|${s.project}` : ''}`];
      else if (this.app.store.project) url = `${this.app.stillUrl(s)}&h=${this.app.store.project.hash.slice(0, 10)}`;
    } else if (s.type === 'image') url = /^(data:|https?:)/.test(s.src) ? s.src : files ? files[`image:${s.src}`] : `/api/image?src=${encodeURIComponent(s.src)}`;
    if (!url) return undefined;
    const hit = this.images.get(url);
    if (hit) return hit.ok ? hit.img : undefined;
    const img = new Image();
    img.decoding = 'async';
    const entry = { img, ok: false };
    img.onload = () => { entry.ok = true; this.request(); };
    img.onerror = () => { /* keep the placeholder */ };
    img.src = url;
    this.images.set(url, entry);
    if (this.images.size > 600) this.images.delete(this.images.keys().next().value as string);
    return undefined;
  }

  private frame(now: number): void {
    this.raf = 0;
    if (!this.dirty) return;
    this.dirty = false;
    const t0 = performance.now();
    const { app, ctx } = this, { cam } = app.camera, theme = app.theme, c = chrome(theme);
    this.syncGrid();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const k = this.dpr * cam.zoom;
    ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
    const store = app.store, view = expandBox(app.camera.viewBox(), 40 / cam.zoom);
    const shapes = store.shapes().filter((s) => { const b = store.bounds(s.id); return !b || boxesIntersect(b, view) || s.type === 'arrow'; });
    const sel = new Set(app.selection);
    let animating = false;
    const env: DrawEnv = {
      zoom: cam.zoom, theme, outline: store.project,
      image: (id) => { const s = store.get(id); return s ? this.image(s) : undefined; },
      bounds: (id) => store.bounds(id),
      stillCaption: (id) => {
        const s = store.get(id);
        if (!s || s.type !== 'still') return undefined;
        const at = stillAt(store.project, s);
        if (!at || !store.project) return stillTimecode(s, store.project);
        const clips = clipsAt(store.project, at.comp, at.frame);
        return `${stillTimecode(s, store.project)}${clips.length ? '  ' + clips.join(', ') : ''}`;
      },
    };
    const editing = app.editing;
    drawBoard(ctx as unknown as Ctx2D, editing ? shapes.map((s) => (s.id === editing && 'text' in s ? ({ ...s, text: '' } as Shape) : s)) : shapes, env, (s) => {
      const f = store.flashOf(s.id, now) ?? (this.highlighted(s.id, now) ? 'ai' : undefined);
      if (f) animating = true;
      return { selected: sel.has(s.id) && (s.type === 'pin' || s.type === 'arrow' || s.type === 'draw'), ...(f ? { flash: f } : {}) };
    });
    const hair = 1 / cam.zoom;
    // the other party's selection
    const ai = store.view.ai?.selection ?? [];
    if (ai.length) {
      ctx.setLineDash([5 * hair, 4 * hair]);
      ctx.strokeStyle = c.ai; ctx.lineWidth = 1.5 * hair;
      for (const id of ai) { const b = store.bounds(id); if (b) { ctx.beginPath(); ctx.roundRect(b.x - 5 * hair, b.y - 5 * hair, b.w + 10 * hair, b.h + 10 * hair, 6 * hair); ctx.stroke(); } }
      ctx.setLineDash([]);
    }
    // hover
    if (app.hover && !sel.has(app.hover)) {
      const b = store.bounds(app.hover);
      if (b) { ctx.strokeStyle = c.selection; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.5 * hair; ctx.beginPath(); ctx.roundRect(b.x - 2 * hair, b.y - 2 * hair, b.w + 4 * hair, b.h + 4 * hair, 4 * hair); ctx.stroke(); ctx.globalAlpha = 1; }
    }
    // selection: each shape hairline, the group box with handles
    const box = this.selectionBox();
    if (box && app.tool === 'select') {
      ctx.strokeStyle = c.selection; ctx.lineWidth = hair;
      if (app.selection.length > 1) for (const id of app.selection) { const b = store.bounds(id); if (b) ctx.strokeRect(b.x, b.y, b.w, b.h); }
      ctx.lineWidth = 1.5 * hair;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      if (this.canResize()) {
        const hs = 8 * hair;
        for (const h of HANDLES) {
          const [x, y] = handlePoint(box, h);
          ctx.beginPath(); ctx.roundRect(x - hs / 2, y - hs / 2, hs, hs, 2 * hair);
          ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = c.selection; ctx.lineWidth = 1.25 * hair; ctx.stroke();
        }
      }
    }
    app.overlay?.(ctx as unknown as Ctx2D, cam.zoom);
    this.drawMs = performance.now() - t0;
    if (animating) this.request();
  }

  private highlighted(id: string, now: number): boolean {
    const until = this.app.highlight.get(id);
    if (until === undefined) return false;
    if (until < now) { this.app.highlight.delete(id); return false; }
    return true;
  }

  /** the selection's box in board px (pins and arrows included) */
  selectionBox(): Box | undefined { return this.app.selection.length ? this.app.boundsOf(this.app.selection) : undefined; }
  canResize(): boolean { return this.app.selection.some((id) => { const s = this.app.store.get(id); return !!s && RESIZABLE.has(s.type) && !s.locked; }); }

  /** CSS dot grid: background offset/size follow the camera */
  private syncGrid(): void {
    const { cam } = this.app.camera;
    let step = 24;
    while (step * cam.zoom < 14) step *= 2;
    while (step * cam.zoom > 56) step /= 2;
    const px = step * cam.zoom;
    this.grid.style.backgroundSize = `${px}px ${px}px`;
    this.grid.style.backgroundPosition = `${-cam.x * cam.zoom - px / 2}px ${-cam.y * cam.zoom - px / 2}px`;
  }

  snapshot(): string { return this.canvas.toDataURL('image/png'); }
}

export function handlePoint(b: Box, h: Handle): [number, number] {
  const x = h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : b.x + b.w / 2;
  const y = h.startsWith('n') ? b.y : h.startsWith('s') ? b.y + b.h : b.y + b.h / 2;
  return [x, y];
}
