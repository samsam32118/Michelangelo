/**
 * The reader: parse (with line numbers) → normalise edge forms (time strings) → validate the schema →
 * check references and semantics. Every problem names its line and a fix.
 */
import { parseTree, findNodeAtLocation, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import type { z } from 'zod';
import { MglError, suggest, type MglErrorInfo } from './errors.js';
import { canonicalSchemas, CLIP_SOURCES, FORMAT_VERSION, TABLES, TIME_FIELDS, clipKind, type ProjectFile, type TableName, type Clip } from './schema/index.js';
import { parseRate, parseTimeDetailed, type Rate } from './time.js';

export interface Problem extends MglErrorInfo {
  severity: 'error' | 'warning';
  /** semantic issues (overlaps, words/cues mismatch) block rendering, not loading or editing */
  renderOnly?: boolean;
}

/** Built-in style ids (provided by the builtin plugin); the loader accepts them without a styles entry. */
export const BUILTIN_STYLES = ['title', 'subtitle', 'caption', 'karaoke', 'pop', 'boxed', 'lower-third', 'cta', 'label', 'body'];

export interface LoadResult {
  project: ProjectFile;
  problems: Problem[];
  /** JSON path ("clips.3.opacity") → 1-based line */
  lineOf: (path: (string | number)[]) => number | undefined;
  /** true when saving would change the text (time strings, trailing commas, order, defaults) */
  normalised: boolean;
}

type Path = (string | number)[];

function lineIndex(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Animatable clip properties whose keyframe times are normalised. */
export const ANIMATABLE_CLIP_KEYS = ['x', 'y', 'scale', 'rotate', 'opacity', 'gain', 'remap'];

export function isKeyframes(v: unknown): v is [unknown, unknown, unknown?][] {
  return Array.isArray(v) && v.length > 0 && Array.isArray(v[0]) && v.every((k) => Array.isArray(k) && (k.length === 2 || k.length === 3));
}

/** Rate of each comp, and of each entity through its comp. */
export function ratesOf(p: { comps?: { id: string; fps: number | string }[]; tracks?: { id: string; comp: string }[] }) {
  const compRate = new Map<string, Rate>();
  for (const c of p.comps ?? []) {
    try { compRate.set(c.id, parseRate(c.fps)); } catch { /* reported by validation */ }
  }
  const trackComp = new Map((p.tracks ?? []).map((t) => [t.id, t.comp]));
  return { compRate, trackComp };
}

export function parseProjectText(text: string, opts: { file?: string } = {}): LoadResult {
  const problems: Problem[] = [];
  const errors: ParseError[] = [];
  const line = lineIndex(text);
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  let trailingCommas = false;
  for (const e of errors) {
    const code = printParseErrorCode(e.error);
    problems.push({ severity: 'error', code: 'E_JSON', line: line(e.offset), message: `the file is not valid JSON (${code}) at line ${line(e.offset)}.`,
      fix: code === 'CommaExpected' ? 'add a "," between the two entries (each entity line except the last in a table ends with ",").'
        : code === 'PropertyNameExpected' ? 'property names need double quotes, and an entry cannot end with ",".' : 'fix the JSON syntax on that line (quotes, commas, brackets).' });
  }
  if (/,\s*[\]}]/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) trailingCommas = true;
  if (trailingCommas) problems.push({ severity: 'warning', code: 'W_TRAILING_COMMA', message: 'the file has a trailing comma (accepted).', fix: 'nothing to do: saving the project removes it.' });
  if (/\/\/|\/\*/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) problems.push({ severity: 'warning', code: 'W_COMMENT', message: 'the file has comments; they are dropped when the project is saved.', fix: 'use a "note" field on the entity instead.' });

  const lineOf = (path: Path): number | undefined => {
    if (!tree) return undefined;
    for (let n = path.length; n >= 0; n--) {
      const node: Node | undefined = findNodeAtLocation(tree, path.slice(0, n));
      if (node) return line(node.offset);
    }
    return undefined;
  };
  if (!tree || problems.some((p) => p.severity === 'error')) {
    throw new MglError({ ...firstError(problems), problems: problems.filter((p) => p.severity === 'error') });
  }
  // jsonc-parser's getNodeValue
  const raw = nodeValue(tree) as Record<string, unknown>;
  const result = normaliseAndValidate(raw, lineOf, problems);
  result.normalised ||= trailingCommas;
  void opts;
  return result;
}

function nodeValue(n: Node): unknown {
  switch (n.type) {
    case 'object': {
      const o: Record<string, unknown> = {};
      for (const prop of n.children ?? []) {
        const [k, v] = prop.children ?? [];
        if (k && v) o[k.value as string] = nodeValue(v);
      }
      return o;
    }
    case 'array': return (n.children ?? []).map(nodeValue);
    default: return n.value;
  }
}

function firstError(problems: Problem[]): MglErrorInfo {
  const e = problems.find((p) => p.severity === 'error')!;
  const { severity: _s, ...info } = e;
  return info;
}

export function normaliseAndValidate(raw: Record<string, unknown>, lineOf: (p: Path) => number | undefined = () => undefined, problems: Problem[] = []): LoadResult {
  let normalised = false;
  const err = (path: Path, code: string, message: string, fix: string, extra: Partial<Problem> = {}) => {
    const l = lineOf(path);
    problems.push({ severity: 'error', code, message: l ? `line ${l}: ${message}` : message, fix, path: path.join('.'), ...(l ? { line: l } : {}), ...extra });
  };
  const warn = (path: Path, code: string, message: string, fix: string) => {
    const l = lineOf(path);
    problems.push({ severity: 'warning', code, message: l ? `line ${l}: ${message}` : message, fix, path: path.join('.'), ...(l ? { line: l } : {}) });
  };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err([], 'E_SCHEMA', 'the project file must be a JSON object.', 'start from "mgl new" and compare.');
    throw new MglError({ ...firstError(problems), problems });
  }
  if (raw.michelangelo !== FORMAT_VERSION) {
    err(['michelangelo'], 'E_VERSION', `"michelangelo" must be ${FORMAT_VERSION} (the file format version), found ${JSON.stringify(raw.michelangelo)}.`, `set "michelangelo": ${FORMAT_VERSION} on the first line.`);
  }

  // --- 1. normalise time edge forms to frames, using each entity's comp rate ---
  const { compRate, trackComp } = ratesOf(raw as never);
  const clipsById = new Map<string, Record<string, unknown>>();
  for (const c of (raw.clips as Record<string, unknown>[] | undefined) ?? []) if (c && typeof c.id === 'string') clipsById.set(c.id, c);
  const rateFor = (table: TableName, e: Record<string, unknown>): Rate | undefined => {
    if (table === 'comps') return compRate.get(e.id as string);
    if (table === 'clips') return compRate.get(trackComp.get(e.track as string) ?? '');
    if (table === 'markers') return compRate.get(e.comp as string);
    if (table === 'cues') {
      const c = clipsById.get(e.clip as string);
      return c ? compRate.get(trackComp.get(c.track as string) ?? '') : undefined;
    }
    return undefined;
  };
  const conv = (v: unknown, rate: Rate | undefined, path: Path): unknown => {
    if (typeof v !== 'string' || v === 'auto') return v;
    if (!rate) return v; // the missing comp/track is reported by the reference checks
    try {
      const t = parseTimeDetailed(v, rate, path.join('.'));
      normalised = true;
      if (t.rounded) warn(path, 'W_TIME_ROUNDED', `"${v}" is not on a frame boundary; rounded to frame ${t.frames}.`, `write ${t.frames} (frames) to make it exact.`);
      return t.frames;
    } catch (e) {
      if (e instanceof MglError) err(path, e.code, e.message, e.fix);
      return v;
    }
  };
  const convKeys = (v: unknown, rate: Rate | undefined, path: Path): unknown => {
    if (!isKeyframes(v)) return v;
    return v.map((k, i) => [conv(k[0], rate, [...path, i, 0]), ...k.slice(1)]);
  };
  for (const table of TABLES) {
    const rows = raw[table];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) continue; // schema reports it
    rows.forEach((e: Record<string, unknown>, i: number) => {
      if (!e || typeof e !== 'object') return;
      const rate = rateFor(table, e);
      for (const f of TIME_FIELDS[table]) if (f in e) e[f] = conv(e[f], rate, [table, i, f]);
      if (table === 'clips') {
        for (const k of ANIMATABLE_CLIP_KEYS) if (k in e) e[k] = convKeys(e[k], rate, [table, i, k]);
        if (Array.isArray(e.fade)) e.fade = e.fade.map((x, j) => conv(x, rate, [table, i, 'fade', j]));
        const an = e.animate as Record<string, unknown> | undefined;
        if (an && typeof an === 'object') for (const f of ['stagger', 'len']) if (f in an) an[f] = conv(an[f], rate, [table, i, 'animate', f]);
        const tr = e.transition as Record<string, Record<string, unknown> | undefined> | undefined;
        if (tr && typeof tr === 'object') for (const side of ['in', 'out']) {
          const t = tr[side];
          if (t && typeof t === 'object' && 'len' in t) t.len = conv(t.len, rate, [table, i, 'transition', side, 'len']);
        }
        const sh = e.shape as Record<string, unknown> | undefined;
        if (sh && typeof sh === 'object' && 'trim' in sh) sh.trim = convKeys(sh.trim, rate, [table, i, 'shape', 'trim']);
        if (Array.isArray(e.fx)) e.fx.forEach((fx: Record<string, unknown>, j: number) => {
          if (fx && typeof fx === 'object') for (const [k, v] of Object.entries(fx)) if (isKeyframes(v)) fx[k] = convKeys(v, rate, [table, i, 'fx', j, k]);
        });
      }
      if (table === 'cues' && Array.isArray(e.words)) e.words = e.words.map((x, j) => conv(x, rate, [table, i, 'words', j]));
    });
  }

  // --- 2. schema ---
  const parsed = canonicalSchemas.File.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) reportIssue(issue, raw, err);
  }
  if (problems.some((p) => p.severity === 'error')) {
    throw new MglError({ ...firstError(problems), problems: problems.filter((p) => p.severity === 'error').slice(0, 50) });
  }
  const project = parsed.data!;

  // --- 3. references and semantics ---
  const issue: Reporter = (path, code, message, fix, extra = {}) => err(path, code, message, fix, { ...extra, renderOnly: true });
  semanticChecks(project, err, warn, issue);
  if (problems.some((p) => p.severity === 'error' && !p.renderOnly)) {
    throw new MglError({ ...firstError(problems.filter((p) => !p.renderOnly)), problems: problems.filter((p) => p.severity === 'error' && !p.renderOnly).slice(0, 50) });
  }
  return { project, problems, lineOf, normalised };
}

type Reporter = (path: Path, code: string, message: string, fix: string, extra?: Partial<Problem>) => void;

/** Allowed keys of the object at a path, for did-you-mean. */
function shapeKeysAt(path: Path): string[] {
  const s = canonicalSchemas;
  const table = path[0];
  const tableSchema: Record<string, z.ZodObject> = { project: s.Project, styles: s.Style, assets: s.Asset, comps: s.Comp, tracks: s.Track, clips: s.Clip, cues: s.Cue, buses: s.Bus, markers: s.Marker };
  if (path.length === 0) return Object.keys(s.File.shape);
  if (path.length <= 2 && typeof table === 'string') return Object.keys(tableSchema[table]?.shape ?? {});
  const sub = path[2];
  if (table === 'clips') {
    if (sub === 'style') return Object.keys(s.TextStyle.shape);
    if (sub === 'animate') return Object.keys(s.TextAnimate.shape);
    if (sub === 'shape') return Object.keys(s.ShapeSpec.shape);
    if (sub === 'masks') return Object.keys(s.Mask.shape);
    if (sub === 'transition') return path.length === 3 ? ['in', 'out'] : ['type', 'len'];
  }
  if (table === 'buses' && sub === 'duck') return ['by', 'db', 'attack', 'release'];
  if (table === 'buses' && sub === 'loudness') return ['lufs', 'peak'];
  return [];
}

function describePath(path: Path, raw: Record<string, unknown>): string {
  const [table, idx, ...rest] = path;
  if (typeof table === 'string' && typeof idx === 'number') {
    const e = (raw[table] as Record<string, unknown>[] | undefined)?.[idx];
    const id = e && typeof e.id === 'string' ? `"${e.id}"` : `#${idx + 1}`;
    const kind = table.replace(/es$|s$/, '').replace(/^bus$/, 'bus');
    return `${kind} ${id}${rest.length ? ' ' + rest.join('.') : ''}`;
  }
  return path.join('.') || 'the file';
}

function reportIssue(issue: z.core.$ZodIssue, raw: Record<string, unknown>, err: Reporter) {
  const path = issue.path as Path;
  const where = describePath(path, raw);
  if (issue.code === 'unrecognized_keys') {
    const allowed = shapeKeysAt(path);
    for (const k of issue.keys) {
      const dym = suggest(k, allowed);
      err([...path, k], 'E_UNKNOWN_KEY', `${where}: "${k}" is not a known property.`,
        dym.length ? `did you mean "${dym[0]}"?` : `allowed: ${allowed.slice(0, 20).join(', ')}${allowed.length > 20 ? ', ...' : ''}.`, dym.length ? { didYouMean: dym } : {});
    }
    return;
  }
  if (issue.code === 'invalid_union') {
    err(path, 'E_SCHEMA', `${where}: ${unionMessage(path)}`, unionFix(path));
    return;
  }
  if (issue.code === 'invalid_type' && issue.input === undefined) {
    err(path, 'E_MISSING', `${where} is required.`, `add "${path[path.length - 1]}" to the entity.`);
    return;
  }
  err(path, 'E_SCHEMA', `${where}: ${issue.message}.`, fixFor(path));
}

function unionMessage(path: Path): string {
  const key = path[path.length - 1];
  if (['x', 'y', 'rotate', 'opacity', 'gain'].includes(String(key))) return 'must be a number or a keyframe list [[frame, value, easing?], ...].';
  if (key === 'scale') return 'must be a number, [sx, sy], or keyframes [[frame, value, easing?], ...].';
  if (['at', 'len', 'in', 'clock', 'length'].includes(String(key))) return 'must be frames (an integer) or a time string like "2.5s".';
  return 'has the wrong type.';
}
function unionFix(path: Path): string {
  const key = path[path.length - 1];
  if (['x', 'y', 'rotate', 'opacity', 'gain', 'scale'].includes(String(key))) return `e.g. "${key}": 1 or "${key}": [[0, 0], [15, 1, "outCubic"]].`;
  return 'see "mgl docs format" for the field types.';
}
function fixFor(path: Path): string {
  const key = String(path[path.length - 1] ?? '');
  if (key === 'id') return 'ids use letters, digits, "_", "-", "." (e.g. "title", "shot3", "V1").';
  if (key === 'size') return 'size is [width, height] in px, e.g. [1080, 1920].';
  if (['color', 'bg', 'fill', 'stroke'].includes(key)) return 'use "#rrggbb" (e.g. "#ffcc00").';
  return 'see "mgl docs format" for the field types.';
}

function semanticChecks(p: ProjectFile, err: Reporter, warn: Reporter, issue: Reporter) {
  // ids unique across the project
  const seen = new Map<string, string>();
  for (const table of TABLES) {
    (p[table] as { id: string }[] | undefined)?.forEach((e, i) => {
      const prev = seen.get(e.id);
      if (prev) err([table, i, 'id'], 'E_DUPLICATE_ID', `id "${e.id}" is used twice (also in ${prev}).`, `rename one of them, e.g. "${e.id}-2".`);
      else seen.set(e.id, table);
    });
  }
  const comps = new Map(p.comps.map((c) => [c.id, c]));
  const tracks = new Map((p.tracks ?? []).map((t) => [t.id, t]));
  const assets = new Map((p.assets ?? []).map((a) => [a.id, a]));
  const clips = new Map((p.clips ?? []).map((c) => [c.id, c]));
  const styles = new Set((p.styles ?? []).map((st) => st.id));
  (p.styles ?? []).forEach((st, i) => {
    if (st.base && !styles.has(st.base) && !BUILTIN_STYLES.includes(st.base)) err(['styles', i, 'base'], 'E_REF', `style "${st.id}" inherits "${st.base}", which does not exist.`, `use a built-in style (${BUILTIN_STYLES.join(', ')}) or another style id.`);
  });
  const buses = new Set(['master', 'dialogue', 'music', 'sfx', ...(p.buses ?? []).map((b) => b.id)]);
  const compRates = new Map<string, Rate>();
  p.comps.forEach((c, i) => {
    try { compRates.set(c.id, parseRate(c.fps)); } catch (e) { if (e instanceof MglError) err(['comps', i, 'fps'], e.code, e.message, e.fix); }
  });
  if (p.project?.main && !comps.has(p.project.main)) err(['project', 'main'], 'E_REF', `project main comp "${p.project.main}" does not exist.`, `use one of ${[...comps.keys()].join(', ')}.`);

  (p.tracks ?? []).forEach((t, i) => {
    if (!comps.has(t.comp)) err(['tracks', i, 'comp'], 'E_REF', `track "${t.id}" refers to comp "${t.comp}", which does not exist.`, `use one of ${[...comps.keys()].join(', ')}.`);
    if (t.bus && !buses.has(t.bus)) err(['tracks', i, 'bus'], 'E_REF', `track "${t.id}" sends to bus "${t.bus}", which does not exist.`, `use master, dialogue, music, sfx, or add {"id": "${t.bus}"} to "buses".`);
    if (t.bus && !t.audio) warn(['tracks', i, 'bus'], 'W_BUS_ON_VISUAL', `track "${t.id}" has a bus but is not an audio track; embedded audio of its clips goes to that bus.`, 'nothing to do if that is intended.');
  });
  (p.buses ?? []).forEach((b, i) => {
    if (b.duck && !buses.has(b.duck.by)) err(['buses', i, 'duck', 'by'], 'E_REF', `bus "${b.id}" ducks by "${b.duck.by}", which does not exist.`, 'use dialogue, music, sfx or a bus id.');
    if (b.to && !buses.has(b.to)) err(['buses', i, 'to'], 'E_REF', `bus "${b.id}" feeds "${b.to}", which does not exist.`, 'use master or another bus id.');
  });

  const byTrack = new Map<string, { c: Clip; i: number }[]>();
  (p.clips ?? []).forEach((c, i) => {
    const t = tracks.get(c.track);
    if (!t) {
      const sameComp = [...tracks.keys()];
      err(['clips', i, 'track'], 'E_REF', `clip "${c.id}" refers to track "${c.track}", which does not exist.`,
        sameComp.length ? `use one of ${sameComp.slice(0, 8).join(', ')}, or add {"id": "${c.track}", "comp": "${p.comps[0]!.id}"} to "tracks".` : `add {"id": "${c.track}", "comp": "${p.comps[0]!.id}"} to "tracks".`);
      return;
    }
    const sources = CLIP_SOURCES.filter((k) => (c as Record<string, unknown>)[k] !== undefined);
    if (sources.length !== 1) {
      err(['clips', i], 'E_CLIP_SOURCE', sources.length ? `clip "${c.id}" has ${sources.length} sources (${sources.join(', ')}); a clip shows exactly one thing.` : `clip "${c.id}" has no source.`,
        sources.length ? 'keep one of them; put the others in separate clips.' : `add one of: ${CLIP_SOURCES.join(', ')} (e.g. "text": "Hello" or "asset": "<asset id>").`);
      return;
    }
    if (c.len <= 0) err(['clips', i, 'len'], 'E_RANGE', `clip "${c.id}" has length ${c.len}; it must be at least 1 frame.`, 'give "len" a positive number of frames or a time like "2s".');
    if (c.at < 0) err(['clips', i, 'at'], 'E_RANGE', `clip "${c.id}" starts at ${c.at}, before the start of the comp.`, 'use "at" ≥ 0.');
    if (c.asset !== undefined && !assets.has(c.asset)) {
      const dym = suggest(c.asset, assets.keys());
      err(['clips', i, 'asset'], 'E_REF', `clip "${c.id}" uses asset "${c.asset}", which does not exist.`, dym.length ? `did you mean "${dym[0]}"?` : `add it: mgl edit <file> asset.add src=<path> id=${c.asset}`);
    }
    if (c.comp !== undefined) {
      if (!comps.has(c.comp)) err(['clips', i, 'comp'], 'E_REF', `clip "${c.id}" nests comp "${c.comp}", which does not exist.`, `use one of ${[...comps.keys()].join(', ')}.`);
      else if (c.comp === t.comp) err(['clips', i, 'comp'], 'E_CYCLE', `clip "${c.id}" nests comp "${c.comp}" inside itself.`, 'nest a different comp.');
    }
    if (typeof c.style === 'string' && !styles.has(c.style) && !BUILTIN_STYLES.includes(c.style)) {
      const dym = suggest(c.style, [...styles, ...BUILTIN_STYLES]);
      err(['clips', i, 'style'], 'E_REF', `clip "${c.id}" uses style "${c.style}", which does not exist.`, dym.length ? `did you mean "${dym[0]}"?` : `use a built-in style (${BUILTIN_STYLES.join(', ')}) or add it to "styles".`);
    }
    if (c.matte && !clips.has(c.matte.clip)) err(['clips', i, 'matte', 'clip'], 'E_REF', `clip "${c.id}" uses matte clip "${c.matte.clip}", which does not exist.`, 'use the id of a clip in the same comp.');
    if (c.parent !== undefined && !clips.has(c.parent)) err(['clips', i, 'parent'], 'E_REF', `clip "${c.id}" has parent "${c.parent}", which does not exist.`, 'use the id of a clip in the same comp, or remove "parent".');
    if (t.audio && !(c.asset !== undefined)) err(['clips', i], 'E_TRACK_KIND', `clip "${c.id}" is visual but sits on audio track "${t.id}".`, 'move it to a visual track.');
    if (c.speed !== undefined && typeof c.speed === 'string' && !/^\d+\/\d+$|^\d+(\.\d+)?$/.test(c.speed)) err(['clips', i, 'speed'], 'E_SPEED', `clip "${c.id}" speed "${c.speed}" is not a factor.`, 'use a number (2, 0.5) or "num/den".');
    for (const k of ANIMATABLE_CLIP_KEYS) {
      const v = (c as Record<string, unknown>)[k];
      if (isKeyframes(v)) {
        const times = v.map((kf) => kf[0] as number);
        for (let j = 1; j < times.length; j++) if (times[j]! <= times[j - 1]!) {
          issue(['clips', i, k, j, 0], 'E_KEYFRAMES', `clip "${c.id}" ${k}: keyframe times must increase (frame ${times[j]} after ${times[j - 1]}).`, 'sort the keyframes by frame and remove duplicates.');
          break;
        }
        if (times.every((tt) => tt >= c.len) || times.every((tt) => tt < 0)) warn(['clips', i, k], 'W_KEYS_OUTSIDE', `clip "${c.id}" ${k}: every keyframe lies outside the clip (frames are clip-local: 0..${c.len - 1}).`, `keyframe frames count from the clip start; subtract ${c.at} if you used comp frames.`);
      }
    }
    const list = byTrack.get(c.track) ?? [];
    list.push({ c, i });
    byTrack.set(c.track, list);
  });
  for (const [trackId, list] of byTrack) {
    list.sort((a, b) => a.c.at - b.c.at);
    for (let j = 1; j < list.length; j++) {
      const a = list[j - 1]!.c, b = list[j]!;
      if (b.c.at < a.at + a.len) {
        issue(['clips', b.i, 'at'], 'E_OVERLAP', `clips "${a.id}" (${a.at}–${a.at + a.len}) and "${b.c.id}" (${b.c.at}–${b.c.at + b.c.len}) overlap on track ${trackId}.`,
          `move "${b.c.id}" to "at": ${a.at + a.len}, shorten "${a.id}" to "len": ${b.c.at - a.at}, or put one on another track. For a transition keep them adjacent and add "transition": {"in": {"type": "crossfade", "len": 10}} to "${b.c.id}".`);
      }
    }
  }
  (p.cues ?? []).forEach((q, i) => {
    const c = clips.get(q.clip);
    if (!c) return err(['cues', i, 'clip'], 'E_REF', `cue "${q.id}" belongs to clip "${q.clip}", which does not exist.`, 'use the id of a captions clip.');
    if (!c.captions) err(['cues', i, 'clip'], 'E_REF', `cue "${q.id}" belongs to clip "${q.clip}", which is not a captions clip.`, `use a clip with "captions": true.`);
    if (q.len <= 0) err(['cues', i, 'len'], 'E_RANGE', `cue "${q.id}" has length ${q.len}.`, 'cue lengths are positive frames.');
    if (q.at < 0 || q.at + q.len > c.len) warn(['cues', i, 'at'], 'W_CUE_OUTSIDE', `cue "${q.id}" (${q.at}–${q.at + q.len}) is not inside its clip "${c.id}" (0–${c.len}); the part outside is not shown.`, 'cue times count from the captions clip start; extend the clip or move the cue.');
    if (q.words) {
      const n = q.text.split(/\s+/).filter(Boolean).length;
      if (q.words.length !== n) issue(['cues', i, 'words'], 'E_WORDS', `cue "${q.id}" has ${n} words but ${q.words.length} word times.`, 'give one start offset (frames from the cue start) per word, or remove "words".');
    }
  });
  (p.markers ?? []).forEach((m, i) => {
    if (!comps.has(m.comp)) err(['markers', i, 'comp'], 'E_REF', `marker "${m.id}" refers to comp "${m.comp}", which does not exist.`, `use one of ${[...comps.keys()].join(', ')}.`);
  });
  // nesting cycles
  const nests = new Map<string, Set<string>>();
  for (const c of p.clips ?? []) {
    if (c.comp === undefined) continue;
    const from = tracks.get(c.track)?.comp;
    if (!from) continue;
    if (!nests.has(from)) nests.set(from, new Set());
    nests.get(from)!.add(c.comp);
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string, chain: string[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      err(['comps'], 'E_CYCLE', `comps nest each other in a loop: ${[...chain, id].join(' → ')}.`, 'remove one of the nested comp clips.');
      return;
    }
    visiting.add(id);
    for (const n of nests.get(id) ?? []) visit(n, [...chain, id]);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of nests.keys()) visit(id, []);
  // parent cycles
  for (const c of p.clips ?? []) {
    const seenP = new Set<string>([c.id]);
    let cur = c.parent;
    while (cur) {
      if (seenP.has(cur)) { err(['clips', (p.clips ?? []).indexOf(c), 'parent'], 'E_CYCLE', `clip "${c.id}" is its own ancestor through "parent".`, 'remove one "parent" link.'); break; }
      seenP.add(cur);
      cur = clips.get(cur)?.parent;
    }
  }
  void clipKind;
}
