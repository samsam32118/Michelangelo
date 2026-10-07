/**
 * The storyboard model: the video as numbered scenes (scene markers, else sentences, else shots, else 5 s chunks),
 * each with its clips sorted into six fixed lanes, plus a diff against the previous storyboard (● changed, words for
 * what changed, moves not counted). Pure: no rendering here; `look` / `show` / the page draw from it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { clipKind, type Clip, type ClipKind, type Cue, type ProjectFile, type TableName } from '../core/schema/index.js';
import { parseRate, rateToNumber, type Rate } from '../core/time.js';
import { stripEmphasis } from '../core/captions.js';
import { isKeyframes } from '../core/load.js';
import { diffProjects, entityEquals } from '../core/commands/registry.js';
import type { Finding } from '../plugin/api.js';

export const LANES = ['picture', 'graphics', 'captions', 'voice', 'music', 'sfx'] as const;
export type Lane = (typeof LANES)[number];
/** At most this many scenes; more are grouped evenly. */
export const MAX_SCENES = 24;
const SMALL_SCALE = 0.85, MIN_FRAGMENT_S = 0.5, CHUNK_S = 5, TEXT_MAX = 30, MAX_LINES = 40, LANE_ROWS = 3;

export interface StoryItem {
  clip: string; track: string; lane: Lane; kind: ClipKind; label: string;
  /** fx types, transition in/out, text animation, keyframed properties */
  marks: string[];
  at: number; len: number;
  /** hidden / muted clip or track: drawn faded, not dropped */
  faded?: boolean;
  /** visual clips: frames [a, b) inside its transitions (cut-centred unless aligned) */
  busy?: [number, number][];
}
export interface StoryScene {
  n: number;
  /** stable across versions: marker id, first cue id, shot clip id, "0-5s"; a split fragment gets ".2", ".3" */
  id: string;
  source: 'marker' | 'sentence' | 'lead' | 'shot' | 'chunk';
  at: number; len: number; label: string;
  /** nothing visual in it yet */
  idea: boolean;
  items: StoryItem[];
  /** cue ids starting in it */
  cues: string[];
  changed: boolean;
  /** what changed, in words (≤ 3, plain first) */
  changes: string[];
  /** frames this scene moved since the previous storyboard (matched by id, then label) */
  movedBy?: number;
  findings: Finding[];
  /** a scene marker's note (its label) */
  note?: string;
  /** starts at or after the end of the comp: planned, not rendered */
  pastEnd?: boolean;
  /** the caption words of the cues starting in it */
  words?: string;
}
/** One block on a lane: a clip, or a caption cue (`cue`, `text`); `row` stacks overlapping tracks (≤ 3 rows a lane). */
export interface LaneSpan { at: number; len: number; clips: string[]; row: number; cue?: string; text?: string; faded?: boolean; tin?: number; tout?: number }
export interface Storyboard {
  comp: string; fps: number; rate: Rate; length: number; size: [number, number];
  scenes: StoryScene[];
  lanes: Record<Lane, LaneSpan[]>;
  /** markers that are not scenes */
  points: { id: string; at: number; note?: string }[];
  /** changes that belong to no scene (comps, project, buses, point markers) */
  notes: string[];
  /** findings with neither a frame nor a clip in any scene */
  unplaced: Finding[];
}

// ---------------------------------------------------------------- basics

function compOf(p: ProjectFile, compId: string) {
  const comp = p.comps.find((c) => c.id === compId);
  if (!comp) throw new Error(`no comp "${compId}"`);
  return comp;
}
/** Comp length in frames ("auto" = end of the last clip). */
export function storyLength(p: ProjectFile, compId: string): number {
  const comp = compOf(p, compId);
  if (typeof comp.length === 'number') return comp.length;
  const tracks = new Set((p.tracks ?? []).filter((t) => t.comp === compId).map((t) => t.id));
  return (p.clips ?? []).reduce((m, c) => (tracks.has(c.track) ? Math.max(m, c.at + c.len) : m), 0);
}
const compClips = (p: ProjectFile, compId: string) => {
  const order = new Map((p.tracks ?? []).filter((t) => t.comp === compId).map((t, i) => [t.id, i]));
  return (p.clips ?? []).filter((c) => order.has(c.track)).sort((a, b) => order.get(a.track)! - order.get(b.track)! || a.at - b.at);
};
const overlaps = (c: { at: number; len: number }, a: number, b: number) => c.at < b && c.at + Math.max(1, c.len) > a;
const isWatermark = (c: Clip) => !!c.tags?.some((t) => /^(role:)?watermark$/i.test(t));
const trunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** First value of `scale` (number, [sx, sy] or keyframes) as one factor (the larger axis). */
function scaleOf(c: Clip): number {
  let v: unknown = c.scale;
  if (v === undefined) return 1;
  if (isKeyframes(v)) v = (v[0] as unknown[])[1];
  if (typeof v === 'number') return Math.abs(v);
  if (Array.isArray(v) && typeof v[0] === 'number') return Math.max(Math.abs(v[0] as number), Math.abs((v[1] as number) ?? 0));
  return 1;
}

/** The lane a clip belongs in: audio by bus (following `to`), visuals by kind and size. */
export function laneOf(p: ProjectFile, c: Clip): Lane {
  const track = (p.tracks ?? []).find((t) => t.id === c.track);
  if (track?.audio) {
    const seen = new Set<string>();
    for (let bus: string | undefined = track.bus ?? 'master'; bus && !seen.has(bus); bus = (p.buses ?? []).find((b) => b.id === bus)?.to) {
      seen.add(bus);
      if (bus === 'dialogue') return 'voice';
      if (bus === 'music') return 'music';
    }
    return 'sfx';
  }
  const kind = clipKind(c);
  if (kind === 'captions') return 'captions';
  if (isWatermark(c)) return 'picture'; // a full-frame overlay (shade, glow, logo bug) belongs to the picture
  if (kind === 'text' || kind === 'shape') return 'graphics';
  return scaleOf(c) < SMALL_SCALE ? 'graphics' : 'picture';
}

/** Short words for a clip: text "…", asset file, gen type, captions "N cues", solid colour, comp id. */
export function clipLabel(p: ProjectFile, c: Clip, cueCount?: number): string {
  switch (clipKind(c)) {
    case 'text': return `"${trunc(oneLine(stripEmphasis(c.text ?? '')), TEXT_MAX - 2)}"`;
    case 'media': { const src = (p.assets ?? []).find((a) => a.id === c.asset)?.src ?? c.asset!; return /^[a-z]+:/.test(src) && !/^[a-z]:[\\/]/i.test(src) ? src : basename(src).replace(/-[0-9a-f]{8,}(?=\.\w+$)/, ''); } // drop a content hash
    case 'gen': return c.gen!.type;
    case 'captions': { const n = cueCount ?? (p.cues ?? []).filter((q) => q.clip === c.id).length; return `${n} cue${n === 1 ? '' : 's'}`; }
    case 'solid': return c.color!;
    case 'comp': return c.comp!;
    case 'shape': return c.shape!.type;
    default: return 'adjustment';
  }
}

function clipMarks(c: Clip): string[] {
  const m: string[] = [];
  for (const f of c.fx ?? []) if (f.enabled !== false) m.push(f.type);
  if (c.transition?.in) m.push(`in ${c.transition.in.type}`);
  if (c.transition?.out) m.push(`out ${c.transition.out.type}`);
  if (c.animate?.in) m.push(`text ${c.animate.in}`);
  if (c.animate?.out) m.push(`text out ${c.animate.out}`);
  const keyed = (['x', 'y', 'scale', 'rotate', 'opacity', 'gain', 'remap'] as const).filter((k) => isKeyframes(c[k]));
  for (const k of ['trim', 'trimStart', 'trimOffset'] as const) if (isKeyframes(c.shape?.[k])) keyed.push(`shape.${k}` as never);
  if (c.masks?.some((mk) => isKeyframes(mk.box))) keyed.push('mask' as never);
  if (keyed.length) m.push(`keys ${keyed.join(',')}`);
  return m;
}

// ---------------------------------------------------------------- scenes

interface Seg { id: string; source: StoryScene['source']; at: number; len: number; label?: string }

const ENDS = /[.!?…]["'”’)\]»]*$/u;

/** Caption cues of the comp in absolute frames (visible part of each captions clip), time order. */
function compCues(p: ProjectFile, compId: string, length: number): { cue: Cue; at: number; end: number; text: string }[] {
  const out: { cue: Cue; at: number; end: number; text: string }[] = [];
  const hiddenTracks = new Set((p.tracks ?? []).filter((t) => t.hidden).map((t) => t.id));
  for (const c of compClips(p, compId)) {
    if (!c.captions || c.hidden || hiddenTracks.has(c.track)) continue;
    for (const q of p.cues ?? []) {
      if (q.clip !== c.id || q.at >= c.len || q.at < 0) continue;
      const at = c.at + q.at;
      if (at >= length) continue;
      out.push({ cue: q, at, end: Math.min(at + q.len, c.at + c.len), text: oneLine(stripEmphasis(q.text)) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Segments [starts[i], starts[i+1]) up to `length`, a lead segment before the first when ≥ minLead (else folded into it). */
function partition(starts: { at: number; id: string; source: Seg['source']; label?: string }[], length: number, minLead: number): Seg[] {
  const s = starts.filter((x, i) => x.at < length && (i === 0 || x.at > starts[i - 1]!.at));
  if (!s.length) return [];
  const segs: Seg[] = [];
  if (s[0]!.at > 0) {
    if (s[0]!.at >= minLead) segs.push({ id: '', source: 'lead', at: 0, len: s[0]!.at });
    else s[0] = { ...s[0]!, at: 0 };
  }
  s.forEach((x, i) => segs.push({ id: x.id, source: x.source, at: x.at, len: (s[i + 1]?.at ?? length) - x.at, label: x.label }));
  return segs;
}

function baseSegments(p: ProjectFile, compId: string, length: number, fps: number): Seg[] {
  const minLead = Math.round(MIN_FRAGMENT_S * fps);
  // 1. sentences
  const cues = compCues(p, compId, length);
  if (cues.length) {
    const starts: { at: number; id: string; source: Seg['source']; label: string }[] = [];
    let cur: { at: number; id: string; words: string[] } | undefined;
    for (const q of cues) {
      cur ??= { at: q.at, id: q.cue.id, words: [] };
      if (q.text) cur.words.push(q.text);
      if (ENDS.test(q.text)) { starts.push({ at: cur.at, id: cur.id, source: 'sentence', label: cur.words.join(' ') }); cur = undefined; }
    }
    if (cur) starts.push({ at: cur.at, id: cur.id, source: 'sentence', label: cur.words.join(' ') });
    return partition(starts, length, minLead);
  }
  // 2. shots: clips on the bottom visible visual track that has clips
  const hidden = new Set((p.tracks ?? []).filter((t) => t.hidden).map((t) => t.id));
  for (const t of (p.tracks ?? []).filter((x) => x.comp === compId && !x.audio && !x.hidden)) {
    const clips = (p.clips ?? []).filter((c) => c.track === t.id && !c.hidden && !hidden.has(c.track) && c.len > 0 && c.at < length && c.at + c.len > 0).sort((a, b) => a.at - b.at);
    if (clips.length) return partition(clips.map((c) => ({ at: Math.max(0, c.at), id: c.id, source: 'shot' as const })), length, minLead);
  }
  // 3. chunks
  const step = Math.max(1, Math.round(CHUNK_S * fps)), segs: Seg[] = [];
  for (let a = 0, i = 0; a < length; a += step, i++) segs.push({ id: `${i * CHUNK_S}-${(i + 1) * CHUNK_S}s`, source: 'chunk', at: a, len: Math.min(step, length - a) });
  return segs;
}

/** [a, b) minus the union of `cover`, as ranges. */
function subtract(a: number, b: number, cover: [number, number][]): [number, number][] {
  let parts: [number, number][] = [[a, b]];
  for (const [x, y] of cover) parts = parts.flatMap(([u, v]): [number, number][] => (y <= u || x >= v ? [[u, v]] : [...(x > u ? [[u, x] as [number, number]] : []), ...(y < v ? [[y, v] as [number, number]] : [])]));
  return parts;
}

const fmtS = (f: number, fps: number) => `${(f / fps).toFixed(1)}`;
const rangeText = (at: number, len: number, fps: number) => `${fmtS(at, fps)}–${fmtS(at + len, fps)}s`;

/** The text of the topmost text clip that covers at least half of [a, b) or starts in it (watermarks excluded). */
function textLabel(clips: Clip[], a: number, b: number): string | undefined {
  let best: Clip | undefined;
  for (const c of clips) {
    if (c.text === undefined || c.hidden || isWatermark(c) || !overlaps(c, a, b)) continue;
    const cover = Math.min(b, c.at + c.len) - Math.max(a, c.at);
    if (cover * 2 >= b - a || (c.at >= a && c.at < b)) best = c; // later = higher in the stack (clips sorted by track)
  }
  return best ? trunc(oneLine(stripEmphasis(best.text!)), 60) : undefined;
}

/**
 * The scenes of a comp, in time order and numbered from 1: sentences / shots / chunks, overlaid by markers with
 * `scene: true` (base scenes are clipped around them; a piece under 0.5 s merges into the scene it touches). More than 24 are grouped.
 */
export function deriveScenes(p: ProjectFile, compId: string): StoryScene[] {
  const comp = compOf(p, compId), fps = rateToNumber(parseRate(comp.fps)), length = storyLength(p, compId);
  const clips = compClips(p, compId), minFrag = Math.round(MIN_FRAGMENT_S * fps);
  // scene markers tile: one that overlaps an earlier one starts where it ends (one inside another gets no scene)
  const markers: { id: string; at: number; end: number; note?: string }[] = [];
  for (const m of (p.markers ?? []).filter((x) => x.comp === compId && x.scene && (x.len ?? 0) > 0).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    const at = Math.max(m.at, markers.at(-1)?.end ?? -Infinity), end = m.at + m.len!;
    if (end > at) markers.push({ id: m.id, at, end, ...(m.note ? { note: oneLine(m.note) } : {}) });
  }
  const cover = markers.map((m): [number, number] => [m.at, m.end]);
  let segs: (Seg & { base?: string; cut?: boolean; note?: string })[] = markers.map((m) => ({ id: m.id, source: 'marker', at: m.at, len: m.end - m.at, label: m.note ?? m.id, ...(m.note ? { note: m.note } : {}) }));
  for (const s of baseSegments(p, compId, length, fps)) {
    const parts = subtract(s.at, s.at + s.len, cover).filter(([a, b]) => b > a);
    const cut = parts.length !== 1 || parts[0]![1] - parts[0]![0] !== s.len;
    parts.forEach(([a, b], i) => segs.push({ ...s, at: a, len: b - a, id: (s.id || '') + (i ? `.${i + 1}` : ''), base: `${s.source}:${s.id}@${s.at}`, cut }));
  }
  segs.sort((a, b) => a.at - b.at || (a.source === 'marker' ? -1 : 0) - (b.source === 'marker' ? -1 : 0));
  // a cut-off piece under 0.5 s merges into the scene it touches (its own other piece, else the marker), so scenes leave no gaps
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (!s.cut || s.len >= minFrag) continue;
    const prev = segs[i - 1], next = segs[i + 1];
    const okPrev = prev && prev.at + prev.len === s.at, okNext = next && next.at === s.at + s.len;
    const rank = (x: typeof s) => (x.base === s.base ? 2 : x.source === 'marker' ? 1 : 0); // own piece, then the marker that cut it
    const into = okPrev && okNext ? (rank(next!) > rank(prev!) ? next : prev) : okPrev ? prev : okNext ? next : undefined;
    if (!into) continue;
    if (into === next) { next!.len += next!.at - s.at; next!.at = s.at; } else prev!.len += s.len;
    segs.splice(i--, 1);
  }
  segs = segs.filter((s) => !s.cut || s.len >= 1);
  // labels and ids of segments that have none of their own
  for (const s of segs) {
    const shotClip = s.source === 'shot' ? s.id.replace(/\.\d+$/, '') : undefined;
    s.label ??= textLabel(clips, s.at, s.at + s.len) ?? shotClip ?? rangeText(s.at, s.len, fps);
    if (!s.id || s.id.startsWith('.')) {
      const t = clips.find((c) => c.text !== undefined && !isWatermark(c) && overlaps(c, s.at, s.at + s.len));
      s.id = (t?.id ?? `${fmtS(s.at, fps)}-${fmtS(s.at + s.len, fps)}s`) + s.id;
    }
  }
  // group into at most 24
  let groups: (Seg & { note?: string })[][] = segs.map((s) => [s]);
  if (segs.length > MAX_SCENES) {
    groups = [];
    for (let g = 0, k = 0; g < MAX_SCENES; g++) { const size = Math.floor(((g + 1) * segs.length) / MAX_SCENES) - Math.floor((g * segs.length) / MAX_SCENES); groups.push(segs.slice(k, k + size)); k += size; }
  }
  const visual = new Set((p.tracks ?? []).filter((t) => t.comp === compId && !t.audio).map((t) => t.id));
  return groups.map((g, i): StoryScene => {
    const first = g[0]!, end = Math.max(...g.map((s) => s.at + s.len)), at = first.at, len = end - at;
    const inside = clips.filter((c) => overlaps(c, at, end));
    return {
      n: i + 1, id: first.id, source: first.source, at, len,
      label: g.length > 1 ? `${first.label} (+${g.length - 1})` : first.label!,
      idea: !inside.some((c) => visual.has(c.track) && !c.hidden),
      items: [], cues: [], changed: false, changes: [], findings: [],
      ...(g.length === 1 && first.note ? { note: first.note } : {}), ...(at >= length ? { pastEnd: true } : {}),
    };
  });
}

/** Frames [a, b) a clip spends inside its in / out transitions. */
function transitionWindows(c: Clip): [number, number][] {
  const w: [number, number][] = [];
  for (const [side, edge] of [['in', c.at], ['out', c.at + c.len]] as const) {
    const t = c.transition?.[side], len = typeof t?.len === 'number' ? t.len : 0;
    if (!t || len <= 0) continue;
    const align = t.align ?? (side === 'out' ? 'end' : 'center'); // an out fades before the clip's end
    const a = align === 'center' ? edge - len / 2 : align === 'start' ? edge : edge - len;
    w.push([Math.floor(a), Math.ceil(a + len)]);
  }
  return w;
}

function sceneItems(p: ProjectFile, compId: string, sc: StoryScene, clips: Clip[]): { items: StoryItem[]; cues: string[]; words?: string } {
  const tracks = new Map((p.tracks ?? []).map((t) => [t.id, t]));
  const end = sc.at + sc.len, items: StoryItem[] = [], cues: string[] = [], words: string[] = [];
  for (const c of clips) {
    if (!overlaps(c, sc.at, end)) continue;
    const t = tracks.get(c.track);
    let n: number | undefined;
    if (c.captions) {
      const qs = (p.cues ?? []).filter((q) => q.clip === c.id && q.at < c.len && c.at + q.at >= sc.at && c.at + q.at < end).sort((a, b) => a.at - b.at);
      n = qs.length;
      cues.push(...qs.map((q) => q.id));
      words.push(...qs.map((q) => oneLine(stripEmphasis(q.text))).filter(Boolean));
    }
    const faded = !!(c.hidden || c.muted || t?.hidden || t?.muted), busy = t?.audio ? [] : transitionWindows(c);
    items.push({ clip: c.id, track: c.track, lane: laneOf(p, c), kind: clipKind(c), label: clipLabel(p, c, n), marks: clipMarks(c), at: c.at, len: c.len, ...(faded ? { faded } : {}), ...(busy.length ? { busy } : {}) });
  }
  items.sort((a, b) => LANES.indexOf(a.lane) - LANES.indexOf(b.lane));
  return { items, cues, ...(words.length ? { words: words.join(' ') } : {}) };
}

/** The storyboard of a comp as it is now (no diff: see diffStoryboard). */
export function buildStoryboard(p: ProjectFile, compId: string): Storyboard {
  const comp = compOf(p, compId), rate = parseRate(comp.fps), length = storyLength(p, compId), clips = compClips(p, compId);
  const scenes = deriveScenes(p, compId);
  for (const sc of scenes) Object.assign(sc, sceneItems(p, compId, sc, clips));
  const lanes = laneSpans(p, clips);
  const points = (p.markers ?? []).filter((m) => m.comp === compId && !m.scene).sort((a, b) => a.at - b.at).map((m) => ({ id: m.id, at: m.at, ...(m.note ? { note: m.note } : {}) }));
  return { comp: compId, fps: rateToNumber(rate), rate, length, size: comp.size, scenes, lanes, points, notes: [], unplaced: [] };
}

/**
 * Each lane's blocks: one per clip (one per cue on captions), split at element boundaries. A track's clips share a
 * row; tracks that overlap stack in rows (bottom of the stack first, ≤ 3 rows, the rest in the last).
 */
function laneSpans(p: ProjectFile, clips: Clip[]): Record<Lane, LaneSpan[]> {
  const lanes = Object.fromEntries(LANES.map((l) => [l, [] as LaneSpan[]])) as Record<Lane, LaneSpan[]>;
  const tracks = new Map((p.tracks ?? []).map((t) => [t.id, t]));
  const rows = new Map<Lane, [number, number][][]>(), rowOf = new Map<string, number>();
  for (const c of clips) {
    if (c.len <= 0) continue;
    const lane = laneOf(p, c), t = tracks.get(c.track), key = `${lane}|${c.track}`;
    let row = rowOf.get(key);
    if (row === undefined) {
      const mine = clips.filter((x) => x.track === c.track && x.len > 0).map((x): [number, number] => [x.at, x.at + x.len]);
      const rs = rows.get(lane) ?? [];
      row = rs.findIndex((r) => !r.some(([a, b]) => mine.some(([x, y]) => x < b && y > a)));
      if (row < 0) row = Math.min(rs.length, LANE_ROWS - 1);
      (rs[row] ??= []).push(...mine);
      rows.set(lane, rs); rowOf.set(key, row);
    }
    const faded = !!(c.hidden || c.muted || t?.hidden || t?.muted);
    const base = { clips: [c.id], row, ...(faded ? { faded } : {}) };
    if (c.captions) {
      for (const q of (p.cues ?? []).filter((x) => x.clip === c.id && x.at >= 0 && x.at < c.len).sort((a, b) => a.at - b.at)) {
        lanes[lane].push({ ...base, at: c.at + q.at, len: Math.max(1, Math.min(q.len, c.len - q.at)), cue: q.id, text: oneLine(stripEmphasis(q.text)) });
      }
      continue;
    }
    const tl = (side: 'in' | 'out') => { const x = c.transition?.[side]?.len; return typeof x === 'number' && x > 0 ? { [side === 'in' ? 'tin' : 'tout']: x } : {}; };
    lanes[lane].push({ ...base, at: c.at, len: c.len, ...tl('in'), ...tl('out') });
  }
  for (const l of LANES) lanes[l].sort((a, b) => a.row - b.row || a.at - b.at);
  return lanes;
}

/** Start, middle and end frame of a scene, clamped into the comp (none for a scene past the end). */
export function sceneMoments(sb: Storyboard, sc: StoryScene): { start: number; middle: number; end: number } | undefined {
  if (sc.at >= sb.length || sb.length <= 0) return undefined;
  const last = Math.min(sb.length, sc.at + sc.len) - 1;
  // step each moment out of a picture transition (a half-pushed frame says little), staying in the scene
  const busy = sb.scenes.flatMap((x) => x.items).filter((i) => i.lane === 'picture' && !i.faded).flatMap((i) => i.busy ?? []); // the next shot's window reaches back
  const clear = (f: number) => {
    const w = busy.find(([a, b]) => f >= a && f < b);
    if (!w) return f;
    const opts = [w[1], w[0] - 1].filter((x) => x >= sc.at && x <= last && !busy.some(([a, b]) => x >= a && x < b));
    return opts.sort((x, y) => Math.abs(x - f) - Math.abs(y - f))[0] ?? f;
  };
  return { start: clear(sc.at), middle: clear(Math.min(last, sc.at + Math.floor(sc.len / 2))), end: clear(last) };
}
/** The middle frame of every scene inside the comp (for the storyboard tiles). */
export const sceneFrames = (sb: Storyboard): number[] => [...new Set(sb.scenes.map((s) => sceneMoments(sb, s)?.middle).filter((f): f is number => f !== undefined))];

// ---------------------------------------------------------------- findings

const sceneAt = (sb: Storyboard, f: number) => sb.scenes.find((s) => f >= s.at && f < s.at + s.len);

/** Attach findings to scenes: by frame, else every scene with the clip in it; others go to `unplaced`. Returns sb. */
export function assignFindings(sb: Storyboard, findings: Finding[]): Storyboard {
  for (const s of sb.scenes) s.findings = [];
  sb.unplaced = [];
  for (const f of findings) {
    const byFrame = f.frame !== undefined ? sceneAt(sb, f.frame) : undefined;
    const targets = byFrame ? [byFrame] : f.clip ? sb.scenes.filter((s) => s.items.some((i) => i.clip === f.clip)) : [];
    if (targets.length) for (const s of targets) s.findings.push(f); else sb.unplaced.push(f);
  }
  return sb;
}

// ---------------------------------------------------------------- diff

/** A recorded edit: `at` when made, `stepped` when last undone or redone (both stacks count). */
export interface HistoryLike { at: string; stepped?: string; patch: { table: string; id: string }[] }
type Change = { table: TableName | 'project'; id: string; before?: Record<string, unknown>; after?: Record<string, unknown> };

const num = (v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : undefined);
const show = (v: unknown) => (typeof v === 'string' ? trunc(v, 20) : num(v) ?? (v === undefined ? '—' : 'set'));
/** Keys whose values differ (both sides), schema order not needed. */
const diffKeys = (a: Record<string, unknown> = {}, b: Record<string, unknown> = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !entityEquals(a[k], b[k]));

/** Words for a changed clip, plain ones first. */
function clipWords(p: ProjectFile, b: Clip, a: Clip): { words: string[]; edges: boolean } {
  const keys = diffKeys(b as never, a as never).filter((k) => k !== 'at');
  const w: string[] = [];
  const has = (...ks: string[]) => ks.some((k) => keys.includes(k));
  if (has('text')) w.push(a.text === undefined ? `${a.id}: text removed` : `${a.id} now says "${trunc(oneLine(stripEmphasis(a.text)), 24)}"`);
  if (has('style')) w.push(`${a.id} restyled`);
  if (has('asset', 'comp')) w.push(`${a.id} different ${laneOf(p, a) === 'picture' || laneOf(p, a) === 'graphics' ? 'footage' : 'sound'}`);
  if (has('gen')) { const g = b.gen?.type === a.gen?.type ? diffKeys(b.gen as never, a.gen as never).filter((k) => k !== 'type') : []; w.push(g.length ? `${a.id} ${a.gen?.type ?? 'generator'} ${g.slice(0, 2).join(', ')} changed` : `${a.id} now ${a.gen?.type ?? 'not generated'}`); }
  if (has('color')) w.push(`${a.id} colour ${show(b.color)}→${show(a.color)}`);
  if (has('shape')) w.push(`${a.id} shape changed`);
  if (has('in', 'speed', 'remap')) w.push(`${a.id} retimed`);
  if (has('fx', 'masks')) w.push(`${a.id} effects`);
  if (has('transition')) w.push(`${a.id} transition`);
  if (has('gain', 'muted', 'fade')) w.push(`${a.id} volume`);
  if (has('animate')) w.push(`${a.id} animation`);
  if (has('hidden')) w.push(`${a.id} ${a.hidden ? 'hidden' : 'shown'}`);
  for (const k of ['x', 'y', 'scale', 'rotate', 'opacity'] as const) {
    if (!has(k)) continue;
    const x = num(b[k] ?? (k === 'scale' || k === 'opacity' ? 1 : undefined)), y = num(a[k] ?? (k === 'scale' || k === 'opacity' ? 1 : undefined));
    const plain = x !== undefined && y !== undefined ? ({ x: y > x ? 'further right' : 'further left', y: y < x ? 'higher' : 'lower', scale: y > x ? 'bigger' : 'smaller', rotate: 'turned', opacity: y > x ? 'more opaque' : 'fainter' })[k] : 'moved';
    w.push(x !== undefined && y !== undefined ? `${a.id} ${plain} (${k} ${x}→${y})` : `${a.id} ${k === 'opacity' ? 'opacity' : 'motion'} changed`);
  }
  if (has('len')) w.push(`${a.id} ${a.len > b.len ? 'longer' : 'shorter'}`);
  const known = ['text', 'style', 'asset', 'gen', 'color', 'comp', 'shape', 'in', 'speed', 'remap', 'fx', 'masks', 'transition', 'gain', 'muted', 'fade', 'animate', 'hidden', 'x', 'y', 'scale', 'rotate', 'opacity', 'len'];
  for (const k of keys.filter((x) => !known.includes(x))) w.push(`${a.id}: ${k} ${show((b as never)[k])}→${show((a as never)[k])}`);
  // only at/len changed: the edges are what changed (a ripple that carried an edge along is not a change)
  return { words: w, edges: keys.every((k) => k === 'len') };
}

/**
 * The storyboard of `current` with ● on the scenes that changed since `previous` (when given), words for what changed,
 * `movedBy` on scenes that only moved, and global notes for comp / project / bus changes. With `history` (entries
 * newer than `since` count), a change no recorded command touched is marked "(by hand)".
 */
export function diffStoryboard(previous: ProjectFile | undefined, current: ProjectFile, compId: string, history?: HistoryLike[], since?: string): Storyboard {
  const sb = buildStoryboard(current, compId);
  if (!previous) return sb;
  const prevSb = previous.comps.some((c) => c.id === compId) ? buildStoryboard(previous, compId) : undefined;
  // match scenes across versions: id, then label
  const prevById = new Map(prevSb?.scenes.map((s) => [s.id, s]) ?? []), prevByLabel = new Map(prevSb?.scenes.map((s) => [s.label, s]) ?? []);
  const matched = new Map<StoryScene, StoryScene>();
  for (const s of sb.scenes) {
    const m = prevById.get(s.id) ?? prevByLabel.get(s.label);
    if (m) { matched.set(s, m); if (m.at !== s.at) s.movedBy = s.at - m.at; }
  }
  const touched = history ? new Set(history.filter((h) => since === undefined || h.at > since || (h.stepped ?? '') > since).flatMap((h) => h.patch.map((c) => `${c.table}:${c.id}`))) : undefined;
  const byHand = (c: Change, w: string) => (touched && !touched.has(`${c.table}:${c.id}`) ? `${w} (by hand)` : w);

  // collapse the patch to one before/after per entity; reorders with equal content are not changes
  const changes = new Map<string, Change>();
  for (const c of diffProjects(previous, current)) {
    const k = `${c.table}:${c.id}`, e = changes.get(k);
    if (!e) changes.set(k, { table: c.table, id: c.id, before: c.before as never, after: c.after as never });
    else { if (c.before !== undefined && e.before === undefined) e.before = c.before as never; if (c.after !== undefined) e.after = c.after as never; }
  }
  for (const [k, c] of changes) if (c.before !== undefined && c.after !== undefined && entityEquals(c.before, c.after)) changes.delete(k);

  const words = new Map<StoryScene, { w: string; rank: number }[]>();
  const fps = sb.fps, note = (w: string) => { if (!sb.notes.includes(w)) sb.notes.push(w); };
  // a change where no scene is now (past the end, a removed last shot or idea) is still reported, as a note
  const mark = (a: number, b: number, w: string, rank: number) => {
    const hit = sb.scenes.filter((s) => (b > a ? overlaps(s, a, b) : a >= s.at && a < s.at + s.len));
    if (!hit.length) note(`${w} (${b > a ? rangeText(a, b - a, fps) : `${fmtS(a, fps)}s`}, no scene there now)`);
    for (const s of hit) { const l = words.get(s) ?? []; l.push({ w, rank }); words.set(s, l); }
  };
  const markScene = (s: StoryScene | undefined, w: string, rank: number) => { if (s) { const l = words.get(s) ?? []; l.push({ w, rank }); words.set(s, l); } else note(w); };
  // a change of start by d is a ripple when the scene now holding it moved by d and kept its length
  const rippled = (f: number, d: number) => { const s = sceneAt(sb, Math.max(0, f)), m = s && matched.get(s); return !!m && s!.movedBy === d && m.len === s!.len; };

  const trackComp = (p: ProjectFile, track: string) => (p.tracks ?? []).find((t) => t.id === track)?.comp;
  const inComp = (p: ProjectFile, c: Clip | undefined) => !!c && trackComp(p, c.track) === compId;
  const nestedHolders = (comp: string | undefined) => (comp ? compClips(current, compId).filter((c) => c.comp === comp) : []);
  const clipSpan = (c: Clip) => [c.at, c.at + c.len] as const;
  const scenesOf = (p: ProjectFile, pred: (c: Clip) => boolean) => (p.clips ?? []).filter((c) => inComp(p, c) && pred(c));

  for (const c of changes.values()) {
    const b = c.before as never, a = c.after as never;
    switch (c.table) {
      case 'clips': {
        const cb = b as Clip | undefined, ca = a as Clip | undefined;
        if (!inComp(previous, cb) && !inComp(current, ca)) {
          // a clip inside a nested comp: the clips that show that comp changed
          const comp = trackComp(current, (ca ?? cb)!.track) ?? trackComp(previous, (ca ?? cb)!.track);
          for (const h of nestedHolders(comp)) mark(...clipSpan(h), byHand(c, `${h.id}: contents changed`), 3);
          break;
        }
        if (!cb || !inComp(previous, cb)) { mark(...clipSpan(ca!), byHand(c, `new ${clipLabel(current, ca!)}`), 0); break; }
        if (!ca || !inComp(current, ca)) { mark(...clipSpan(cb), byHand(c, `removed ${clipLabel(previous, cb)}`), 0); break; }
        const { words: w, edges } = clipWords(current, cb, ca);
        const d = ca.at - cb.at, move = d !== 0 && !rippled(ca.at, d) && (!w.length || !edges);
        if (move) { const t = byHand(c, `${ca.id} moved (${fmtS(cb.at, fps)}s→${fmtS(ca.at, fps)}s)`); mark(...clipSpan(cb), t, 1); mark(...clipSpan(ca), t, 1); } // where it was and where it is
        if (!w.length) break;
        if (edges) {
          // only the length (and maybe the start) changed: the scenes at the edges that moved, unless a ripple carried them
          for (const [o, n, end] of [[cb.at, ca.at, false], [cb.at + cb.len, ca.at + ca.len, true]] as const) {
            if (o === n) continue;
            const s = sceneAt(sb, Math.max(0, end ? n - 1 : n));
            if (s && s.movedBy === n - o) continue;
            mark(Math.min(o, n), Math.max(o, n), byHand(c, w[0]!), 2);
          }
        } else w.forEach((x, i) => mark(...clipSpan(ca), byHand(c, x), 1 + i * 0.01 + (x.includes(': ') ? 2 : 0)));
        break;
      }
      case 'cues': {
        const qa = a as Cue | undefined, qb = b as Cue | undefined;
        const abs = (p: ProjectFile, q: Cue | undefined) => { const h = q && (p.clips ?? []).find((x) => x.id === q.clip); return h && inComp(p, h) ? h.at + q!.at : undefined; };
        const at = abs(current, qa), bt = abs(previous, qb);
        if (at === undefined && bt === undefined) break;
        if (!qb || bt === undefined) { mark(at!, at!, byHand(c, 'new caption'), 0); break; }
        if (!qa || at === undefined) { mark(bt, bt, byHand(c, 'removed caption'), 0); break; }
        const keys = diffKeys(qb as never, qa as never).filter((k) => k !== 'at');
        if (at !== bt && !rippled(at, at - bt)) { const w = byHand(c, 'captions retimed'); mark(bt, bt, w, 1); mark(at, at, w, 1); }
        if (!keys.length) break; // only moved (a ripple, or marked above)
        mark(at, at, byHand(c, keys.includes('text') ? 'captions: text changed' : 'captions retimed'), 1);
        break;
      }
      case 'styles': for (const x of scenesOf(current, (k) => k.style === c.id)) mark(...clipSpan(x), byHand(c, `${x.id} restyled`), 1); break;
      case 'assets': for (const x of scenesOf(current, (k) => k.asset === c.id || k.gen?.asset === c.id)) mark(...clipSpan(x), byHand(c, `${x.id} different ${laneOf(current, x) === 'picture' || laneOf(current, x) === 'graphics' ? 'footage' : 'sound'}`), 1); break;
      case 'tracks': {
        const t = (a ?? b) as { id: string; comp: string; hidden?: boolean; muted?: boolean };
        if (t.comp !== compId) { for (const h of nestedHolders(t.comp)) mark(...clipSpan(h), byHand(c, `${h.id}: contents changed`), 3); break; }
        const keys = diffKeys(b, a);
        const w = !b ? 'new track' : !a ? 'track removed' : keys.includes('hidden') ? (t.hidden ? 'hidden' : 'shown') : keys.includes('muted') ? (t.muted ? 'muted' : 'unmuted') : keys.includes('bus') ? 'different bus' : 'track changed';
        for (const x of scenesOf(a ? current : previous, (k) => k.track === c.id)) mark(...clipSpan(x), byHand(c, `${c.id} ${w}`), 2);
        break;
      }
      case 'markers': {
        const m = (a ?? b) as { comp: string; scene?: boolean; at: number; len?: number; note?: string };
        if (m.comp !== compId) break;
        const sa = (a as typeof m | undefined)?.scene, sbf = (b as typeof m | undefined)?.scene;
        if (!sa && !sbf) { sb.notes.push(byHand(c, `marker ${c.id} ${!b ? 'added' : !a ? 'removed' : 'changed'}`)); break; }
        const scene = sb.scenes.find((s) => s.id === c.id);
        if (!b || !sbf) { markScene(scene, byHand(c, 'new scene'), 0); break; }
        if (!a || !sa) { const bm = b as typeof m; mark(bm.at, bm.at + (bm.len ?? 0), byHand(c, `scene ${c.id} removed`), 0); break; }
        const keys = diffKeys(b, a).filter((k) => k !== 'at');
        if (!keys.length) break;
        markScene(scene, byHand(c, keys.includes('note') ? 'renamed' : keys.includes('len') ? ((a as typeof m).len! > (b as typeof m).len! ? 'longer' : 'shorter') : 'scene changed'), 1);
        break;
      }
      case 'comps': {
        const keys = diffKeys(b, a);
        sb.notes.push(byHand(c, !b ? `new comp ${c.id}` : !a ? `removed comp ${c.id}` : `comp ${c.id}: ${keys.map((k) => (k === 'length' ? `length ${show(b[k])}→${show(a[k])}` : k)).join(', ')}`));
        if (c.id !== compId) for (const h of nestedHolders(c.id)) mark(...clipSpan(h), byHand(c, `${h.id}: contents changed`), 3);
        break;
      }
      case 'buses': sb.notes.push(byHand(c, !b ? `new bus ${c.id}` : !a ? `removed bus ${c.id}` : `bus ${c.id}: ${diffKeys(b, a).join(', ')}`)); break;
      case 'project': sb.notes.push(byHand(c, `project: ${diffKeys(b, a).join(', ')}`)); break;
    }
  }
  for (const [s, l] of words) {
    const seen = new Set<string>();
    s.changes = l.sort((x, y) => x.rank - y.rank).map((x) => x.w).filter((w) => !seen.has(w) && !!seen.add(w)).slice(0, 3);
    s.changed = s.changes.length > 0;
  }
  // a scene that is new (no match) is changed even when nothing else said so (e.g. a sentence split)
  for (const s of sb.scenes) if (prevSb && !matched.has(s) && !s.changed) { s.changed = true; s.changes = ['new scene']; }
  return sb;
}

/** The scenes an edit touched (for one line in `mgl edit`). */
export function touchedScenes(before: ProjectFile, after: ProjectFile, compId: string): { n: number; label: string }[] {
  return diffStoryboard(before, after, compId).scenes.filter((s) => s.changed).map((s) => ({ n: s.n, label: s.label }));
}
/** `scenes: 3 "Work in 25-minute blocks", 4 "…"` (empty when none). */
export function touchedLine(list: { n: number; label: string }[]): string {
  if (!list.length) return '';
  const shown = list.slice(0, 4).map((s) => `${s.n} "${trunc(s.label, 40)}"`);
  return `scenes: ${shown.join(', ')}${list.length > 4 ? ` +${list.length - 4} more` : ''}`;
}

// ---------------------------------------------------------------- snapshots

/** Where the storyboard keeps its copy of the project: .mgl/<basename>/storyboard/ next to the file. */
export function storyboardDir(file: string): string {
  const base = basename(file).replace(/\.mgl\.json$|\.json$/, '');
  return join(dirname(resolve(file)), '.mgl', base, 'storyboard');
}
/** The previous storyboard: when it was made, the project it was made from, and the QA findings it showed (⚠ for `show`). */
export function readPrevious(file: string): { at: string; project: ProjectFile; comp?: string; findings?: Finding[] } | undefined {
  const f = join(storyboardDir(file), 'project.json');
  if (!existsSync(f)) return undefined;
  try {
    const v = JSON.parse(readFileSync(f, 'utf8')) as { at?: unknown; project?: unknown; comp?: unknown; findings?: unknown };
    if (typeof v.at !== 'string' || !v.project || typeof v.project !== 'object') return undefined;
    return { at: v.at, project: v.project as ProjectFile, ...(typeof v.comp === 'string' ? { comp: v.comp } : {}), ...(Array.isArray(v.findings) ? { findings: v.findings as Finding[] } : {}) };
  } catch { return undefined; }
}
/** Save the project the next storyboard compares against, with the findings of `comp` it showed. */
export function writeSnapshot(file: string, project: ProjectFile, at = new Date(), qa?: { comp: string; findings: Finding[] }): string {
  const dir = storyboardDir(file);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'project.json');
  const keep = qa?.findings.map(({ rule, severity, message, frame, clip, fix }) => ({ rule, severity, message, ...(frame !== undefined ? { frame } : {}), ...(clip ? { clip } : {}), ...(fix ? { fix } : {}) }));
  writeFileSync(f, JSON.stringify({ at: at.toISOString(), project, ...(qa ? { comp: qa.comp, findings: keep } : {}) }) + '\n');
  return f;
}

// ---------------------------------------------------------------- text levels

const rateNum = (r: Rate | number) => (typeof r === 'number' ? r : rateToNumber(r));

function sceneMarks(s: StoryScene): string[] {
  return [s.idea ? 'idea' : '', s.findings.length ? '⚠' : '', s.changed ? '●' : ''].filter(Boolean).slice(0, 2);
}

function laneWords(s: StoryScene, lane: Lane): string {
  const items = s.items.filter((i) => i.lane === lane);
  if (!items.length) return '—';
  if (lane === 'captions' && s.cues.length) return s.cues.length === 1 ? s.cues[0]! : `${s.cues[0]}–${s.cues[s.cues.length - 1]}`;
  // no file name when it repeats the id (sfx-whoosh2 = sfx-whoosh.wav); a text label keeps its closing quote
  const word = (i: StoryItem) => (i.label === i.clip || i.label.replace(/\.\w+$/, '') === i.clip.replace(/\d+$/, '') ? '' : /^".*"$/.test(i.label) ? `"${trunc(i.label.slice(1, -1), 22)}"` : trunc(i.label, 24));
  const one = (i: StoryItem) => [i.clip, word(i), i.marks[0] ?? '', i.faded ? '(off)' : ''].filter(Boolean).join(' ');
  // the rest by id, so no member hides behind a count
  const rest = items.slice(2).map((i) => i.clip);
  return items.slice(0, 2).map(one).join(', ') + (rest.length ? ` + ${rest.slice(0, 3).join(', ')}${rest.length > 3 ? ` +${rest.length - 3} more` : ''}` : '');
}
/** `3 "Work in…"`, or `6 note "Show a timer"` for a scene marker's note. */
const head = (s: StoryScene, n = 48) => `${s.n} ${s.note ? 'note ' : ''}"${trunc(s.label, n)}"`;
const pastEnd = (s: StoryScene) => (s.pastEnd ? ' (after the end: not in the video)' : '');

/** Level 1 as text: one line per scene, then changes outside scenes, point markers and unplaced findings (≤ 40 lines). */
export function sceneLines(sb: Storyboard, rate: Rate | number = sb.rate): string[] {
  const fps = rateNum(rate);
  const lines = sb.scenes.map((s) => {
    const marks = sceneMarks(s), moved = s.movedBy && !s.changed ? ` (moved ${s.movedBy > 0 ? '+' : ''}${fmtS(s.movedBy, fps)}s)` : '';
    return `${head(s)} ${rangeText(s.at, s.len, fps)}${marks.length ? ' ' + marks.join(' ') : ''}${pastEnd(s)}${moved} | ${LANES.map((l) => `${l} ${laneWords(s, l)}`).join(' | ')}`;
  });
  if (sb.notes.length) lines.push(`changed: ${sb.notes.slice(0, 6).join('; ')}${sb.notes.length > 6 ? ` +${sb.notes.length - 6}` : ''}`);
  if (sb.points.length) lines.push(`markers: ${sb.points.slice(0, 12).map((m) => `${m.id} ${fmtS(m.at, fps)}s${m.note ? ` "${trunc(m.note, 24)}"` : ''}`).join(', ')}${sb.points.length > 12 ? ` +${sb.points.length - 12}` : ''}`);
  for (const f of sb.unplaced.slice(0, Math.max(0, MAX_LINES - lines.length - 1))) lines.push(`⚠ ${f.message}${f.fix ? ` · fix: ${f.fix}` : ''}`);
  if (sb.unplaced.length && lines.length >= MAX_LINES) lines.splice(MAX_LINES - 1, lines.length, `… ${sb.unplaced.length} findings in all`);
  return lines.slice(0, MAX_LINES);
}

/** Level 2 as text: one scene's range, lanes with their items (marks, file line), changes, findings with fixes, moments (≤ 40 lines). */
export function sceneDetail(sb: Storyboard, n: number, rate: Rate | number = sb.rate, lineOf?: (clipId: string) => number | undefined): string[] {
  const fps = rateNum(rate), s = sb.scenes.find((x) => x.n === n);
  if (!s) return [`no scene ${n} (scenes 1–${sb.scenes.length})`];
  const marks = sceneMarks(s);
  const out = [`scene ${head(s, 200)} ${rangeText(s.at, s.len, fps)} (${s.source} ${s.id})${marks.length ? ' ' + marks.join(' ') : ''}${s.movedBy ? ` moved ${s.movedBy > 0 ? '+' : ''}${fmtS(s.movedBy, fps)}s` : ''}`];
  if (s.note) out.push(`note: "${s.note}" (scene marker ${s.id})`);
  if (s.idea) out.push(`idea: nothing visual here yet${s.pastEnd ? '; it starts after the end of the video, so it is not rendered' : ''}`);
  for (const f of s.findings.slice(0, 6)) out.push(`⚠ issue: ${f.message}${f.fix ? ` · fix: ${f.fix}` : ''}`);
  if (s.findings.length > 6) out.push(`… +${s.findings.length - 6} more issues`);
  for (const l of LANES) {
    const items = s.items.filter((i) => i.lane === l);
    if (!items.length) { out.push(`${l}: —`); continue; }
    out.push(`${l}:`);
    for (const i of items.slice(0, 6)) {
      const line = lineOf?.(i.clip);
      out.push(`  ${i.clip} ${i.label !== i.clip ? i.label + ' ' : ''}${rangeText(i.at, i.len, fps)}${i.marks.length ? ' · ' + i.marks.join(' · ') : ''}${i.faded ? ' · off' : ''}${line !== undefined ? ` · line ${line}` : ''}`);
    }
    if (items.length > 6) out.push(`  … +${items.length - 6} more`);
    if (l === 'captions' && s.cues.length) out.push(`  cues ${s.cues.length === 1 ? s.cues[0] : `${s.cues[0]}–${s.cues[s.cues.length - 1]}`}${s.words ? `: "${trunc(s.words, 120)}"` : ''}`);
  }
  if (s.changes.length) out.push(`● changed: ${s.changes.join('; ')}`);
  const m = sceneMoments(sb, s);
  out.push(m ? `moments: start ${m.start} · middle ${m.middle} · end ${m.end} (frames)` : 'moments: — (past the end of the comp)');
  if (out.length > MAX_LINES) out.splice(MAX_LINES - 1, out.length, `… (${out.length - MAX_LINES + 1} lines cut)`);
  return out;
}
