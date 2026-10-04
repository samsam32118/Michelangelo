/**
 * Built-in QA checks (public plugin API only).
 * project: from the data and evaluated layer boxes (`check` and `look`); frame: from rendered stills (`look`);
 * audio: from the mix analysis (`look`). Every finding names the clip, the time, and a ready-to-run fix that never
 * destroys work (no ripple trims or wipes of an animation the user meant).
 *
 * Layers in a frame are in draw order: a later layer is stacked above an earlier one.
 * Clips tagged "qa-ignore:<rule>" (or "qa-ignore:all") are skipped by that rule (see IGNORE_ALIASES).
 */
import { definePlugin, defineCheck, licenceClass, licenceName, type CheckContext, type CheckDef, type Finding } from '../../plugin/api.js';
import { retentionChecks } from './retention.js';

type Project = CheckContext['project'];
type Clip = NonNullable<Project['clips']>[number];
type Box = [number, number, number, number];
type Layer = NonNullable<CheckContext['layers']> extends Map<number, (infer L)[]> ? L : never;
type Layers = Map<number, Layer[]>;
type Rect = { x: number; y: number; w: number; h: number };

/**
 * The check context (plugin API 1.1 carries sampled, sourceDuration and alpha, all optional; every check works without them).
 * `sourceAlpha` (set by the QA runner when media were probed) says whether a media asset carries an alpha channel.
 */
export type QaContext = CheckContext;
/** What opacity decisions need: the project, and probed alpha when known. */
type Q = Pick<QaContext, 'project' | 'sourceAlpha'>;

/** Pixel formats with an alpha channel (ProRes 4444 yuva444p*, VP9 alpha yuva420p, PNG/QuickTime rgba/argb ...). */
export const ALPHA_PIX_FMT = /^(yuva|rgba|argb|bgra|abgr|gbrap|ya8|ya16|rgba64|bgra64|pal8)/i;
/** Containers that cannot (in practice) carry an alpha channel: a video in one of these is opaque without probing. */
const NO_ALPHA_VIDEO = /\.(mp4|m4v|mpe?g|ts|mts|m2ts|avi|wmv|flv|3gp|y4m)(\?.*)?$/i;

// ------------------------------------------------------------------------------------------- helpers

function fpsOf(fps: number | string): number {
  if (typeof fps === 'number') return fps;
  const [n, d] = fps.split('/').map(Number);
  return d ? n! / d : n!;
}

interface Comp { id: string; W: number; H: number; fps: number; length?: number; bg?: string; tracks: NonNullable<Project['tracks']>; clips: Clip[] }

function compOf(ctx: CheckContext, id = ctx.compId): Comp {
  const c = ctx.project.comps.find((x) => x.id === id) ?? ctx.project.comps[0]!;
  const tracks = (ctx.project.tracks ?? []).filter((t) => t.comp === c.id);
  const ids = new Set(tracks.map((t) => t.id));
  const comp: Comp = { id: c.id, W: c.size[0], H: c.size[1], fps: fpsOf(c.fps), tracks, clips: (ctx.project.clips ?? []).filter((x) => ids.has(x.track)) };
  if (typeof c.length === 'number') comp.length = c.length;
  if (c.bg) comp.bg = c.bg;
  return comp;
}

const sec = (frame: number, fps: number) => `${(frame / fps).toFixed(2)}s`;
const quote = (t: string | undefined) => (t === undefined ? '' : `"${t.length > 24 ? t.slice(0, 23) + '…' : t}" `);
const isText = (kind: string) => kind === 'text' || kind === 'captions';
const area = (b: Box) => Math.max(0, b[2]) * Math.max(0, b[3]);
const fullFrame = (b: Box, c: Comp) => area(intersect(b, [0, 0, c.W, c.H])) >= 0.8 * c.W * c.H;
const round = (b: Box): Box => b.map((v) => Math.round(v)) as Box;
const frameBox = (c: Comp): Box => [0, 0, c.W, c.H];
const visualTrack = (c: Comp, id: string) => { const t = c.tracks.find((x) => x.id === id); return !!t && !t.audio && !t.hidden; };

function intersect(a: Box, b: Box): Box {
  const x = Math.max(a[0], b[0]), y = Math.max(a[1], b[1]);
  return [x, y, Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x), Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y)];
}
const meets = (a: Box, b: Box) => area(intersect(a, b)) > 0.02 * Math.min(area(a), area(b));

const keyed = (v: unknown): v is [number, unknown, unknown?][] => Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);

/** ctx.layers as [frame, layers] sorted by frame. */
function layerFrames(ctx: CheckContext): [number, Layer[]][] {
  return [...(ctx.layers ?? new Map<number, Layer[]>())].sort((a, b) => a[0] - b[0]);
}

/** Rest layers and sampled layers together (sampled frames first win nothing: both are kept, sorted). */
function allLayers(ctx: QaContext): [number, Layer[]][] {
  const m = new Map<number, Layer[]>(ctx.sampled ?? []);
  for (const [f, ls] of ctx.layers ?? []) m.set(f, ls);
  return [...m].sort((a, b) => a[0] - b[0]);
}

/** Which rules a "qa-ignore:<word>" tag covers besides the rule id itself. */
export const IGNORE_ALIASES: Record<string, string[]> = {
  'safe-zone': ['text-outside-safe', 'ui-overlap'], safe: ['text-outside-safe', 'ui-overlap'], ui: ['ui-overlap'],
  covered: ['layer-hidden'], hidden: ['layer-hidden'],
  overlap: ['caption-overlap', 'overlap-alpha'],
  'cut-off': ['text-cut-off'], 'off-frame': ['media-off-frame', 'text-cut-off'],
  black: ['black-frames', 'trailing-black'], silence: ['long-silence'],
  frozen: ['frozen', 'clip-past-source'], levels: ['luma-range'], broadcast: ['luma-range'],
  credits: ['stock-credits'], licence: ['stock-licence'],
  static: ['static-visuals'], motion: ['static-visuals'], contrast: ['low-contrast'], legibility: ['low-contrast'], gap: ['edge-gap'], edge: ['edge-gap'],
};

/** Does a clip carry a qa-ignore tag for this rule? */
export function ignores(clip: { tags?: string[] | undefined } | undefined, rule: string): boolean {
  for (const t of clip?.tags ?? []) {
    if (!t.startsWith('qa-ignore:')) continue;
    const w = t.slice(10).trim();
    if (w === rule || w === 'all' || w === '*' || IGNORE_ALIASES[w]?.includes(rule)) return true;
  }
  return false;
}

/**
 * Does a clip carry a tag that names this rule itself (the rule id or an alias, never "all" or "*")? Project-scoped
 * findings (the mix's loudness or true peak, a comp-wide note) are only silenced this way: a qa-ignore:all on one
 * credits clip must not hide clipping in the whole mix.
 */
export function ignoresExplicitly(clip: { tags?: string[] | undefined } | undefined, rule: string): boolean {
  for (const t of clip?.tags ?? []) {
    if (!t.startsWith('qa-ignore:')) continue;
    const w = t.slice(10).trim();
    if (w === rule || IGNORE_ALIASES[w]?.includes(rule)) return true;
  }
  return false;
}

/** A fix that tags a clip so a rule skips it (keeps its other tags). */
function ignoreFix(clip: Clip | undefined, id: string, word: string): string {
  const tags = [...(clip?.tags ?? []).filter((t) => t !== `qa-ignore:${word}`), `qa-ignore:${word}`];
  return `mgl edit <file> clip.set ${id} 'tags=${JSON.stringify(tags)}'`;
}

/** A fix that moves/narrows a clip so its box fits inside `r`, changing only the axes that cross. */
function fitFix(clip: Clip | undefined, id: string, box: Box, r: Rect, c: Comp): string {
  const style: string[] = [];
  let dx = 0, dy = 0;
  if (box[2] > r.w) style.push(`style.maxWidth=${Math.floor(r.w)}`);
  else if (box[0] < r.x) dx = r.x - box[0]; else if (box[0] + box[2] > r.x + r.w) dx = r.x + r.w - (box[0] + box[2]);
  if (box[3] > r.h) style.push('style.maxLines=2');
  else if (box[1] < r.y) dy = r.y - box[1]; else if (box[1] + box[3] > r.y + r.h) dy = r.y + r.h - (box[1] + box[3]);
  if (!style.length) return moveFix(clip, id, dx, dy, c, box);
  const move = Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5 ? moveFix(clip, id, dx, dy, c, box) : '';
  if (move.includes('key.clear')) return move;
  return `mgl edit <file> clip.set ${id} ${[...style, ...move.split(' ').filter((p) => /^[xy]=/.test(p))].join(' ')}`;
}

function moveFix(clip: Clip | undefined, id: string, dx: number, dy: number, c: Comp, box: Box): string {
  const parts: string[] = [];
  for (const [prop, d, centre, def] of [['x', dx, box[0] + box[2] / 2, c.W / 2], ['y', dy, box[1] + box[3] / 2, c.H / 2]] as const) {
    if (Math.abs(d) < 0.5) continue;
    const v = clip?.[prop];
    if (keyed(v)) return `mgl edit <file> key.clear ${id} prop=${prop} value=${Math.round(centre + d)}`;
    parts.push(`${prop}=${Math.round((typeof v === 'number' ? v : def) + d)}`);
  }
  return `mgl edit <file> clip.set ${id} ${parts.join(' ') || `y=${Math.round(c.H / 2)}`}`;
}

/** Is the clip inside a fade or transition window at comp frame f (intentional dark/held frames)? */
function inFade(clip: Clip, f: number): boolean {
  const s = f - clip.at, e = clip.at + clip.len - f;
  const fi = Math.max(clip.fade?.[0] ?? 0, clip.transition?.in?.len ?? 0), fo = Math.max(clip.fade?.[1] ?? 0, clip.transition?.out?.len ?? 0);
  return s < fi || e <= fo;
}

const clipAt = (c: Comp, f: number, pred: (x: Clip) => boolean = () => true) => c.clips.find((x) => f >= x.at && f < x.at + x.len && pred(x));
const byId = (c: Comp) => new Map(c.clips.map((x) => [x.id, x]));
const allClips = (p: Project) => new Map((p.clips ?? []).map((x) => [x.id, x]));
const mainTrack = (c: Comp) => c.tracks.find((t) => !t.audio && !t.hidden);
const onTrack = (c: Comp, track: string) => c.clips.filter((x) => x.track === track && !x.hidden).sort((a, b) => a.at - b.at);
const visualClips = (c: Comp) => c.clips.filter((x) => !x.hidden && visualTrack(c, x.track));

function speedOf(x: Clip): number {
  const s = x.speed;
  if (s === undefined) return 1;
  if (typeof s === 'number') return s;
  const [n, d] = s.split('/').map(Number);
  return d ? n! / d : n!;
}

const ASSET_IMAGE = /\.(png|jpe?g|webp|gif|bmp|svg|tiff?|avif)(\?.*)?$/i;
const ASSET_AUDIO = /\.(wav|mp3|m4a|aac|opus|ogg|flac)(\?.*)?$/i;
function assetKind(p: Project, id: string | undefined): 'video' | 'image' | 'audio' | 'other' | undefined {
  const a = (p.assets ?? []).find((x) => x.id === id);
  if (!a) return undefined;
  if (a.kind) return a.kind === 'video' || a.kind === 'image' || a.kind === 'audio' ? a.kind : 'other';
  return ASSET_IMAGE.test(a.src) ? 'image' : ASSET_AUDIO.test(a.src) ? 'audio' : 'video';
}

/** A colour with no transparency. */
function opaqueColour(s: string | undefined): boolean {
  if (!s || s === 'transparent' || s === 'none' || s.startsWith('rgba') || s.startsWith('hsla')) return false;
  if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(7).toLowerCase() === 'ff';
  if (/^#[0-9a-f]{4}$/i.test(s)) return s.slice(4).toLowerCase() === 'f';
  return true;
}

/**
 * Is a media asset known to have no alpha channel? Probed pixel format first; else only containers that cannot carry
 * alpha (.mp4 ...) and generators count. .mov (ProRes 4444), .webm (VP9 alpha), .mkv, .png ... are unknown = not opaque.
 */
function mediaOpaque(q: Q, assetId: string | undefined): boolean {
  const a = (q.project.assets ?? []).find((y) => y.id === assetId);
  if (!a) return false;
  const known = q.sourceAlpha?.(a.id);
  if (known !== undefined) return !known;
  if (/^lavfi:/i.test(a.src)) return !/alpha|yuva|rgba/i.test(a.src);
  return NO_ALPHA_VIDEO.test(a.src);
}

function fullOpacity(v: unknown): boolean {
  if (v === undefined) return true;
  if (typeof v === 'number') return v >= 0.999;
  if (keyed(v)) return v.every((k) => typeof k[1] === 'number' && k[1] >= 0.999);
  return false;
}

/** Clip-level properties that let lower layers show through anywhere (blend, masks, matte, opacity, keying effects). */
function seeThrough(x: Clip): boolean {
  if ((x.blend && x.blend !== 'normal') || x.masks?.length || x.matte || x.adjustment) return true;
  if (!fullOpacity(x.opacity)) return true;
  return !!x.fx?.some((e) => e.enabled !== false && /key|mask|alpha|erode|transparen/i.test(e.type));
}

/** Does a nested comp draw an opaque picture over its whole frame (opaque bg, or a clip that fills it at rest)? */
function compOpaque(q: Q, compId: string | undefined, depth = 0): boolean {
  const p = q.project, child = p.comps.find((x) => x.id === compId);
  if (!child || depth > 8) return false;
  if (opaqueColour(child.bg)) return true;
  const tracks = new Set((p.tracks ?? []).filter((t) => t.comp === child.id && !t.audio && !t.hidden).map((t) => t.id));
  return (p.clips ?? []).some((x) => tracks.has(x.track) && x.at === 0 && (typeof child.length !== 'number' || x.len >= child.length)
    && fillsFrame(q, x, child.size[0], child.size[1], depth));
}

/** Does clip x (at rest, from the data alone) draw an opaque picture over the whole W×H frame? Conservative. */
function fillsFrame(q: Q, x: Clip, W: number, H: number, depth = 0): boolean {
  const p = q.project;
  return !x.hidden && !seeThrough(x)
    && (x.x === undefined || x.x === W / 2) && (x.y === undefined || x.y === H / 2)
    && x.rotate === undefined && (x.scale === undefined || (typeof x.scale === 'number' && x.scale >= 1))
    && (x.color !== undefined ? opaqueColour(x.color)
      : x.asset !== undefined ? assetKind(p, x.asset) === 'video' && mediaOpaque(q, x.asset) && (x.fit ?? 'cover') !== 'contain' && x.fit !== 'none'
        : x.comp !== undefined && compOpaque(q, x.comp, depth + 1));
}

/** Do the spans of `cover` clips (outside their fades) cover [s, e) completely? */
function spansCover(cover: Clip[], s: number, e: number): boolean {
  const spans = cover.map((k) => [k.at + (k.fade?.[0] ?? 0), k.at + k.len - (k.fade?.[1] ?? 0)] as const).sort((a, b) => a[0] - b[0]);
  let reach = s;
  for (const [a, b] of spans) if (a <= reach) reach = Math.max(reach, b);
  return reach >= e;
}

/** Is this layer opaque over its whole box at frame f (so it hides what is under it)? Conservative: unknown = no. */
function opaqueLayer(q: Q, clips: Map<string, Clip>, l: Layer, f: number): boolean {
  const x = clips.get(l.clipId);
  if (!x || seeThrough(x) || inFade(x, f)) return false;
  if (typeof x.rotate === 'number' ? x.rotate % 360 !== 0 : x.rotate !== undefined) return false;
  switch (l.kind) {
    case 'solid': return opaqueColour(x.color);
    case 'shape': {
      const s = x.shape;
      if (!s || s.type !== 'rect' || s.fill === 'none' || (s.trim !== undefined && s.trim !== 1) || (s.trimStart !== undefined && s.trimStart !== 0)) return false;
      if (s.gradient) return s.gradient.stops.every((st) => opaqueColour(st[1]));
      if ((s.radius ?? 0) > 0.1 * Math.min(l.box[2], l.box[3])) return false;
      return s.fill === undefined || opaqueColour(s.fill);
    }
    case 'video': {
      // an alpha video (ProRes 4444, VP9 alpha, PNG sequence ...) shows what is under it: only known-opaque media hide
      if (!mediaOpaque(q, x.asset)) return false;
      return (x.fit ?? 'cover') === 'cover' || x.fit === 'fill';
    }
    case 'image': {
      const a = (q.project.assets ?? []).find((y) => y.id === x.asset);
      if (!a || !(x.fit === 'cover' || x.fit === 'fill')) return false;
      const known = q.sourceAlpha?.(a.id);
      return known !== undefined ? !known : /\.(jpe?g|bmp)(\?.*)?$/i.test(a.src);
    }
    case 'comp': return compOpaque(q, x.comp);
    default: return false;
  }
}

/** Is box b fully covered by the union of `covers` (sampled on a 12×12 grid inside b ∩ frame)? */
function coveredBy(b: Box, covers: Box[], c: Comp): boolean {
  const v = intersect(b, frameBox(c));
  if (!covers.length || area(v) <= 0) return false;
  const N = 12;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const px = v[0] + ((i + 0.5) * v[2]) / N, py = v[1] + ((j + 0.5) * v[3]) / N;
    if (!covers.some((k) => px >= k[0] && px <= k[0] + k[2] && py >= k[1] && py <= k[1] + k[3])) return false;
  }
  return true;
}

/** Opaque layers stacked above index i that cover layers[i] completely, or [] when it shows. */
function coversOf(q: Q, clips: Map<string, Clip>, layers: Layer[], i: number, f: number, c: Comp): Layer[] {
  const above = layers.slice(i + 1).filter((o) => o.clipId !== layers[i]!.clipId && opaqueLayer(q, clips, o, f) && area(intersect(o.box, layers[i]!.box)) > 0);
  return coveredBy(layers[i]!.box, above.map((o) => o.box), c) ? above : [];
}

/** Does the clip (or a parent) move over time: keyframed x/y with different values, or boxes that shift between samples? */
function moving(p: Project, clips: Map<string, Clip>, id: string, samples: [number, Layer[]][], c: Comp, depth = 0): boolean {
  const x = clips.get(id);
  if (!x || depth > 8) return false;
  for (const prop of ['x', 'y'] as const) {
    const v = x[prop];
    if (keyed(v) && new Set(v.map((k) => JSON.stringify(k[1]))).size > 1) return true;
  }
  if (x.parent && moving(p, clips, x.parent, [], c, depth + 1)) return true;
  if (depth) return false;
  const boxes = samples.flatMap(([, ls]) => ls.filter((l) => l.clipId === id).map((l) => l.box));
  for (let i = 1; i < boxes.length; i++) {
    if (Math.abs(boxes[i]![0] - boxes[0]![0]) > 0.02 * c.W || Math.abs(boxes[i]![1] - boxes[0]![1]) > 0.02 * c.H) return true;
  }
  return false;
}

/** Unique id for a new track in the project. */
function newTrackId(p: Project, base = 'V'): string {
  const used = new Set([...(p.tracks ?? []), ...(p.clips ?? []), ...p.comps, ...(p.assets ?? [])].map((e) => e.id));
  let n = (p.tracks ?? []).length + 1;
  while (used.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/** A fix that puts clip `id` on a visual track above `over`'s track (a free existing one, else a new track right above). */
function moveUpFix(ctx: CheckContext, c: Comp, id: string, over: string[]): string {
  const clips = allClips(ctx.project), x = clips.get(id);
  if (!x) return '';
  const order = c.tracks.filter((t) => !t.audio);
  const top = Math.max(...over.map((o) => order.findIndex((t) => t.id === clips.get(o)?.track)));
  if (top < 0) return '';
  const free = order.slice(top + 1).find((t) => !t.hidden && !c.clips.some((y) => y.id !== id && y.track === t.id && y.at < x.at + x.len && x.at < y.at + y.len));
  if (free) return `mgl edit <file> clip.move ${id} track=${free.id}`;
  const nt = newTrackId(ctx.project);
  return `mgl edit <file> track.add id=${nt} comp=${c.id} above=${order[top]!.id} && mgl edit <file> clip.move ${id} track=${nt}`;
}

// ------------------------------------------------------------------------------------------- project stage

/** Visual clips that draw a picture (not adjustment layers, not the sound of an audio asset). */
const pictureClips = (ctx: CheckContext, c: Comp) => visualClips(c).filter((x) => !x.adjustment && !(x.asset !== undefined && assetKind(ctx.project, x.asset) === 'audio'));

const gaps = defineCheck({
  id: 'gaps', stage: 'project', describe: 'black gaps on the main (bottom) visual track not covered by other tracks, and a main track that ends before the clips over it',
  run(ctx: QaContext) {
    const c = compOf(ctx), t = mainTrack(c);
    if (!t) return [];
    const clips = onTrack(c, t.id), out: Finding[] = [];
    const others = pictureClips(ctx, c).filter((x) => x.track !== t.id);
    const over = (s: number, e: number) => others.filter((y) => y.at < e && y.at + y.len > s);
    const fills = (xs: Clip[]) => xs.filter((y) => fillsFrame(ctx, y, c.W, c.H));
    let end = 0;
    for (const x of clips) {
      if (x.at > end) {
        const o = over(end, x.at), f = fills(o);
        // a slate, title card or full-frame plate on another track plays over the whole gap: nothing is black
        if (!(f.length && spansCover(f, end, x.at))) {
          const span = `${sec(end, c.fps)}–${sec(x.at, c.fps)}`;
          if (f.length) {
            // moving the clip up would put its first frames under an opaque layer: no fix that hides programme
            out.push({ rule: 'gaps', severity: 'info', frame: end, clip: x.id,
              message: `gap on main track ${t.id} ${span} before "${x.id}" is only partly covered by ${f.slice(0, 2).map((y) => `"${y.id}"`).join(', ')}; the rest shows the comp bg` });
          } else {
            const names = o.length ? ` (only ${o.slice(0, 2).map((y) => `"${y.id}"`).join(', ')}${o.length > 2 ? ` +${o.length - 2}` : ''} over it)` : '';
            out.push({ rule: 'gaps', severity: 'warning', frame: end, clip: x.id,
              message: `gap on main track ${t.id} ${span} shows black before "${x.id}"${names}`,
              fix: `mgl edit <file> clip.move ${x.id} at=${end}` });
          }
        }
      }
      end = Math.max(end, x.at + x.len);
    }
    if (!clips.length) return out;
    const last = clips.reduce((a, b) => (b.at + b.len > a.at + a.len ? b : a));
    if (c.length !== undefined) {
      if (end < c.length) out.push({ rule: 'gaps', severity: 'warning', frame: end, clip: last.id,
        message: `main track ${t.id} ends at ${sec(end, c.fps)} ("${last.id}") but comp ${c.id} runs to ${sec(c.length, c.fps)}: black tail`,
        fix: `mgl edit <file> comp.set ${c.id} length=auto` });
      return out;
    }
    // length auto: overlays (captions, lower thirds, titles) that outlast the main picture play over an empty frame
    const tail = others.filter((y) => y.at + y.len > end).sort((a, b) => b.at + b.len - (a.at + a.len));
    if (!tail.length) return out;
    const overEnd = tail[0]!.at + tail[0]!.len;
    if (overEnd - end < Math.max(1, Math.round(c.fps / 2))) return out;
    const f = fills(tail);
    if (f.length && spansCover(f, end, overEnd)) return out;
    const fixes: string[] = [];
    // extend the main clip when its source can play that long (stills, solids, gens, comps, loops, or a probed handle)
    const room = (() => {
      if (last.asset === undefined || last.loop || assetKind(ctx.project, last.asset) === 'image') return true;
      const d = ctx.sourceDuration?.(last.asset);
      if (d === undefined || !(d > 0) || last.remap !== undefined) return false;
      return (last.in ?? 0) + (overEnd - last.at) * speedOf(last) <= Math.floor(d * c.fps + 1e-6);
    })();
    if (room) fixes.push(`mgl edit <file> clip.trim ${last.id} end=${overEnd}`);
    else for (const y of tail.filter((y) => y.at < end).slice(0, 3)) fixes.push(`mgl edit <file> clip.trim ${y.id} end=${end}`);
    const names = `${tail.slice(0, 2).map((y) => `"${y.id}"`).join(', ')}${tail.length > 2 ? ` +${tail.length - 2}` : ''}`;
    out.push({ rule: 'gaps', severity: 'warning', frame: end, clip: last.id,
      message: `main track ${t.id} ends at ${sec(end, c.fps)} ("${last.id}") but ${names} run${tail.length > 1 ? '' : 's'} to ${sec(overEnd, c.fps)} over an empty frame; ${room ? `extend "${last.id}"` : 'trim the overlays to the picture'}${room || !tail.some((y) => y.at >= end) ? '' : ' (clips that start after it need a picture under them)'}`,
      ...(fixes.length ? { fix: fixes.join(' && ') } : {}) });
    return out;
  },
});

/** The edges of r that box b crosses, in reading order. */
function crossedEdges(b: Box, r: Rect): string[] {
  const e: string[] = [];
  if (b[1] < r.y - 1) e.push('top');
  if (b[1] + b[3] > r.y + r.h + 1) e.push('bottom');
  if (b[0] < r.x - 1) e.push('left');
  if (b[0] + b[2] > r.x + r.w + 1) e.push('right');
  return e;
}
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

const textOutsideSafe = defineCheck({
  id: 'text-outside-safe', stage: 'project', describe: 'text or captions outside the platform safe zone (every crossed edge is named)',
  run(ctx: QaContext) {
    const c = compOf(ctx), r = ctx.safeArea(ctx.platform), clips = byId(c), seen = new Set<string>(), out: Finding[] = [];
    const samples = allLayers(ctx);
    for (const [f, layers] of layerFrames(ctx)) for (const l of layers) {
      if (!isText(l.kind) || seen.has(l.clipId)) continue;
      const b = l.box, edges = crossedEdges(b, r);
      if (!edges.length) continue;
      if (b[0] + b[2] <= 0 || b[1] + b[3] <= 0 || b[0] >= c.W || b[1] >= c.H) continue; // off-screen (animating in)
      seen.add(l.clipId);
      if (moving(ctx.project, allClips(ctx.project), l.clipId, samples, c)) continue; // crawls and rolls pass through on purpose
      out.push({ rule: 'text-outside-safe', severity: 'warning', frame: f, clip: l.clipId, box: round(b),
        message: `${l.kind} ${quote(l.text)}(${l.clipId}) crosses the ${andList(edges)} of the ${ctx.platform === 'none' ? 'title' : ctx.platform}-safe area at ${sec(f, c.fps)}`,
        fix: fitFix(clips.get(l.clipId), l.clipId, b, r, c) });
    }
    return out;
  },
});

/** Vertical platforms whose interface covers the video (header, action buttons, caption panel). */
const UI_PLATFORMS = ['tiktok', 'reels', 'shorts'];
const UI_NAMES: Record<string, string> = { tiktok: 'TikTok', reels: 'Reels', shorts: 'Shorts' };
/** Layer kinds that count as stickers when small (logos, emoji, arrows, product shots, lower-third plates). */
const STICKER_KINDS = new Set(['image', 'video', 'gen', 'shape', 'comp', 'solid']);

/** Which platforms' interfaces to test: the project's own when it is vertical-only, all three when none is set. */
function uiPlatforms(platform: string): string[] {
  if (UI_PLATFORMS.includes(platform)) return [platform];
  return platform === 'none' ? UI_PLATFORMS : [];
}

/** The part of the frame clear of every listed platform's interface (intersection of their safe areas). */
function sharedSafe(ctx: QaContext, platforms: string[]): Rect {
  let x0 = 0, y0 = 0, x1 = Infinity, y1 = Infinity;
  for (const p of platforms) {
    const r = ctx.safeArea(p);
    x0 = Math.max(x0, r.x); y0 = Math.max(y0, r.y); x1 = Math.min(x1, r.x + r.w); y1 = Math.min(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** A fix for a sticker: move it into r, scaling it down first when it is larger than r. */
function stickerFix(clip: Clip | undefined, id: string, box: Box, r: Rect, c: Comp): string {
  const k = Math.min(1, r.w / Math.max(1, box[2]), r.h / Math.max(1, box[3]));
  if (k >= 1) return fitFix(clip, id, box, r, c);
  const sc = clip?.scale;
  if (keyed(sc) || Array.isArray(sc)) return fitFix(clip, id, box, r, c);
  const s = (typeof sc === 'number' ? sc : 1) * k * 0.98;
  const w = box[2] * k * 0.98, h = box[3] * k * 0.98, cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
  const nx = Math.min(Math.max(cx, r.x + w / 2), r.x + r.w - w / 2), ny = Math.min(Math.max(cy, r.y + h / 2), r.y + r.h - h / 2);
  const move = moveFix(clip, id, nx - cx, ny - cy, c, box);
  const xy = move.includes('key.clear') ? [] : move.split(' ').filter((q) => /^[xy]=/.test(q));
  return `mgl edit <file> clip.set ${id} scale=${Math.round(s * 1000) / 1000}${xy.length ? ' ' + xy.join(' ') : ''}`;
}

const uiOverlap = defineCheck({
  id: 'ui-overlap', stage: 'project',
  describe: 'captions, text and stickers under the TikTok / Reels / Shorts interface (header, action buttons, caption panel); all three when the project names no platform',
  run(ctx: QaContext) {
    const c = compOf(ctx);
    const platforms = uiPlatforms(ctx.platform);
    if (c.H <= c.W || !platforms.length || !ctx.uiZones) return [];
    const zones = platforms.map((p) => [p, ctx.uiZones!(p)] as const);
    const clips = byId(c), every = allClips(ctx.project), samples = allLayers(ctx);
    const hits = new Map<string, { f: number; l: Layer; under: Map<string, number> }>();
    const skip = new Set<string>();
    for (const [f, layers] of samples) for (const l of layers) {
      if (skip.has(l.clipId)) continue;
      const clip = clips.get(l.clipId);
      const text = isText(l.kind);
      const b = l.box;
      if (!text) {
        const tagged = !!clip?.tags?.includes('sticker');
        // stickers are small elements: a layer spanning (nearly) the full width or height is picture, not a sticker
        if (!STICKER_KINDS.has(l.kind) || (!tagged && (area(intersect(b, frameBox(c))) >= 0.4 * c.W * c.H || b[2] >= 0.9 * c.W || b[3] >= 0.9 * c.H))) continue;
      }
      if (b[0] + b[2] <= 0 || b[1] + b[3] <= 0 || b[0] >= c.W || b[1] >= c.H) continue; // off-screen (animating in)
      if (ignores(clip, 'ui-overlap') || moving(ctx.project, every, l.clipId, samples, c)) { skip.add(l.clipId); continue; }
      for (const [p, zs] of zones) for (const z of zs) {
        const r = z.rect, i = intersect(b, [r.x, r.y, r.w, r.h]);
        // depth into the panel: the smallest move that clears it
        const depth = Math.min(i[2], i[3]);
        if (area(i) <= 0 || depth <= 2) continue;
        let h = hits.get(l.clipId);
        if (!h) hits.set(l.clipId, h = { f, l, under: new Map() });
        const key = `${UI_NAMES[p]} ${z.name}`;
        h.under.set(key, Math.max(h.under.get(key) ?? 0, Math.round(depth)));
      }
    }
    const safe = sharedSafe(ctx, platforms), out: Finding[] = [];
    for (const [id, h] of hits) {
      const { f, l } = h, text = isText(l.kind), clip = clips.get(id);
      const what = l.kind === 'captions' ? 'caption cue' : text ? 'text' : `sticker (${l.kind})`;
      const where = [...h.under].map(([k, d]) => `${k} (${d} px)`);
      out.push({ rule: 'ui-overlap', severity: text ? 'error' : 'warning', frame: f, clip: id, box: round(l.box),
        message: `${what} ${quote(l.text)}(${id}) is under the ${andList(where)} at ${sec(f, c.fps)}`,
        fix: text ? fitFix(clip, id, l.box, safe, c) : stickerFix(clip, id, l.box, safe, c) });
    }
    return out;
  },
});

const hasBox = (clip: unknown): boolean => {
  const st = (clip as { style?: unknown } | undefined)?.style;
  return !!st && typeof st === 'object' && 'box' in st && (st as { box?: unknown }).box !== undefined;
};

const tinyText = defineCheck({
  id: 'tiny-text', stage: 'project', describe: 'text smaller than 2.5% of the frame height at rest',
  run(ctx) {
    const c = compOf(ctx), clips = byId(c), min = 0.025 * c.H;
    const best = new Map<string, { f: number; l: Layer }>();
    for (const [f, layers] of layerFrames(ctx)) for (const l of layers) {
      if (!isText(l.kind) || l.fontPx === undefined) continue;
      const b = best.get(l.clipId);
      if (!b || l.fontPx > b.l.fontPx!) best.set(l.clipId, { f, l });
    }
    const out: Finding[] = [];
    for (const [id, { f, l }] of best) {
      if (l.fontPx! >= min) continue;
      const sc = clips.get(id)?.scale, s = typeof sc === 'number' ? sc : Array.isArray(sc) && typeof sc[0] === 'number' ? Math.min(sc[0], sc[1] as number) : 1;
      out.push({ rule: 'tiny-text', severity: 'warning', frame: f, clip: id, box: round(l.box),
        message: `${l.kind} ${quote(l.text)}(${id}) is ${Math.round(l.fontPx!)}px at ${sec(f, c.fps)}, under 2.5% of the ${c.H}px frame height (${Math.ceil(min)}px)`,
        // a fixed text box shrinks text to fit, so a bigger size alone changes nothing: drop the box too
        fix: `mgl edit <file> clip.set ${id} style.size=${Math.ceil((0.03 * c.H) / (s || 1))}${hasBox(clips.get(id)) ? ' style.box=null' : ''}` });
    }
    return out;
  },
});

const CONTENT = ['image', 'video', 'gen', 'comp', 'text', 'captions', 'shape', 'solid'];

/**
 * A see-through overlay meant to sit over everything: a watermark (tag "role:watermark" or "watermark"), a layer at
 * opacity 0.35 or less, or one with a non-normal blend. Text under or over it stays readable, so overlaps skip it.
 */
function translucentOverlay(x: Clip | undefined): boolean {
  if (!x) return false;
  if (x.tags?.some((t) => /^(role:)?watermark$/i.test(t))) return true;
  if (x.blend && x.blend !== 'normal') return true;
  const o = x.opacity;
  return typeof o === 'number' ? o <= 0.35 : keyed(o) && o.every((k) => typeof k[1] === 'number' && k[1] <= 0.35);
}

/**
 * Pairs of a text layer and another content layer whose boxes intersect at a frame. `under` = the other layer is
 * stacked ABOVE the text (the text is hidden under it). Two texts give one pair, with the lower one as `t`.
 * Full-frame backgrounds below the text are skipped, and so are full-frame layers above that are not opaque (particles, vignettes).
 */
function overlaps(ctx: CheckContext, c: Comp, layers: Layer[], f: number, rule: string): { t: Layer; o: Layer; i: Box; under: boolean }[] {
  const out: { t: Layer; o: Layer; i: Box; under: boolean }[] = [], clips = allClips(ctx.project);
  layers.forEach((t, ti) => {
    if (!isText(t.kind) || ignores(clips.get(t.clipId), rule) || translucentOverlay(clips.get(t.clipId))) return;
    layers.forEach((o, oi) => {
      if (oi === ti || o.clipId === t.clipId || !CONTENT.includes(o.kind) || ignores(clips.get(o.clipId), rule) || translucentOverlay(clips.get(o.clipId))) return;
      const under = oi > ti;
      if (isText(o.kind) && !under) return; // the pair is reported from the lower text
      if (!under && (fullFrame(o.box, c) || o.kind === 'shape' || o.kind === 'solid')) return; // text on a background, plate or panel
      if (under && fullFrame(o.box, c) && !opaqueLayer(ctx, clips, o, f)) return;
      const i = intersect(t.box, o.box);
      if (area(i) > 0.02 * Math.min(area(t.box), area(o.box))) out.push({ t, o, i, under });
    });
  });
  return out;
}

/** Content boxes at a frame other than `skip`, minus full-frame backgrounds and watermarks (what a moved box must stay clear of). */
function obstacles(c: Comp, layers: Layer[], skip: string[], clips?: Map<string, Clip>): Box[] {
  return layers.filter((l) => !skip.includes(l.clipId) && CONTENT.includes(l.kind) && !fullFrame(l.box, c) && !translucentOverlay(clips?.get(l.clipId))).map((l) => l.box);
}

/**
 * A fix that separates text t from layer o below it, verified: the moved box stays inside the frame and clear of every
 * other layer, at this frame and at every other sampled frame where the moved clip shows (so it never moves into
 * another overlap). Undefined when no such spot exists (e.g. labels on split-screen halves).
 */
function awayFix(ctx: QaContext, c: Comp, clips: Map<string, Clip>, layers: Layer[], f: number, t: Layer, o: Layer): string | undefined {
  const gap = Math.round(c.H * 0.01);
  const frames = new Map<number, Layer[]>([...allLayers(ctx), [f, layers]]);
  const fitsAt = (ls: Layer[], b: Box, moved: string) => b[1] >= 0 && b[1] + b[3] <= c.H && !obstacles(c, ls, [moved], clips).some((k) => meets(b, k));
  const fits = (moved: string, dy: number) => [...frames.values()].every((ls) => ls.every((l) => l.clipId !== moved || fitsAt(ls, [l.box[0], l.box[1] + dy, l.box[2], l.box[3]], moved)));
  const cands: [Layer, number][] = [];
  if (o.kind !== 'comp' && o.kind !== 'video') {
    cands.push([o, t.box[1] - gap - (o.box[1] + o.box[3])], [o, t.box[1] + t.box[3] + gap - o.box[1]]); // o above / below the text
  }
  cands.push([t, o.box[1] - gap - (t.box[1] + t.box[3])], [t, o.box[1] + o.box[3] + gap - t.box[1]]); // text above / below o
  cands.sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]));
  for (const [l, dy] of cands) {
    const nb: Box = [l.box[0], l.box[1] + dy, l.box[2], l.box[3]];
    if (fitsAt(layers, nb, l.clipId) && fits(l.clipId, dy)) return moveFix(clips.get(l.clipId), l.clipId, 0, dy, c, l.box);
  }
  return undefined;
}

function overlapFinding(ctx: CheckContext, c: Comp, rule: string, f: number, layers: Layer[], p: { t: Layer; o: Layer; i: Box; under: boolean }, detail = ''): Finding {
  const { t, o, i } = p, clips = allClips(ctx.project);
  if (p.under && !isText(o.kind)) {
    return { rule, severity: 'warning', frame: f, clip: t.clipId, box: round(i),
      message: `${t.kind} ${quote(t.text)}(${t.clipId}) is hidden under ${o.kind} "${o.clipId}" (stacked above it) at ${sec(f, c.fps)}${detail}`,
      fix: moveUpFix(ctx, c, t.clipId, [o.clipId]) || ignoreFix(clips.get(t.clipId), t.clipId, 'overlap') };
  }
  const fix = awayFix(ctx, c, clips, layers, f, t, o);
  if (fix) return { rule, severity: 'warning', frame: f, clip: t.clipId, box: round(i), message: `${t.kind} ${quote(t.text)}(${t.clipId}) ${p.under ? 'is overlapped by' : detail ? 'is drawn over' : 'overlaps'} ${o.kind} "${o.clipId}" at ${sec(f, c.fps)}${detail}`, fix };
  return { rule, severity: 'info', frame: f, clip: t.clipId, box: round(i),
    message: `${t.kind} ${quote(t.text)}(${t.clipId}) sits on ${o.kind} "${o.clipId}" at ${sec(f, c.fps)}${detail}; no clear spot nearby (a label meant to sit on it? tag it qa-ignore:overlap)`,
    fix: ignoreFix(clips.get(t.clipId), t.clipId, 'overlap') };
}

const captionOverlap = defineCheck({
  id: 'caption-overlap', stage: 'project', describe: 'a caption or text box overlaps another visible element, or is hidden under a layer stacked above it (by layout box)',
  run(ctx) {
    const c = compOf(ctx), seen = new Set<string>(), out: Finding[] = [];
    for (const [f, layers] of layerFrames(ctx)) for (const pr of overlaps(ctx, c, layers, f, 'caption-overlap')) {
      const key = [pr.t.clipId, pr.o.clipId].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(overlapFinding(ctx, c, 'caption-overlap', f, layers, pr));
    }
    return out;
  },
});

const clipPastEnd = defineCheck({
  id: 'clip-past-end', stage: 'project', describe: 'clips that run past the comp length',
  run(ctx) {
    const c = compOf(ctx);
    if (c.length === undefined) return [];
    const L = c.length;
    return c.clips.filter((x) => x.at + x.len > L).map((x): Finding => x.at >= L
      ? { rule: 'clip-past-end', severity: 'warning', frame: x.at, clip: x.id, message: `clip "${x.id}" starts at ${sec(x.at, c.fps)}, after comp ${c.id} ends (${sec(L, c.fps)}): never seen`, fix: `mgl edit <file> comp.set ${c.id} length=auto` }
      : { rule: 'clip-past-end', severity: 'warning', frame: L, clip: x.id, message: `clip "${x.id}" runs to ${sec(x.at + x.len, c.fps)}, past comp ${c.id}'s end at ${sec(L, c.fps)}: cut off`, fix: `mgl edit <file> clip.trim ${x.id} end=${L}` });
  },
});

const ANIMATABLE = ['x', 'y', 'scale', 'rotate', 'opacity', 'gain', 'remap'] as const;
const keyframesOutside = defineCheck({
  id: 'keyframes-outside', stage: 'project', describe: 'keyframes outside the clip\'s span (never reached)',
  run(ctx) {
    const c = compOf(ctx), out: Finding[] = [];
    for (const x of c.clips) {
      const lo = x.clock ?? 0, hi = lo + x.len;
      const props: [string, unknown][] = ANIMATABLE.map((p) => [p, x[p]]);
      x.fx?.forEach((e, i) => { for (const [k, v] of Object.entries(e)) props.push([`fx.${i}.${k}`, v]); });
      for (const [prop, v] of props) {
        if (!keyed(v)) continue;
        const bad = v.map((k) => k[0]).filter((t) => t < lo || t > hi);
        if (!bad.length) continue;
        out.push({ rule: 'keyframes-outside', severity: 'warning', frame: x.at + Math.min(Math.max(bad[0]! - lo, 0), x.len - 1), clip: x.id,
          message: `clip "${x.id}" ${prop} has ${bad.length} keyframe${bad.length > 1 ? 's' : ''} outside its span 0–${x.len} (at ${bad.join(', ')}); the clip never reaches ${bad.length > 1 ? 'them' : 'it'}`,
          fix: `mgl edit <file> key.remove ${x.id} prop=${prop} at=${bad[0]}` });
      }
    }
    return out;
  },
});

const layerHidden = defineCheck({
  id: 'layer-hidden', stage: 'project', describe: 'a text, image or shape layer fully covered by an opaque layer stacked above it for its whole duration',
  run(ctx: QaContext) {
    const c = compOf(ctx), clips = allClips(ctx.project), out: Finding[] = [];
    const samples = allLayers(ctx);
    for (const x of visualClips(c)) {
      if (x.text === undefined && !x.captions && x.shape === undefined && !(x.asset !== undefined && assetKind(ctx.project, x.asset) === 'image')) continue;
      if (ignores(x, 'layer-hidden')) continue;
      let first: { f: number; l: Layer } | undefined, hidden = true;
      const covers = new Set<string>();
      for (const [f, layers] of samples) {
        if (f < x.at || f >= x.at + x.len) continue;
        const idx = layers.map((l, i) => (l.clipId === x.id ? i : -1)).filter((i) => i >= 0);
        if (!idx.length) continue;
        for (const i of idx) {
          const cov = coversOf(ctx, clips, layers, i, f, c);
          if (!cov.length) { hidden = false; break; }
          first ??= { f, l: layers[i]! };
          for (const k of cov) covers.add(k.clipId);
        }
        if (!hidden) break;
      }
      if (!hidden || !first) continue;
      // the covering clips must span the whole clip (outside their fades), not only the sampled frames
      const spans = [...covers].map((id) => clips.get(id)!).map((k) => [k.at + (k.fade?.[0] ?? 0), k.at + k.len - (k.fade?.[1] ?? 0)] as const).sort((a, b) => a[0] - b[0]);
      let reach = x.at;
      for (const [s, e] of spans) if (s <= reach) reach = Math.max(reach, e);
      if (reach < x.at + x.len) continue;
      const kind = x.text !== undefined ? 'text' : x.captions ? 'captions' : x.shape !== undefined ? 'shape' : 'image';
      const names = [...covers].slice(0, 3).map((id) => `"${id}"`).join(', ');
      out.push({ rule: 'layer-hidden', severity: 'warning', frame: first.f, clip: x.id, box: round(intersect(first.l.box, frameBox(c))),
        message: `${kind} ${kind === 'text' ? quote(x.text) : ''}(${x.id}) is hidden under ${names} (opaque, stacked above it) for its whole duration ${sec(x.at, c.fps)}–${sec(x.at + x.len, c.fps)}`,
        fix: moveUpFix(ctx, c, x.id, [...covers]) });
    }
    return out;
  },
});

/** A fix that brings a non-text layer back into the frame: move it in when it fits, else scale it down (and move). */
function intoFrameFix(clip: Clip | undefined, id: string, box: Box, c: Comp): string {
  const m = 0.05;
  const r: Rect = { x: c.W * m, y: c.H * m, w: c.W * (1 - 2 * m), h: c.H * (1 - 2 * m) };
  if (box[2] <= r.w && box[3] <= r.h) return fitFix(clip, id, box, r, c);
  if (keyed(clip?.scale)) return `mgl edit <file> key.clear ${id} prop=scale value=1`;
  const cur = typeof clip?.scale === 'number' ? clip.scale : Array.isArray(clip?.scale) && typeof clip.scale[0] === 'number' ? clip.scale[0] : 1;
  const k = Math.min(r.w / box[2], r.h / box[3]);
  const w = box[2] * k, h = box[3] * k, nb: Box = [box[0] + box[2] / 2 - w / 2, box[1] + box[3] / 2 - h / 2, w, h];
  const dx = nb[0] < r.x ? r.x - nb[0] : nb[0] + w > r.x + r.w ? r.x + r.w - (nb[0] + w) : 0;
  const dy = nb[1] < r.y ? r.y - nb[1] : nb[1] + h > r.y + r.h ? r.y + r.h - (nb[1] + h) : 0;
  const parts = [`scale=${Math.floor(cur * k * 100) / 100}`];
  for (const [prop, d, def] of [['x', dx, c.W / 2], ['y', dy, c.H / 2]] as const) {
    if (Math.abs(d) < 0.5) continue;
    const v = clip?.[prop];
    if (keyed(v)) continue;
    parts.push(`${prop}=${Math.round((typeof v === 'number' ? v : def) + d)}`);
  }
  return `mgl edit <file> clip.set ${id} ${parts.join(' ')}`;
}

/**
 * The part of a layer's box its masks let through (layout.grid crops with clip-space rect masks). undefined = no masks
 * or matte. `sure` is false when the region cannot be worked out from boxes (paths, inverted/subtracted or animated
 * masks, rotation or flips with clip-space masks, track mattes): then only the layer box is known.
 */
function visibleBox(x: Clip, b: Box): { box: Box; sure: boolean } | undefined {
  if (!x.masks?.length && !x.matte) return undefined;
  if (x.matte) return { box: b, sure: false };
  const sc = x.scale, flipped = (typeof sc === 'number' && sc < 0) || (Array.isArray(sc) && sc.some((v) => typeof v === 'number' && v < 0));
  const rotated = typeof x.rotate === 'number' ? x.rotate % 360 !== 0 : x.rotate !== undefined;
  let region: Box | undefined, sure = true;
  for (const m of x.masks ?? []) {
    const mb = m.box;
    if ((m.shape !== 'rect' && m.shape !== 'ellipse') || keyed(mb) || !Array.isArray(mb) || m.invert || m.mode === 'subtract') { sure = false; continue; }
    const [mx, my, mw, mh] = mb as Box;
    if (m.space === 'clip' && (rotated || flipped)) sure = false;
    const r: Box = m.space === 'clip' ? [b[0] + mx * b[2], b[1] + my * b[3], mw * b[2], mh * b[3]] : [mx, my, mw, mh];
    if (!region) region = r;
    else if (m.mode === 'intersect') region = intersect(region, r);
    else { const x0 = Math.min(region[0], r[0]), y0 = Math.min(region[1], r[1]); region = [x0, y0, Math.max(region[0] + region[2], r[0] + r[2]) - x0, Math.max(region[1] + region[3], r[1] + r[3]) - y0]; }
  }
  return region ? { box: intersect(b, region), sure } : { box: b, sure: false };
}

const mediaOffFrame = defineCheck({
  id: 'media-off-frame', stage: 'project', describe: 'an image, video or shape layer mostly outside the frame at rest (not a background that fills the frame)',
  run(ctx: QaContext) {
    const c = compOf(ctx), clips = allClips(ctx.project), out: Finding[] = [];
    const samples = allLayers(ctx), seen = new Set<string>();
    for (const x of visualClips(c)) {
      if (seen.has(x.id) || ignores(x, 'media-off-frame')) continue;
      // the sampled frame nearest the clip's middle
      const mid = x.at + x.len / 2;
      let best: { f: number; l: Layer } | undefined;
      for (const [f, ls] of samples) {
        if (f < x.at || f >= x.at + x.len) continue;
        const l = ls.find((y) => y.clipId === x.id && ['image', 'video', 'shape', 'gen', 'solid', 'comp'].includes(y.kind));
        if (l && (!best || Math.abs(f - mid) < Math.abs(best.f - mid))) best = { f, l };
      }
      if (!best || (best.l.kind !== 'image' && best.l.kind !== 'video' && best.l.kind !== 'shape')) continue;
      seen.add(x.id);
      // judge what is drawn: a masked layer (a layout.grid cell, a crop) only shows its mask region
      const vis = visibleBox(x, best.l.box), b = vis ? vis.box : best.l.box;
      if (area(b) <= 0) continue;
      if (b[0] <= 1 && b[1] <= 1 && b[0] + b[2] >= c.W - 1 && b[1] + b[3] >= c.H - 1) continue; // fills the frame (background, cover, punch-in)
      if (inFade(x, best.f) || moving(ctx.project, clips, x.id, samples, c)) continue; // flying in or out on purpose
      const inside = area(intersect(b, frameBox(c))) / area(b);
      if (inside >= 0.75) continue;
      const edges = crossedEdges(b, { x: 0, y: 0, w: c.W, h: c.H });
      const what = vis ? `${best.l.kind} "${x.id}"${vis.sure ? '\'s masked area' : ' (masked; its visible area is estimated from the layer box)'}` : `${best.l.kind} "${x.id}"`;
      const f: Finding = { rule: 'media-off-frame', severity: vis && !vis.sure ? 'info' : 'warning', frame: best.f, clip: x.id, box: round(inside > 0 ? intersect(b, frameBox(c)) : b),
        message: inside > 0
          ? `${what} runs off the ${andList(edges)} of the frame at ${sec(best.f, c.fps)}: ${Math.round((1 - inside) * 100)}% of it (${Math.round(b[2])}x${Math.round(b[3])} px) is cut off`
          : `${what} is entirely outside the frame at ${sec(best.f, c.fps)} (box ${round(b).join(',')}): never seen` };
      // moving or scaling a masked layer moves its crop too (it would undo a layout): name the problem, offer no edit
      if (!vis) f.fix = intoFrameFix(clips.get(x.id), x.id, b, c);
      out.push(f);
    }
    return out;
  },
});

const isBlack = (s: string | undefined) => !!s && /^(#0{3}|#0{6}|#0{8}|black)$/i.test(s);

/** A colour that draws nothing visible on black: transparent, or (near) black at any opacity (a matte, a dark plate). */
function darkOrClear(s: string | undefined): boolean {
  if (!s || s === 'transparent' || s === 'none') return true;
  if (/^#[0-9a-f]{8}$/i.test(s) && s.slice(7) === '00') return true;
  if (/^#[0-9a-f]{4}$/i.test(s) && s.slice(4) === '0') return true;
  if (!/^#[0-9a-f]{3,8}$/i.test(s)) return /^black$/i.test(s);
  return Math.max(...parseColor(s)) <= 16;
}

/** Does a shape clip draw something visible (a logo, a graphic), as opposed to a black matte bar or nothing? */
function visibleShape(x: Clip): boolean {
  const s = x.shape;
  if (!s) return false;
  if (s.trim === 0 || (typeof s.trim === 'number' && typeof s.trimStart === 'number' && s.trim <= s.trimStart)) return false;
  // as the renderer draws it: fill defaults to white (lines have none), a line's stroke defaults to its fill or white
  const fill = s.type !== 'line' && s.fill !== 'none' && (s.gradient ? s.gradient.stops.some((st) => !darkOrClear(st[1])) : !darkOrClear(s.fill ?? '#ffffff'));
  const sc = s.stroke ?? (s.type === 'line' ? (s.fill && s.fill !== 'none' ? s.fill : '#ffffff') : undefined);
  const stroke = sc !== undefined && (s.strokeWidth ?? 4) > 0 && !darkOrClear(sc);
  return fill || stroke;
}

const trailingBlack = defineCheck({
  id: 'trailing-black', stage: 'project', describe: 'empty or black timeline after the last visual content (only decoration such as mattes, or nothing)',
  run(ctx) {
    const c = compOf(ctx), vis = visualClips(c);
    if (!vis.length) return [];
    // content: media, text, captions, gens, comps, coloured solids and visible shapes; decoration: black mattes, empty shapes
    const content = vis.filter((x) => !x.adjustment && (x.shape === undefined || visibleShape(x)) && !(x.color !== undefined && darkOrClear(x.color)) && !(x.asset !== undefined && assetKind(ctx.project, x.asset) === 'audio'));
    if (!content.length) return [];
    const last = Math.max(...content.map((x) => x.at + x.len));
    const end = c.length ?? Math.max(...c.clips.map((x) => x.at + x.len));
    if (end - last < Math.max(1, Math.round(c.fps / 2))) return [];
    const main = mainTrack(c);
    if (c.length !== undefined && main && Math.max(0, ...onTrack(c, main.id).map((x) => x.at + x.len)) >= last) return []; // reported by gaps
    const lastClip = content.find((x) => x.at + x.len === last)!;
    if (ignores(lastClip, 'trailing-black')) return [];
    const decor = vis.filter((x) => x.at + x.len > last && !content.includes(x)).sort((a, b) => b.at + b.len - (a.at + a.len));
    const audioOn = c.clips.some((x) => x.asset !== undefined && !x.muted && x.at + x.len > last && (!visualTrack(c, x.track) ? true : assetKind(ctx.project, x.asset) === 'video'));
    const taken = new Set<string>();
    const fixes = decor.slice(0, 3).map((x) => {
      if (x.at < last) return `mgl edit <file> clip.trim ${x.id} end=${last}`;
      // appended after a sibling on its track (e.g. a second matte bar that should run alongside the first): give it its own track
      const sib = vis.find((y) => y.track === x.track && y.at + y.len === x.at && y.at < last);
      if (!sib) return `mgl edit <file> clip.remove ${x.id}`;
      let nt = newTrackId(ctx.project);
      for (let n = 2; taken.has(nt); n++) nt = `${newTrackId(ctx.project)}-${n}`;
      taken.add(nt);
      return `mgl edit <file> track.add id=${nt} comp=${c.id} above=${x.track} && mgl edit <file> clip.move ${x.id} track=${nt} at=${sib.at}`;
    });
    if (c.length !== undefined) fixes.push(`mgl edit <file> comp.set ${c.id} length=${decor.length > 3 ? last : 'auto'}`);
    const what = decor.length ? `only ${decor.slice(0, 2).map((x) => `"${x.id}"`).join(', ')}${decor.length > 2 ? ` +${decor.length - 2}` : ''} (no content)` : 'nothing';
    const bgShows = opaqueColour(c.bg) && !darkOrClear(c.bg); // a coloured bg: an empty end card, not black
    return [{ rule: 'trailing-black', severity: audioOn || bgShows ? 'info' : 'warning', frame: last, clip: lastClip.id,
      message: `after "${lastClip.id}" ends at ${sec(last, c.fps)} comp ${c.id} shows ${what} until ${sec(end, c.fps)}: ${((end - last) / c.fps).toFixed(2)} s of ${bgShows ? `bg ${c.bg} only` : 'black'}${audioOn ? ' (audio continues)' : ''}`,
      fix: fixes.join(' && ') }];
  },
});

const clipPastSource = defineCheck({
  id: 'clip-past-source', stage: 'project', describe: 'a media clip longer than its source (the last frame holds / the sound stops); needs probed durations',
  run(ctx: QaContext) {
    const dur = ctx.sourceDuration;
    if (!dur) return [];
    const out: Finding[] = [], comps = new Map(ctx.project.comps.map((c) => [c.id, c]));
    const trackComp = new Map((ctx.project.tracks ?? []).map((t) => [t.id, t.comp]));
    for (const x of ctx.project.clips ?? []) {
      if (x.asset === undefined || x.loop || x.remap !== undefined || x.hidden || ignores(x, 'clip-past-source')) continue;
      const kind = assetKind(ctx.project, x.asset);
      if (kind !== 'video' && kind !== 'audio') continue;
      const s = speedOf(x), d = dur(x.asset), comp = comps.get(trackComp.get(x.track) ?? '');
      if (!(s > 0) || d === undefined || !(d > 0) || !comp) continue;
      const fps = fpsOf(comp.fps), srcFrames = Math.floor(d * fps + 1e-6), inF = x.in ?? 0;
      if (inF + x.len * s <= srcFrames + 1) continue;
      const end = x.at + Math.floor((srcFrames - inF) / s);
      const what = kind === 'video' ? 'the last frame holds' : 'it is silent';
      out.push(end <= x.at
        ? { rule: 'clip-past-source', severity: 'warning', frame: x.at, clip: x.id,
          message: `${kind} clip "${x.id}" starts at source ${sec(inF, fps)}, after its source "${x.asset}" ends (${d.toFixed(2)} s): ${what} for the whole clip`,
          fix: `mgl edit <file> clip.set ${x.id} in=0` }
        : { rule: 'clip-past-source', severity: 'warning', frame: end, clip: x.id,
          message: `${kind} clip "${x.id}" runs ${((x.at + x.len - end) / fps).toFixed(2)} s past the end of its source "${x.asset}" (${d.toFixed(2)} s): ${what} ${sec(end, fps)}–${sec(x.at + x.len, fps)}`,
          fix: `mgl edit <file> clip.trim ${x.id} end=${end}` });
    }
    return out;
  },
});

const alphaWithBg = defineCheck({
  id: 'alpha-with-bg', stage: 'project', describe: 'an --alpha render of a comp with an opaque bg (the output has no transparency)',
  run(ctx: QaContext) {
    const c = compOf(ctx);
    if (!ctx.alpha || !opaqueColour(c.bg)) return [];
    return [{ rule: 'alpha-with-bg', severity: 'info', message: `comp ${c.id} has an opaque bg (${c.bg}), so the --alpha output is fully opaque`, fix: `mgl edit <file> comp.set ${c.id} bg=null` }];
  },
});

const textCutOff = defineCheck({
  id: 'text-cut-off', stage: 'project', describe: 'text crossing the frame edge at rest (text that moves across the edge, like crawls and rolls, is info)',
  run(ctx: QaContext) {
    const c = compOf(ctx), clips = byId(c), seen = new Set<string>(), out: Finding[] = [];
    const frame: Rect = { x: 0, y: 0, w: c.W, h: c.H }, samples = allLayers(ctx);
    for (const [f, layers] of layerFrames(ctx)) for (const l of layers) {
      const b = l.box;
      if (!isText(l.kind) || seen.has(l.clipId)) continue;
      const crosses = (b[0] < -1 || b[1] < -1 || b[0] + b[2] > c.W + 1 || b[1] + b[3] > c.H + 1) && area(intersect(b, [0, 0, c.W, c.H])) > 0;
      if (!crosses) continue;
      seen.add(l.clipId);
      const edges = crossedEdges(b, frame);
      if (moving(ctx.project, allClips(ctx.project), l.clipId, samples, c)) {
        out.push({ rule: 'text-cut-off', severity: 'info', frame: f, clip: l.clipId, box: round(intersect(b, [0, 0, c.W, c.H])),
          message: `${l.kind} ${quote(l.text)}(${l.clipId}) moves across the ${andList(edges)} frame edge (a crawl or roll? fine if intended)` });
        continue;
      }
      out.push({ rule: 'text-cut-off', severity: 'error', frame: f, clip: l.clipId, box: round(intersect(b, [0, 0, c.W, c.H])),
        message: `${l.kind} ${quote(l.text)}(${l.clipId}) is cut off by the ${andList(edges)} frame edge at ${sec(f, c.fps)}`,
        fix: fitFix(clips.get(l.clipId), l.clipId, b, frame, c) });
    }
    return out;
  },
});

/** The named bus, or the first bus it feeds that is one of `names`. */
function busFamily(p: Project, bus: string, names: string[]): string | undefined {
  const defs = new Map((p.buses ?? []).map((b) => [b.id, b]));
  for (let b: string | undefined = bus, i = 0; b && i < 16; b = defs.get(b)?.to, i++) if (names.includes(b)) return bus;
  return undefined;
}

const musicOverVoice = defineCheck({
  id: 'music-over-voice', stage: 'project', describe: 'music plays under dialogue without ducking (from the buses; no analysis needed)',
  run(ctx) {
    const c = compOf(ctx), p = ctx.project, trackBus = new Map(c.tracks.map((t) => [t.id, t.bus ?? 'master']));
    const audible = c.clips.filter((x) => x.asset !== undefined && !x.muted && !c.tracks.find((t) => t.id === x.track)?.muted);
    const music = audible.filter((x) => busFamily(p, trackBus.get(x.track)!, ['music']));
    const voice = audible.filter((x) => busFamily(p, trackBus.get(x.track)!, ['dialogue', 'voice', 'vo']));
    const defs = new Map((p.buses ?? []).map((b) => [b.id, b]));
    for (const m of music) for (const v of voice) {
      const s = Math.max(m.at, v.at), e = Math.min(m.at + m.len, v.at + v.len);
      if (e <= s) continue;
      const mb = trackBus.get(m.track)!, vb = trackBus.get(v.track)!;
      if (defs.get(mb)?.duck || defs.get('music')?.duck) continue;
      return [{ rule: 'music-over-voice', severity: 'warning', frame: s, clip: m.id,
        message: `music "${m.id}" (bus ${mb}) plays under voice "${v.id}" ${sec(s, c.fps)}–${sec(e, c.fps)} without ducking`,
        fix: `mgl edit <file> audio.duck bus=${mb} by=${vb} db=9` }];
    }
    return [];
  },
});

// ------------------------------------------------------------------------------------------- frame stage

type Img = NonNullable<CheckContext['frames']> extends Map<number, infer I> ? I : never;

/** Mean luma (0..1, BT.709) of a region (comp px) of a frame. */
function meanLuma(img: Img, region?: Box, step = 2): number {
  const [x0, y0, x1, y1] = regionPx(img, region);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const i = (y * img.width + x) * 4;
    sum += (0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!) * (img.data[i + 3]! / 255);
    n++;
  }
  return n ? sum / n / 255 : 0;
}

function regionPx(img: Img, r?: Box): [number, number, number, number] {
  if (!r) return [0, 0, img.width, img.height];
  const s = img.scale, cl = (v: number, m: number) => Math.min(m, Math.max(0, Math.round(v)));
  return [cl(r[0] * s, img.width), cl(r[1] * s, img.height), cl((r[0] + r[2]) * s, img.width), cl((r[1] + r[3]) * s, img.height)];
}

/** Mean absolute difference (0..1) of a region of two frames. */
function regionDiff(a: Img, b: Img, r: Box): number {
  const [x0, y0, x1, y1] = regionPx(a, r);
  let sum = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 12));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const i = (y * a.width + x) * 4;
    sum += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
    n += 3;
  }
  return n ? sum / n / 255 : 0;
}

function parseColor(s: string | undefined): [number, number, number] {
  const m = /^#([0-9a-f]{3,8})$/i.exec(s ?? '');
  if (!m) return s === 'white' ? [255, 255, 255] : [0, 0, 0];
  const h = m[1]!.length < 6 ? [...m[1]!.slice(0, 3)].map((ch) => ch + ch).join('') : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const sortedFrames = (ctx: CheckContext) => [...(ctx.frames ?? new Map<number, Img>())].sort((a, b) => a[0] - b[0]);

/** Luma statistics (0..1, BT.709, alpha-weighted) of a frame: mean, standard deviation and the share of bright pixels (> 0.12). */
function lumaStats(img: Img, step: number): { mean: number; sd: number; bright: number } {
  let sum = 0, sq = 0, bright = 0, n = 0;
  for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
    const i = (y * img.width + x) * 4;
    const Y = ((0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!) * (img.data[i + 3]! / 255)) / 255;
    sum += Y; sq += Y * Y; n++;
    if (Y > 0.12) bright++;
  }
  if (!n) return { mean: 0, sd: 0, bright: 0 };
  const mean = sum / n;
  return { mean, sd: Math.sqrt(Math.max(0, sq / n - mean * mean)), bright: bright / n };
}

/**
 * A black frame: near-zero mean luma AND almost no spread or bright detail. Dark footage (a night shot, grey text on
 * black) and white credits on a black bg have bright pixels or variance, so they are not black.
 */
function blackFrame(img: Img): boolean {
  const st = lumaStats(img, Math.max(1, Math.floor(img.width / 240)));
  return st.mean < 0.03 && st.sd < 0.025 && st.bright < 0.001;
}

const GRAPHIC = ['text', 'captions', 'shape', 'gen'];

const blackFrames = defineCheck({
  id: 'black-frames', stage: 'frame', describe: 'black stretches (near-zero luma with no detail, and no graphics on screen) in the sampled frames (not in audio-only comps)',
  run(ctx: QaContext) {
    const c = compOf(ctx), out: Finding[] = [];
    if (!visualClips(c).length) return []; // an audio-only deliverable has no picture to check
    const frames = sortedFrames(ctx), clips = allClips(ctx.project);
    const step = frames.length > 1 ? Math.max(1, frames[1]![0] - frames[0]![0]) : 1;
    let run: number[] = [];
    const flush = () => {
      if (!run.length) return;
      const f = run[0]!, layers = (ctx.layers?.get(f) ?? []).filter((l) => l.kind !== 'adjustment');
      const media = [...layers].reverse().find((l) => l.kind === 'video' || l.kind === 'image');
      const t = mainTrack(c), next = t ? onTrack(c, t.id).find((x) => x.at > f) : undefined;
      const span = run.length > 1 ? `${sec(f, c.fps)}–${sec(run.at(-1)!, c.fps)} (${run.length} sampled frames)` : `at ${sec(f, c.fps)}`;
      if (media) out.push(mediaBlack(ctx, c, clips.get(media.clipId), media, run, step, span));
      else if (!layers.length && next) out.push({ rule: 'black-frames', severity: 'warning', frame: f, clip: next.id, message: `black frame ${span}: nothing is on screen before "${next.id}"`, fix: `mgl edit <file> clip.move ${next.id} at=${f}` });
      else if (!layers.length) out.push({ rule: 'black-frames', severity: 'warning', frame: f, message: `black frame ${span}: nothing is on screen`, fix: `mgl edit <file> comp.set ${c.id} length=auto` });
      else {
        const top = layers.at(-1)!.clipId;
        if (ctx.alpha || !c.bg) {
          out.push({ rule: 'black-frames', severity: 'info', frame: f, clip: top,
            message: ctx.alpha ? `black frame ${span} with "${top}" on top: transparent in the --alpha render (fine if intended)`
              : `black frame ${span} with "${top}" on top: comp ${c.id} has no bg (transparent renders as black); set one if it should not be black`,
            fix: ctx.alpha ? ignoreFix(clips.get(top), top, 'black-frames') : `mgl edit <file> comp.set ${c.id} bg=#202020` });
        } else {
          // the bg was chosen (a black bg under a dark solid or comp is a look): never suggest repainting it
          out.push({ rule: 'black-frames', severity: 'info', frame: f, clip: top,
            message: `black frame ${span} with "${top}" on top (comp bg ${c.bg}); tag it qa-ignore:black-frames if intended`,
            fix: ignoreFix(clips.get(top), top, 'black-frames') });
        }
      }
      run = [];
    };
    const samples = [...new Map<number, Layer[]>([...allLayers(ctx), ...(ctx.layers ?? [])])].sort((a, b) => a[0] - b[0]);
    for (const [f, img] of frames) {
      const layers = ctx.layers?.get(f) ?? [];
      // titles, credits, shapes or gens on screen: the frame shows something even when it is mostly dark;
      // a roll or crawl just outside the frame (entering or leaving) is part of the same deliberate design
      const graphic = layers.some((l) => GRAPHIC.includes(l.kind) && !translucentOverlay(clips.get(l.clipId))
        && (area(intersect(l.box, frameBox(c))) > 0 || moving(ctx.project, clips, l.clipId, samples, c)));
      const intentional = c.clips.some((x) => f >= x.at && f < x.at + x.len && inFade(x, f));
      if (!graphic && !intentional && blackFrame(img)) run.push(f); else flush();
    }
    flush();
    return out;
  },
});

/**
 * A black run inside a media clip. A slip is offered only when it clears the run without running past the source:
 * the source has a probed handle for it, and the run is a minority of the clip. Otherwise an info with an ignore tag.
 */
function mediaBlack(ctx: QaContext, c: Comp, clip: Clip | undefined, media: Layer, run: number[], step: number, span: string): Finding {
  const f = run[0]!, id = media.clipId;
  const base = { rule: 'black-frames', frame: f, clip: id } as const;
  const runLen = run.at(-1)! - f + step;
  if (clip && media.kind === 'video' && clip.asset !== undefined && !clip.loop && clip.remap === undefined && runLen < clip.len / 2) {
    const d = ctx.sourceDuration?.(clip.asset), sp = speedOf(clip);
    // slip past the dark run when it is at the head of the clip, else by one second
    const by = f - clip.at <= step ? Math.max(Math.round(c.fps), run.at(-1)! - clip.at + step) : Math.round(c.fps);
    if (d !== undefined && d > 0 && sp > 0 && (clip.in ?? 0) + clip.len * sp + by * sp <= Math.floor(d * c.fps + 1e-6)) {
      return { ...base, severity: 'warning', message: `black frame ${span} in "${id}"`, fix: `mgl edit <file> clip.slip ${id} by=${Math.round(by * sp)}` };
    }
  }
  return { ...base, severity: 'info',
    message: `black frame ${span} in "${id}" (${clip?.asset !== undefined && ctx.sourceDuration?.(clip.asset) === undefined ? 'source length unknown' : 'no source handle to slip past it'}; check it with --at, or tag the clip qa-ignore:black-frames if intended)`,
    fix: ignoreFix(clip, id, 'black-frames') };
}

/** The timeline frame where a media clip's source runs out (undefined when it never does or is unknown). */
function sourceEnd(ctx: QaContext, x: Clip, fps: number): number | undefined {
  if (x.asset === undefined || x.loop || x.remap !== undefined) return undefined;
  const d = ctx.sourceDuration?.(x.asset), s = speedOf(x);
  if (d === undefined || !(d > 0) || !(s > 0)) return undefined;
  const srcFrames = Math.floor(d * fps + 1e-6), inF = x.in ?? 0;
  if (inF + x.len * s <= srcFrames + 1) return undefined;
  return Math.max(x.at, x.at + Math.floor((srcFrames - inF) / s));
}

const TILES = 16;
const frozen = defineCheck({
  id: 'frozen', stage: 'frame', describe: 'a visible video layer whose visible pixels do not change between consecutive sampled frames',
  run(ctx: QaContext) {
    const c = compOf(ctx), clips = allClips(ctx.project), out: Finding[] = [], seen = new Set<string>();
    const frames = sortedFrames(ctx);
    const tw = c.W / TILES, th = c.H / TILES;
    for (let i = 1; i < frames.length; i++) {
      const [fa, a] = frames[i - 1]!, [fb, b] = frames[i]!;
      if (a.width !== b.width || a.height !== b.height) continue;
      const la = ctx.layers?.get(fa) ?? [], lb = ctx.layers?.get(fb) ?? [];
      lb.forEach((v, vi) => {
        if (v.kind !== 'video' || seen.has(v.clipId)) return;
        const ai = la.findIndex((x) => x.clipId === v.clipId);
        if (ai < 0) return;
        const clip = clips.get(v.clipId);
        if (!clip || clip.speed === 0 || clip.speed === '0' || clip.remap !== undefined || ignores(clip, 'frozen') || inFade(clip, fa) || inFade(clip, fb)) return;
        // visible tiles: inside the layer's box in both frames and clear of every layer stacked above it in either frame
        const above = [...lb.slice(vi + 1), ...la.slice(ai + 1)].filter((o) => o.clipId !== v.clipId && o.kind !== 'adjustment').map((o) => o.box);
        const own = intersect(intersect(v.box, la[ai]!.box), frameBox(c));
        const tiles: Box[] = [];
        for (let ty = 0; ty < TILES; ty++) for (let tx = 0; tx < TILES; tx++) {
          const t: Box = [tx * tw, ty * th, tw, th];
          if (area(intersect(t, own)) < 0.99 * area(t) || above.some((o) => area(intersect(o, t)) > 0)) continue;
          tiles.push(t);
        }
        if (tiles.length < 0.1 * TILES * TILES) return; // mostly hidden: nothing to judge
        if (tiles.some((t) => regionDiff(a, b, t) > 0.002)) return; // something in the visible picture moves
        seen.add(v.clipId);
        const end = sourceEnd(ctx, clip, c.fps);
        if (end !== undefined && fb >= end) {
          out.push({ rule: 'frozen', severity: 'warning', frame: Math.max(fa, end), clip: v.clipId, box: round(own),
            message: `video "${v.clipId}" is frozen from ${sec(end, c.fps)}: its source "${clip.asset}" ends there but the clip runs to ${sec(clip.at + clip.len, c.fps)}`,
            fix: `mgl edit <file> clip.trim ${v.clipId} end=${end}` });
        } else {
          out.push({ rule: 'frozen', severity: 'info', frame: fa, clip: v.clipId, box: round(own),
            message: `video "${v.clipId}" shows the same picture at ${sec(fa, c.fps)} and ${sec(fb, c.fps)} (a still shot, or a held frame?${ctx.sourceDuration ? '' : ' source length unknown'}); check it with --at between them` });
        }
      });
    }
    return out;
  },
});

const overlapAlpha = defineCheck({
  id: 'overlap-alpha', stage: 'frame', describe: 'caption or text drawn over another element\'s visible pixels, or hidden under a layer stacked above it (refines caption-overlap)',
  run(ctx) {
    const c = compOf(ctx), bg = parseColor(c.bg), seen = new Set<string>(), out: Finding[] = [];
    for (const [f, img] of sortedFrames(ctx)) {
      const layers = ctx.layers?.get(f);
      if (!layers) continue;
      for (const pr of overlaps(ctx, c, layers, f, 'overlap-alpha')) {
        const key = [pr.t.clipId, pr.o.clipId].sort().join('|');
        if (seen.has(key)) continue;
        // pixels in the shared box that differ from the background: glyphs alone cover < 35%, glyphs over an opaque element far more
        const [x0, y0, x1, y1] = regionPx(img, pr.i);
        let hit = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const k = (y * img.width + x) * 4;
          n++;
          if (Math.abs(img.data[k]! - bg[0]) + Math.abs(img.data[k + 1]! - bg[1]) + Math.abs(img.data[k + 2]! - bg[2]) > 48) hit++;
        }
        if (!n || hit / n < 0.35) continue;
        seen.add(key);
        out.push(overlapFinding(ctx, c, 'overlap-alpha', f, layers, pr, ` (${Math.round((100 * hit) / n)}% of the shared area covered)`));
      }
    }
    return out;
  },
});

const hasLegalize = (x: Clip | undefined) => !!x?.fx?.some((e) => e.enabled !== false && e.type === 'legalize');

const lumaRange = defineCheck({
  id: 'luma-range', stage: 'frame', describe: 'broadcast range: over 5% of the visible pixels of video/image layers (not under titles or graphics) outside luma 16–235 in a sampled frame (info)',
  run(ctx: QaContext) {
    const c = compOf(ctx), clips = allClips(ctx.project);
    let worst: { f: number; pct: number; lo: number; hi: number; clip: string } | undefined;
    for (const [f, img] of sortedFrames(ctx)) {
      // the layer each pixel shows is the topmost one whose box holds it: only pixels a media layer shows are judged,
      // so a white title over the video does not count, and a legalize on that media clip clears what is counted
      const ls = (ctx.layers?.get(f) ?? []).filter((l) => l.kind !== 'adjustment');
      if (!ls.some((l) => l.kind === 'video' || l.kind === 'image')) continue;
      const step = Math.max(1, Math.floor(img.width / 160));
      const per = new Map<string, { n: number; bad: number; lo: number; hi: number }>();
      for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
        const px = x / img.scale, py = y / img.scale;
        let top: Layer | undefined, under = false;
        for (let k = ls.length - 1; k >= 0; k--) {
          const l = ls[k]!;
          if (px >= l.box[0] && px < l.box[0] + l.box[2] && py >= l.box[1] && py < l.box[1] + l.box[3]) {
            if (top) { under = true; break; }
            top = l;
          }
        }
        if (!top || (top.kind !== 'video' && top.kind !== 'image')) continue;
        const clip = clips.get(top.clipId);
        // a see-through media layer (alpha overlay, low opacity, blend) over another layer: the pixel may be either's
        if (under && (!clip || seeThrough(clip) || !mediaOpaque(ctx, clip.asset))) continue;
        if (ignores(clip, 'luma-range') || hasLegalize(clip)) continue;
        const i = (y * img.width + x) * 4;
        if (img.data[i + 3]! < 250) continue;
        const Y = 0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!;
        const s = per.get(top.clipId) ?? { n: 0, bad: 0, lo: 255, hi: 0 };
        s.n++;
        s.lo = Math.min(s.lo, Y); s.hi = Math.max(s.hi, Y);
        if (Y < 16 || Y > 235.5) s.bad++;
        per.set(top.clipId, s);
      }
      for (const [id, s] of per) {
        if (s.n < 50 || s.bad / s.n <= 0.05) continue;
        if (!worst || s.bad / s.n > worst.pct) worst = { f, pct: s.bad / s.n, lo: s.lo, hi: s.hi, clip: id };
      }
    }
    if (!worst) return [];
    return [{ rule: 'luma-range', severity: 'info', frame: worst.f, clip: worst.clip,
      message: `${Math.round(worst.pct * 100)}% of "${worst.clip}" at ${sec(worst.f, c.fps)} is outside broadcast luma 16–235 (Y ${Math.round(worst.lo)}–${Math.round(worst.hi)}); only matters for broadcast/legal-range delivery`,
      fix: `mgl edit <file> fx.add ${worst.clip} type=legalize range=pc` }];
  },
});

// ------------------------------------------------------------------------------------------- open media licences

/** Assets with an open-media licence that a clip of any comp uses, with their first user. */
function licensedInUse(p: Project): { a: NonNullable<Project['assets']>[number]; user: Clip }[] {
  const first = new Map<string, Clip>();
  for (const c of p.clips ?? []) if (c.asset && !c.hidden && !first.has(c.asset)) first.set(c.asset, c);
  return (p.assets ?? []).filter((a) => a.licence && first.has(a.id)).map((a) => ({ a, user: first.get(a.id)! }));
}

const stockCredits = defineCheck({
  id: 'stock-credits', stage: 'project', describe: 'open media under an attribution licence (CC BY ...) used without credits (media.credits)',
  run(ctx) {
    const credited = new Set(ctx.project.project?.credits?.assets ?? []);
    const missing = licensedInUse(ctx.project).filter(({ a, user }) => ['attribution', 'share-alike', 'non-commercial'].includes(licenceClass(a.licence)) && !credited.has(a.id) && !ignores(user, 'stock-credits'));
    if (!missing.length) return [];
    const card = (ctx.project.clips ?? []).some((c) => c.tags?.includes('credits'));
    const fix = `mgl edit <file> media.credits${card || !ctx.project.project?.credits?.file ? ' card=true' : ''}${ctx.project.project?.credits?.file ? ` out=${ctx.project.project.credits.file}` : ''}`;
    return missing.map(({ a, user }): Finding => ({ rule: 'stock-credits', severity: 'warning', clip: user.id, frame: user.at,
      message: `asset "${a.id}" (${licenceName(a.licence!)}) is used by "${user.id}" but not credited${a.credit ? `: ${a.credit}` : ''}`, fix }));
  },
});

const stockLicence = defineCheck({
  id: 'stock-licence', stage: 'project', describe: 'open media whose licence the video cannot meet: no-derivatives always, non-commercial in a commercial project, share-alike (the video inherits it)',
  run(ctx) {
    const out: Finding[] = [];
    for (const { a, user } of licensedInUse(ctx.project)) {
      if (ignores(user, 'stock-licence')) continue;
      const cls = licenceClass(a.licence), name = licenceName(a.licence!);
      const replace = `mgl edit <file> media.search kind=${a.kind === 'audio' ? 'sfx' : a.kind ?? 'image'} query="<what it shows>"`;
      if (cls === 'no-derivatives') out.push({ rule: 'stock-licence', severity: 'error', clip: user.id, frame: user.at, message: `asset "${a.id}" is ${name}: no-derivatives forbids putting it in an edit`, fix: replace });
      else if (cls === 'non-commercial' && ctx.project.project?.commercial) out.push({ rule: 'stock-licence', severity: 'error', clip: user.id, frame: user.at, message: `asset "${a.id}" is ${name} (non-commercial) and the project is commercial`, fix: replace });
      else if (cls === 'share-alike') out.push({ rule: 'stock-licence', severity: 'info', clip: user.id, frame: user.at, message: `asset "${a.id}" is ${name}: the finished video must be released under the same licence`, fix: replace });
      else if (cls === 'unknown') out.push({ rule: 'stock-licence', severity: 'warning', clip: user.id, frame: user.at, message: `asset "${a.id}" has an unrecognised licence "${a.licence}"`, fix: replace });
    }
    return out;
  },
});

// ------------------------------------------------------------------------------------------- audio stage

const PLATFORM_LUFS: Record<string, number> = { shorts: -14, tiktok: -14, reels: -14, youtube: -14 };
const masterOf = (p: Project) => p.buses?.find((b) => b.id === 'master');

const clipping = defineCheck({
  id: 'clipping', stage: 'audio', describe: 'true peak above -1 dBTP',
  run(ctx) {
    const tp = ctx.audio?.loudness.truePeak;
    if (tp === undefined || !Number.isFinite(tp) || tp <= -1) return [];
    return [{ rule: 'clipping', severity: tp > 0 ? 'error' : 'warning', message: `mix true peak ${tp.toFixed(1)} dBTP is above -1 dBTP (clips on lossy encodes)`, fix: 'mgl edit <file> audio.normalize peak=-1' }];
  },
});

const loudness = defineCheck({
  id: 'loudness', stage: 'audio', describe: 'integrated loudness more than 2 LU from the target',
  run(ctx) {
    const a = ctx.audio, I = a?.loudness.integrated;
    // a silent mix (no audible audio at all; ebur128 floors at -70) has no loudness to fix
    if (!a || I === undefined || !Number.isFinite(I) || I <= -60) return [];
    const target = masterOf(ctx.project)?.loudness?.lufs ?? PLATFORM_LUFS[ctx.platform] ?? -16;
    if (Math.abs(I - target) <= 2) return [];
    return [{ rule: 'loudness', severity: 'warning', message: `mix is ${I.toFixed(1)} LUFS, ${Math.abs(I - target).toFixed(1)} LU ${I > target ? 'over' : 'under'} the ${target} LUFS target`, fix: `mgl edit <file> audio.normalize lufs=${target}` }];
  },
});

const longSilence = defineCheck({
  id: 'long-silence', stage: 'audio', describe: 'silences longer than 2 s inside the content',
  run(ctx) {
    const a = ctx.audio;
    if (!a) return [];
    const c = compOf(ctx), audio = c.clips.filter((x) => x.asset !== undefined && c.tracks.find((t) => t.id === x.track)?.audio);
    if (!audio.length) return [];
    return a.silences.filter((s) => s.end - s.start > 2 && s.start > 0.05 && s.end < a.duration - 0.05).map((s): Finding => {
      const f = Math.round(s.start * c.fps), cover = clipAt(c, f + 1, (x) => audio.includes(x));
      const next = audio.filter((x) => x.at > f).sort((x, y) => x.at - y.at)[0];
      const msg = `${(s.end - s.start).toFixed(1)} s of silence ${s.start.toFixed(2)}–${s.end.toFixed(2)}s`;
      return cover ? { rule: 'long-silence', severity: 'warning', frame: f, clip: cover.id, message: `${msg} in "${cover.id}"`, fix: `mgl edit <file> audio.cut-silences ${cover.id} min=2s` }
        : { rule: 'long-silence', severity: 'warning', frame: f, ...(next ? { clip: next.id } : {}), message: `${msg}: no audio clip plays`, fix: next ? `mgl edit <file> clip.move ${next.id} at=${f}` : `mgl edit <file> comp.set ${c.id} length=auto` };
    });
  },
});

export const builtinChecks: CheckDef[] = [gaps, textOutsideSafe, uiOverlap, tinyText, captionOverlap, clipPastEnd, keyframesOutside,
  layerHidden, mediaOffFrame, trailingBlack, clipPastSource, alphaWithBg, textCutOff, musicOverVoice,
  stockCredits, stockLicence, blackFrames, frozen, overlapAlpha, lumaRange, clipping, loudness, longSilence, ...retentionChecks];

export default definePlugin({ name: 'builtin-checks', version: '1.2.0', checks: builtinChecks });
