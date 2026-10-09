/**
 * The Canvas 2D subset that shape draw code may use. The browser's CanvasRenderingContext2D and @napi-rs/canvas's
 * SKRSContext2D both satisfy it, so one draw function serves the page and the Skia snapshot.
 */
export interface Ctx2D {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(a: number): void;
  scale(x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw?: boolean): void;
  rect(x: number, y: number, w: number, h: number): void;
  roundRect(x: number, y: number, w: number, h: number, r: number | number[]): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(t: string, x: number, y: number, maxW?: number): void;
  measureText(t: string): { width: number };
  setLineDash(d: number[]): void;
  drawImage(img: unknown, x: number, y: number, w: number, h: number): void;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  globalAlpha: number;
}

/**
 * What a draw function gets besides the shape: images it may draw (stills, image shapes, already loaded by the host),
 * the zoom (for hairlines), the theme, and lookups for bound arrows / pins.
 */
export interface DrawEnv {
  zoom: number;
  theme: 'light' | 'dark';
  /** a loaded image for a still (key = shape id) or image shape, or undefined while loading */
  image(shapeId: string): unknown | undefined;
  /** the bounds of another shape (arrows, pins) */
  bounds(id: string): { x: number; y: number; w: number; h: number } | undefined;
  /** label under a still: timecode + visible clip ids, filled in by the host from the outline */
  stillCaption?(shapeId: string): string | undefined;
  selected?: boolean;
  /** recently changed by: draws a flash outline */
  flash?: 'human' | 'ai';
}
