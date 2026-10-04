/** Clip commands: add, set, remove, move, trim, split, ripple-delete, slip, slide, roll, speed, freeze, detach-audio, nest, duplicate, punch-in. */
import { z } from 'zod';
import { fail, suggest } from '../errors.js';
import { defineCommand, TimeArg, type CommandContext } from './registry.js';
import { Easing, Id, inputSchemas, type Clip, type Cue, type Track } from '../schema/index.js';
import { kindFromExtension } from './structure.js';
import { parseSpeed, secondsToNearestFrame } from '../time.js';
import { isKeyframes, ANIMATABLE_CLIP_KEYS } from '../load.js';
import { keyLists } from '../keylists.js';
import { interpolate } from '../../render/keyframes.js';
import { defaultY } from '../../render/evaluate.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function speedOf(c: Clip): { num: number; den: number } {
  return c.speed === undefined ? { num: 1, den: 1 } : parseSpeed(c.speed);
}
/** source frames consumed by `frames` timeline frames at the clip's speed */
export function srcFrames(c: Clip, frames: number): number {
  const s = speedOf(c);
  return Math.floor((frames * s.num) / s.den);
}
export function clipEnd(c: Clip): number { return c.at + c.len; }

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));

/** Source frames (in the units of the clip's `in`) per timeline frame: speed, × childRate/parentRate for a nested comp. */
export function srcRatio(ctx: CommandContext, c: Clip): { num: number; den: number } {
  const s = speedOf(c);
  if (c.comp === undefined) return s;
  const cr = ctx.rate(c.comp), pr = ctx.rate(ctx.compOfClip(c));
  const num = s.num * cr.num * pr.den, den = s.den * cr.den * pr.num;
  const g = gcd(num, den) || 1;
  return { num: num / g, den: den / g };
}

/** Whether the clip's `in` selects what it shows (video/audio media without remap, or a nested comp). */
function usesIn(ctx: CommandContext, c: Clip): boolean {
  if (c.remap !== undefined) return false;
  if (c.comp !== undefined) return true;
  if (c.asset === undefined) return false;
  const a = (ctx.project.assets ?? []).find((x) => x.id === c.asset);
  return (a ? a.kind ?? kindFromExtension(a.src) : undefined) !== 'image';
}

/** Source offset of `frames` timeline frames; `exact` is false when it falls between source frames. */
function srcOffset(ctx: CommandContext, c: Clip, frames: number): { frames: number; exact: boolean } {
  const r = srcRatio(ctx, c);
  return { frames: Math.floor((frames * r.num) / r.den), exact: (frames * r.num) % r.den === 0 };
}

/** Refuse a cut that would fall between two source frames (the second part would show other frames). */
function assertExactCut(ctx: CommandContext, c: Clip, off: number, what: string) {
  if (!usesIn(ctx, c) || srcOffset(ctx, c, off).exact) return;
  const r = srcRatio(ctx, c);
  const step = r.den / gcd(r.num, r.den);
  const lo = Math.floor(off / step) * step, hi = lo + step;
  const opts = [lo, hi].filter((o) => o > 0 && o < c.len).map((o) => c.at + o);
  fail('E_RANGE', `${what} ${c.at + off} falls between two source frames of "${c.id}" (it plays ${r.num}/${r.den} source frames per frame), so the part after it would show different frames.`,
    opts.length ? `use ${opts.join(' or ')} (cuts must be a multiple of ${step} frames from its start ${c.at}).` : `cuts in "${c.id}" must be a multiple of ${step} frames from its start ${c.at}.`);
}

/** The earliest frame a head trim can move the clip's start to without running out of source. */
function earliestStart(ctx: CommandContext, c: Clip): number {
  if (!usesIn(ctx, c)) return c.at - (c.in ?? 0);
  const r = srcRatio(ctx, c);
  const step = r.den / gcd(r.num, r.den);
  const back = Math.floor(((c.in ?? 0) * r.den) / r.num);
  return c.at - Math.floor(back / step) * step;
}

/** Clips of a link group (always includes `c`), unless unlinked. */
export function linked(ctx: CommandContext, c: Clip, unlinked?: boolean): Clip[] {
  if (unlinked || !c.link) return [c];
  return (ctx.project.clips ?? []).filter((x) => x.link === c.link);
}

function clipsOnTrack(ctx: CommandContext, trackId: string): Clip[] {
  return (ctx.project.clips ?? []).filter((c) => c.track === trackId).sort((a, b) => a.at - b.at);
}

function assertUnlocked(ctx: CommandContext, c: Clip) {
  if (c.locked) fail('E_LOCKED', `clip "${c.id}" is locked.`, `unlock it: mgl edit <file> clip.set ${c.id} locked=false`);
  const t = ctx.track(c.track);
  if (t.locked) fail('E_LOCKED', `track "${t.id}" is locked.`, `unlock it: mgl edit <file> track.set ${t.id} locked=false`);
}

/** Shift clip-local keyframes by -delta (used when the clip's start moves but its content must stay put). */
function shiftKeys(c: Clip, delta: number) {
  for (const l of keyLists(c)) l.keys.forEach((kf) => { kf[0] -= delta; });
}

/** Keep keyframes within [0, len) plus the nearest key on each side (so interpolation is unchanged). */
function pruneKeys(c: Clip) {
  const prune = (v: [number, unknown][]) => {
    const inside = v.filter((k) => k[0] >= 0 && k[0] < c.len);
    const before = v.filter((k) => k[0] < 0).pop();
    const after = v.find((k) => k[0] >= c.len);
    const out = [...(before ? [before] : []), ...inside, ...(after ? [after] : [])];
    return out.length ? out : v.slice(0, 1);
  };
  for (const l of keyLists(c)) l.set(prune(l.keys as [number, unknown][]));
}

/** Move a clip's start by delta while keeping its content in place (head trim); refuses when the source runs out. */
function headTrim(ctx: CommandContext, c: Clip, delta: number) {
  if (c.asset !== undefined || c.comp !== undefined) {
    const exact = usesIn(ctx, c);
    if (exact) assertExactCut(ctx, c, delta, 'the new start');
    const nin = (c.in ?? 0) + srcOffset(ctx, c, delta).frames;
    if (nin < 0 && exact) {
      fail('E_RANGE', `"${c.id}" has only ${c.in ?? 0} source frames before its start, so it can't start at ${c.at + delta}.`, `the earliest start of "${c.id}" is ${earliestStart(ctx, c)} (slip it later first to make room: clip.slip ${c.id} by=<frames>).`);
    }
    c.in = Math.max(0, nin);
  }
  c.at += delta;
  c.len -= delta;
  c.clock = (c.clock ?? 0) + delta;
  if (c.clock === 0) delete c.clock;
  shiftKeys(c, delta);
  if (c.captions) shiftCues(ctx, c, -delta);
}

function shiftCues(ctx: CommandContext, c: Clip, delta: number) {
  const cues = (ctx.project.cues ?? []).filter((q) => q.clip === c.id);
  for (const q of cues) q.at += delta;
  ctx.project.cues = (ctx.project.cues ?? []).filter((q) => q.clip !== c.id || (q.at + q.len > 0 && q.at < c.len));
}

/** Ripple: shift every clip on `trackIds` starting at or after `from` by `delta` frames. */
function ripple(ctx: CommandContext, trackIds: Set<string>, from: number, delta: number, except: Set<string> = new Set()) {
  if (!delta) return;
  for (const c of ctx.project.clips ?? []) if (trackIds.has(c.track) && c.at >= from && !except.has(c.id)) c.at += delta;
}

function tracksOfComp(ctx: CommandContext, compId: string): Track[] {
  return (ctx.project.tracks ?? []).filter((t) => t.comp === compId);
}

export function defaultTrack(ctx: CommandContext, audio: boolean, compId?: string): string {
  const comp = compId ?? ctx.project.project?.main ?? (ctx.project.comps.find((c) => c.id === 'main') ?? ctx.project.comps[0]!).id;
  const t = tracksOfComp(ctx, comp).filter((x) => !!x.audio === audio);
  if (t.length) return audio ? t[0]!.id : t[t.length - 1]!.id;
  const tracks = (ctx.project.tracks ??= []);
  const prefix = audio ? 'A' : 'V';
  let n = 1;
  while (tracks.some((x) => x.id === `${prefix}${n}`)) n++;
  const nt: Track = { id: `${prefix}${n}`, comp };
  if (audio) nt.audio = true;
  tracks.push(nt);
  ctx.note(`created track ${nt.id}.`);
  return nt.id;
}

/** A solid colour with no transparency ("#rgb", "#rrggbb", a CSS name; not "transparent", "#rrggbbaa" < ff, rgba()). */
function opaqueColour(c: string): boolean {
  if (c === 'transparent' || c.startsWith('rgba') || c.startsWith('hsla')) return false;
  if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(7).toLowerCase() === 'ff';
  if (/^#[0-9a-fA-F]{4}$/.test(c)) return c.slice(4).toLowerCase() === 'f';
  return true;
}

/**
 * Whether a clip hides everything below it while it plays: an opaque layer filling the frame at rest (no transform
 * moving it, no opacity, masks, matte or blend). Nested comps cover when their background is opaque or one of
 * their own clips covers. A cheap, conservative test used to choose tracks (it never claims coverage it can't see).
 */
export function coversFrame(ctx: CommandContext, c: Clip, depth = 0): boolean {
  if (c.hidden || depth > 8) return false;
  if ((c.blend && c.blend !== 'normal') || c.masks?.length || c.matte) return false;
  if (c.opacity !== undefined && c.opacity !== 1) return false;
  if (c.rotate !== undefined && c.rotate !== 0) return false;
  const comp = ctx.compOfClip(c);
  if (c.x !== undefined && c.x !== comp.size[0] / 2) return false;
  if (c.y !== undefined && c.y !== comp.size[1] / 2) return false;
  if (c.anchor !== undefined && (c.anchor[0] !== 0.5 || c.anchor[1] !== 0.5)) return false;
  if (c.scale !== undefined) {
    const sc = c.scale;
    const ok = typeof sc === 'number' ? sc >= 1 : Array.isArray(sc) && sc.length === 2 && typeof sc[0] === 'number' && typeof sc[1] === 'number' && sc[0] >= 1 && sc[1] >= 1;
    if (!ok) return false;
  }
  if (c.color !== undefined) return opaqueColour(c.color);
  if (c.asset !== undefined) {
    const a = (ctx.project.assets ?? []).find((x) => x.id === c.asset);
    if (!a) return false;
    const kind = a.kind ?? kindFromExtension(a.src);
    const fit = c.fit ?? (kind === 'image' ? 'contain' : 'cover');
    if (fit !== 'cover' && fit !== 'fill') return false;
    if (kind === 'video') return true;
    // images: only formats without alpha
    return kind === 'image' && /\.(jpe?g|bmp)$/i.test(a.src.split('?')[0]!);
  }
  if (c.comp !== undefined) {
    const child = ctx.project.comps.find((x) => x.id === c.comp);
    if (!child) return false;
    if (child.size[0] < comp.size[0] || child.size[1] < comp.size[1]) return false;
    if (child.bg !== undefined && opaqueColour(child.bg)) return true;
    const tracks = new Set(tracksOfComp(ctx, child.id).filter((t) => !t.audio && !t.hidden).map((t) => t.id));
    return (ctx.project.clips ?? []).some((x) => tracks.has(x.track) && coversFrame(ctx, x, depth + 1));
  }
  return false;
}

/** A new track on top of a comp's stack (named V<n>/A<n>), returned by id. */
function newTopTrack(ctx: CommandContext, compId: string, audio: boolean): string {
  const tracks = (ctx.project.tracks ??= []);
  const prefix = audio ? 'A' : 'V';
  let n = 1;
  while (ctx.project.comps.some((x) => x.id === `${prefix}${n}`) || tracks.some((x) => x.id === `${prefix}${n}`) || (ctx.project.clips ?? []).some((x) => x.id === `${prefix}${n}`)) n++;
  const nt: Track = { id: `${prefix}${n}`, comp: compId };
  if (audio) nt.audio = true;
  tracks.push(nt);
  ctx.note(`created track ${nt.id}.`);
  return nt.id;
}

/**
 * The track for a clip spanning [at, at+len) when none was named: `preferred` when it is free; for audio the first
 * free audio track; for visuals the topmost free track ABOVE every opaque full-frame clip playing at that time (so a
 * new overlay is never hidden under, e.g., a nested comp clip), else a new track on top.
 */
export function pickTrack(ctx: CommandContext, compId: string, audio: boolean, at: number, len: number, preferred?: string): string {
  const busy = (tid: string) => (ctx.project.clips ?? []).some((c) => c.track === tid && c.at < at + len && at < clipEnd(c));
  const same = tracksOfComp(ctx, compId).filter((t) => !!t.audio === audio);
  if (audio) {
    if (preferred && !busy(preferred)) return preferred;
    return same.find((t) => !busy(t.id))?.id ?? newTopTrack(ctx, compId, true);
  }
  let floor = -1;
  same.forEach((t, i) => {
    if (t.hidden) return;
    if ((ctx.project.clips ?? []).some((c) => c.track === t.id && c.at < at + len && at < clipEnd(c) && coversFrame(ctx, c))) floor = i;
  });
  const above = same.slice(floor + 1);
  if (preferred && !busy(preferred) && above.some((t) => t.id === preferred)) return preferred;
  const free = [...above].reverse().find((t) => !busy(t.id));
  if (free) {
    if (floor >= 0 && preferred && preferred !== free.id) ctx.note(`put the clip on ${free.id}, above "${(ctx.project.clips ?? []).find((c) => c.track === same[floor]!.id && c.at < at + len && at < clipEnd(c))?.id}" on ${same[floor]!.id} (it fills the frame and would hide it).`);
    return free.id;
  }
  return newTopTrack(ctx, compId, false);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const ClipFields = inputSchemas.Clip.partial().extend({ id: Id.optional(), track: Id.optional(), at: TimeArg.optional(), len: TimeArg.optional() });

defineCommand({
  op: 'clip.add', group: 'clip', doc: 'Add a clip: media (asset or src), text, shape, solid colour, nested comp, captions, adjustment or generator. Missing track/at/len are chosen for you: after=<clip> starts it where that clip ends, on that clip\'s track; with no track a visual clip goes on the topmost free track above any full-frame opaque clip at that time (never hidden under one).',
  schema: ClipFields.extend({ src: z.string().optional(), after: Id.optional() }),
  example: { track: 'T1', at: '2s', len: '3s', text: 'Hello', style: 'title' },
  async apply(ctx, p) {
    const { src, after, ...fields } = p;
    const clip = { ...fields } as Record<string, unknown>;
    if (src) {
      // add (or reuse) the asset in the same step
      const assets = (ctx.project.assets ??= []);
      let a = assets.find((x) => x.src === src);
      if (!a) {
        const stem = src.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();
        a = { id: ctx.newId(stem === fields.id ? `${stem}-${src.split('.').pop()!.toLowerCase()}` : stem), src };
        assets.push(a);
        ctx.note(`added asset "${a.id}" for ${src}.`);
      }
      clip.asset = a.id;
    }
    const asset = clip.asset !== undefined ? (ctx.project.assets ?? []).find((a) => a.id === clip.asset) : undefined;
    if (clip.asset !== undefined && !asset) fail('E_REF', `asset "${String(clip.asset)}" does not exist.`, 'add it with asset.add, or pass src=<path> to clip.add.');
    const kind = asset ? asset.kind ?? kindFromExtension(asset.src) : undefined;
    const isAudio = kind === 'audio';
    // track: given; else the track of the `after` clip (same kind); else the default (topmost visual / first audio)
    const afterClip = after !== undefined ? ctx.clip(after) : undefined;
    const afterTrack = afterClip && clip.track === undefined && !!ctx.track(afterClip.track).audio === isAudio ? afterClip.track : undefined;
    const trackId = (clip.track as string | undefined) ?? afterTrack ?? defaultTrack(ctx, isAudio);
    const comp = ctx.compOfTrack(trackId);
    clip.track = trackId;
    // start: given, after another clip, or the end of the track
    if (clip.at === undefined) {
      if (afterClip) clip.at = clipEnd(afterClip);
      else clip.at = clipsOnTrack(ctx, trackId).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
    } else clip.at = ctx.time(clip.at as string | number, comp, 'at');
    if (clip.len === undefined) {
      let len = ctx.time('3s', comp);
      if (asset && ctx.services.probe && (kind === 'video' || kind === 'audio')) {
        const info = await ctx.services.probe(asset.src);
        if (info.duration) {
          const total = secondsToNearestFrame(info.duration, ctx.rate(comp));
          const inF = clip.in === undefined ? 0 : ctx.time(clip.in as string | number, comp, 'in');
          const s = clip.speed === undefined ? { num: 1, den: 1 } : parseSpeed(clip.speed as number | string);
          len = Math.max(1, Math.floor(((total - inF) * s.den) / Math.max(1, s.num)));
        }
      } else if (clip.comp !== undefined) {
        const nested = ctx.comp(clip.comp as string);
        if (typeof nested.length === 'number') len = Math.round((nested.length * ctx.rate(comp).num * ctx.rate(nested).den) / (ctx.rate(comp).den * ctx.rate(nested).num));
      }
      clip.len = len;
    } else clip.len = ctx.time(clip.len as string | number, comp, 'len');
    const base = (clip.id as string | undefined) ?? (typeof clip.text === 'string' ? clip.text.split(/\s+/).slice(0, 2).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'text'
      : asset ? asset.id : clip.shape ? (clip.shape as { type: string }).type : clip.captions ? 'captions' : clip.comp ? String(clip.comp) : clip.color !== undefined ? 'solid' : clip.adjustment ? 'adjust' : clip.gen ? (clip.gen as { type: string }).type : 'clip');
    if (clip.id !== undefined && (ctx.project.clips ?? []).some((c) => c.id === clip.id)) fail('E_DUPLICATE_ID', `clip "${String(clip.id)}" already exists.`, 'choose another id or omit it.');
    clip.id = clip.id ?? ctx.newId(base);
    // overlap: refuse with a fix (no silent ripple)
    const at = clip.at as number, len = clip.len as number;
    const busy = (tid: string) => clipsOnTrack(ctx, tid).find((c) => c.at < at + len && at < clipEnd(c));
    let hit = busy(trackId);
    if (fields.track === undefined) {
      // no track was named: keep the chosen track when it is free (and, for visuals, not hidden under an opaque
      // full-frame layer); else the topmost free track above such layers, else a new track on top
      clip.track = pickTrack(ctx, comp.id, isAudio, at, len, afterTrack ?? (hit ? undefined : trackId));
      hit = undefined;
    }
    if (hit) fail('E_OVERLAP', `clip would overlap "${hit.id}" (${hit.at}–${clipEnd(hit)}) on track ${trackId}.`, `use at=${clipEnd(hit)}, another track (track=...), or omit at to append.`);
    (ctx.project.clips ??= []).push(clip as Clip);
    ctx.out.id = clip.id;
    ctx.summary(`added clip "${clip.id}" on ${String(clip.track)} at ${at}–${at + len}.`);
  },
});

/** Set a dotted path inside an object; `null` deletes. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    let next = cur[key];
    if (Array.isArray(next) && key === 'fx') {
      const sel = parts[++i]!;
      const fx = next as Record<string, unknown>[];
      const idx = /^\d+$/.test(sel) ? Number(sel) : fx.findIndex((f) => f.type === sel);
      if (idx < 0 || idx >= fx.length) fail('E_PATH', `no effect "${sel}" on this clip.`, `effects: ${fx.map((f, j) => `${j}:${String(f.type)}`).join(', ') || '(none; add one with fx.add)'}`);
      if (i === parts.length - 1) { if (value === null) fx.splice(idx, 1); else fx[idx] = value as Record<string, unknown>; return; }
      cur = fx[idx]!;
      continue;
    }
    if (next === undefined || next === null || typeof next !== 'object') { next = {}; cur[key] = next; }
    cur = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (value === null) delete cur[last]; else cur[last] = value;
}

defineCommand({
  op: 'clip.set', group: 'clip', doc: 'Set clip properties by name or dotted path (y=380, style.color=#ffcc00, fx.blur.radius=8, fx.0.amount=0.5); null resets to the default.',
  schema: z.looseObject({ id: Id }),
  primary: 'id', example: { id: 'title', y: 380, 'style.color': '#ffcc00' },
  apply(ctx, p) {
    const { id, ...props } = p as { id: string } & Record<string, unknown>;
    const c = ctx.clip(id);
    if (!Object.keys(props).length) fail('E_ARG', 'clip.set needs at least one property.', 'example: mgl edit <file> clip.set title y=380 opacity=0.8');
    const allowed = new Set(Object.keys(inputSchemas.Clip.shape));
    for (const [k, v] of Object.entries(props)) {
      const top = k.split('.')[0]!;
      if (!allowed.has(top)) {
        const d = suggest(top, allowed);
        fail('E_ARG', `clip.set: "${top}" is not a clip property.`, d.length ? `did you mean "${d[0]}"?` : 'see: mgl docs format');
      }
      if (['id'].includes(top)) fail('E_ARG', 'clip.set cannot change the id.', `use: mgl edit <file> id.rename ${id} to=<new id>`);
      const cur = (c as Record<string, unknown>)[top];
      if (!k.includes('.') && isKeyframes(cur) && v !== null && !isKeyframes(v) && ANIMATABLE_CLIP_KEYS.includes(top)) {
        fail('E_KEYFRAMED', `clip "${id}" ${top} is animated by keyframes; a constant would discard them.`, `remove them first: mgl edit <file> key.clear ${id} prop=${top} value=${JSON.stringify(v)} (or set a keyframe: key.set ${id} prop=${top} at=<frame> value=${JSON.stringify(v)})`);
      }
      if (top === 'style' && k.includes('.') && typeof c.style === 'string') c.style = { base: c.style };
      if (['at', 'len', 'in', 'clock'].includes(k) && v !== null) {
        (c as Record<string, unknown>)[k] = ctx.time(v as string | number, ctx.compOfClip(c), k);
        continue;
      }
      setPath(c as Record<string, unknown>, k, v);
    }
    ctx.summary(`clip "${id}": set ${Object.keys(props).join(', ')}.`);
  },
});

defineCommand({
  op: 'clip.remove', group: 'clip', doc: 'Remove clips (and their cues); ripple=true closes the gap on their tracks.',
  schema: z.strictObject({ id: Id.optional(), ids: z.array(Id).optional(), ripple: z.boolean().optional(), unlinked: z.boolean().optional() }),
  primary: 'id', example: { id: 'shot2', ripple: true },
  apply(ctx, p) {
    const ids = [...(p.ids ?? []), ...(p.id ? [p.id] : [])];
    if (!ids.length) fail('E_ARG', 'clip.remove needs id or ids.', 'example: mgl edit <file> clip.remove shot2');
    const targets = new Map<string, Clip>();
    // ripple units: a named clip with its link group; the whole group shifts by the named clip's length (keeps sync, like ripple-delete)
    const units: { lead: Clip; tracks: Set<string> }[] = [];
    for (const id of ids) {
      const lead = ctx.clip(id);
      if (targets.has(lead.id)) continue;
      const group = linked(ctx, lead, p.unlinked);
      for (const c of group) { assertUnlocked(ctx, c); targets.set(c.id, c); }
      units.push({ lead, tracks: new Set(group.map((g) => g.track)) });
    }
    ctx.project.clips = (ctx.project.clips ?? []).filter((c) => !targets.has(c.id));
    ctx.project.cues = (ctx.project.cues ?? []).filter((q) => !targets.has(q.clip));
    // ripple from the latest unit backwards so shifts don't affect each other
    if (p.ripple) for (const u of units.sort((a, b) => b.lead.at - a.lead.at)) ripple(ctx, u.tracks, clipEnd(u.lead), -u.lead.len);
    ctx.summary(`removed ${targets.size} clip(s)${p.ripple ? ' with ripple' : ''}: ${[...targets.keys()].slice(0, 6).join(', ')}${targets.size > 6 ? ', ...' : ''}.`);
  },
});

defineCommand({
  op: 'clip.ripple-delete', group: 'clip', doc: 'Remove a clip and close the gap; all=true shifts every track of the comp (keeps sync).',
  schema: z.strictObject({ id: Id, all: z.boolean().optional(), unlinked: z.boolean().optional() }),
  primary: 'id', example: { id: 'shot2' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const group = linked(ctx, c, p.unlinked);
    group.forEach((g) => assertUnlocked(ctx, g));
    const ids = new Set(group.map((g) => g.id));
    ctx.project.clips = (ctx.project.clips ?? []).filter((x) => !ids.has(x.id));
    ctx.project.cues = (ctx.project.cues ?? []).filter((q) => !ids.has(q.clip));
    const comp = ctx.compOfClip(c);
    const tracks = p.all ? new Set(tracksOfComp(ctx, comp.id).map((t) => t.id)) : new Set(group.map((g) => g.track));
    ripple(ctx, tracks, clipEnd(c), -c.len);
    if (p.all) for (const m of ctx.project.markers ?? []) if (m.comp === comp.id && m.at >= clipEnd(c)) m.at -= c.len;
    ctx.summary(`ripple-deleted "${c.id}" (${c.len} frames) on ${p.all ? 'all tracks' : [...tracks].join(', ')}.`);
  },
});

defineCommand({
  op: 'clip.move', group: 'clip', doc: 'Move a clip (and its linked clips) to a new start and/or track.',
  schema: z.strictObject({ id: Id, at: TimeArg.optional(), by: TimeArg.optional(), track: Id.optional(), unlinked: z.boolean().optional() }),
  primary: 'id', example: { id: 'title', at: '4s' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const comp = ctx.compOfClip(c);
    let delta = 0;
    if (p.at !== undefined) delta = ctx.time(p.at, comp, 'at') - c.at;
    if (p.by !== undefined) delta += typeof p.by === 'string' && p.by.startsWith('-') ? -ctx.time(p.by.slice(1), comp, 'by') : ctx.time(p.by, comp, 'by');
    const group = linked(ctx, c, p.unlinked);
    for (const g of group) { assertUnlocked(ctx, g); g.at += delta; if (g.at < 0) fail('E_RANGE', `clip "${g.id}" would start before 0.`, 'use a later time.'); }
    if (p.track) {
      const t = ctx.track(p.track);
      if (t.comp !== ctx.track(c.track).comp) fail('E_ARG', `track "${p.track}" is in another comp.`, 'move clips within one comp; use clip.nest for comps.');
      if (!!t.audio !== !!ctx.track(c.track).audio) fail('E_TRACK_KIND', `track "${p.track}" is ${t.audio ? 'an audio' : 'a visual'} track.`, 'move to a track of the same kind.');
      c.track = p.track;
    }
    for (const g of group) {
      const hit = (ctx.project.clips ?? []).find((x) => x.id !== g.id && x.track === g.track && x.at < clipEnd(g) && g.at < clipEnd(x));
      if (hit) fail('E_OVERLAP', `"${g.id}" would overlap "${hit.id}" (${hit.at}–${clipEnd(hit)}) on ${g.track}.`, `choose at so it fits, another track, or ripple-delete "${hit.id}" first.`);
    }
    ctx.summary(`moved "${c.id}"${group.length > 1 ? ` (+${group.length - 1} linked)` : ''} to ${c.at}${p.track ? ` on ${p.track}` : ''}.`);
  },
});

defineCommand({
  op: 'clip.trim', group: 'clip', doc: 'Trim a clip\'s head (start=) or tail (end= or len=); content stays in place. ripple=true shifts later clips on the track.',
  schema: z.strictObject({ id: Id, start: TimeArg.optional(), end: TimeArg.optional(), len: TimeArg.optional(), ripple: z.boolean().optional(), unlinked: z.boolean().optional() }),
  primary: 'id', example: { id: 'shot1', start: '0.5s', end: '3.5s' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const comp = ctx.compOfClip(c);
    const group = linked(ctx, c, p.unlinked);
    group.forEach((g) => assertUnlocked(ctx, g));
    const oldAt = c.at, oldEnd = clipEnd(c);
    if (p.start !== undefined) {
      const s = ctx.time(p.start, comp, 'start');
      const delta = s - c.at;
      if (delta >= c.len) fail('E_RANGE', `start ${s} is at or after the clip end ${clipEnd(c)}.`, 'choose a start inside the clip.');
      for (const g of group) headTrim(ctx, g, delta);
      if (p.ripple) { for (const g of group) ripple(ctx, new Set([g.track]), oldEnd, -delta, new Set(group.map((x) => x.id))); for (const g of group) g.at -= delta; }
    }
    let newEnd: number | undefined;
    if (p.end !== undefined) newEnd = ctx.time(p.end, comp, 'end');
    if (p.len !== undefined) newEnd = c.at + ctx.time(p.len, comp, 'len');
    if (newEnd !== undefined) {
      if (newEnd <= c.at) fail('E_RANGE', `the end ${newEnd} is not after the start ${c.at}.`, 'choose a later end.');
      const delta = newEnd - clipEnd(c);
      const endBefore = clipEnd(c);
      for (const g of group) { g.len += delta; pruneKeys(g); if (g.captions) ctx.project.cues = (ctx.project.cues ?? []).filter((q) => q.clip !== g.id || q.at < g.len); }
      if (p.ripple) for (const g of group) ripple(ctx, new Set([g.track]), endBefore, delta, new Set(group.map((x) => x.id)));
    }
    if (p.start === undefined && newEnd === undefined) fail('E_ARG', 'clip.trim needs start=, end= or len=.', 'example: mgl edit <file> clip.trim shot1 start=0.5s end=3.5s');
    if (!p.ripple) for (const g of group) {
      const hit = (ctx.project.clips ?? []).find((x) => x.id !== g.id && x.track === g.track && x.at < clipEnd(g) && g.at < clipEnd(x));
      if (hit) fail('E_OVERLAP', `trimmed "${g.id}" would overlap "${hit.id}".`, 'trim less, or pass ripple=true to push later clips.');
    }
    ctx.summary(`trimmed "${c.id}" ${oldAt}–${oldEnd} → ${c.at}–${clipEnd(c)}.`);
  },
});

function splitOne(ctx: CommandContext, c: Clip, at: number, newId?: string): Clip {
  const off = at - c.at;
  assertExactCut(ctx, c, off, 'the cut at');
  const b = structuredClone(c);
  b.id = newId ?? ctx.newId(`${c.id}-2`);
  // first part
  c.len = off;
  pruneKeys(c);
  if (c.fade) c.fade = [c.fade[0], 0];
  if (c.transition?.out) { delete c.transition.out; if (!c.transition.in) delete c.transition; }
  // second part
  b.at = at;
  b.len -= off;
  if (b.asset !== undefined || b.comp !== undefined) b.in = (b.in ?? 0) + srcOffset(ctx, b, off).frames;
  b.clock = (b.clock ?? 0) + off;
  shiftKeys(b, off);
  pruneKeys(b);
  if (b.fade) b.fade = [0, b.fade[1]];
  if (b.transition?.in) { delete b.transition.in; if (!b.transition.out) delete b.transition; }
  if (b.fade && b.fade[0] === 0 && b.fade[1] === 0) delete b.fade;
  if (c.fade && c.fade[0] === 0 && c.fade[1] === 0) delete c.fade;
  ctx.project.clips!.push(b);
  if (c.captions) {
    const cues = ctx.project.cues ?? [];
    const moved: Cue[] = [];
    for (const q of cues.filter((x) => x.clip === c.id)) {
      if (q.at >= off) { q.clip = b.id; q.at -= off; }
      else if (q.at + q.len > off) {
        // a cue spanning the cut is cut too (words split by their offsets)
        const n: Cue = { ...structuredClone(q), id: ctx.newId(`${q.id}-2`), clip: b.id, at: 0, len: q.at + q.len - off };
        q.len = off - q.at;
        if (q.words) {
          const words = q.text.split(/\s+/).filter(Boolean);
          const cutAt = off - q.at;
          const k = Math.max(1, q.words.filter((w) => w < cutAt).length);
          // every word starts before the cut: the cue stays in the first part only (no duplicated word)
          if (k >= words.length) continue;
          n.text = words.slice(k).join(' ');
          n.words = q.words.slice(k).map((w) => Math.max(0, w - cutAt));
          if (!n.words.length) delete n.words;
          q.text = words.slice(0, k).join(' ');
          q.words = q.words.slice(0, k);
        }
        moved.push(n);
      }
    }
    cues.push(...moved);
    ctx.project.cues = cues;
  }
  return b;
}

defineCommand({
  op: 'clip.split', group: 'clip', doc: 'Split a clip (and its linked clips) at a comp time into two; animations keep their clock, so nothing restarts.',
  schema: z.strictObject({ id: Id, at: TimeArg, newId: Id.optional(), unlinked: z.boolean().optional() }),
  primary: 'id', example: { id: 'shot1', at: '2s' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const at = ctx.time(p.at, ctx.compOfClip(c), 'at');
    const made: string[] = [];
    for (const g of linked(ctx, c, p.unlinked)) {
      assertUnlocked(ctx, g);
      if (at <= g.at || at >= clipEnd(g)) {
        if (g === c) fail('E_RANGE', `split point ${at} is not inside "${c.id}" (${c.at}–${clipEnd(c)}).`, `choose a frame between ${c.at + 1} and ${clipEnd(c) - 1}.`);
        continue;
      }
      made.push(splitOne(ctx, g, at, g === c ? p.newId : undefined).id);
    }
    ctx.out.id = made[0];
    ctx.out.created = made;
    ctx.summary(`split "${c.id}" at ${at}: new clip(s) ${made.join(', ')}.`);
  },
});

defineCommand({
  op: 'clip.slip', group: 'clip', doc: 'Slip: shift which part of the source a media clip shows (by= frames or time; negative = earlier), keeping its place on the timeline.',
  schema: z.strictObject({ id: Id, by: TimeArg, unlinked: z.boolean().optional() }),
  primary: 'id', example: { id: 'shot3', by: '1s' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const comp = ctx.compOfClip(c);
    const neg = typeof p.by === 'string' && p.by.trim().startsWith('-');
    const by = neg ? -ctx.time((p.by as string).trim().slice(1), comp, 'by') : ctx.time(p.by, comp, 'by');
    for (const g of linked(ctx, c, p.unlinked)) {
      assertUnlocked(ctx, g);
      if (g.asset === undefined && g.comp === undefined) fail('E_ARG', `"${g.id}" is not a media or comp clip; slip changes the source offset.`, 'use clip.move to move it instead.');
      const nin = (g.in ?? 0) + by;
      if (nin < 0) fail('E_RANGE', `slipping "${g.id}" by ${by} would start before the source (in=${g.in ?? 0}).`, `the most you can slip earlier is ${-(g.in ?? 0)} frames.`);
      g.in = nin;
      if (g.in === 0) delete g.in;
    }
    ctx.summary(`slipped "${c.id}" by ${by} frames (in=${c.in ?? 0}).`);
  },
});

function neighbours(ctx: CommandContext, c: Clip) {
  const list = clipsOnTrack(ctx, c.track);
  const i = list.findIndex((x) => x.id === c.id);
  const prev = list[i - 1], next = list[i + 1];
  return { prev: prev && clipEnd(prev) === c.at ? prev : undefined, next: next && next.at === clipEnd(c) ? next : undefined };
}

defineCommand({
  op: 'clip.roll', group: 'clip', doc: 'Roll the cut at the END of a clip by= frames: this clip gets longer, the adjacent next clip starts later (total length unchanged).',
  schema: z.strictObject({ id: Id, by: TimeArg, unlinked: z.boolean().optional() }),
  primary: 'id', example: { id: 'a', by: 12 },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const comp = ctx.compOfClip(c);
    const neg = typeof p.by === 'string' && p.by.trim().startsWith('-');
    const by = typeof p.by === 'number' ? p.by : neg ? -ctx.time(p.by.trim().slice(1), comp, 'by') : ctx.time(p.by, comp, 'by');
    for (const g of linked(ctx, c, p.unlinked)) {
      const { next } = neighbours(ctx, g);
      if (!next) { if (g === c) fail('E_NO_NEIGHBOUR', `"${c.id}" has no clip right after it on ${c.track}; roll moves a cut between two adjacent clips.`, 'use clip.trim to change one clip.'); continue; }
      assertUnlocked(ctx, g);
      assertUnlocked(ctx, next);
      if (g.len + by <= 0 || next.len - by <= 0) fail('E_RANGE', `rolling by ${by} would make a clip empty.`, `roll by between ${1 - g.len} and ${next.len - 1}.`);
      g.len += by;
      pruneKeys(g);
      headTrim(ctx, next, by);
    }
    ctx.summary(`rolled the cut after "${c.id}" by ${by} frames.`);
  },
});

defineCommand({
  op: 'clip.slide', group: 'clip', doc: 'Slide a clip by= frames between its neighbours: its content and length stay, the previous clip gets longer/shorter and the next one starts later/earlier.',
  schema: z.strictObject({ id: Id, by: TimeArg, unlinked: z.boolean().optional() }),
  primary: 'id', example: { id: 'b', by: -6 },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const comp = ctx.compOfClip(c);
    const neg = typeof p.by === 'string' && p.by.trim().startsWith('-');
    const by = typeof p.by === 'number' ? p.by : neg ? -ctx.time(p.by.trim().slice(1), comp, 'by') : ctx.time(p.by, comp, 'by');
    for (const g of linked(ctx, c, p.unlinked)) {
      const { prev, next } = neighbours(ctx, g);
      for (const x of [g, prev, next]) if (x) assertUnlocked(ctx, x);
      if (prev) { if (prev.len + by <= 0) fail('E_RANGE', `sliding by ${by} would empty "${prev.id}".`, 'slide less.'); prev.len += by; pruneKeys(prev); }
      else if (g.at + by < 0) fail('E_RANGE', 'the clip would start before 0.', 'slide less.');
      if (next) { if (next.len - by <= 0) fail('E_RANGE', `sliding by ${by} would empty "${next.id}".`, 'slide less.'); headTrim(ctx, next, by); }
      g.at += by;
    }
    ctx.summary(`slid "${c.id}" by ${by} frames.`);
  },
});

defineCommand({
  op: 'clip.speed', group: 'clip', doc: 'Change playback speed (2 = twice as fast, "3/2"); keeps the same source range (the clip length changes) unless keep=len.',
  schema: z.strictObject({ id: Id, speed: z.union([z.number().positive(), z.string()]), keep: z.enum(['range', 'len']).optional(), ripple: z.boolean().optional(), unlinked: z.boolean().optional() }),
  primary: 'id', example: { id: 'run', speed: 2 },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const ns = parseSpeed(p.speed);
    if (ns.num === 0) fail('E_SPEED', 'speed 0 would freeze the whole clip.', 'use clip.freeze to hold a frame for a while.');
    const group = linked(ctx, c, p.unlinked);
    group.forEach((g) => assertUnlocked(ctx, g));
    for (const g of group) {
      const os = speedOf(g);
      const oldEnd = clipEnd(g);
      if (p.keep !== 'len') g.len = Math.max(1, Math.round((g.len * os.num * ns.den) / (os.den * ns.num)));
      g.speed = ns.den === 1 ? ns.num : `${ns.num}/${ns.den}`;
      if (g.speed === 1) delete g.speed;
      if (p.ripple) ripple(ctx, new Set([g.track]), oldEnd, clipEnd(g) - oldEnd, new Set([g.id]));
    }
    ctx.summary(`"${c.id}" speed ${p.speed}; length now ${c.len} frames.`);
  },
});

defineCommand({
  op: 'clip.freeze', group: 'clip', doc: 'Freeze the frame shown at comp time at= for len= (a held clip is inserted; later clips on the track and its linked tracks ripple; audio is silent during the hold).',
  schema: z.strictObject({ id: Id, at: TimeArg, len: TimeArg, unlinked: z.boolean().optional() }),
  primary: 'id', example: { id: 'run', at: '3s', len: '1s' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    if (c.asset === undefined && c.comp === undefined) fail('E_ARG', `"${c.id}" is not a media or comp clip.`, 'freeze works on video and nested comps.');
    const comp = ctx.compOfClip(c);
    const at = ctx.time(p.at, comp, 'at');
    const len = ctx.time(p.len, comp, 'len');
    if (len < 1) fail('E_RANGE', `freeze length ${len} is not positive.`, 'give len ≥ 1 frame, e.g. len=1s.');
    if (at < c.at || at > clipEnd(c)) fail('E_RANGE', `at ${at} is not inside "${c.id}" (${c.at}–${clipEnd(c)}).`, 'choose a frame inside the clip.');
    const group = linked(ctx, c, p.unlinked);
    group.forEach((g) => assertUnlocked(ctx, g));
    // the frame on screen at `at` (the last frame when at is the clip end), in clip-local time
    const t = Math.min(at, clipEnd(c) - 1) - c.at;
    const srcFrame = c.remap !== undefined ? Math.max(0, Math.floor(interpolate(c.remap as never, t) as number)) : (c.in ?? 0) + srcOffset(ctx, c, t).frames;
    const hold: Clip = { ...structuredClone(c), id: ctx.newId(`${c.id}-hold`), at, len, in: srcFrame, speed: 0, muted: true };
    delete hold.transition; delete hold.fade; delete hold.link; delete hold.remap;
    // the hold shows one still moment: every animated property is collapsed to its value at that moment
    for (const l of keyLists(hold)) l.set(interpolate(l.keys as never, t));
    hold.clock = (c.clock ?? 0) + t;
    if (hold.clock === 0) delete hold.clock;
    // cut every clip of the link group at `at`, then open a gap of len on all their tracks (linked audio stays in sync, silent during the hold)
    for (const g of group) if (at > g.at && at < clipEnd(g)) splitOne(ctx, g, at);
    ripple(ctx, new Set(group.map((g) => g.track)), at, len);
    ctx.project.clips!.push(hold);
    ctx.out.id = hold.id;
    ctx.summary(`froze "${c.id}" at ${at} for ${len} frames (hold clip "${hold.id}").`);
  },
});

defineCommand({
  op: 'clip.detach-audio', group: 'clip', doc: 'Move a video clip\'s embedded audio to its own clip on an audio track (linked), e.g. for J and L cuts.',
  schema: z.strictObject({ id: Id, track: Id.optional() }),
  primary: 'id', example: { id: 'shotA' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    if (c.asset === undefined) fail('E_ARG', `"${c.id}" is not a media clip.`, 'detach-audio works on video clips with sound.');
    if (ctx.track(c.track).audio) fail('E_ARG', `"${c.id}" is already on an audio track.`, 'detach-audio works on video clips.');
    const already = c.link !== undefined ? (ctx.project.clips ?? []).find((x) => x.id !== c.id && x.link === c.link && x.asset === c.asset && (ctx.project.tracks ?? []).find((t) => t.id === x.track)?.audio) : undefined;
    if (already) fail('E_ARG', `the audio of "${c.id}" is already detached to "${already.id}".`, `edit "${already.id}" instead (move it with clip.move ${already.id} track=<audio track> unlinked=true), or remove it first to detach again.`);
    const comp = ctx.compOfClip(c);
    const track = p.track ?? defaultTrack(ctx, true, comp.id);
    if (!ctx.track(track).audio) fail('E_TRACK_KIND', `track "${track}" is not an audio track.`, 'pass an audio track, or omit track.');
    const link = c.link ?? c.id;
    const a: Clip = { id: ctx.newId(`${c.id}-audio`), track, at: c.at, len: c.len, asset: c.asset, link };
    for (const k of ['in', 'speed', 'gain', 'fade', 'clock'] as const) if (c[k] !== undefined) (a as Record<string, unknown>)[k] = structuredClone(c[k]);
    const hit = clipsOnTrack(ctx, track).find((x) => x.at < clipEnd(a) && a.at < clipEnd(x));
    if (hit) fail('E_OVERLAP', `track ${track} already has "${hit.id}" at that time.`, 'pass another audio track (track=A2) or add one with track.add audio=true.');
    c.link = link;
    c.muted = true;
    delete c.gain;
    ctx.project.clips!.push(a);
    ctx.out.id = a.id;
    ctx.summary(`detached audio of "${c.id}" to "${a.id}" on ${track} (linked as "${link}").`);
  },
});

defineCommand({
  op: 'clip.link', group: 'clip', doc: 'Link clips so edits (move, trim, split, ripple) apply to all of them; ids=[] with link=null unlinks.',
  schema: z.strictObject({ ids: z.array(Id).min(1), link: z.string().nullable().optional() }),
  example: { ids: ['shotA', 'shotA-audio'] },
  apply(ctx, p) {
    const name = p.link === undefined ? p.ids[0]! : p.link;
    for (const id of p.ids) { const c = ctx.clip(id); if (name === null) delete c.link; else c.link = name; }
    ctx.summary(name === null ? `unlinked ${p.ids.join(', ')}.` : `linked ${p.ids.join(', ')} as "${name}".`);
  },
});

defineCommand({
  op: 'clip.nest', group: 'clip', doc: 'Move clips (with their linked clips, unless unlinked=true) into a new comp and replace them with one clip of that comp (pre-compose).',
  schema: z.strictObject({ ids: z.array(Id).min(1), id: Id.optional(), unlinked: z.boolean().optional() }),
  example: { ids: ['badge-bg', 'badge-text'], id: 'badge' },
  apply(ctx, p) {
    if (p.id !== undefined && ctx.project.comps.some((x) => x.id === p.id)) fail('E_DUPLICATE_ID', `comp "${p.id}" already exists.`, 'choose another id or omit it.');
    const named = [...new Set(p.ids)].map((id) => ctx.clip(id));
    const chosen = new Map(named.map((c) => [c.id, c]));
    const added: string[] = [];
    if (!p.unlinked) {
      // keep link groups whole: a group split across comps could no longer be edited together
      for (const c of named) for (const x of linked(ctx, c)) if (!chosen.has(x.id)) { chosen.set(x.id, x); added.push(x.id); }
    } else {
      // unlinked: members inside the nest leave their group; a lone member left outside loses its link too
      for (const c of named) {
        if (!c.link) continue;
        const outside = (ctx.project.clips ?? []).filter((x) => x.link === c.link && !chosen.has(x.id));
        if (!outside.length) continue;
        if (outside.length === 1) delete outside[0]!.link;
        for (const x of chosen.values()) if (x.link === c.link) delete x.link;
      }
    }
    const clips = [...chosen.values()];
    const parentComp = ctx.compOfClip(clips[0]!);
    for (const c of clips) if (ctx.compOfClip(c).id !== parentComp.id) fail('E_ARG', `clip "${c.id}" is in another comp${added.includes(c.id) ? ' (it is linked to a clip you named; pass unlinked=true to leave it out)' : ''}.`, 'nest clips of one comp at a time.');
    clips.forEach((c) => assertUnlocked(ctx, c));
    if (added.length) ctx.note(`also nested linked clip(s) ${added.join(', ')} (pass unlinked=true to leave them out).`);
    const start = Math.min(...clips.map((c) => c.at));
    const end = Math.max(...clips.map(clipEnd));
    const compId = p.id ?? ctx.newId('nest');
    ctx.project.comps.push({ id: compId, size: [...parentComp.size] as [number, number], fps: parentComp.fps, length: end - start });
    const trackMap = new Map<string, string>();
    const parentTracks = tracksOfComp(ctx, parentComp.id);
    for (const t of parentTracks) if (clips.some((c) => c.track === t.id)) {
      const nid = ctx.newId(`${compId}-${t.id}`);
      trackMap.set(t.id, nid);
      const nt: Track = { id: nid, comp: compId };
      if (t.audio) nt.audio = true;
      if (t.bus) nt.bus = t.bus;
      ctx.project.tracks!.push(nt);
    }
    const fromTracks = new Set(clips.map((c) => c.track));
    for (const c of clips) { c.track = trackMap.get(c.track)!; c.at -= start; }
    // the comp clip goes on a visual track that is free over [start, end): the top one the clips came from, else any other, else a new one
    const visual = parentTracks.filter((t) => !t.audio);
    const free = (t: Track) => !(ctx.project.clips ?? []).some((x) => x.track === t.id && x.at < end && start < clipEnd(x));
    const order = [...visual.filter((t) => fromTracks.has(t.id)).reverse(), ...visual.filter((t) => !fromTracks.has(t.id)).reverse()];
    let host = order.find(free);
    if (!host) {
      const tracks = ctx.project.tracks!;
      const main = parentComp.id === (ctx.project.project?.main ?? ctx.project.comps[0]!.id);
      let n = 1;
      while (tracks.some((x) => x.id === (main ? `V${n}` : `${parentComp.id}-V${n}`))) n++;
      host = { id: main ? `V${n}` : `${parentComp.id}-V${n}`, comp: parentComp.id };
      tracks.push(host);
      ctx.note(`created track ${host.id} for the nested comp clip (no visual track was free over ${start}–${end}).`);
    }
    const nc: Clip = { id: ctx.newId(`${compId}-clip`), track: host.id, at: start, len: end - start, comp: compId };
    ctx.project.clips!.push(nc);
    ctx.out.id = nc.id;
    ctx.summary(`nested ${clips.length} clip(s) into comp "${compId}" (clip "${nc.id}" on ${host.id}).`);
  },
});

// ---------------------------------------------------------------------------
// duplicate, punch-in
// ---------------------------------------------------------------------------

/** Fit a source of sw×sh into W×H like the renderer does (contain/cover keep the aspect, fill stretches, none keeps the size). */
function fitSize(sw: number, sh: number, W: number, H: number, fit: string): { w: number; h: number } {
  if (fit === 'fill') return { w: W, h: H };
  if (fit === 'none') return { w: sw, h: sh };
  const s = fit === 'contain' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
  return { w: sw * s, h: sh * s };
}

/**
 * A clip's layer box at scale 1 in comp px (the box `anchor` and clip-space masks refer to), as the renderer sizes it:
 * media fitted to the comp (probed size; the comp size when unknown), a nested comp's size, the comp size for solids,
 * adjustments and generators. `known` is false for text and shapes (their size depends on fonts / geometry).
 */
export async function layerBox(ctx: CommandContext, c: Clip): Promise<{ w: number; h: number; known: boolean; fit?: string }> {
  const comp = ctx.compOfClip(c);
  const [W, H] = comp.size;
  if (c.asset !== undefined) {
    const a = (ctx.project.assets ?? []).find((x) => x.id === c.asset);
    const kind = a ? a.kind ?? kindFromExtension(a.src) : undefined;
    const fit = c.fit ?? (kind === 'image' ? 'contain' : 'cover');
    if (a && ctx.services.probe && !a.src.startsWith('lavfi:') && (kind === 'video' || kind === 'image')) {
      try {
        const info = await ctx.services.probe(a.src);
        if (info.width && info.height) {
          const [l, t, r, b] = c.crop ?? [0, 0, 0, 0];
          return { ...fitSize(Math.max(1, info.width - l - r), Math.max(1, info.height - t - b), W, H, fit), known: true, fit };
        }
      } catch { /* fall back to the comp size, like the renderer */ }
    }
    return { w: W, h: H, known: true, fit };
  }
  if (c.comp !== undefined) { const cc = ctx.comp(c.comp); return { w: cc.size[0], h: cc.size[1], known: true }; }
  if (c.text !== undefined || c.shape !== undefined || c.captions) {
    if (c.shape?.size) return { w: c.shape.size[0], h: c.shape.size[1], known: true };
    return { w: W, h: H, known: false };
  }
  return { w: W, h: H, known: true };
}

/** A constant uniform scale of a clip (keyframes and non-uniform [sx, sy] are refused with a fix). */
function constScale(c: Clip, op: string): number {
  const sc = c.scale ?? 1;
  if (isKeyframes(sc)) fail('E_KEYFRAMED', `clip "${c.id}" scale is animated by keyframes; ${op} writes its own.`, `remove them first: mgl edit <file> key.clear ${c.id} prop=scale`);
  if (Array.isArray(sc)) { if (sc[0] !== sc[1]) fail('E_ARG', `clip "${c.id}" has a non-uniform scale ${JSON.stringify(sc)}.`, `set a uniform scale first: mgl edit <file> clip.set ${c.id} scale=${sc[0]}`); return sc[0] as number; }
  return sc as number;
}

function constNum(c: Clip, key: 'x' | 'y' | 'rotate', def: number, op: string): number {
  const v = c[key];
  if (isKeyframes(v)) fail('E_KEYFRAMED', `clip "${c.id}" ${key} is animated by keyframes; ${op} writes its own.`, `remove them first: mgl edit <file> key.clear ${c.id} prop=${key}`);
  return (v as number | undefined) ?? def;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

defineCommand({
  op: 'clip.duplicate', group: 'clip',
  doc: 'Copy a clip with everything on it (keyframes, effects, masks, transitions, cues of a captions clip): at= its start (default: right after the original, or the same time when track= is given), track= (default: the same track, else a free one), newId=; linked=true also copies its linked clips (same offset, as a new link group).',
  schema: z.strictObject({ id: Id, at: TimeArg.optional(), track: Id.optional(), newId: Id.optional(), linked: z.boolean().optional() }),
  primary: 'id', example: { id: 'title', at: '8s' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const comp = ctx.compOfClip(c);
    const at = p.at !== undefined ? ctx.time(p.at, comp, 'at') : p.track !== undefined ? c.at : clipEnd(c);
    const delta = at - c.at;
    if (p.newId !== undefined && (ctx.project.clips ?? []).some((x) => x.id === p.newId)) fail('E_DUPLICATE_ID', `clip "${p.newId}" already exists.`, 'choose another newId or omit it.');
    const group = p.linked ? linked(ctx, c) : [c];
    // every copy's id up front (parent/matte links inside the group point to the copies)
    const ids = new Map<string, string>();
    const taken = new Set<string>(p.newId ? [p.newId] : []);
    for (const g of [c, ...group.filter((x) => x !== c)]) {
      if (g === c && p.newId) { ids.set(g.id, p.newId); continue; }
      let nid = ctx.newId(`${g.id}-copy`);
      for (let n = 2; taken.has(nid); n++) nid = ctx.newId(`${g.id}-copy${n}`);
      taken.add(nid);
      ids.set(g.id, nid);
    }
    const link = group.length > 1 ? ids.get(c.id)! : undefined;
    const made: Clip[] = [];
    for (const g of group) {
      const n = structuredClone(g);
      n.id = ids.get(g.id)!;
      n.at = g.at + delta;
      if (n.at < 0) fail('E_RANGE', `the copy of "${g.id}" would start at ${n.at}, before 0.`, 'use a later at=.');
      delete n.locked;
      if (link) n.link = link; else delete n.link;
      if (n.parent && ids.has(n.parent)) n.parent = ids.get(n.parent);
      if (n.matte && ids.has(n.matte.clip)) n.matte.clip = ids.get(n.matte.clip)!;
      const audio = !!ctx.track(g.track).audio;
      const busy = (tid: string) => (ctx.project.clips ?? []).find((x) => x.track === tid && x.at < n.at + n.len && n.at < clipEnd(x));
      if (g === c && p.track !== undefined) {
        const t = ctx.track(p.track);
        if (t.comp !== comp.id) fail('E_ARG', `track "${t.id}" is in comp "${t.comp}", not "${comp.id}".`, 'duplicate within one comp (or nest first).');
        if (!!t.audio !== audio) fail('E_TRACK_KIND', `track "${t.id}" is ${t.audio ? 'an audio' : 'a visual'} track.`, 'use a track of the same kind.');
        const hit = busy(t.id);
        if (hit) fail('E_OVERLAP', `the copy would overlap "${hit.id}" (${hit.at}–${clipEnd(hit)}) on ${t.id}.`, `use another at= or track=, or omit track= to pick a free one.`);
        n.track = t.id;
      } else if (busy(g.track)) {
        n.track = pickTrack(ctx, comp.id, audio, n.at, n.len);
      }
      (ctx.project.clips ??= []).push(n);
      made.push(n);
      if (g.captions) {
        const cues = (ctx.project.cues ?? []).filter((q) => q.clip === g.id);
        for (const q of cues) (ctx.project.cues ??= []).push({ ...structuredClone(q), id: ctx.newId(`${q.id}-copy`), clip: n.id });
      }
    }
    ctx.out.id = made[0]!.id;
    ctx.out.created = made.map((m) => m.id);
    ctx.summary(`duplicated "${c.id}" as ${made.map((m) => `"${m.id}" on ${m.track} at ${m.at}`).join(', ')}.`);
  },
});

const Box4 = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]);

defineCommand({
  op: 'clip.punch-in', group: 'clip',
  doc: 'Zoom a clip into a region (box=[x, y, w, h] in comp px as the clip shows now): writes scale/x/y keyframes that ramp in over len= (default 0.5s; 0 = a hard cut) from at= (comp time; local=true for clip-local frames; default the clip start), hold= (default: to the end), then out= ramps back. ease= (default inOutCubic). The zoom shows the whole box centred and is clamped so no edge of the layer shows when it fills the frame (cover-fit media, nested comps).',
  schema: z.strictObject({ id: Id, box: Box4, at: TimeArg.optional(), local: z.boolean().optional(), len: TimeArg.optional(), hold: TimeArg.optional(), out: TimeArg.optional(), ease: Easing.optional() }),
  primary: 'id', example: { id: 'screen', box: [1200, 600, 480, 270], at: '3s', len: '0.6s', hold: '4s', out: '0.6s' },
  async apply(ctx, p) {
    const c = ctx.clip(p.id);
    assertUnlocked(ctx, c);
    const comp = ctx.compOfClip(c);
    const [W, H] = comp.size;
    if (ctx.track(c.track).audio) fail('E_ARG', `"${c.id}" is an audio clip.`, 'punch in on a visual clip.');
    const t0 = p.at === undefined ? 0 : ctx.time(p.at, comp, 'at') - (p.local ? 0 : c.at);
    if (t0 < 0 || t0 >= c.len) fail('E_RANGE', `the punch-in starts at clip frame ${t0}, outside "${c.id}" (0..${c.len - 1}).`, p.local ? 'at= is clip-local with local=true.' : `at= is a comp time between ${c.at} and ${clipEnd(c) - 1} (or pass local=true for clip-local frames).`);
    const len = p.len === undefined ? ctx.time('0.5s', comp) : ctx.time(p.len, comp, 'len');
    const out = p.out === undefined ? undefined : ctx.time(p.out, comp, 'out');
    const hold = p.hold === undefined ? Math.max(0, c.len - t0 - len - (out ?? 0)) : ctx.time(p.hold, comp, 'hold');
    const end = t0 + len + (out !== undefined ? hold + out : 0);
    if (end > c.len) ctx.note(`the punch-in runs to clip frame ${end}, past the end of "${c.id}" (${c.len} frames); the part after the clip end is not seen.`);
    const ease = p.ease ?? 'inOutCubic';
    const s0 = constScale(c, 'clip.punch-in');
    const x0 = constNum(c, 'x', W / 2, 'clip.punch-in');
    const y0 = constNum(c, 'y', defaultY(c, W, H), 'clip.punch-in');
    if (constNum(c, 'rotate', 0, 'clip.punch-in') !== 0) fail('E_ARG', `clip "${c.id}" is rotated; punch-in boxes are axis-aligned.`, `remove the rotation first: mgl edit <file> clip.set ${c.id} rotate=null`);
    const [bx, by, bw, bh] = p.box;
    const k = Math.min(W / bw, H / bh);
    if (k < 1) ctx.note(`the box ${bw}x${bh} is larger than the frame, so this zooms out (${round(k, 3)}x).`);
    const s1 = s0 * k;
    const lb = await layerBox(ctx, c);
    const [ax, ay] = c.anchor ?? [0.5, 0.5];
    let x1 = W / 2 - s1 * ((bx + bw / 2 - x0) / s0);
    let y1 = H / 2 - s1 * ((by + bh / 2 - y0) / s0);
    // keep the frame filled: the layer's edges stay outside the frame wherever the zoomed layer is big enough
    const clamped: string[] = [];
    const clamp = (v: number, size: number, a: number, frame: number, axis: string) => {
      if (s1 * size < frame - 1e-6) return v;
      const lo = frame - s1 * (1 - a) * size, hi = s1 * a * size;
      const r = Math.min(hi, Math.max(lo, v));
      if (Math.abs(r - v) > 0.01) clamped.push(axis);
      return r;
    };
    if (lb.known) { x1 = clamp(x1, lb.w, ax, W, 'x'); y1 = clamp(y1, lb.h, ay, H, 'y'); }
    if (clamped.length) ctx.note(`moved the zoom ${clamped.join(' and ')} so no edge of "${c.id}" shows (the box is near the edge of the picture).`);
    const keys = (base: number, zoom: number) => {
      const out2: [number, number, (typeof ease)?][] = [];
      const push = (f: number, v: number, e?: typeof ease) => {
        const last = out2[out2.length - 1];
        if (last && last[0] === f) { out2[out2.length - 1] = e !== undefined ? [f, v, e] : [f, v]; return; }
        out2.push(e !== undefined ? [f, v, e] : [f, v]);
      };
      if (len > 0) { push(t0, base, ease); push(t0 + len, zoom); } else { if (t0 > 0) push(0, base, 'hold'); push(t0, zoom); }
      if (out !== undefined) {
        const t2 = t0 + len + hold;
        if (out > 0) { push(t2, zoom, ease); push(t2 + out, base); }
        else { const last = out2[out2.length - 1]!; out2[out2.length - 1] = [last[0], last[1], 'hold']; push(Math.max(t2, last[0] + 1), base); }
      }
      return out2.length === 1 ? out2[0]![1] : out2;
    };
    c.scale = keys(round(s0, 4), round(s1, 4)) as never;
    c.x = keys(round(x0, 2), round(x1, 2)) as never;
    c.y = keys(round(y0, 2), round(y1, 2)) as never;
    ctx.summary(`punch-in on "${c.id}": ${round(k, 3)}x into [${p.box.join(', ')}] from clip frame ${t0} (${len}-frame ramp${out !== undefined ? `, hold ${hold}, out ${out}` : ', held to the end'}).`);
  },
});
