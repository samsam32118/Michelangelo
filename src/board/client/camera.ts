/** The camera: board point at the viewport's top-left plus zoom. Zoom at a screen point, fit a box, animated moves. */
import type { Camera, Point } from '../shared/types.js';
import type { Box } from '../shared/geometry.js';

export const MIN_ZOOM = 0.05, MAX_ZOOM = 8;
const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

export class CameraCtl {
  cam: Camera = { x: -80, y: -80, zoom: 1 };
  /** viewport size in CSS px */
  w = 800;
  h = 600;
  private anim?: number;
  constructor(private changed: () => void) {}

  toBoard(p: Point): Point { return [p[0] / this.cam.zoom + this.cam.x, p[1] / this.cam.zoom + this.cam.y]; }
  toScreen(p: Point): Point { return [(p[0] - this.cam.x) * this.cam.zoom, (p[1] - this.cam.y) * this.cam.zoom]; }
  /** the board rect in view */
  viewBox(): Box { return { x: this.cam.x, y: this.cam.y, w: this.w / this.cam.zoom, h: this.h / this.cam.zoom }; }

  set(c: Partial<Camera>): void {
    this.stop();
    this.cam = { x: c.x ?? this.cam.x, y: c.y ?? this.cam.y, zoom: clampZoom(c.zoom ?? this.cam.zoom) };
    this.changed();
  }
  pan(dx: number, dy: number): void { this.set({ x: this.cam.x - dx / this.cam.zoom, y: this.cam.y - dy / this.cam.zoom }); }
  /** zoom by `factor` keeping the screen point fixed */
  zoomAt(screen: Point, factor: number): void {
    const before = this.toBoard(screen), zoom = clampZoom(this.cam.zoom * factor);
    this.set({ zoom, x: before[0] - screen[0] / zoom, y: before[1] - screen[1] / zoom });
  }
  /** camera that shows box with a margin (zoom capped at `max`), centred; `right`/`bottom` are covered by UI */
  fitCamera(b: Box, o: { margin?: number; max?: number; right?: number; bottom?: number } = {}): Camera {
    const m = o.margin ?? 64, vw = Math.max(100, this.w - (o.right ?? 0)), vh = Math.max(100, this.h - (o.bottom ?? 0));
    const zoom = clampZoom(Math.min((vw - 2 * m) / Math.max(1, b.w), (vh - 2 * m) / Math.max(1, b.h), o.max ?? 1));
    return { zoom, x: b.x + b.w / 2 - vw / 2 / zoom, y: b.y + b.h / 2 - vh / 2 / zoom };
  }
  /** animate to a camera (ease out, ~320 ms); interpolates zoom in log space so it feels even */
  animateTo(to: Camera, ms = 320): void {
    this.stop();
    const from = { ...this.cam }, t0 = performance.now();
    const fc: Point = [from.x + this.w / 2 / from.zoom, from.y + this.h / 2 / from.zoom];
    const tc: Point = [to.x + this.w / 2 / to.zoom, to.y + this.h / 2 / to.zoom];
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms), e = 1 - (1 - k) ** 3;
      const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e);
      const cx = fc[0] + (tc[0] - fc[0]) * e, cy = fc[1] + (tc[1] - fc[1]) * e;
      this.cam = { zoom, x: cx - this.w / 2 / zoom, y: cy - this.h / 2 / zoom };
      this.changed();
      this.anim = k < 1 ? requestAnimationFrame(step) : undefined;
    };
    this.anim = requestAnimationFrame(step);
  }
  stop(): void { if (this.anim !== undefined) { cancelAnimationFrame(this.anim); this.anim = undefined; } }
}
