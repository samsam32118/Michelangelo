/**
 * Retention and legibility checks (public plugin API only): static-visuals, low-contrast, edge-gap.
 *
 * - static-visuals (project): in a vertical (9:16) social comp, a stretch over 2.5 s where nothing big moves or
 *   changes (no video, no keyframed motion, no cut, no animated generator). Fix: a slow punch-in on the dominant layer.
 * - low-contrast (frame): rendered text against the pixels behind it under the WCAG 3:1 (large text) ratio, with no
 *   outline, plate or shadow that separates it. Fix: a contrasting stroke (titles) or a translucent plate (small text).
 * - edge-gap (project): a picture layer meant to fill the frame (covers ≥ 80 %) that is zoomed out or moved so part
 *   of the frame shows the comp background. Fix: the smallest scale that covers the frame again.
 *
 * Every fix is a single `mgl edit` command whose result makes the finding disappear (so `--fix` converges).
 */
import { defineCheck, type CheckContext, type Finding } from '../../plugin/api.js';

type Project = CheckContext['project'];
type Clip = NonNullable<Project['clips']>[number];
type Box = [number, number, number, number];
type Layer = NonNullable<CheckContext['layers']> extends Map<number, (infer L)[]> ? L : never;
type Img = NonNullable<CheckContext['frames']> extends Map<number, infer I> ? I : never;

// ------------------------------------------------------------------------------------------- helpers

const fpsOf = (fps: number | string) => {
  if (typeof fps === 'number') return fps;
  const [n, d] = fps.split('/').map(Number);
  return d ? n! / d : n!;
};
const sec = (f: number, fps: number) => `${(f / fps).toFixed(2)}s`;
const area = (b: Box) => Math.max(0, b[2]) * Math.max(0, b[3]);
function intersect(a: Box, b: Box): Box {
  const x = Math.max(a[0], b[0]), y = Math.max(a[1], b[1]);
  return [x, y, Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x), Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y)];
}
const keyed = (v: unknown): v is [number, unknown, unknown?][] => Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);
const quote = (t: string | undefined) => (t === undefined ? '' : `"${t.length > 24 ? t.slice(0, 23) + '…' : t}" `);

interface Comp { id: string; W: number; H: number; fps: number; length: number; clips: Clip[]; visual: Set<string> }

function compOf(ctx: CheckContext): Comp {
  const c = ctx.project.comps.find((x) => x.id === ctx.compId) ?? ctx.project.comps[0]!;
  const tracks = (ctx.project.tracks ?? []).filter((t) => t.comp === c.id);
  const ids = new Set(tracks.map((t) => t.id));
  const visual = new Set(tracks.filter((t) => !t.audio && !t.hidden).map((t) => t.id));
  const clips = (ctx.project.clips ?? []).filter((x) => ids.has(x.track));
  const length = typeof c.length === 'number' ? c.length : clips.reduce((m, x) => Math.max(m, x.at + x.len), 0);
  return { id: c.id, W: c.size[0], H: c.size[1], fps: fpsOf(c.fps), length, clips, visual };
}

const ASSET_IMAGE = /\.(png|jpe?g|webp|gif|bmp|svg|tiff?|avif)(\?.*)?$/i;
const ASSET_AUDIO = /\.(wav|mp3|m4a|aac|opus|ogg|flac)(\?.*)?$/i;
function assetKind(p: Project, id: string | undefined): 'video' | 'image' | 'audio' | 'other' | undefined {
  const a = (p.assets ?? []).find((x) => x.id === id);
  if (!a) return undefined;
  if (a.kind) return a.kind === 'video' || a.kind === 'image' || a.kind === 'audio' ? a.kind : 'other';
  return ASSET_IMAGE.test(a.src) ? 'image' : ASSET_AUDIO.test(a.src) ? 'audio' : 'video';
}

/** What a clip draws: video, image, text, captions, shape, solid, comp, gen, adjustment, audio. */
function clipKind(p: Project, x: Clip): string {
  if (x.asset !== undefined) return assetKind(p, x.asset) ?? 'video';
  if (x.text !== undefined) return 'text';
  if (x.captions) return 'captions';
  if (x.shape) return 'shape';
  if (x.color !== undefined) return 'solid';
  if (x.comp !== undefined) return 'comp';
  if (x.gen) return 'gen';
  if (x.adjustment) return 'adjustment';
  return 'other';
}

/** Layer boxes from look (`layers`) and the project stage (`sampled`), by frame. */
function allLayers(ctx: CheckContext): [number, Layer[]][] {
  const m = new Map<number, Layer[]>(ctx.sampled ?? []);
  for (const [f, ls] of ctx.layers ?? []) m.set(f, ls);
  return [...m].sort((a, b) => a[0] - b[0]);
}

function speedOf(x: Clip): number {
  const s = x.speed;
  if (s === undefined) return 1;
  if (typeof s === 'number') return s;
  const [n, d] = s.split('/').map(Number);
  return d ? n! / d : n!;
}

function inFade(clip: Clip, f: number): boolean {
  const s = f - clip.at, e = clip.at + clip.len - f;
  const fi = Math.max(clip.fade?.[0] ?? 0, clip.transition?.in?.len ?? 0), fo = Math.max(clip.fade?.[1] ?? 0, clip.transition?.out?.len ?? 0);
  return s < fi || e <= fo;
}

// ------------------------------------------------------------------------------------------- colours

const NAMED: Record<string, [number, number, number]> = { white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], yellow: [255, 255, 0], gray: [128, 128, 128], grey: [128, 128, 128] };

/** "#rgb[a]", "#rrggbb[aa]", rgb()/rgba() or a few names → [r, g, b, a 0..1]; undefined when unknown. */
export function parseRgba(s: string | undefined): [number, number, number, number] | undefined {
  if (!s) return undefined;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
    if (h.length !== 6 && h.length !== 8) return undefined;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(s);
  if (fn) {
    const v = fn[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    if (v.length < 3 || v.slice(0, 3).some((n) => !Number.isFinite(n))) return undefined;
    return [v[0]!, v[1]!, v[2]!, v[3] === undefined || !Number.isFinite(v[3]) ? 1 : v[3]];
  }
  if (s === 'transparent') return [0, 0, 0, 0];
  const n = NAMED[s.toLowerCase()];
  return n ? [...n, 1] : undefined;
}

const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
/** WCAG relative luminance of an sRGB colour. */
export const luminance = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
/** WCAG contrast ratio of two luminances (1..21). */
export const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

// ------------------------------------------------------------------------------------------- styles

interface TextLook { size: number; color?: string; stroke?: string; strokeWidth?: number; shadow?: string; bg?: string }

/**
 * Legibility fields of the built-in styles (src/builtin/text/styles.ts publishes them through the registry, which a
 * check cannot see): colour, outline, shadow and plate. Unknown style ids (from plugins) are not judged.
 */
const BUILTIN_LOOKS: Record<string, TextLook> = {
  title: { size: 120, color: '#ffffff', stroke: '#000000', strokeWidth: 8 },
  subtitle: { size: 56, color: '#ffffff', shadow: '#00000099' },
  caption: { size: 64, color: '#ffffff', stroke: '#000000', strokeWidth: 6 },
  karaoke: { size: 64, color: '#ffffff', stroke: '#000000', strokeWidth: 6 },
  pop: { size: 96, color: '#ffd400', stroke: '#000000', strokeWidth: 8 },
  boxed: { size: 56, color: '#111111', bg: '#ffffff' },
  'lower-third': { size: 56, color: '#ffffff', shadow: '#00000080' },
  cta: { size: 56, color: '#ffffff' },
  label: { size: 36, color: '#ffffff', bg: '#000000b3' },
  body: { size: 44, color: '#ffffff' },
};
const DEFAULT_LOOK: TextLook = { size: 72, color: '#ffffff' };
const LOOK_KEYS = ['size', 'color', 'stroke', 'strokeWidth', 'shadow', 'bg'] as const;

function pick(o: Record<string, unknown>): Partial<TextLook> {
  const out: Record<string, unknown> = {};
  for (const k of LOOK_KEYS) if (o[k] !== undefined) out[k] = o[k];
  return out as Partial<TextLook>;
}

/** The legibility fields of a clip's style (project styles with base chains, then the built-ins); undefined when unknown. */
export function textLook(p: Project, x: Clip): TextLook | undefined {
  const fromId = (id: string, depth: number): Partial<TextLook> | undefined => {
    if (depth > 8) return undefined;
    const own = (p.styles ?? []).find((s) => s.id === id) as (Record<string, unknown> & { base?: string }) | undefined;
    if (own) {
      const base = own.base ? fromId(own.base, depth + 1) : {};
      return base && { ...base, ...pick(own) };
    }
    return BUILTIN_LOOKS[id];
  };
  const st = x.style ?? (x.captions ? 'caption' : undefined);
  let r: Partial<TextLook> | undefined = {};
  if (typeof st === 'string') r = fromId(st, 0);
  else if (st) {
    const o = st as Record<string, unknown> & { base?: string };
    const base = o.base ? fromId(o.base, 0) : {};
    r = base && { ...base, ...pick(o) };
  }
  return r && { ...DEFAULT_LOOK, ...r };
}

// ------------------------------------------------------------------------------------------- static-visuals

const STATIC_SECONDS = 2.5;
/** Layers smaller than this share of the frame do not count as visual change (captions, stickers, small logos). */
const BIG = 0.05;

function staticGen(gen: Record<string, unknown>): boolean {
  switch (gen.type) {
    case 'gradient': return !gen.animate;
    case 'checker': case 'pattern': return !gen.speed;
    case 'noise': return gen.speed === 0;
    case 'particles': return gen.speed === 0;
    case 'smpte-bars': return true;
    default: return false; // unknown and audio-driven generators move
  }
}

/** Share of the frame a clip covers (largest sampled box; estimated from the data when it was never sampled). */
function coverage(c: Comp, x: Clip, kind: string, boxes: Map<string, Box[]>): number {
  const bs = boxes.get(x.id);
  const fr: Box = [0, 0, c.W, c.H];
  if (bs?.length) return Math.max(...bs.map((b) => area(intersect(b, fr)))) / (c.W * c.H);
  if (kind === 'video' || kind === 'image' || kind === 'solid' || kind === 'comp' || kind === 'gen') {
    const s = typeof x.scale === 'number' ? x.scale : Array.isArray(x.scale) && typeof x.scale[0] === 'number' ? (x.scale[0] as number) : 1;
    return Math.min(1, s * s);
  }
  return 0.02;
}

type Span = [number, number];

/** Comp-frame spans where a clip's own keyframes change a value (clock-aware; hold keys are instant changes). */
function keySpans(x: Clip, events: number[]): Span[] {
  const out: Span[] = [];
  const base = x.at - (x.clock ?? 0);
  const props: unknown[] = [x.x, x.y, x.scale, x.rotate, x.opacity, x.anchor];
  for (const fx of x.fx ?? []) for (const v of Object.values(fx as Record<string, unknown>)) props.push(v);
  for (const m of x.masks ?? []) props.push((m as { box?: unknown }).box);
  for (const v of props) {
    if (!keyed(v)) continue;
    for (let i = 1; i < v.length; i++) {
      const a = v[i - 1]!, b = v[i]!;
      if (JSON.stringify(a[1]) === JSON.stringify(b[1])) continue;
      if (a[2] === 'hold') events.push(base + b[0]);
      else out.push([base + a[0], base + b[0]]);
    }
  }
  return out;
}

/** Motion spans and change events of every big visual clip, from the data. */
function motionOf(ctx: CheckContext, c: Comp, boxes: Map<string, Box[]>): { motion: Span[]; events: number[]; kinds: Map<string, string>; cover: Map<string, number> } {
  const motion: Span[] = [], events: number[] = [];
  const kinds = new Map<string, string>(), cover = new Map<string, number>();
  const clips = new Map(c.clips.map((x) => [x.id, x]));
  for (const x of c.clips) {
    if (x.hidden || !c.visual.has(x.track) || x.len <= 0) continue;
    const kind = clipKind(ctx.project, x);
    if (kind === 'audio' || kind === 'adjustment' || kind === 'captions') continue;
    kinds.set(x.id, kind);
    const cv = coverage(c, x, kind, boxes);
    cover.set(x.id, cv);
    if (cv < BIG) continue;
    const end = x.at + x.len;
    events.push(x.at, end);
    if ((x as Record<string, unknown>).motion !== undefined) motion.push([x.at, end]);
    if (kind === 'video' && speedOf(x) > 0) motion.push([x.at, end]);
    else if (kind === 'video' && x.remap !== undefined) motion.push([x.at, end]);
    if (kind === 'comp') motion.push([x.at, end]); // nested comps: judged as moving (conservative)
    if (kind === 'gen' && !staticGen(x.gen as Record<string, unknown>)) motion.push([x.at, end]);
    if (kind === 'other') motion.push([x.at, end]);
    const fi = Math.max(x.fade?.[0] ?? 0, x.transition?.in?.len ?? 0), fo = Math.max(x.fade?.[1] ?? 0, x.transition?.out?.len ?? 0);
    if (fi > 0) motion.push([x.at, x.at + fi]);
    if (fo > 0) motion.push([end - fo, end]);
    if (kind === 'text' && x.animate) {
      const words = Math.min(12, String(x.text ?? '').split(/\s+/).filter(Boolean).length || 1);
      const dur = Math.round((x.animate.len as number | undefined ?? 12) + (x.animate.stagger as number | undefined ?? 3) * (words - 1));
      if (x.animate.in) motion.push([x.at, x.at + dur]);
      if (x.animate.out) motion.push([end - dur, end]);
    }
    motion.push(...keySpans(x, events).map(([a, b]) => [Math.max(x.at, a), Math.min(end, b)] as Span).filter(([a, b]) => b > a));
    // a moving parent moves its children
    let par = x.parent ? clips.get(x.parent) : undefined;
    for (let d = 0; par && d < 8; d++, par = par.parent ? clips.get(par.parent) : undefined) {
      motion.push(...keySpans(par, []).map(([a, b]) => [Math.max(x.at, a), Math.min(end, b)] as Span).filter(([a, b]) => b > a));
    }
  }
  return { motion, events, kinds, cover };
}

/** Stretches of [0, L) not covered by any motion span, split at the events. */
export function staticStretches(L: number, motion: Span[], events: number[]): Span[] {
  const moving = new Uint8Array(Math.max(0, L));
  for (const [a, b] of motion) for (let f = Math.max(0, Math.floor(a)); f < Math.min(L, Math.ceil(b)); f++) moving[f] = 1;
  const cuts = new Set(events.map((e) => Math.round(e)));
  const out: Span[] = [];
  let s = -1;
  for (let f = 0; f <= L; f++) {
    const still = f < L && !moving[f];
    if (s >= 0 && (!still || cuts.has(f))) { out.push([s, f]); s = -1; }
    if (still && s < 0) s = f;
  }
  return out;
}

/** Rank for the layer a punch-in should move: textured pictures first, then text and shapes, then generators. */
const PUNCH_RANK: Record<string, number> = { image: 3, video: 3, comp: 3, text: 2, shape: 2, gen: 1 };

function punchable(x: Clip): boolean {
  if (x.locked || x.parent) return false;
  if (keyed(x.scale) || keyed(x.x) || keyed(x.y) || keyed(x.rotate)) return false;
  if (typeof x.rotate === 'number' && x.rotate % 360 !== 0) return false;
  if (Array.isArray(x.scale) && !keyed(x.scale) && x.scale[0] !== x.scale[1]) return false;
  return true;
}

const staticVisuals = defineCheck({
  id: 'static-visuals', stage: 'project',
  describe: 'a vertical (9:16) social comp where nothing big moves or changes for over 2.5 s (retention); fix: a slow punch-in on the dominant layer',
  run(ctx) {
    const c = compOf(ctx);
    if (c.H / c.W < 1.6 || c.length <= c.fps * STATIC_SECONDS) return [];
    const boxes = new Map<string, Box[]>();
    for (const [, ls] of allLayers(ctx)) for (const l of ls) { const a = boxes.get(l.clipId) ?? []; a.push(l.box); boxes.set(l.clipId, a); }
    const { motion, events, kinds, cover } = motionOf(ctx, c, boxes);
    const out: Finding[] = [];
    const min = Math.round(c.fps * STATIC_SECONDS);
    for (const [s, e] of staticStretches(c.length, motion, events)) {
      if (e - s <= min) continue;
      const mid = Math.floor((s + e) / 2);
      const on = c.clips.filter((x) => kinds.has(x.id) && x.at <= mid && mid < x.at + x.len && (cover.get(x.id) ?? 0) >= BIG && kinds.get(x.id) !== 'solid');
      if (!on.length) continue; // nothing on screen but solids: black/empty frames are other rules' business
      on.sort((a, b) => (PUNCH_RANK[kinds.get(b.id)!] ?? 0) - (PUNCH_RANK[kinds.get(a.id)!] ?? 0) || (cover.get(b.id) ?? 0) - (cover.get(a.id) ?? 0));
      const dom = on[0]!;
      const target = on.find((x) => punchable(x) && (PUNCH_RANK[kinds.get(x.id)!] ?? 0) > 0 && s >= x.at);
      const span = `${sec(s, c.fps)}–${sec(e, c.fps)}`;
      const f: Finding = {
        rule: 'static-visuals', severity: 'warning', frame: s, clip: (target ?? dom).id, box: [0, 0, c.W, c.H],
        message: `nothing moves on screen for ${((e - s) / c.fps).toFixed(1)} s (${span}; "${(target ?? dom).id}" holds still): viewers swipe away from static shots`,
      };
      if (target) f.fix = kinds.get(target.id) === 'gen' ? genFix(target) ?? punchFix(c, target, s, Math.min(e, target.at + target.len)) : punchFix(c, target, s, Math.min(e, target.at + target.len));
      out.push(f);
    }
    return out;
  },
});

/** A still generator background gets its own motion parameter (a slow drift) instead of a zoom. */
function genFix(x: Clip): string | undefined {
  const g = x.gen as Record<string, unknown>;
  const set = (k: string, v: number) => `mgl edit <file> clip.set ${x.id} gen.${k}=${v}`;
  switch (g.type) {
    case 'gradient': return set('animate', 24);
    case 'checker': case 'pattern': return set('speed', 40);
    case 'noise': return set('speed', 0.5);
    case 'particles': return set('speed', 120);
    default: return undefined;
  }
}

/** A slow centred push-in over the whole static stretch that keeps the layer's anchor where it is. */
function punchFix(c: Comp, x: Clip, s: number, e: number): string {
  const secs = (e - s) / c.fps;
  const k = 1 + Math.min(0.15, Math.max(0.06, 0.025 * secs));
  const x0 = typeof x.x === 'number' ? x.x : c.W / 2;
  const y0 = typeof x.y === 'number' ? x.y : c.H / 2;
  const bw = Math.round(c.W / k), bh = Math.round(c.H / k);
  const cx = x0 + (c.W / 2 - x0) / k, cy = y0 + (c.H / 2 - y0) / k;
  // half-pixel corners keep the box centre exact, so the layer's anchor does not drift
  const half = (v: number) => Math.round(v * 2) / 2;
  const box = [half(cx - bw / 2), half(cy - bh / 2), bw, bh];
  return `mgl edit <file> clip.punch-in ${x.id} 'box=${JSON.stringify(box)}' at=${s} len=${e - s} ease=inOutSine`;
}

// ------------------------------------------------------------------------------------------- low-contrast

const MIN_CONTRAST = 3;

/** Does the style separate the text from any backdrop (outline, plate or shadow that contrasts with the fill)? */
function separated(look: TextLook, fillL: number): string | undefined {
  const ok = (col: string | undefined, minAlpha: number) => {
    const v = parseRgba(col);
    return !!v && v[3] >= minAlpha && contrast(fillL, luminance(v[0], v[1], v[2])) >= MIN_CONTRAST;
  };
  if (look.stroke && (look.strokeWidth ?? 0) >= Math.max(2, 0.04 * look.size) && ok(look.stroke, 0.6)) return 'stroke';
  if (look.bg && ok(look.bg, 0.6)) return 'plate';
  if (look.shadow && ok(look.shadow, 0.5)) return 'shadow';
  return undefined;
}

/**
 * Median WCAG contrast between the fill colour and the pixels in the text box (padded by a quarter of the font size).
 * Glyphs cover well under half of that area, so the median is set by the backdrop around and between the letters.
 */
export function backdropContrast(img: Img, box: Box, fill: [number, number, number], pad: number, W: number, H: number): number | undefined {
  const s = img.scale;
  const b = intersect([box[0] - pad, box[1] - pad, box[2] + 2 * pad, box[3] + 2 * pad], [0, 0, W, H]);
  const x0 = Math.max(0, Math.floor(b[0] * s)), y0 = Math.max(0, Math.floor(b[1] * s));
  const x1 = Math.min(img.width, Math.ceil((b[0] + b[2]) * s)), y1 = Math.min(img.height, Math.ceil((b[1] + b[3]) * s));
  if (x1 - x0 < 2 || y1 - y0 < 2) return undefined;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 6000)));
  const fl = luminance(...fill), rs: number[] = [];
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const i = (y * img.width + x) * 4;
    rs.push(contrast(fl, luminance(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!)));
  }
  rs.sort((a, b2) => a - b2);
  return rs[Math.floor(rs.length / 2)];
}

/** Is text still animating at f (text animator in/out windows)? */
function animating(x: Clip, f: number): boolean {
  if (!x.animate) return false;
  const words = Math.min(12, String(x.text ?? '').split(/\s+/).filter(Boolean).length || 1);
  const dur = Math.round((x.animate.len as number | undefined ?? 12) + (x.animate.stagger as number | undefined ?? 3) * (words - 1)) + 2;
  return (!!x.animate.in && f < x.at + dur) || (!!x.animate.out && f >= x.at + x.len - dur);
}

const fullOpacity = (v: unknown) => v === undefined || (typeof v === 'number' && v >= 0.999) || (keyed(v) && v.every((k) => typeof k[1] === 'number' && k[1] >= 0.999));

const lowContrast = defineCheck({
  id: 'low-contrast', stage: 'frame',
  describe: 'rendered text against the pixels behind it below the WCAG 3:1 ratio, with no outline, plate or shadow; fix: a contrasting stroke or a plate',
  run(ctx) {
    const c = compOf(ctx), clips = new Map(c.clips.map((x) => [x.id, x])), out: Finding[] = [], seen = new Set<string>();
    for (const [f, img] of [...(ctx.frames ?? new Map<number, Img>())].sort((a, b) => a[0] - b[0])) {
      for (const l of ctx.layers?.get(f) ?? []) {
        if ((l.kind !== 'text' && l.kind !== 'captions') || !l.text?.trim() || seen.has(l.clipId)) continue;
        const x = clips.get(l.clipId);
        if (!x || x.hidden || !fullOpacity(x.opacity) || inFade(x, f) || animating(x, f) || (x.blend && x.blend !== 'normal')) continue;
        if (area(intersect(l.box, [0, 0, c.W, c.H])) < 0.5 * area(l.box)) continue; // off frame: text-cut-off's business
        const look = textLook(ctx.project, x);
        const fill = parseRgba(look?.color);
        if (!look || !fill || fill[3] < 0.9) continue;
        const fl = luminance(fill[0], fill[1], fill[2]);
        if (separated(look, fl)) continue;
        const fontPx = l.fontPx ?? look.size;
        const ratio = backdropContrast(img, l.box, [fill[0], fill[1], fill[2]], Math.max(4, 0.25 * fontPx), c.W, c.H);
        if (ratio === undefined || ratio >= MIN_CONTRAST) continue;
        seen.add(l.clipId);
        out.push({
          rule: 'low-contrast', severity: 'warning', frame: f, clip: l.clipId, box: l.box.map((v) => Math.round(v)) as Box,
          message: `text ${quote(l.text)}(${l.clipId}) is hard to read at ${sec(f, c.fps)}: contrast ${ratio.toFixed(1)}:1 against what is behind it (WCAG asks 3:1)`,
          fix: contrastFix(x, look, fl, fontPx, c),
        });
      }
    }
    return out;
  },
});

/** Titles get an outline in black or white (whichever contrasts more with the fill); small text a translucent plate. */
function contrastFix(x: Clip, look: TextLook, fillL: number, fontPx: number, c: Comp): string {
  const dark = contrast(fillL, 0) >= contrast(fillL, 1);
  if (fontPx >= 0.035 * c.H) {
    const w = Math.max(3, Math.round(look.size * 0.08));
    return `mgl edit <file> clip.set ${x.id} style.stroke=${dark ? '#000000' : '#ffffff'} style.strokeWidth=${w}`;
  }
  const px = Math.max(10, Math.round(look.size * 0.45)), py = Math.max(6, Math.round(look.size * 0.25));
  return `mgl edit <file> clip.set ${x.id} style.bg=${dark ? '#000000b3' : '#ffffffe6'} 'style.bgPadding=[${px},${py}]' style.bgRadius=${py}`;
}

// ------------------------------------------------------------------------------------------- edge-gap

const PICTURE = new Set(['video', 'image', 'comp', 'gen', 'solid']);

/** Is the point inside any of the boxes? */
const inside = (px: number, py: number, bs: Box[]) => bs.some((k) => px >= k[0] && px <= k[0] + k[2] && py >= k[1] && py <= k[1] + k[3]);

/** Share of the frame outside every box (a 48×48 grid). */
function uncovered(bs: Box[], W: number, H: number): number {
  const N = 48;
  let miss = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (!inside(((i + 0.5) * W) / N, ((j + 0.5) * H) / N, bs)) miss++;
  return miss / (N * N);
}

/** The zoom about the layer's anchor point that makes its box cover the frame (Infinity when the anchor is off frame). */
export function coverZoom(box: Box, anchor: [number, number], W: number, H: number): number {
  const px = box[0] + anchor[0] * box[2], py = box[1] + anchor[1] * box[3];
  if (px <= 0 || px >= W || py <= 0 || py >= H) return Infinity;
  const need = (reach: number, have: number) => (reach <= 0 ? 1 : have <= 0 ? Infinity : reach / have);
  return Math.max(1, need(px, px - box[0]), need(W - px, box[0] + box[2] - px), need(py, py - box[1]), need(H - py, box[1] + box[3] - py));
}

const up3 = (v: number) => Math.ceil(v * 1000 + 1) / 1000;
const scaleTimes = (v: unknown, k: number): unknown => {
  if (typeof v === 'number') return up3(v * k);
  if (Array.isArray(v) && typeof v[0] === 'number') return v.map((n) => up3((n as number) * k));
  return v;
};
const sval = (v: unknown) => (typeof v === 'number' ? v : Array.isArray(v) && typeof v[0] === 'number' ? Math.min(...(v as number[])) : 1);

/**
 * (scale at clip frame t, linear between keys) ÷ (smallest key): how much more the smallest key must grow than the
 * sampled frame needed. Linear interpolation is at or above an eased curve between the same keys, so this never under-zooms.
 */
function keyRatio(keys: [number, unknown, unknown?][], t: number): number {
  const vals = keys.map((k) => sval(k[1]));
  const min = Math.min(...vals);
  let at = vals[0]!;
  if (t >= keys.at(-1)![0]) at = vals.at(-1)!;
  else for (let i = 1; i < keys.length; i++) if (t < keys[i]![0]) {
    const a = keys[i - 1]![0], b = keys[i]![0];
    at = t <= a ? vals[i - 1]! : vals[i - 1]! + ((vals[i]! - vals[i - 1]!) * (t - a)) / (b - a);
    break;
  }
  return min > 0 ? Math.max(1, at / min) : 1;
}

const edgeGap = defineCheck({
  id: 'edge-gap', stage: 'project',
  describe: 'a picture layer meant to fill the frame (≥ 80 %) zoomed out or moved so the comp background shows at an edge; fix: the smallest scale that covers the frame',
  run(ctx) {
    const c = compOf(ctx), clips = new Map(c.clips.map((x) => [x.id, x]));
    const worst = new Map<string, { k: number; f: number; box: Box; miss: number }>();
    for (const [f, ls] of allLayers(ctx)) {
      const pics = ls.filter((l) => PICTURE.has(l.kind) && c.visual.has(clips.get(l.clipId)?.track ?? ''));
      for (const l of pics) {
        const x = clips.get(l.clipId);
        if (!x || x.hidden || x.masks?.length || x.matte || inFade(x, f)) continue;
        if (typeof x.rotate === 'number' ? x.rotate % 360 !== 0 : x.rotate !== undefined) continue;
        const cov = area(intersect(l.box, [0, 0, c.W, c.H])) / (c.W * c.H);
        if (cov < 0.8 || cov > 0.9995) continue;
        const others = pics.filter((o) => o.clipId !== l.clipId).map((o) => o.box);
        const miss = uncovered([l.box, ...others], c.W, c.H);
        if (miss < 0.002) continue;
        const k = coverZoom(l.box, (x.anchor as [number, number] | undefined) ?? [0.5, 0.5], c.W, c.H);
        if (!(k > 1.0005 && k <= 1.5)) continue; // a slide from off frame or a deliberate inset: not a gap to zoom away
        const w = worst.get(x.id);
        if (!w || k > w.k) worst.set(x.id, { k, f, box: l.box, miss });
      }
    }
    const out: Finding[] = [];
    for (const [id, w] of worst) {
      const x = clips.get(id)!;
      const cur = x.scale ?? 1;
      // keyframed: the gap is widest at the smallest key, so scale every key by what that one needs
      const k = keyed(cur) ? w.k * keyRatio(cur, w.f - x.at + (x.clock ?? 0)) : w.k;
      const next = keyed(cur) ? cur.map((kf) => [kf[0], scaleTimes(kf[1], k), ...kf.slice(2)]) : scaleTimes(cur, k);
      const val = JSON.stringify(next);
      out.push({
        rule: 'edge-gap', severity: 'warning', frame: w.f, clip: id, box: [0, 0, c.W, c.H],
        message: `"${id}" leaves ${(w.miss * 100).toFixed(1)}% of the frame uncovered at ${sec(w.f, c.fps)} (the comp background shows at the edge); it needs ${w.k.toFixed(3)}x its size to fill the frame`,
        fix: `mgl edit <file> clip.set ${id} ${/^[\d.]+$/.test(val) ? `scale=${val}` : `'scale=${val}'`}`,
      });
    }
    return out;
  },
});

export const retentionChecks = [staticVisuals, lowContrast, edgeGap];
