/**
 * evaluate(project, comp, frame) → DisplayList. Pure: no Skia, no ffmpeg, no fs. Text metrics come from the
 * injected layouter, effect/transition/generator definitions from the registry view.
 *
 * Time: clip keyframes (x, y, scale, ..., fx params, remap, shape.trim) use `frame - at` (split re-bases them);
 * text animations and generators use `frame - at + clock` (split carries the clock so nothing restarts).
 */
import { clipKind, type Clip, type Comp, type Cue, type ProjectFile, type TextStyle, type Track, type TransitionInstance } from '../core/schema/index.js';
import { parseRate, parseSpeed, type Rate } from '../core/time.js';
import { fail, suggest } from '../core/errors.js';
import { emphasisWords } from '../core/captions.js';
import type { PluginRegistry } from '../plugin/registry.js';
import type {
  AdjustmentNode, CaptionWord, DisplayList, DisplayNode, FilterSpec, LayerBase, LayerNode, LayerSource, Matrix, MediaSource,
  ResolvedEffect, ResolvedMask, ResolvedTextStyle, TextAnimationState, TextLayout, TextLayouter, TransitionNode, UnitState,
} from './types.js';
import { interpolate, ease, isKeyframeList } from './keyframes.js';
import { bounds, invert, multiply, rotation, scaling, translate } from './matrix.js';
import { pathBounds, pointsBounds } from './path.js';

export { interpolate, ease, easingFn, cubicBezier, EASING_FUNCTIONS } from './keyframes.js';

export type PluginRegistryView = Pick<PluginRegistry, 'effects' | 'transitions' | 'generators' | 'textAnimations' | 'styles'>;

export interface MediaFacts {
  width?: number;
  height?: number;
  /** seconds */
  duration?: number;
}

export interface EvaluateOptions {
  layouter: TextLayouter;
  registry: PluginRegistryView;
  assetKind(assetId: string): 'video' | 'image' | 'audio';
  /** probed facts of an asset, when known (size for fit/box, duration to hold the last frame) */
  media?(assetId: string): MediaFacts | undefined;
}

export const STYLE_DEFAULTS = { font: 'Inter', size: 72, color: '#ffffff', align: 'center', lineHeight: 1.2, letterSpacing: 0, weight: 700 } as const;
const DEFAULT_STAGGER = { char: 1, word: 3, line: 6, all: 0 } as const;
const DEFAULT_ANIM_LEN = 12;
const MAX_DEPTH = 16;

// ---------------------------------------------------------------- index

interface Index {
  p: ProjectFile;
  comps: Map<string, Comp>;
  tracksByComp: Map<string, Track[]>;
  clips: Map<string, Clip>;
  clipsByTrack: Map<string, Clip[]>;
  trackOf: Map<string, Track>;
  cuesByClip: Map<string, Cue[]>;
  layouts: Map<string, TextLayout>;
}

function buildIndex(p: ProjectFile): Index {
  const comps = new Map(p.comps.map((c) => [c.id, c]));
  const tracksByComp = new Map<string, Track[]>();
  const trackOf = new Map<string, Track>();
  for (const t of p.tracks ?? []) {
    trackOf.set(t.id, t);
    const l = tracksByComp.get(t.comp) ?? [];
    l.push(t);
    tracksByComp.set(t.comp, l);
  }
  const clipsByTrack = new Map<string, Clip[]>();
  for (const c of p.clips ?? []) {
    const l = clipsByTrack.get(c.track) ?? [];
    l.push(c);
    clipsByTrack.set(c.track, l);
  }
  for (const l of clipsByTrack.values()) l.sort((a, b) => a.at - b.at);
  const cuesByClip = new Map<string, Cue[]>();
  for (const q of p.cues ?? []) {
    const l = cuesByClip.get(q.clip) ?? [];
    l.push(q);
    cuesByClip.set(q.clip, l);
  }
  for (const l of cuesByClip.values()) l.sort((a, b) => a.at - b.at);
  return { p, comps, tracksByComp, clips: new Map((p.clips ?? []).map((c) => [c.id, c])), clipsByTrack, trackOf, cuesByClip, layouts: new Map() };
}

interface Ctx {
  ix: Index;
  opts: EvaluateOptions;
  comp: Comp;
  rate: Rate;
  W: number;
  H: number;
  depth: number;
}

// ---------------------------------------------------------------- helpers

/** A deterministic 32-bit seed from a clip id (FNV-1a). */
export function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** floor(a·b·… / (c·d·…)) exactly (BigInt), for rational time maps. */
function floorRatio(num: number[], den: number[]): number {
  const n = num.reduce((x, y) => x * BigInt(Math.trunc(y)), 1n), d = den.reduce((x, y) => x * BigInt(Math.trunc(y)), 1n);
  let q = n / d;
  if ((n % d !== 0n) && ((n < 0n) !== (d < 0n))) q -= 1n;
  return Number(q);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function compLength(p: ProjectFile, compId: string): number {
  const comp = p.comps.find((c) => c.id === compId);
  if (comp && typeof comp.length === 'number') return comp.length;
  const tracks = new Set((p.tracks ?? []).filter((t) => t.comp === compId).map((t) => t.id));
  return (p.clips ?? []).reduce((m, c) => (tracks.has(c.track) ? Math.max(m, c.at + c.len) : m), 0);
}

export function fitBox(sw: number, sh: number, W: number, H: number, fit: 'contain' | 'cover' | 'fill' | 'none'): { w: number; h: number } {
  if (fit === 'fill') return { w: W, h: H };
  if (fit === 'none') return { w: sw, h: sh };
  const s = fit === 'contain' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
  return { w: sw * s, h: sh * s };
}

// ---------------------------------------------------------------- styles

type StyleFields = Omit<TextStyle, 'base'> & { base?: string };

/**
 * Resolve a clip's style: a style id (project styles, with base chains, then the registry's built-in styles)
 * or an inline object (its `base` first, then its fields), over the defaults.
 */
export function resolveStyle(style: string | TextStyle | undefined, project: ProjectFile, registryStyles: PluginRegistryView['styles'], defaults: Partial<TextStyle> = {}): ResolvedTextStyle {
  const fromId = (id: string, seen: Set<string>): Record<string, unknown> => {
    if (seen.has(id)) fail('E_CYCLE', `style "${id}" inherits from itself (${[...seen, id].join(' → ')}).`, `remove "base" from one of the styles ${[...seen].join(', ')}.`);
    seen.add(id);
    const own = project.styles?.find((s) => s.id === id) as (StyleFields & { id?: string }) | undefined;
    const fields = (own ?? (registryStyles.get(id)?.style as StyleFields | undefined));
    if (!fields) {
      const known = [...(project.styles ?? []).map((s) => s.id), ...registryStyles.keys()];
      const dym = suggest(id, known);
      return fail('E_REF', `style "${id}" does not exist.`, dym.length ? `did you mean "${dym[0]}"?` : `add {"id": "${id}", ...} to "styles" or use one of ${known.slice(0, 8).join(', ')}.`);
    }
    const { id: _id, base, ...rest } = fields as StyleFields & { id?: string };
    return { ...(base ? fromId(base, seen) : {}), ...defined(rest) };
  };
  let resolved: Record<string, unknown> = {};
  if (typeof style === 'string') resolved = fromId(style, new Set());
  else if (style) {
    const { base, ...rest } = style;
    resolved = { ...(base ? fromId(base, new Set()) : {}), ...defined(rest) };
  }
  return { ...STYLE_DEFAULTS, ...defined(defaults), ...resolved } as ResolvedTextStyle;
}

function defined(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function padOf(st: ResolvedTextStyle): [number, number] {
  if (!st.bg) return [0, 0];
  const p = st.bgPadding ?? Math.round(st.size * 0.25);
  return Array.isArray(p) ? [p[0], p[1]] : [p, p];
}

// ---------------------------------------------------------------- public entry points

export function evaluate(project: ProjectFile, compId: string, frame: number, opts: EvaluateOptions): DisplayList {
  return evalComp(buildIndex(project), compId, frame, opts, 0);
}

export interface LayerBox { clipId: string; kind: string; box: [number, number, number, number]; text?: string; fontPx?: number }

/** Per-layer axis-aligned boxes in comp px at a frame (for QA): every layer node, including both sides of a transition. */
export function evaluateLayers(project: ProjectFile, compId: string, frame: number, opts: EvaluateOptions): LayerBox[] {
  return layerBoxes(evaluate(project, compId, frame, opts).nodes, opts);
}

export function layerBoxes(nodes: DisplayNode[], opts?: Pick<EvaluateOptions, 'layouter'>): LayerBox[] {
  const out: LayerBox[] = [];
  const walk = (ns: DisplayNode[]) => {
    for (const n of ns) {
      if (n.type === 'transition') { walk(n.from); walk(n.to); continue; }
      const b: LayerBox = { clipId: n.clipId, kind: n.type === 'adjustment' ? 'adjustment' : n.source.type === 'media' ? n.source.kind : n.source.type, box: bounds(n.matrix, n.box.w, n.box.h) };
      if (n.type === 'layer' && (n.source.type === 'text' || n.source.type === 'captions')) {
        b.text = n.source.text;
        const sx = Math.hypot(n.matrix[0], n.matrix[1]), sy = Math.hypot(n.matrix[2], n.matrix[3]);
        const size = opts ? opts.layouter.layout(n.source.text, n.source.style).size : n.source.style.size;
        b.fontPx = size * Math.min(sx, sy);
      }
      out.push(b);
    }
  };
  walk(nodes);
  return out;
}

// ---------------------------------------------------------------- comp

function evalComp(ix: Index, compId: string, frame: number, opts: EvaluateOptions, depth: number): DisplayList {
  const comp = ix.comps.get(compId);
  if (!comp) {
    const dym = suggest(compId, ix.comps.keys());
    fail('E_REF', `comp "${compId}" does not exist.`, dym.length ? `did you mean "${dym[0]}"?` : `use one of ${[...ix.comps.keys()].join(', ')}.`);
  }
  if (depth > MAX_DEPTH) fail('E_CYCLE', `comps are nested more than ${MAX_DEPTH} deep at "${compId}".`, 'remove the nesting cycle (a comp clip that contains its own comp).');
  const cx: Ctx = { ix, opts, comp, rate: parseRate(comp.fps), W: comp.size[0], H: comp.size[1], depth };
  const tracks = ix.tracksByComp.get(compId) ?? [];
  const hiddenMattes = new Set<string>();
  for (const t of tracks) for (const c of ix.clipsByTrack.get(t.id) ?? []) if (c.matte && !c.matte.keep) hiddenMattes.add(c.matte.clip);
  const nodes: DisplayNode[] = [];
  for (const t of tracks) {
    if (t.audio || t.hidden) continue;
    const clips = (ix.clipsByTrack.get(t.id) ?? []).filter((c) => !c.hidden && !hiddenMattes.has(c.id));
    const node = trackNode(cx, clips, frame);
    if (node) nodes.push(node);
  }
  const list: DisplayList = { compId, width: cx.W, height: cx.H, frame, rate: cx.rate, nodes };
  if (comp.bg) list.bg = comp.bg;
  return list;
}

/** Transition window [start, end) around a cut. */
function windowAt(cut: number, len: number, align: 'center' | 'start' | 'end' = 'center'): [number, number] {
  if (align === 'start') return [cut, cut + len];
  if (align === 'end') return [cut - len, cut];
  return [cut - Math.floor(len / 2), cut + Math.ceil(len / 2)];
}

function trackNode(cx: Ctx, clips: Clip[], frame: number): DisplayNode | null {
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    const prev = i > 0 && clips[i - 1]!.at + clips[i - 1]!.len === c.at ? clips[i - 1]! : undefined;
    const next = i + 1 < clips.length && c.at + c.len === clips[i + 1]!.at ? clips[i + 1]! : undefined;
    const tin = c.transition?.in ?? prev?.transition?.out;
    if (tin && tin.len > 0) {
      const [s, e] = prev ? windowAt(c.at, tin.len, tin.align) : [c.at, c.at + tin.len];
      if (frame >= s && frame < e) return transitionNode(cx, c.id, tin, prev, c, (frame - s) / tin.len, frame);
    }
    const tout = c.transition?.out;
    if (tout && !next && tout.len > 0) {
      const end = c.at + c.len, s = end - tout.len;
      if (frame >= s && frame < end) return transitionNode(cx, c.id, tout, c, undefined, (frame - s) / tout.len, frame);
    }
  }
  const c = clips.find((x) => frame >= x.at && frame < x.at + x.len);
  return c ? clipNode(cx, c, frame, new Set()) : null;
}

function transitionNode(cx: Ctx, clipId: string, tr: TransitionInstance, from: Clip | undefined, to: Clip | undefined, progress: number, frame: number): TransitionNode {
  const def = cx.opts.registry.transitions.get(tr.type);
  if (!def) {
    const dym = suggest(tr.type, cx.opts.registry.transitions.keys());
    fail('E_UNKNOWN_TRANSITION', `clip "${clipId}": transition "${tr.type}" does not exist.`, dym.length ? `did you mean "${dym[0]}"?` : `use one of ${[...cx.opts.registry.transitions.keys()].join(', ') || '(none registered)'}.`);
  }
  const { type, len: _l, align: _a, ...raw } = tr;
  const params = parseParams(def.params, raw, `clip "${clipId}" transition "${type}"`);
  const side = (c: Clip | undefined) => {
    const n = c ? clipNode(cx, c, frame, new Set()) : null;
    return n ? [n] : [];
  };
  return { type: 'transition', clipId, transition: { type, params }, progress: clamp01(progress), from: side(from), to: side(to) };
}

function parseParams(schema: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: { path: PropertyKey[]; message: string }[] } } }, raw: Record<string, unknown>, what: string): Record<string, unknown> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const iss = r.error!.issues[0]!;
    const key = iss.path.map(String).join('.');
    fail('E_PARAMS', `${what}: ${key ? `"${key}" ` : ''}${iss.message}.`, `fix the parameter${key ? ` "${key}"` : ''} (see "mgl docs ${what.split('"')[3] ?? 'effects'}").`);
  }
  return (r.data ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------- clips



/** Default anchor height: captions sit in the lower third (above platform UI on vertical video), everything else centred. */
export function defaultY(c: Clip, W: number, H: number): number {
  if (c.captions) return Math.round(H * (H > W ? 0.68 : 0.85));
  return H / 2;
}

/** The clip's own transform at a frame (no parent): T(x,y)·R·S·T(-anchor·box). */
function localMatrix(cx: Ctx, c: Clip, t: number, box: { w: number; h: number }): Matrix {
  const x = interpolate(c.x ?? cx.W / 2, t) as number;
  const y = interpolate(c.y ?? defaultY(c, cx.W, cx.H), t) as number;
  const sv = interpolate(c.scale ?? 1, t) as number | [number, number];
  const [sx, sy] = Array.isArray(sv) ? sv : [sv, sv];
  const r = interpolate(c.rotate ?? 0, t) as number;
  const [ax, ay] = c.anchor ?? [0.5, 0.5];
  return multiply(multiply(multiply(translate(x, y), rotation(r)), scaling(sx, sy)), translate(-ax * box.w, -ay * box.h));
}

/**
 * Parenting: a child's own values place it in comp px while its parent is at rest (the parent's first frame);
 * the parent's motion since then (position, rotation around its anchor, scale) carries the child along.
 */
function parentDelta(cx: Ctx, c: Clip, frame: number, seen: Set<string>): Matrix {
  if (!c.parent) return [1, 0, 0, 1, 0, 0];
  const p = cx.ix.clips.get(c.parent);
  if (!p || seen.has(p.id)) return [1, 0, 0, 1, 0, 0];
  seen.add(p.id);
  const world = (f: number) => multiply(parentDelta(cx, p, f, new Set(seen)), localMatrix(cx, p, f - p.at, clipBox(cx, p, f - p.at)));
  return multiply(world(frame), invert(world(p.at)));
}

function clipBox(cx: Ctx, c: Clip, t: number): { w: number; h: number } {
  const kind = clipKind(c);
  switch (kind) {
    case 'media': return mediaBox(cx, c);
    case 'text': {
      const st = textStyle(cx, c);
      const l = layout(cx, c.text!, st);
      const [px, py] = padOf(st);
      return { w: l.w + 2 * px, h: l.h + 2 * py };
    }
    case 'shape': return shapeBox(c);
    case 'comp': {
      const cc = cx.ix.comps.get(c.comp!);
      return cc ? { w: cc.size[0], h: cc.size[1] } : { w: cx.W, h: cx.H };
    }
    case 'gen': {
      const def = cx.opts.registry.generators.get(c.gen!.type);
      if (def?.size) {
        const [w, h] = def.size(genParams(cx, c, t), { width: cx.W, height: cx.H });
        return { w, h };
      }
      return { w: cx.W, h: cx.H };
    }
    case 'captions': {
      const cap = captionsAt(cx, c, t);
      if (!cap) return { w: 0, h: 0 };
      const l = layout(cx, cap.text, cap.style);
      const [px, py] = padOf(cap.style);
      return { w: l.w + 2 * px, h: l.h + 2 * py };
    }
    default: return { w: cx.W, h: cx.H };
  }
}

/**
 * A shape's layer box: its size; else, for points and SVG paths, the extent of the geometry from the shape origin
 * (the bounding box's right and bottom edges, so shape-local coordinates stay layer px); else 200 × 200.
 */
export function shapeBox(c: Pick<Clip, 'shape'>): { w: number; h: number } {
  const s = c.shape!;
  if (s.size) return { w: s.size[0], h: s.size[1] };
  const b = s.points?.length && s.type !== 'path' ? pointsBounds(s.points) : s.type === 'path' && s.d ? pathBounds(s.d) : null;
  if (b) return { w: Math.max(1, b.x + b.w), h: Math.max(1, b.y + b.h) };
  return { w: 200, h: 200 };
}

function mediaFit(cx: Ctx, c: Clip): 'contain' | 'cover' | 'fill' | 'none' {
  return c.fit ?? (cx.opts.assetKind(c.asset!) === 'image' ? 'contain' : 'cover');
}

function mediaBox(cx: Ctx, c: Clip): { w: number; h: number } {
  const info = cx.opts.media?.(c.asset!);
  if (!info?.width || !info.height) return { w: cx.W, h: cx.H };
  const [l, tp, r, b] = c.crop ?? [0, 0, 0, 0];
  const sw = Math.max(1, info.width - l - r), sh = Math.max(1, info.height - tp - b);
  return fitBox(sw, sh, cx.W, cx.H, mediaFit(cx, c));
}

function textStyle(cx: Ctx, c: Clip): ResolvedTextStyle {
  const st = c.style ?? (c.captions && cx.opts.registry.styles.has('caption') ? 'caption' : undefined);
  // text wraps inside the frame by default: on vertical video a centred line stays clear of the platform UI on
  // the right (Shorts/TikTok/Reels safe area ≈ 6–83 % of the width); styles and clips can set their own maxWidth
  const maxWidth = Math.round(cx.W * (cx.H > cx.W ? 0.64 : 0.86));
  return resolveStyle(st, cx.ix.p, cx.opts.registry.styles, { maxWidth });
}

function layout(cx: Ctx, text: string, st: ResolvedTextStyle): TextLayout {
  const key = text + '\u0000' + JSON.stringify(st);
  let l = cx.ix.layouts.get(key);
  if (!l) cx.ix.layouts.set(key, (l = cx.opts.layouter.layout(text, st)));
  return l;
}

function genParams(cx: Ctx, c: Clip, t: number): Record<string, unknown> {
  const { type, ...raw } = c.gen!;
  const def = cx.opts.registry.generators.get(type);
  if (!def) {
    const dym = suggest(type, cx.opts.registry.generators.keys());
    fail('E_UNKNOWN_GENERATOR', `clip "${c.id}": generator "${type}" does not exist.`, dym.length ? `did you mean "${dym[0]}"?` : `use one of ${[...cx.opts.registry.generators.keys()].join(', ') || '(none registered)'}.`);
  }
  const vals = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, interpolate(v as never, t)]));
  return parseParams(def.params, vals, `clip "${c.id}" generator "${type}"`);
}

function resolveFx(cx: Ctx, c: Clip, t: number, media: boolean): { fx: ResolvedEffect[]; filters: FilterSpec[] } {
  const fx: ResolvedEffect[] = [], filters: FilterSpec[] = [];
  for (const e of c.fx ?? []) {
    if (e.enabled === false) continue;
    const def = cx.opts.registry.effects.get(e.type);
    if (!def) {
      const dym = suggest(e.type, cx.opts.registry.effects.keys());
      fail('E_UNKNOWN_EFFECT', `clip "${c.id}": effect "${e.type}" does not exist.`, dym.length ? `did you mean "${dym[0]}"?` : `use one of ${[...cx.opts.registry.effects.keys()].join(', ') || '(none registered)'}.`);
    }
    const { type, id, enabled: _e, ...raw } = e;
    const vals = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, interpolate(v as never, t)]));
    const params = parseParams(def.params, vals, `clip "${c.id}" effect "${type}"`);
    // keyframed params change the decoder's filter every frame: run those at the layer stage when the effect has one
    const animated = Object.values(raw).some((v) => isKeyframeList(v));
    if (media && def.source && !(animated && def.draw)) filters.push(...def.source(params as never));
    else if (def.draw) fx.push(id ? { type, params, id } : { type, params });
    else if (!media) {
      // no layer stage: on anything but a media clip the effect would silently do nothing
      const kind = clipKind(c);
      const stage = def.source ? 'a source-stage effect (it runs while a media clip is decoded)' : def.audio ? 'an audio effect' : 'an effect with no layer stage';
      const idx = (c.fx ?? []).indexOf(e);
      fail('E_FX_STAGE', `clip "${c.id}" (${kind}): effect "${type}" is ${stage}, so it has no effect on this clip.`,
        kind === 'adjustment' && def.source
          ? `put it on the media clips below instead (mgl edit <file> fx.add <clip> type=${type} ...) and remove it here: mgl edit <file> fx.remove ${c.id} fx=${idx}.`
          : `remove it: mgl edit <file> fx.remove ${c.id} fx=${idx}${def.source ? `, or add it to a video/image clip` : ''}.`);
    }
  }
  return { fx, filters };
}

type Box4 = [number, number, number, number];

/** A mask's box at clip-local frame t: a constant [x, y, w, h] or keyframes [[frame, [x, y, w, h], ease?], ...]. */
export function maskBoxAt(box: unknown, t: number): Box4 | undefined {
  if (box === undefined || box === null) return undefined;
  const v = interpolate(box as Box4 | [number, Box4][], t);
  return Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number') ? (v as Box4) : undefined;
}

function resolveMasks(c: Clip, box: { w: number; h: number }, t: number): ResolvedMask[] {
  return (c.masks ?? []).map((m0) => {
    const b = maskBoxAt((m0 as { box?: unknown }).box, t);
    const m = { ...m0 } as ResolvedMask;
    if (b) m.box = b; else delete m.box;
    if (m.space !== 'clip' || !b) return m;
    const [x, y, w, h] = b;
    return { ...m, box: [x * box.w, y * box.h, w * box.w, h * box.h] as Box4 };
  });
}

function fadeFactor(c: Clip, t: number): number {
  if (!c.fade) return 1;
  const [fi, fo] = c.fade;
  const tc = Math.min(c.len - 1, Math.max(0, t));
  let f = 1;
  if (fi > 0) f = Math.min(f, clamp01(tc / fi));
  if (fo > 0) f = Math.min(f, clamp01((c.len - 1 - tc) / fo));
  return f;
}

/** Evaluate one clip at a comp frame, also outside its span (transition handles). */
function clipNode(cx: Ctx, c: Clip, frame: number, matteSeen: Set<string>): LayerNode | AdjustmentNode | null {
  const t = frame - c.at;
  const lf = t + (c.clock ?? 0);
  const kind = clipKind(c);
  const isMedia = kind === 'media';
  if (isMedia && cx.opts.assetKind(c.asset!) === 'audio') return null;
  const box = clipBox(cx, c, t);
  const matrix = multiply(parentDelta(cx, c, frame, new Set([c.id])), localMatrix(cx, c, t, box));
  const opacity = clamp01(interpolate(c.opacity ?? 1, t) as number) * fadeFactor(c, t);
  const { fx, filters } = resolveFx(cx, c, t, isMedia);
  const base: LayerBase = { clipId: c.id, box, matrix, opacity, blend: c.blend ?? 'normal', fx, masks: resolveMasks(c, box, t), localFrame: lf, seed: seedOf(c.id) };
  if (kind === 'adjustment') return { type: 'adjustment', ...base };

  let source: LayerSource;
  switch (kind) {
    case 'media': source = mediaSource(cx, c, t, filters); break;
    case 'text': {
      const style = textStyle(cx, c);
      source = { type: 'text', text: c.text!, style };
      const anim = textAnimation(cx, c, lf, layout(cx, c.text!, style));
      if (anim) source.animate = anim;
      break;
    }
    case 'shape': {
      const sh = c.shape! as typeof c.shape & { trimStart?: unknown; trimOffset?: unknown };
      const shape: LayerSource & { type: 'shape' } = { type: 'shape', shape: c.shape! };
      if (sh.trim !== undefined) shape.trim = clamp01(interpolate(sh.trim, t) as number);
      if (sh.trimStart !== undefined) shape.trimStart = clamp01(interpolate(sh.trimStart as number, t) as number);
      if (sh.trimOffset !== undefined) shape.trimOffset = interpolate(sh.trimOffset as number, t) as number;
      source = shape;
      break;
    }
    case 'solid': source = { type: 'solid', color: c.color! }; break;
    case 'comp': source = { type: 'comp', list: nestedList(cx, c, t) }; break;
    case 'gen': {
      const params = genParams(cx, c, t);
      const gen: LayerSource & { type: 'gen' } = { type: 'gen', gen: c.gen!, params, frame: lf, time: (lf * cx.rate.den) / cx.rate.num };
      const follows = cx.opts.registry.generators.get(c.gen!.type)?.audioSource?.(params as never);
      if (follows) {
        const sp = parseSpeed(c.speed ?? 1);
        // the clip's own clock (lf = t + clock: set by split/head trim) so a later piece continues the sound
        gen.audio = { assetId: follows, frame: Math.max(0, (c.in ?? 0) + (sp.num === 0 ? 0 : floorRatio([lf, sp.num], [sp.den]))) };
      }
      source = gen;
      break;
    }
    case 'captions': {
      const cap = captionsAt(cx, c, t);
      if (!cap) return null;
      source = { type: 'captions', text: cap.text, style: cap.style, words: cap.words, cueId: cap.cueId };
      break;
    }
    default: return null;
  }
  const node: LayerNode = { type: 'layer', ...base, source };
  if (c.matte && !matteSeen.has(c.id)) {
    const mc = cx.ix.clips.get(c.matte.clip);
    const mode = c.matte.mode ?? 'alpha';
    const active = mc && frame >= mc.at && frame < mc.at + mc.len;
    const mn = active ? clipNode(cx, mc, frame, new Set([...matteSeen, c.id])) : null;
    if (mn && mn.type === 'layer') node.matte = { node: mn, mode };
    else if (!mode.endsWith('inverted')) return null; // nothing to show through
  }
  return node;
}

function mediaSource(cx: Ctx, c: Clip, t: number, filters: FilterSpec[]): MediaSource {
  const kind = cx.opts.assetKind(c.asset!) === 'image' ? 'image' : 'video';
  const asset = cx.ix.p.assets?.find((a) => a.id === c.asset);
  const info = cx.opts.media?.(c.asset!);
  let sf = 0;
  if (kind === 'video') {
    if (c.remap !== undefined) sf = Math.floor(interpolate(c.remap, t) as number);
    else {
      const sp = parseSpeed(c.speed ?? 1);
      sf = (c.in ?? 0) + (sp.num === 0 ? 0 : floorRatio([t, sp.num], [sp.den]));
    }
    if (info?.duration !== undefined) {
      const frames = Math.max(1, Math.floor((info.duration * cx.rate.num) / cx.rate.den));
      sf = c.loop ? ((sf % frames) + frames) % frames : Math.min(sf, frames - 1);
    }
    sf = Math.max(0, sf);
  }
  const src: MediaSource = { type: 'media', assetId: c.asset!, src: asset?.src ?? c.asset!, kind, sourceFrame: sf, rate: cx.rate, filters, fit: mediaFit(cx, c) };
  if (c.crop) src.crop = c.crop;
  if (info?.width && info.height) src.size = { w: info.width, h: info.height };
  return src;
}

function nestedList(cx: Ctx, c: Clip, t: number): DisplayList | null {
  const child = cx.ix.comps.get(c.comp!);
  if (!child) return null;
  const cr = parseRate(child.fps);
  const sp = parseSpeed(c.speed ?? 1);
  let f = (c.in ?? 0) + (sp.num === 0 ? 0 : floorRatio([t, sp.num, cr.num, cx.rate.den], [sp.den, cr.den, cx.rate.num]));
  const len = compLength(cx.ix.p, child.id);
  if (f < 0) f = 0;
  if (f >= len) {
    if (!c.loop || len <= 0) return null;
    f %= len;
  }
  return evalComp(cx.ix, child.id, f, cx.opts, cx.depth + 1);
}

// ---------------------------------------------------------------- text animation

function unitCount(l: TextLayout, by: 'char' | 'word' | 'line' | 'all'): number {
  if (by === 'all') return 1;
  if (by === 'line') return l.lines.length;
  if (by === 'word') return l.words.length;
  return l.words.reduce((n, w) => n + [...w.text].length, 0);
}

/**
 * The clock frame where a clip's animation ends: its own end, or, when split pieces follow it (the next clip on
 * the track starts at its end and carries the clock on: clock = this clock + len, as clip.split writes), the end
 * of the last piece, so the out animation plays once, at the end of the original clip, not at each cut.
 */
function animEnd(cx: Ctx, c: Clip): number {
  let cur = c, end = (c.clock ?? 0) + c.len;
  const seen = new Set<string>([c.id]);
  for (;;) {
    const next = (cx.ix.clipsByTrack.get(cur.track) ?? []).find((x) => x.at === cur.at + cur.len && !x.hidden && !seen.has(x.id));
    if (!next || (next.clock ?? 0) !== end || next.text !== c.text) return end;
    seen.add(next.id);
    cur = next;
    end = (next.clock ?? 0) + next.len;
  }
}

function textAnimation(cx: Ctx, c: Clip, lf: number, l: TextLayout): TextAnimationState | undefined {
  const a = c.animate;
  if (!a || (!a.in && !a.out)) return undefined;
  const by = a.by ?? 'word';
  const n = Math.max(1, unitCount(l, by));
  const stagger = a.stagger ?? DEFAULT_STAGGER[by];
  const len = Math.max(1, a.len ?? DEFAULT_ANIM_LEN);
  const get = (id: string) => {
    const d = cx.opts.registry.textAnimations.get(id);
    if (!d) {
      const dym = suggest(id, cx.opts.registry.textAnimations.keys());
      fail('E_UNKNOWN_ANIMATION', `clip "${c.id}": text animation "${id}" does not exist.`, dym.length ? `did you mean "${dym[0]}"?` : `use one of ${[...cx.opts.registry.textAnimations.keys()].join(', ') || '(none registered)'}.`);
    }
    return d;
  };
  const inDef = a.in ? get(a.in) : undefined, outDef = a.out ? get(a.out) : undefined;
  const end = animEnd(cx, c);
  const outStart = end - len - (n - 1) * stagger;
  const units: UnitState[] = [];
  for (let i = 0; i < n; i++) {
    let s: ReturnType<NonNullable<typeof inDef>['state']> = {};
    if (inDef) s = inDef.state(ease(inDef.easing ?? 'outCubic', (lf - i * stagger) / len));
    if (outDef) {
      const p = (lf - (outStart + i * stagger)) / len;
      if (p > 0) s = outDef.state(1 - ease(outDef.easing ?? 'inCubic', p));
    }
    const u: UnitState = { opacity: clamp01(s.opacity ?? 1), dx: s.dx ?? 0, dy: s.dy ?? 0, scale: s.scale ?? 1, rotate: s.rotate ?? 0 };
    if (s.blur) u.blur = s.blur;
    units.push(u);
  }
  return { by, units };
}

// ---------------------------------------------------------------- captions

function captionsAt(cx: Ctx, c: Clip, t: number): { text: string; style: ResolvedTextStyle; words: CaptionWord[]; cueId: string } | null {
  // the latest-starting active cue wins when cues overlap
  const q = (cx.ix.cuesByClip.get(c.id) ?? []).findLast((x) => t >= x.at && t < x.at + x.len);
  if (!q) return null;
  const style = textStyle(cx, c);
  const marked = emphasisWords(q.text);
  const all = marked.map((w) => w.text);
  if (!all.length) return null;
  const offs = q.words && q.words.length === all.length ? q.words : all.map((_, i) => Math.floor((i * q.len) / all.length));
  const rel = t - q.at;
  let active = -1;
  for (let i = 0; i < offs.length; i++) if (offs[i]! <= rel) active = i;
  let from = 0, to = all.length;
  if (style.maxWords && all.length > style.maxWords) {
    // balanced pages of at most maxWords (4 words at 3 → 2 + 2, 7 at 3 → 3 + 2 + 2): never one word left alone
    const pages = Math.ceil(all.length / style.maxWords), base = Math.floor(all.length / pages), extra = all.length % pages;
    const cur = Math.max(0, active);
    for (let k = 0, start = 0; k < pages; k++) {
      const size = base + (k < extra ? 1 : 0);
      if (cur < start + size || k === pages - 1) { from = start; to = start + size; break; }
      start += size;
    }
  }
  const words: CaptionWord[] = [];
  for (let i = from; i < to; i++) {
    const start = offs[i]!, end = i + 1 < offs.length ? offs[i + 1]! : q.len;
    words.push({ text: all[i]!, state: i < active ? 'past' : i === active ? 'active' : 'future', progress: i === active ? clamp01((rel - start) / Math.max(1, end - start)) : i < active ? 1 : 0, ...(marked[i]!.emphasis ? { emphasis: true } : {}) });
  }
  return { text: words.map((w) => w.text).join(' '), style, words, cueId: q.id };
}
