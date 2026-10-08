/**
 * Commands: every change to a project is a typed command `{op, ...fields}`.
 * A command's `apply` mutates a draft copy of the project through a context; the change set (patch) is
 * computed by diffing entities, so every command is undoable and dry-runnable without extra code.
 */
import { z } from 'zod';
import { MglError, fail, suggest } from '../errors.js';
import type { ProjectFile, TableName, Clip, Comp, Track, Cue } from '../schema/index.js';
import { TABLES } from '../schema/index.js';
import { parseRate, parseTimeDetailed, type Rate, type TimeInput } from '../time.js';
import { expectedText, foundText, lookupPath } from '../issues.js';

export const TimeArg = z.union([z.number().int(), z.string()]);

/** Services commands may use (injected by the SDK; absent in pure contexts). */
export interface CommandServices {
  /** probe a media file (relative to the project dir) */
  probe?(src: string): Promise<ProbeInfo>;
  /** speech/silence analysis of an audio range of an asset */
  analyzeAudio?(src: string, opts?: { silenceDb?: number; minSilence?: number; envelope?: boolean }): Promise<AudioAnalysis>;
  /** motion-centroid track of a media asset (normalised 0..1 per sampled frame) */
  trackMotion?(src: string, opts: { fps: number; inFrames: number; lenFrames: number; rate: Rate }): Promise<{ frame: number; x: number; y: number }[]>;
  /** read a text file relative to the project dir */
  readText?(path: string): Promise<string>;
  /** templates, effects, transitions, generators, styles known to the plugin registry */
  catalog?: Catalog;
  /** problems loading the project's plugins (path "project.plugins.<name>"), so commands can explain a missing effect/transition */
  pluginProblems?: { code: string; message: string; fix: string; path?: string; severity?: 'error' | 'warning' }[];
  /** text measurement (for layout-aware commands) */
  measureText?(text: string, style: Record<string, unknown>): { width: number; height: number };
  /** (API 1.3) text-to-speech: the first 'speak' provider of the plugin registry; `out` is relative to the project folder (media/generated/...) */
  speak?: SpeakService;
  /** (API 1.3) speech-to-text: the first 'transcribe' provider of the plugin registry; `file` is relative to the project folder */
  transcribe?: TranscribeService;
  /** (API 1.5) open media: every 'stock' provider of the plugin registry, bound to the project folder (media/stock/) */
  stock?: StockService;
  /** (API 1.5) write a report file into the project's work folder .mgl/<name>/; returns its path relative to the cwd */
  writeWork?(name: string, data: Uint8Array): Promise<string>;
  /** (API 1.5) write a .txt or .md file inside the project folder (credits); returns the absolute path */
  writeProjectText?(rel: string, text: string): Promise<string>;
  /** (API 1.5) a sound described as text for an agent that cannot listen (`src` relative to the project folder) */
  describeSound?(src: string): Promise<SoundFacts>;
}

/** (API 1.5) What an agent needs to judge a sound without hearing it. */
export interface SoundFacts {
  duration: number;
  /** integrated loudness (LUFS; -70 or below when the sound is too short to gate, under 0.4 s) and true peak (dBTP) */
  lufs: number;
  peak: number;
  /** the loudest 100 ms RMS (dBFS): the level of sounds too short for LUFS */
  rms?: number;
  /** first audible moment (s): where a hit or whoosh really starts */
  onset: number;
  /** where the sound is loudest (s) */
  peakAt: number;
  /** spectral flatness 0 (pure tone) .. 1 (white noise), and the label */
  flatness: number;
  texture: 'tonal' | 'mixed' | 'noisy';
  /** power-weighted spectral centroid on the log-frequency scale 40 Hz … 11 kHz: 0..1, in Hz, and the label */
  brightness: number;
  centroidHz?: number;
  tone: 'dark' | 'balanced' | 'bright';
  /** music: estimated tempo */
  bpm?: number;
  /** silences inside (s) */
  silences: { start: number; end: number }[];
}

/** (API 1.5) A stock search as commands see it. */
export interface StockService {
  providers: { id: string; describe: string; media: string[]; sources?: string[] }[];
  /** search every provider serving `kind` (or one), in parallel; providers that fail are reported, not fatal */
  search(q: import('../../plugin/api.js').StockQuery & { provider?: string }): Promise<{ items: import('../../plugin/api.js').StockItem[]; failed: { provider: string; error: string }[]; notes: string[] }>;
  /** an item from a recent search (cached for 30 days), else from its provider's item() */
  item(id: string): Promise<import('../../plugin/api.js').StockItem | undefined>;
  /**
   * remember what a search showed and return each item's short handle ("s1", "i3": kind letter + number). Handles are
   * stable in a project: a later search continues the numbering, and an item shown before keeps its handle.
   */
  setShown(kind: string, ids: string[]): Promise<string[]>;
  /** download an item to `rel` (media/stock/<kind>/<name>); refuses HTML error pages; returns bytes and sha256 */
  download(item: import('../../plugin/api.js').StockItem, rel: string): Promise<{ bytes: number; sha256: string }>;
  exists(rel: string): Promise<boolean>;
  /** remove a downloaded file that turned out to be unusable */
  remove(rel: string): Promise<void>;
  /** write the sidecar JSON next to a downloaded file (`rel` ends in .json, inside media/stock/) */
  writeSidecar(rel: string, data: unknown): Promise<void>;
  readSidecar(rel: string): Promise<Record<string, unknown> | undefined>;
  /** a numbered contact sheet (PNG) of the items' previews */
  sheet?(items: import('../../plugin/api.js').StockItem[], handles?: string[]): Promise<Uint8Array | undefined>;
}

/** A word with times in seconds (from a speak or transcribe provider). */
export interface TimedWord { text: string; start: number; end?: number; confidence?: number }

export interface SpeakService {
  id: string;
  describe?: string;
  voices(): Promise<{ id: string; describe?: string; lang?: string }[]>;
  speak(args: { text: string; voice?: string; speed?: number; out: string }): Promise<{ words?: TimedWord[] }>;
}

export interface TranscribeService {
  id: string;
  describe?: string;
  transcribe(args: { file: string; lang?: string }): Promise<{ text: string; words: TimedWord[] }>;
}

/** Which stages an effect implements (API 1.1); absent = unknown (no stage checks). */
export interface EffectStages { draw?: boolean; source?: boolean; audio?: boolean }

export interface Catalog {
  /** `stages` lets fx.add refuse an audio-only effect on a silent clip, or a video-only effect on an audio clip or a bus */
  effects: Map<string, { params?: z.ZodType; describe?: string; stages?: EffectStages }>;
  transitions: Map<string, { params?: z.ZodType; describe?: string }>;
  generators: Map<string, { params?: z.ZodType; describe?: string }>;
  templates: Map<string, TemplateDef>;
  textAnimations?: Map<string, { describe?: string }>;
  styles?: Map<string, { describe?: string; style: Record<string, unknown> }>;
  /** (API 1.3) motion presets by id, for motion.apply (built-ins plus plugins) */
  motionPresets?: Map<string, import('../../plugin/api.js').MotionPresetDef>;
}

export interface TemplateDef {
  id: string;
  describe: string;
  params?: z.ZodType;
  /** build the template's entities; ids are prefixed by the caller */
  build(args: { params: Record<string, unknown>; comp: Comp; rate: Rate; at: number; len?: number; prefix: string; project: ProjectFile }): TemplateOutput;
}

export interface TemplateOutput {
  comps?: Comp[];
  tracks?: Track[];
  clips?: Clip[];
  styles?: ProjectFile['styles'];
  cues?: Cue[];
  /** summary line */
  summary?: string;
}

export interface ProbeInfo {
  kind: 'video' | 'audio' | 'image' | 'subtitles' | 'font' | 'lut' | 'data';
  /** duration in seconds (float, from ffprobe) */
  duration?: number;
  width?: number;
  height?: number;
  fps?: Rate;
  hasAudio?: boolean;
  hasVideo?: boolean;
  codec?: string;
}

export interface AudioAnalysis {
  /** silence ranges in seconds */
  silences: { start: number; end: number }[];
  duration: number;
  /** onset/beat times in seconds, and a tempo estimate */
  beats?: number[];
  bpm?: number;
  /** RMS dBFS per 10 ms (only when asked for with `envelope: true`): word alignment (src/core/align.ts) reads it */
  envelope?: number[];
}

export interface CommandContext {
  project: ProjectFile;
  services: CommandServices;
  /** notes for the result ("rounded 2.51s to frame 75") */
  note(msg: string): void;
  /** the comp an entity lives in */
  compOfTrack(trackId: string): Comp;
  compOfClip(clip: Clip): Comp;
  rate(comp: Comp | string): Rate;
  /** edge time → frames at a comp's rate */
  time(v: TimeInput, comp: Comp | string, what?: string): number;
  clip(id: string): Clip;
  track(id: string): Track;
  comp(id: string): Comp;
  /** a fresh readable id: `base`, `base2`, `base3`, ... */
  newId(base: string): string;
  /** the summary sentence of the command */
  summary(s: string): void;
  /** structured data returned with the result (e.g. created ids) */
  out: Record<string, unknown>;
  /**
   * (API 1.6) Run another command on the same draft, validated like any command: it is part of this command's undo
   * step and dry run. Returns its `out`; its summary is dropped and its notes go to `note` (default: this context's).
   */
  run(cmd: Command, opts?: { note?: (msg: string) => void }): Promise<Record<string, unknown>>;
}

export interface CommandDef<S extends z.ZodObject = z.ZodObject> {
  op: string;
  /** one sentence */
  doc: string;
  schema: S;
  /** the field a bare CLI word fills (`mgl edit p clip.split title at=2s` → id=title) */
  primary?: string;
  /** a working example payload (without op) */
  example: Record<string, unknown>;
  group: string;
  apply(ctx: CommandContext, payload: z.infer<S>): void | Promise<void>;
}

const REGISTRY = new Map<string, CommandDef>();

export function defineCommand<S extends z.ZodObject>(def: CommandDef<S>): CommandDef<S> {
  if (REGISTRY.has(def.op)) throw new Error(`command ${def.op} defined twice`);
  REGISTRY.set(def.op, def as unknown as CommandDef);
  return def;
}

export function getCommand(op: string): CommandDef {
  const c = REGISTRY.get(op);
  if (!c) {
    const dym = suggest(op, REGISTRY.keys());
    fail('E_UNKNOWN_OP', `"${op}" is not a command.`, dym.length ? `did you mean "${dym[0]}"? (list: mgl docs commands)` : 'list the commands with: mgl docs commands', { didYouMean: dym });
  }
  return c;
}

export function listCommands(): CommandDef[] {
  return [...REGISTRY.values()].sort((a, b) => a.op.localeCompare(b.op));
}

// ---------------------------------------------------------------------------
// patches
// ---------------------------------------------------------------------------

export interface EntityChange {
  table: TableName | 'project';
  id: string;
  before?: unknown;
  after?: unknown;
  /** index in the table before (for re-inserting on undo) */
  index?: number;
}

export type Patch = EntityChange[];

export function clone<T>(v: T): T {
  return structuredClone(v);
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
}

export function entityEquals(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

/**
 * The change set between two projects. Entities are compared by content AND by position: a reordered entity (e.g.
 * track.move) is recorded as a removal at its old index followed by an insertion at its new index, so the order is
 * saved, recorded in history, and undone/redone exactly. Removals come first (descending old index), then in-place
 * changes, then insertions (ascending new index); the inverse patch therefore re-inserts in ascending order too.
 */
export function diffProjects(before: ProjectFile, after: ProjectFile): Patch {
  const patch: Patch = [];
  if (!entityEquals(before.project ?? {}, after.project ?? {})) patch.push({ table: 'project', id: 'project', before: before.project, after: after.project });
  for (const t of TABLES) {
    const a = (before[t] as { id: string }[] | undefined) ?? [];
    const b = (after[t] as { id: string }[] | undefined) ?? [];
    const am = new Map(a.map((e, i) => [e.id, { e, i }]));
    const bm = new Map(b.map((e, i) => [e.id, { e, i }]));
    // common entities in their new order; those outside a longest run that keeps the old order have moved
    const common = b.filter((e) => am.has(e.id)).map((e) => e.id);
    const stay = longestIncreasing(common.map((id) => am.get(id)!.i)).map((k) => common[k]!);
    const kept = new Set(stay);
    const removals: EntityChange[] = [], changes: EntityChange[] = [], inserts: EntityChange[] = [];
    for (const [id, { e, i }] of am) {
      const n = bm.get(id);
      if (!n || !kept.has(id)) removals.push({ table: t, id, before: e, index: i });
      else if (!entityEquals(e, n.e)) changes.push({ table: t, id, before: e, after: n.e });
    }
    b.forEach((e, i) => { if (!kept.has(e.id)) inserts.push({ table: t, id: e.id, after: e, index: i }); });
    removals.sort((x, y) => y.index! - x.index!);
    patch.push(...removals, ...changes, ...inserts);
  }
  return patch;
}

/** Indices (into xs) of a longest strictly increasing subsequence. */
function longestIncreasing(xs: number[]): number[] {
  const tails: number[] = [], prev: number[] = new Array(xs.length).fill(-1);
  for (let i = 0; i < xs.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[tails[m]!]! < xs[i]!) lo = m + 1; else hi = m; }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) out.push(k);
  return out.reverse();
}

export function invertPatch(p: Patch): Patch {
  return p.map((c) => ({ ...c, before: c.after, after: c.before })).reverse();
}

/** Apply a patch; `check` verifies that each touched entity is currently in its `before` state. */
export function applyPatch(project: ProjectFile, patch: Patch, check = true): ProjectFile {
  const p = clone(project);
  for (const c of patch) {
    if (c.table === 'project') {
      if (check && !entityEquals(p.project ?? {}, c.before ?? {})) conflict(c);
      if (c.after === undefined) delete p.project; else p.project = clone(c.after) as ProjectFile['project'];
      continue;
    }
    const rows = ((p as Record<string, unknown>)[c.table] as { id: string }[] | undefined) ?? [];
    const idx = rows.findIndex((e) => e.id === c.id);
    if (check) {
      if (c.before === undefined && idx >= 0) conflict(c);
      if (c.before !== undefined && (idx < 0 || !entityEquals(rows[idx], c.before))) conflict(c);
    }
    if (c.after === undefined) { if (idx >= 0) rows.splice(idx, 1); }
    else if (idx >= 0) rows[idx] = clone(c.after) as { id: string };
    else rows.splice(c.index !== undefined ? Math.min(c.index, rows.length) : rows.length, 0, clone(c.after) as { id: string });
    (p as Record<string, unknown>)[c.table] = rows;
  }
  return p;
}

function conflict(c: EntityChange): never {
  throw new MglError({ code: 'E_HISTORY_CONFLICT', message: `${c.table.replace(/s$/, '')} "${c.id}" was changed since that step (by hand or by another command), so it can't be undone/redone safely.`,
    fix: 'make the change with a new command instead (mgl edit <file> ...), or revert your hand edit of that line first.' });
}

// ---------------------------------------------------------------------------
// running a command
// ---------------------------------------------------------------------------

export interface Command { op: string; [k: string]: unknown }

export function makeContext(project: ProjectFile, services: CommandServices): { ctx: CommandContext; notes: string[]; summaries: string[] } {
  const notes: string[] = [];
  const summaries: string[] = [];
  const ids = () => {
    const s = new Set<string>();
    for (const t of TABLES) for (const e of (project[t] as { id: string }[] | undefined) ?? []) s.add(e.id);
    return s;
  };
  const ctx: CommandContext = {
    project,
    services,
    out: {},
    note: (m) => notes.push(m),
    summary: (m) => summaries.push(m),
    comp(id) {
      const c = project.comps.find((x) => x.id === id);
      if (!c) { const d = suggest(id, project.comps.map((x) => x.id)); fail('E_REF', `comp "${id}" does not exist.`, d.length ? `did you mean "${d[0]}"?` : `comps: ${project.comps.map((x) => x.id).join(', ')}`); }
      return c;
    },
    track(id) {
      const t = (project.tracks ?? []).find((x) => x.id === id);
      if (!t) {
        const all = (project.tracks ?? []).map((x) => x.id); const d = suggest(id, all);
        // creating the named track comes first: a near-miss existing track would put the clip somewhere else
        fail('E_REF', `track "${id}" does not exist.`, `add it: mgl edit <file> track.add id=${id}${/^A\d/.test(id) ? ' audio=true' : ''} (or omit track= to pick a free track)${d.length ? `; or did you mean "${d[0]}"?` : all.length ? `; tracks: ${all.join(', ')}` : ''}`, d.length ? { didYouMean: d } : {});
      }
      return t;
    },
    clip(id) {
      const c = (project.clips ?? []).find((x) => x.id === id);
      if (!c) { const all = (project.clips ?? []).map((x) => x.id); const d = suggest(id, all); fail('E_REF', `clip "${id}" does not exist.`, d.length ? `did you mean "${d[0]}"? (mgl show <file> lists clips)` : 'list clips with: mgl show <file>'); }
      return c;
    },
    compOfTrack(trackId) { return ctx.comp(ctx.track(trackId).comp); },
    compOfClip(clip) { return ctx.compOfTrack(clip.track); },
    rate(comp) { return parseRate((typeof comp === 'string' ? ctx.comp(comp) : comp).fps); },
    time(v, comp, what) {
      const t = parseTimeDetailed(v, ctx.rate(comp), what);
      if (t.rounded) notes.push(`${what ?? 'time'} ${v} rounded to frame ${t.frames}.`);
      return t.frames;
    },
    newId(base) {
      const taken = ids();
      const b = base.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'item';
      const stem = /^[A-Za-z0-9]/.test(b) ? b : 'x' + b;
      if (!taken.has(stem)) return stem;
      for (let n = 2; ; n++) if (!taken.has(`${stem}${n}`)) return `${stem}${n}`;
    },
    run: (cmd, o) => runNested(ctx, cmd, o?.note ?? ctx.note),
  };
  return { ctx, notes, summaries };
}

async function runNested(parent: CommandContext, cmd: Command, note: (msg: string) => void): Promise<Record<string, unknown>> {
  const { def, data } = parseCommand(cmd);
  const sub: CommandContext = { ...parent, out: {}, summary: () => {}, note, run: (c, o) => runNested(sub, c, o?.note ?? note) };
  await def.apply(sub, data as never);
  return sub.out;
}

export interface RunResult {
  project: ProjectFile;
  patch: Patch;
  notes: string[];
  summaries: string[];
  out: Record<string, unknown>;
}

/** Validate a command object: its definition and parsed payload, or an E_COMMAND / E_ARG error with a fix. */
function parseCommand(cmd: Command): { def: CommandDef; data: unknown } {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.op !== 'string') fail('E_COMMAND', 'a command is a JSON object with "op", e.g. {"op": "clip.split", "id": "shot1", "at": "2s"}.', 'add "op": "<command>" (list: mgl docs commands).');
  const def = getCommand(cmd.op);
  const { op: _op, ...payload } = cmd;
  const parsed = def.schema.safeParse(payload);
  if (!parsed.success) {
    const issues = [...parsed.error.issues].sort((a, b) => (a.code === 'unrecognized_keys' ? 0 : 1) - (b.code === 'unrecognized_keys' ? 0 : 1));
    const issue = issues[0]!;
    const allowed = Object.keys(def.schema.shape);
    if (issue.code === 'unrecognized_keys') {
      const k = issue.keys[0]!;
      const dym = suggest(k, allowed);
      fail('E_ARG', `${def.op}: "${k}" is not a field of this command.`, dym.length ? `did you mean "${dym[0]}"? fields: ${allowed.join(', ')}` : `fields: ${allowed.join(', ')} (mgl docs ${def.op})`, { didYouMean: dym });
    }
    const field = issue.path.join('.');
    // clip-shaped commands (clip.add, ...) explain a nested field's format instead of showing the generic example
    const hint = 'shape' in def.schema.shape ? fieldHint(issue.path) : undefined;
    const fix = hint ?? `example: ${exampleLine(def)}`;
    if (issue.code === 'invalid_type' || issue.code === 'invalid_union') {
      const at = lookupPath(payload, issue.path);
      if (!at.present) fail('E_ARG', `${def.op}: "${field}" is required.`, fix);
      const want = isTimeField(def, issue.path) ? 'frames (an integer) or a time like "2s"' : expectedText(issue);
      if (want) fail('E_ARG', `${def.op}: "${field}" must be ${want}, found ${foundText(at.value)}.`, fix);
    }
    fail('E_ARG', `${def.op}: ${field ? `"${field}" ` : ''}${issue.message}.`, fix);
  }
  return { def, data: parsed.data };
}

/** Validate a command object and apply it to a copy of `project`. */
export async function runCommand(project: ProjectFile, cmd: Command, services: CommandServices = {}): Promise<RunResult> {
  const { def, data } = parseCommand(cmd);
  const draft = clone(project);
  const { ctx, notes, summaries } = makeContext(draft, services);
  await def.apply(ctx, data as never);
  const patch = diffProjects(project, ctx.project);
  return { project: ctx.project, patch, notes, summaries, out: ctx.out };
}

/** Keyframeable numbers inside a clip (a nested field's error names its own format, not the command's generic example). */
const ANIM_FIELDS: Record<string, true> = { x: true, y: true, rotate: true, opacity: true, gain: true, remap: true, 'shape.trim': true, 'shape.trimStart': true, 'shape.trimOffset': true };

/** A fix line for a nested or animatable field, or undefined to use the command's example. */
export function fieldHint(path: PropertyKey[]): string | undefined {
  const key = path.filter((p) => typeof p === 'string').join('.');
  for (const k of Object.keys(ANIM_FIELDS)) if (key === k || key.startsWith(k + '.')) {
    if (k.startsWith('shape.trim')) {
      return `${k} is a number${k === 'shape.trimOffset' ? ' (a fraction of the outline; 1 = once around)' : ' (a fraction 0..1 of the outline)'} or keyframes [[frame, value, easing?], ...], e.g. ${k}=[[0,0],[30,1,"outCubic"]]. One value per key: animate the start with shape.trimStart and the end with shape.trim.`;
    }
    return `${k} is a number or keyframes [[frame, value, easing?], ...], e.g. ${k}=[[0,0],[15,1,"outCubic"]].`;
  }
  if (key === 'scale' || key.startsWith('scale.')) return 'scale is a number, [sx, sy], or keyframes [[frame, value, easing?], ...], e.g. scale=[[0,1],[30,1.2,"inOutCubic"]].';
  if (key.startsWith('masks')) return 'a mask is {shape: rect|ellipse|path, box: [x, y, w, h] or keyframes [[frame, [x, y, w, h], easing?], ...], ...} (mgl docs mask.add).';
  if (key.startsWith('shape.')) return 'see the shape fields: mgl docs format (type, size, radius, sides, d, points, fill, stroke, strokeWidth, trim, trimStart, trimOffset, lineCap, lineJoin, gradient).';
  return undefined;
}

/** Whether a top-level command field is a TimeArg (optional or not). */
function isTimeField(def: CommandDef, path: PropertyKey[]): boolean {
  if (path.length !== 1) return false;
  let f = (def.schema.shape as Record<string, z.ZodType>)[String(path[0])];
  while (f && f instanceof z.ZodOptional) f = f.unwrap() as z.ZodType;
  return f === TimeArg;
}

export function exampleLine(def: CommandDef): string {
  const parts = Object.entries(def.example).map(([k, v]) => (k === def.primary ? String(v) : `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`));
  return `mgl edit <file> ${def.op} ${parts.join(' ')}`.trim();
}
