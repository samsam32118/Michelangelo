/** A recording Ctx2D for tests: every call is logged; measureText is 0.6 em per character. */
import type { Ctx2D, DrawEnv } from '../../src/board/shared/canvas.js';
import type { Outline } from '../../src/board/shared/types.js';

export class FakeCtx implements Ctx2D {
  calls: { name: string; args: unknown[] }[] = [];
  fillStyle: unknown = '#000'; strokeStyle: unknown = '#000'; lineWidth = 1; lineCap = 'butt'; lineJoin = 'miter';
  font = '10px sans-serif'; textAlign = 'start'; textBaseline = 'alphabetic'; globalAlpha = 1;
  private depth = 0;
  maxDepth = 0;
  private rec(name: string, args: unknown[]) {
    for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`${name}: non-finite argument ${a}`);
    this.calls.push({ name, args });
  }
  px(): number { const m = /([\d.]+)px/.exec(this.font); return m ? Number(m[1]) : 10; }
  save() { this.depth++; this.maxDepth = Math.max(this.maxDepth, this.depth); this.rec('save', []); }
  restore() { this.depth--; if (this.depth < 0) throw new Error('restore without save'); this.rec('restore', []); }
  get balanced() { return this.depth === 0; }
  translate(...a: number[]) { this.rec('translate', a); } rotate(...a: number[]) { this.rec('rotate', a); } scale(...a: number[]) { this.rec('scale', a); }
  setTransform(...a: number[]) { this.rec('setTransform', a); } beginPath() { this.rec('beginPath', []); } closePath() { this.rec('closePath', []); }
  moveTo(...a: number[]) { this.rec('moveTo', a); } lineTo(...a: number[]) { this.rec('lineTo', a); }
  quadraticCurveTo(...a: number[]) { this.rec('quadraticCurveTo', a); } bezierCurveTo(...a: number[]) { this.rec('bezierCurveTo', a); }
  arc(...a: (number | boolean | undefined)[]) { this.rec('arc', a.filter((x) => typeof x === 'number')); }
  ellipse(...a: (number | boolean | undefined)[]) { if ((a[2] as number) < 0 || (a[3] as number) < 0) throw new Error('negative radius'); this.rec('ellipse', a.filter((x) => typeof x === 'number')); }
  rect(...a: number[]) { this.rec('rect', a); }
  roundRect(x: number, y: number, w: number, h: number, r: number | number[]) { this.rec('roundRect', [x, y, w, h, ...(Array.isArray(r) ? r : [r])]); }
  fill() { this.rec('fill', []); } stroke() { this.rec('stroke', []); } clip() { this.rec('clip', []); }
  fillRect(...a: number[]) { this.rec('fillRect', a); } strokeRect(...a: number[]) { this.rec('strokeRect', a); } clearRect(...a: number[]) { this.rec('clearRect', a); }
  fillText(t: string, x: number, y: number) { this.rec('fillText', [t, x, y]); }
  measureText(t: string) { return { width: t.length * this.px() * 0.6 }; }
  setLineDash(d: number[]) { this.rec('setLineDash', d); }
  drawImage(img: unknown, x: number, y: number, w: number, h: number) { this.rec('drawImage', [img, x, y, w, h]); }
  texts(): string[] { return this.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0] as string); }
  count(name: string): number { return this.calls.filter((c) => c.name === name).length; }
}

export const OUTLINE: Outline = {
  file: 'video.mgl.json', main: 'main', hash: 'abc123',
  comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: 900 }],
  tracks: [{ id: 'v1', comp: 'main' }, { id: 'titles', comp: 'main' }, { id: 'vo', comp: 'main', audio: true }],
  clips: [
    { id: 'beach', track: 'v1', at: 0, len: 450, kind: 'video', label: 'beach.mov' },
    { id: 'desk', track: 'v1', at: 450, len: 450, kind: 'video', label: 'desk.mov' },
    { id: 'title', track: 'titles', at: 30, len: 90, kind: 'text', label: 'The 2-minute trick' },
    { id: 'voice', track: 'vo', at: 0, len: 900, kind: 'audio', label: 'vo.wav' },
  ],
};

export function env(over: Partial<DrawEnv> = {}, bounds: DrawEnv['bounds'] = () => undefined): DrawEnv {
  return { zoom: 1, theme: 'light', image: () => undefined, bounds, ...over };
}
