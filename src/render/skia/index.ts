/**
 * The built-in Skia renderer (@napi-rs/canvas): draws a DisplayList into an RGBA frame.
 *
 * Every layer is drawn into its own surface (box × resolution factor, plus a margin for effects, stroke and
 * shadow), run through its layer effects and masks, then composited with its matrix, opacity and blend mode.
 * Solid and media layers without effects, masks or matte are drawn straight onto the target.
 */
import { createCanvas, type Canvas, type ImageData } from '@napi-rs/canvas';
import type { BlendMode } from '../../core/schema/index.js';
import type { Rate } from '../../core/time.js';
import { fail, suggest } from '../../core/errors.js';
import type { Surface } from '../../plugin/api.js';
import { createSurface } from '../../plugin/surface.js';
import type {
  AdjustmentNode, AudioLevelsTable, DisplayList, DisplayNode, FrameProvider, LayerNode, Matrix, MediaSource, Renderer, RendererRegistry, RenderSession,
  ResolvedEffect, RGBAFrame, TextLayouter, TransitionNode,
} from '../types.js';
import { createTextLayouter, registerFontAsset, registerFonts, BUNDLED_FONTS_DIR } from '../text.js';
import { fitBox } from '../evaluate.js';
import { decodeSize } from '../frames.js';
import { invert, multiply, scaling } from '../matrix.js';
import { drawShape, shapeOverhang } from './shapes.js';
import { drawTextLayer, textOverhang } from './text.js';
import { applyMasks, applyMatte } from './masks.js';

export const BLEND_OPS: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', add: 'lighter',
  'color-dodge': 'color-dodge', 'color-burn': 'color-burn', 'hard-light': 'hard-light', 'soft-light': 'soft-light', difference: 'difference',
  exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

const MAX_SURFACE = 8192;
const EMPTY_REGISTRY: RendererRegistry = { effects: new Map(), transitions: new Map(), generators: new Map() };

interface DrawCtx {
  frames: FrameProvider;
  layouter: TextLayouter;
  registry: RendererRegistry;
  /** the comp being drawn (for FrameInfo) */
  list: DisplayList;
  /** copy RGBA bytes into a canvas (pooled per session) */
  upload(w: number, h: number, data: Uint8Array | Buffer): Canvas;
  audioLevels?: (assetId: string, rate: Rate) => AudioLevelsTable | undefined;
}

const setT = (s: Surface, m: Matrix) => s.ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
const scaleOf = (m: Matrix) => Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));

function frameInfo(dc: DrawCtx, frame: number, seed: number) {
  const fps = dc.list.rate.num / dc.list.rate.den;
  return { frame, time: frame / fps, fps, seed, comp: { width: dc.list.width, height: dc.list.height } };
}

function effectDef(dc: DrawCtx, e: ResolvedEffect) {
  const def = dc.registry.effects.get(e.type);
  if (!def) {
    const dym = suggest(e.type, dc.registry.effects.keys());
    fail('E_UNKNOWN_EFFECT', `effect "${e.type}" is not known to the renderer.`, dym.length ? `did you mean "${dym[0]}"?` : 'pass the project\'s plugin registry to renderer.open({ registry }), or remove the effect.');
  }
  return def;
}

function fxMargin(dc: DrawCtx, fx: ResolvedEffect[]): number {
  return fx.reduce((m, e) => m + (effectDef(dc, e).margin?.(e.params as never) ?? 0), 0);
}

/** Run layer effects in order; returns the final surface. */
function runEffects(dc: DrawCtx, s: Surface, fx: ResolvedEffect[], localFrame: number, seed: number): Surface {
  let src = s;
  for (const e of fx) {
    const def = effectDef(dc, e);
    if (!def.draw) continue;
    const dst = src.scratch();
    def.draw({ src, dst, params: e.params as never, ...frameInfo(dc, localFrame, seed) });
    src = dst;
  }
  return src;
}

async function mediaImage(dc: DrawCtx, src: MediaSource, w: number, h: number): Promise<{ canvas: Canvas; width: number; height: number }> {
  const f = await dc.frames.get(src, { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) });
  return { canvas: dc.upload(f.width, f.height, f.data), width: f.width, height: f.height };
}

/** Draw a media frame into the layer box (layer px) with crop and fit. */
async function drawMedia(dc: DrawCtx, target: Surface, src: MediaSource, box: { w: number; h: number }, k: number): Promise<void> {
  const want = decodeSize(src, box.w * k, box.h * k);
  const img = await mediaImage(dc, src, want.w, want.h);
  const srcW = src.size?.w ?? img.width, srcH = src.size?.h ?? img.height;
  const sc = img.width / srcW;
  const [l, t, r, b] = src.crop ?? [0, 0, 0, 0];
  const sx = l * sc, sy = t * (img.height / srcH), sw = Math.max(1, img.width - (l + r) * sc), sh = Math.max(1, img.height - (t + b) * (img.height / srcH));
  const d = fitBox(srcW - l - r, srcH - t - b, box.w, box.h, src.fit);
  target.ctx.drawImage(img.canvas, sx, sy, sw, sh, (box.w - d.w) / 2, (box.h - d.h) / 2, d.w, d.h);
}

/** Draw a layer's source into `s` whose transform maps layer px → surface px. */
async function drawSource(dc: DrawCtx, s: Surface, node: LayerNode, k: number): Promise<void> {
  const src = node.source, { w, h } = node.box, ctx = s.ctx;
  switch (src.type) {
    case 'solid': ctx.fillStyle = src.color; ctx.fillRect(0, 0, w, h); return;
    case 'media': return drawMedia(dc, s, src, node.box, k);
    case 'shape': return drawShape(ctx, src.shape, w, h, src.trim, src.trimStart, src.trimOffset);
    case 'text': return drawTextLayer(ctx, dc.layouter, src, node.box);
    case 'captions': return drawTextLayer(ctx, dc.layouter, src, node.box);
    case 'comp': {
      if (!src.list) return;
      const t = ctx.getTransform();
      await drawList({ ...dc, list: src.list }, src.list, s, [t.a, t.b, t.c, t.d, t.e, t.f], true);
      return;
    }
    case 'gen': {
      const def = dc.registry.generators.get(src.gen.type);
      if (!def) fail('E_UNKNOWN_GENERATOR', `generator "${src.gen.type}" is not known to the renderer.`, 'pass the project\'s plugin registry to renderer.open({ registry }).');
      const g = createSurface(w, h);
      const lv = src.audio ? dc.audioLevels?.(src.audio.assetId, dc.list.rate) : undefined;
      const audio = lv && src.audio ? { rms: lv.rms, spectrum: lv.spectrum, bands: lv.bands, frame: src.audio.frame } : undefined;
      def.draw({ dst: g, params: src.params as never, ...(audio ? { audio } : {}), ...frameInfo(dc, src.frame, node.seed) });
      ctx.drawImage(g.canvas, 0, 0, w, h);
      return;
    }
  }
}

function sourceOverhang(node: LayerNode): number {
  const s = node.source;
  if (s.type === 'text' || s.type === 'captions') return textOverhang(s.style, node.box, s.type === 'text' ? s.animate : undefined);
  if (s.type === 'shape') return shapeOverhang(s.shape);
  return 0;
}

/** Render a layer (source, effects, masks) into its own surface; returns it with the matrix that places it (surface px → target px). */
async function renderLayer(dc: DrawCtx, node: LayerNode, toTarget: Matrix): Promise<{ surface: Surface; place: Matrix } | null> {
  const { w, h } = node.box;
  if (!(w > 0 && h > 0)) return null;
  const fixedRes = node.fx.length > 0 || node.source.type === 'gen';
  let k = fixedRes ? 1 : Math.min(8, Math.max(0.02, scaleOf(toTarget)));
  const m = sourceOverhang(node) + fxMargin(dc, node.fx);
  const dim = Math.max(w, h) + 2 * m;
  if (dim * k > MAX_SURFACE) k = MAX_SURFACE / dim;
  const s = createSurface(Math.ceil((w + 2 * m) * k), Math.ceil((h + 2 * m) * k));
  const layerT: Matrix = [k, 0, 0, k, m * k, m * k];
  setT(s, layerT);
  await drawSource(dc, s, node, k);
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  // masks cut the layer before its effects (as in After Effects), so a shadow or glow can extend past the mask
  if (node.masks.length) applyMasks(s, node.masks, multiply(layerT, invert(node.matrix)), layerT);
  const out = runEffects(dc, s, node.fx, node.localFrame, node.seed);
  const place = multiply(multiply(toTarget, node.matrix), invert(layerT));
  return { surface: out, place };
}

function composite(target: Surface, img: Canvas, place: Matrix, opacity: number, blend: BlendMode): void {
  const c = target.ctx;
  c.save();
  setT(target, place);
  c.globalAlpha = opacity;
  c.globalCompositeOperation = BLEND_OPS[blend] ?? 'source-over';
  c.drawImage(img, 0, 0);
  c.restore();
}

async function drawLayer(dc: DrawCtx, target: Surface, node: LayerNode, toTarget: Matrix): Promise<void> {
  if (node.opacity <= 0) return;
  const direct = !node.fx.length && !node.masks.length && !node.matte && (node.source.type === 'solid' || node.source.type === 'media');
  if (direct) {
    const c = target.ctx;
    c.save();
    setT(target, multiply(toTarget, node.matrix));
    c.globalAlpha = node.opacity;
    c.globalCompositeOperation = BLEND_OPS[node.blend] ?? 'source-over';
    await drawSource(dc, target, node, scaleOf(multiply(toTarget, node.matrix)));
    c.restore();
    return;
  }
  const r = await renderLayer(dc, node, toTarget);
  if (!r) return;
  if (!node.matte) return composite(target, r.surface.canvas, r.place, node.opacity, node.blend);
  const tmp = target.scratch();
  composite(tmp, r.surface.canvas, r.place, node.opacity, 'normal');
  const mt = target.scratch();
  await drawLayer(dc, mt, node.matte.node, toTarget);
  applyMatte(tmp, mt, node.matte.mode);
  composite(target, tmp.canvas, [1, 0, 0, 1, 0, 0], 1, node.blend);
}

/** Is a toTarget matrix scaled (draft renders, scaled stills, nested comps at k ≠ 1)? */
function offScale(toTarget: Matrix): boolean {
  return Math.abs(toTarget[0] - 1) > 1e-6 || Math.abs(toTarget[3] - 1) > 1e-6 || toTarget[1] !== 0 || toTarget[2] !== 0;
}

/**
 * Run `fn` on comp-px surfaces when the target is scaled, so effect and transition parameters in px (blur radius,
 * feather, offsets) mean the same at every output size: `fn` gets a surface factory and the comp px → surface
 * matrix, and returns the surface to place; it is drawn back onto the target through `toTarget`.
 */
async function inCompPx(dc: DrawCtx, target: Surface, toTarget: Matrix, fn: (make: () => Surface, toS: Matrix) => Promise<{ s: Surface; opacity: number; blend: BlendMode } | null>): Promise<void> {
  if (!offScale(toTarget)) {
    const r = await fn(() => target.scratch(), toTarget);
    if (r) composite(target, r.s.canvas, [1, 0, 0, 1, 0, 0], r.opacity, r.blend);
    return;
  }
  const W = Math.max(1, Math.round(dc.list.width)), H = Math.max(1, Math.round(dc.list.height));
  const r = await fn(() => createSurface(W, H), [1, 0, 0, 1, 0, 0]);
  if (!r) return;
  const c = target.ctx;
  c.save();
  setT(target, toTarget);
  c.imageSmoothingEnabled = true;
  c.globalAlpha = r.opacity;
  c.globalCompositeOperation = BLEND_OPS[r.blend] ?? 'source-over';
  c.drawImage(r.s.canvas, 0, 0, W, H);
  c.restore();
}

async function drawTransition(dc: DrawCtx, target: Surface, node: TransitionNode, toTarget: Matrix): Promise<void> {
  const def = dc.registry.transitions.get(node.transition.type);
  if (!def) {
    const dym = suggest(node.transition.type, dc.registry.transitions.keys());
    fail('E_UNKNOWN_TRANSITION', `transition "${node.transition.type}" is not known to the renderer.`, dym.length ? `did you mean "${dym[0]}"?` : 'pass the project\'s plugin registry to renderer.open({ registry }).');
  }
  await inCompPx(dc, target, toTarget, async (make, toS) => {
    const from = make(), to = make(), dst = make();
    await drawNodes(dc, node.from, from, toS);
    await drawNodes(dc, node.to, to, toS);
    const lf = (node.to[0] ?? node.from[0]) as LayerNode | undefined;
    def.draw({ from, to, dst, progress: node.progress, params: node.transition.params as never, ...frameInfo(dc, lf?.localFrame ?? dc.list.frame, lf?.seed ?? 0) });
    return { s: dst, opacity: 1, blend: 'normal' };
  });
}

async function drawAdjustment(dc: DrawCtx, target: Surface, node: AdjustmentNode, toTarget: Matrix): Promise<void> {
  if (node.opacity <= 0 || !node.fx.length) return;
  await inCompPx(dc, target, toTarget, async (make, toS) => {
    const copy = make();
    // what is below, in the working space (comp px when the target is scaled)
    const c = copy.ctx;
    c.save();
    const inv = multiply(toS, invert(toTarget));
    c.setTransform(inv[0], inv[1], inv[2], inv[3], inv[4], inv[5]);
    c.drawImage(target.canvas, 0, 0);
    c.restore();
    const out = runEffects(dc, copy, node.fx, node.localFrame, node.seed);
    if (node.masks.length) applyMasks(out, node.masks, toS, multiply(toS, node.matrix));
    // drawn back with the same blend; the part of the target it covers is replaced by the adjusted copy
    return { s: out, opacity: node.opacity, blend: node.blend };
  });
}

async function drawNodes(dc: DrawCtx, nodes: DisplayNode[], target: Surface, toTarget: Matrix): Promise<void> {
  for (const n of nodes) {
    if (n.type === 'layer') await drawLayer(dc, target, n, toTarget);
    else if (n.type === 'transition') await drawTransition(dc, target, n, toTarget);
    else await drawAdjustment(dc, target, n, toTarget);
  }
}

/**
 * Draw a display list into `target` with `toTarget` mapping its comp px → target px. A nested list
 * (`nested`) is drawn through its own comp-sized surface so adjustment layers only see its content.
 */
async function drawList(dc: DrawCtx, list: DisplayList, target: Surface, toTarget: Matrix, nested = false): Promise<void> {
  if (!nested) {
    if (list.bg) { const c = target.ctx; c.save(); setT(target, toTarget); c.fillStyle = list.bg; c.fillRect(0, 0, list.width, list.height); c.restore(); }
    return drawNodes(dc, list.nodes, target, toTarget);
  }
  const k = Math.min(8, Math.max(0.02, scaleOf(toTarget)));
  const s = createSurface(Math.ceil(list.width * k), Math.ceil(list.height * k));
  await drawList(dc, list, s, scaling(k, k));
  composite(target, s.canvas, multiply(toTarget, scaling(1 / k, 1 / k)), 1, 'normal');
}

/**
 * Readback: canvas.data() returns premultiplied RGBA. Measured at 1080×1920: @napi-rs/canvas 0.1.80 returns a
 * zero-copy view (~0.1 ms; we copy it, ~3 ms, so the frame outlives the canvas); 1.0.x copies (~44 ms, the same
 * as getImageData). We unpremultiply in JS only when some pixel is translucent.
 */
function readRGBA(canvas: Canvas): Uint8Array {
  const raw = canvas.data();
  let translucent = false;
  for (let i = 3; i < raw.length; i += 4) if (raw[i] !== 255) { translucent = true; break; }
  if (!translucent) return new Uint8Array(raw);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 4) {
    const a = raw[i + 3]!;
    if (a === 255) { out[i] = raw[i]!; out[i + 1] = raw[i + 1]!; out[i + 2] = raw[i + 2]!; }
    else if (a > 0) { const k = 255 / a; out[i] = Math.min(255, Math.round(raw[i]! * k)); out[i + 1] = Math.min(255, Math.round(raw[i + 1]! * k)); out[i + 2] = Math.min(255, Math.round(raw[i + 2]! * k)); }
    out[i + 3] = a;
  }
  return out;
}

class SkiaSession implements RenderSession {
  /** media upload canvases by size; slots are reused across frames (the readback flushes all draws) */
  private pool = new Map<string, { canvas: Canvas; img: ImageData }[]>();
  constructor(readonly width: number, readonly height: number, readonly layouter: TextLayouter, readonly registry: RendererRegistry, readonly audioLevels?: (assetId: string, rate: Rate) => AudioLevelsTable | undefined) {}

  /** the output surface, reused (the readback copies its pixels) */
  private out: Surface | null = null;

  async drawFrame(list: DisplayList, frames: FrameProvider): Promise<RGBAFrame> {
    const out = (this.out ??= createSurface(this.width, this.height));
    out.clear();
    const root = scaling(this.width / list.width, this.height / list.height);
    const used = new Map<string, number>();
    const upload = (w: number, h: number, data: Uint8Array | Buffer): Canvas => {
      const key = `${w}x${h}`, n = used.get(key) ?? 0;
      used.set(key, n + 1);
      const slots = this.pool.get(key) ?? [];
      this.pool.set(key, slots);
      if (!slots[n]) {
        const canvas = createCanvas(w, h);
        slots[n] = { canvas, img: canvas.getContext('2d').createImageData(w, h) };
      }
      const slot = slots[n]!;
      slot.img.data.set(data.length === w * h * 4 ? data : data.subarray(0, w * h * 4));
      slot.canvas.getContext('2d').putImageData(slot.img, 0, 0);
      return slot.canvas;
    };
    await drawList({ frames, layouter: this.layouter, registry: this.registry, list, upload, ...(this.audioLevels ? { audioLevels: this.audioLevels } : {}) }, list, out, root);
    return { width: this.width, height: this.height, data: readRGBA(out.canvas) };
  }

  async close(): Promise<void> { this.pool.clear(); this.out = null; }
}

export const skiaRenderer: Renderer = {
  id: 'skia',
  async open(opts) {
    registerFonts(opts.fontsDir ? [BUNDLED_FONTS_DIR, opts.fontsDir] : [BUNDLED_FONTS_DIR]);
    for (const f of opts.fontAssets ?? []) registerFontAsset(f.path, f.id);
    return new SkiaSession(Math.round(opts.width), Math.round(opts.height), createTextLayouter(), opts.registry ?? EMPTY_REGISTRY, opts.audioLevels);
  },
};
