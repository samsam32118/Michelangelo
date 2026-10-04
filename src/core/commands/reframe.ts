/** comp.reframe: change a comp's size (or make a resized copy) and re-lay out its clips; optionally follow a subject with motion tracking. */
import { z } from 'zod';
import { fail } from '../errors.js';
import { defineCommand, clone, type CommandContext } from './registry.js';
import { Id, clipKind, type Clip, type Comp, type TextStyle } from '../schema/index.js';
import { isKeyframes } from '../load.js';
import { PRESETS, kindFromExtension } from './structure.js';
import { speedOf, srcFrames } from './clip.js';
import { styles as BUILTIN_STYLE_DEFS } from '../../builtin/text/styles.js';
import { safeRect } from '../../builtin/text/templates.js';

type Num = number | [number, unknown, unknown?][];
type Style = Partial<TextStyle> & Record<string, unknown>;

/** Map a constant or every keyframe value. */
function mapValue(v: unknown, f: (n: number) => number): unknown {
  if (typeof v === 'number') return f(v);
  if (isKeyframes(v)) return v.map((k) => [k[0], typeof k[1] === 'number' ? f(k[1]) : k[1], ...k.slice(2)]);
  return v;
}

function values(v: unknown): number[] {
  if (typeof v === 'number') return [v];
  if (Array.isArray(v) && typeof v[0] === 'number') return v as number[];
  if (isKeyframes(v)) return v.flatMap((k) => values(k[1]));
  return [];
}

/** A style id or inline style resolved through the styles table and the built-in styles. */
function resolveStyle(ctx: CommandContext, s: Clip['style'], depth = 0): Style {
  if (s === undefined || depth > 8) return {};
  if (typeof s === 'string') {
    const st = (ctx.project.styles ?? []).find((x) => x.id === s) ?? BUILTIN_STYLE_DEFS.find((x) => x.id === s)?.style;
    if (!st) return {};
    const { id: _id, ...rest } = st as Style;
    return { ...resolveStyle(ctx, rest.base as string | undefined, depth + 1), ...rest };
  }
  return { ...resolveStyle(ctx, s.base, depth + 1), ...(s as Style) };
}

function measure(ctx: CommandContext, text: string, st: Style, size: number): number {
  const t = st.uppercase ? text.toUpperCase() : text;
  const m = ctx.services.measureText?.(t, { ...st, size });
  return m ? m.width : t.length * size * (st.uppercase ? 0.62 : 0.55) + t.length * (st.letterSpacing ?? 0);
}

/** Fit a text or captions clip's style to the new width; returns its approximate box (unscaled). */
function fitText(ctx: CommandContext, c: Clip, sx: number, W2: number, scale: number): { w: number; h: number } {
  const st = resolveStyle(ctx, c.style);
  const text = c.captions
    ? (ctx.project.cues ?? []).filter((q) => q.clip === c.id).reduce((m, q) => (q.text.length > m.length ? q.text : m), '')
    : c.text ?? '';
  const size = st.size ?? 72, lh = st.lineHeight ?? 1.2;
  const limit = (0.9 * W2) / scale;
  const changes: Style = {};
  let maxW = st.maxWidth !== undefined ? Math.min(st.maxWidth * sx, limit) : undefined;
  const full = measure(ctx, text, st, size);
  if (maxW === undefined && full > limit) maxW = limit;
  if (st.box) changes.box = [Math.round(Math.min(st.box[0] * sx, limit)), st.box[1]];
  const cap = st.box ? changes.box![0]! : maxW ?? limit;
  const longest = Math.max(0, ...text.split(/\s+/).map((w) => measure(ctx, w, st, size)));
  const newSize = longest > cap ? Math.max(1, Math.floor((size * cap) / longest)) : size;
  if (maxW !== undefined && Math.round(maxW) !== st.maxWidth) changes.maxWidth = Math.round(maxW);
  if (newSize !== size) changes.size = newSize;
  if (Object.keys(changes).length) c.style = typeof c.style === 'string' ? { base: c.style, ...changes } : { ...(c.style ?? {}), ...changes } as Clip['style'];
  const w = (full * newSize) / size;
  const wrap = maxW ?? cap;
  const lines = Math.min(Math.max(1, Math.ceil(w / wrap)), c.captions ? st.maxLines ?? 2 : st.maxLines ?? 99);
  return { w: Math.min(w, wrap), h: lines * newSize * lh };
}

/** Pull a clip whose box leaves the frame back inside the safe area (constants and every keyframe). */
function pullInside(c: Clip, box: { w: number; h: number }, W: number, H: number) {
  const S = safeRect(W, H);
  const [ax, ay] = c.anchor ?? [0.5, 0.5];
  const axis = (key: 'x' | 'y', size: number, a: number, full: number, lo0: number, hi0: number) => {
    const v = c[key] as Num | undefined;
    if (v === undefined) return;
    const out = values(v).some((p) => p - size * a < 0 || p + size * (1 - a) > full);
    if (!out) return;
    const lo = lo0 + size * a, hi = hi0 - size * (1 - a);
    (c as Record<string, unknown>)[key] = mapValue(v, (p) => Math.round(lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, p))));
  };
  axis('x', box.w, ax, W, S.x0, S.x1);
  axis('y', box.h, ay, H, S.y0, S.y1);
}

function scaleOf(c: Clip): [number, number] {
  const s = values(c.scale ?? 1);
  if (Array.isArray(c.scale) && !isKeyframes(c.scale)) return [s[0]!, s[1]!];
  const m = Math.max(...s.map(Math.abs), 0) || 1;
  return [m, m];
}

/** Copy a comp with its tracks, clips, cues and markers under new ids. */
function copyComp(ctx: CommandContext, src: Comp, to: string): { comp: Comp; clipMap: Map<string, string> } {
  if (ctx.project.comps.some((c) => c.id === to)) fail('E_DUPLICATE_ID', `comp "${to}" already exists.`, 'choose another to= id, or omit to= to reframe in place.');
  const comp: Comp = { ...clone(src), id: to };
  ctx.project.comps.push(comp);
  const trackMap = new Map<string, string>(), clipMap = new Map<string, string>();
  const tracks = (ctx.project.tracks ??= []);
  for (const t of tracks.filter((x) => x.comp === src.id)) {
    const id = ctx.newId(`${to}-${t.id}`);
    trackMap.set(t.id, id);
    tracks.push({ ...clone(t), id, comp: to });
  }
  const clips = (ctx.project.clips ??= []);
  const made: Clip[] = [];
  for (const c of clips.filter((x) => trackMap.has(x.track))) {
    const n: Clip = { ...clone(c), id: ctx.newId(`${to}-${c.id}`), track: trackMap.get(c.track)! };
    if (n.link) n.link = `${to}-${n.link}`;
    clipMap.set(c.id, n.id);
    clips.push(n);
    made.push(n);
  }
  for (const n of made) {
    if (n.parent) n.parent = clipMap.get(n.parent) ?? n.parent;
    if (n.matte) n.matte.clip = clipMap.get(n.matte.clip) ?? n.matte.clip;
  }
  const cues = (ctx.project.cues ??= []);
  for (const q of cues.filter((x) => clipMap.has(x.clip))) cues.push({ ...clone(q), id: ctx.newId(`${to}-${q.id}`), clip: clipMap.get(q.clip)! });
  for (const m of (ctx.project.markers ?? []).filter((x) => x.comp === src.id)) ctx.project.markers!.push({ ...clone(m), id: ctx.newId(`${to}-${m.id}`), comp: to });
  return { comp, clipMap };
}

function assetKind(ctx: CommandContext, c: Clip) {
  const a = (ctx.project.assets ?? []).find((x) => x.id === c.asset);
  return a ? { src: a.src, kind: a.kind ?? kindFromExtension(a.src) } : undefined;
}

/** Keyframes that keep a tracked subject centred in a cover-fit media clip. */
async function trackSubject(ctx: CommandContext, comp: Comp, subjectId: string | undefined, oldSize: [number, number]) {
  const [W, H] = comp.size;
  const visual = (ctx.project.clips ?? []).filter((c) => ctx.compOfClip(c).id === comp.id && !ctx.track(c.track).audio && c.asset !== undefined && assetKind(ctx, c)?.kind === 'video');
  let c: Clip | undefined;
  if (subjectId) {
    ctx.clip(subjectId);
    c = visual.find((x) => x.id === subjectId);
    if (!c) fail('E_ARG', `subject "${subjectId}" is not a video clip of comp "${comp.id}".`, `use one of: ${visual.map((x) => x.id).join(', ') || '(none)'}`);
  } else c = [...visual].sort((a, b) => b.len - a.len)[0];
  if (!c) fail('E_NO_SUBJECT', `comp "${comp.id}" has no video clip to track.`, 'add a video clip, or reframe without track=true.');
  if (!ctx.services.trackMotion) fail('E_NO_SERVICE', 'motion tracking is not available here.', 'run through the CLI or the SDK (Project.open), or reframe without track=true.');
  const rate = ctx.rate(comp);
  const src = assetKind(ctx, c)!.src;
  const step = Math.max(1, Math.round(rate.num / rate.den / 6));
  const pts = await ctx.services.trackMotion(src, { fps: rate.num / rate.den / step, inFrames: c.in ?? 0, lenFrames: Math.max(1, srcFrames(c, c.len)), rate });
  if (!pts.length) { ctx.note(`tracking found no frames in "${c.id}"; kept it centred.`); return; }
  const info = ctx.services.probe ? await ctx.services.probe(src) : undefined;
  const [mw, mh] = info?.width && info.height ? [info.width, info.height] : oldSize;
  const [s1, s2] = scaleOf(c);
  const k = Math.max(W / mw, H / mh);
  const sw = mw * k * s1, sh = mh * k * s2;
  const sp = speedOf(c);
  // smooth again (radius 2) so the virtual camera moves gently
  const sm = pts.map((_, i) => {
    const win = pts.slice(Math.max(0, i - 2), i + 3);
    return { frame: pts[i]!.frame, x: win.reduce((a, p) => a + p.x, 0) / win.length, y: win.reduce((a, p) => a + p.y, 0) / win.length };
  });
  const keys = (full: number, size: number, get: (p: { x: number; y: number }) => number) => {
    const room = Math.max(0, (size - full) / 2);
    const out: [number, number][] = [];
    for (const p of sm) {
      const f = sp.num ? Math.round((p.frame * sp.den) / sp.num) : 0;
      const v = Math.round(Math.min(full / 2 + room, Math.max(full / 2 - room, full / 2 - (get(p) - 0.5) * size)));
      if (out.length && out[out.length - 1]![0] === f) continue;
      out.push([f, v]);
    }
    const uniq = new Set(out.map((x) => x[1]));
    return uniq.size === 1 ? out[0]![1] : out;
  };
  c.fit = 'cover';
  delete c.anchor;
  c.x = keys(W, sw, (p) => p.x) as Clip['x'];
  if (sh - H > 1) c.y = keys(H, sh, (p) => p.y) as Clip['y']; else delete c.y;
  ctx.out.tracked = c.id;
  ctx.note(`tracked "${c.id}": ${Array.isArray(c.x) ? c.x.length : 1} x keyframe(s)${Array.isArray(c.y) ? `, ${c.y.length} y` : ''}.`);
}

defineCommand({
  op: 'comp.reframe', group: 'comp', doc: 'Resize a comp (or a copy with to=) to another size or preset and re-lay out its clips: media fills the frame, text and shapes keep their relative place inside the frame; track=true follows the main subject.',
  schema: z.strictObject({ id: Id, size: z.tuple([z.number().int().min(2).max(8192), z.number().int().min(2).max(8192)]).optional(), preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]).optional(), to: Id.optional(), track: z.boolean().optional(), subject: Id.optional() }),
  primary: 'id', example: { id: 'main', preset: 'shorts', to: 'vertical' },
  async apply(ctx, p) {
    const src = ctx.comp(p.id);
    if (!p.size && !p.preset) fail('E_ARG', 'comp.reframe needs size= or preset=.', `presets: ${Object.keys(PRESETS).join(', ')}; e.g. mgl edit <file> comp.reframe ${p.id} preset=shorts`);
    const oldSize: [number, number] = [src.size[0], src.size[1]];
    const size = p.size ?? PRESETS[p.preset!]!.size;
    const copy = p.to ? copyComp(ctx, src, p.to) : undefined;
    const comp = copy?.comp ?? src;
    comp.size = [size[0], size[1]];
    const [W, H] = oldSize, [W2, H2] = comp.size;
    const sx = W2 / W, sy = H2 / H;
    let n = 0;
    for (const c of (ctx.project.clips ?? []).filter((x) => ctx.compOfClip(x).id === comp.id && !ctx.track(x.track).audio)) {
      n++;
      if (c.x !== undefined) c.x = mapValue(c.x, (v) => Math.round(v * sx)) as Clip['x'];
      if (c.y !== undefined) c.y = mapValue(c.y, (v) => Math.round(v * sy)) as Clip['y'];
      const kind = clipKind(c);
      if (kind === 'media' || kind === 'comp') { if (c.fit === undefined && (kind === 'comp' || assetKind(ctx, c)?.kind !== 'audio')) c.fit = 'cover'; continue; }
      if (c.parent !== undefined) continue;
      const [scx, scy] = scaleOf(c);
      let box: { w: number; h: number } | undefined;
      if (kind === 'text' || kind === 'captions') box = fitText(ctx, c, sx, W2, scx);
      else if (kind === 'shape' && c.shape!.size) box = { w: c.shape!.size[0], h: c.shape!.size[1] };
      if (box) pullInside(c, { w: box.w * scx, h: box.h * scy }, W2, H2);
    }
    if (p.track) await trackSubject(ctx, comp, p.subject && (copy?.clipMap.get(p.subject) ?? p.subject), oldSize);
    else if (p.subject) ctx.note('subject= is used only with track=true.');
    ctx.out.id = comp.id;
    ctx.summary(`${p.to ? `copied comp "${src.id}" to "${comp.id}" at` : `reframed comp "${comp.id}" to`} ${W2}x${H2} (from ${W}x${H}); re-laid out ${n} clip(s).`);
  },
});
