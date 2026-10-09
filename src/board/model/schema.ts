/**
 * The board file's schemas (docs/plans/BOARD.md §3), the key order the writer uses, and the validator: zod for
 * shape, then references. Every problem names its line (when known) and a fix; unknown keys get a did-you-mean.
 */
import { z } from 'zod';
import { MglError, suggest, type MglErrorInfo } from '../../core/errors.js';
import { expectedText, foundText, lookupPath } from '../../core/issues.js';
import { parseTimeDetailed } from '../../core/time.js';
import { BOARD_FORMAT, SHAPE_TYPES, type BoardFile, type ShapeType } from '../shared/types.js';

type Path = (string | number)[];

export const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const Id = z.string().regex(ID_RE, 'ids are lowercase letters, digits, "-" and "_" (e.g. n3)');
const Num = z.number().finite();
const Point = z.tuple([Num, Num]);
export const PALETTE = ['yellow', 'blue', 'green', 'red', 'violet', 'grey', 'black', 'white'] as const;
const Who = z.enum(['human', 'ai']);
const Level = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const FIDELITIES = ['thumb', 'half', 'full'] as const;

/** A time in an edge form of DESIGN §3 (frames, "2.5s", "1:02.5", "00:00:02:15"); kept as written (a board has no fps). */
export const TimeLike = z.union([z.number().int(), z.string()]).superRefine((v, ctx) => {
  if (typeof v !== 'string') return;
  try { parseTimeDetailed(v, { num: 30, den: 1 }); } catch { ctx.addIssue({ code: 'custom', message: `"${v}" is not a time (use frames like 75, or "2.5s", "1:02.5", "00:00:02:15")` }); }
});

const base = {
  id: Id, type: z.string(), x: Num.optional(), y: Num.optional(), w: Num.min(0).optional(), h: Num.min(0).optional(), rot: Num.optional(),
  parent: Id.optional(), label: z.string().optional(), color: z.enum(PALETTE).optional(), by: Who.optional(), locked: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
};
const End = z.union([Id, Point]);

export const SHAPE_SCHEMAS: Record<ShapeType, z.ZodObject> = {
  frame: z.strictObject({ ...base }),
  note: z.strictObject({ ...base, text: z.string().optional() }),
  text: z.strictObject({ ...base, text: z.string().optional(), size: Num.positive().optional() }),
  rect: z.strictObject({ ...base, text: z.string().optional(), fill: z.enum(['none', 'solid', 'tint']).optional() }),
  ellipse: z.strictObject({ ...base, text: z.string().optional(), fill: z.enum(['none', 'solid', 'tint']).optional() }),
  arrow: z.strictObject({ ...base, from: End.optional(), to: End.optional(), text: z.string().optional() }),
  draw: z.strictObject({ ...base, points: z.array(Point) }),
  image: z.strictObject({ ...base, src: z.string().min(1) }),
  still: z.strictObject({ ...base, t: TimeLike, comp: Id.optional(), fidelity: z.enum(FIDELITIES).optional() }),
  timeline: z.strictObject({ ...base, comp: Id.optional(), from: TimeLike.optional(), to: TimeLike.optional() }),
  pin: z.strictObject({ ...base, target: Id, u: Num.min(0).max(1).optional(), v: Num.min(0).max(1).optional(), text: z.string().optional(), status: z.enum(['open', 'resolved']).optional(), reply: z.string().optional() }),
};

export const Budget = z.strictObject({ cpuMin: Num.min(0).optional(), maxLevel: Level.optional() });
const Strs = z.array(z.string());
export const Brief = z.strictObject({
  goal: z.string().optional(), audience: z.string().optional(), platform: z.string().optional(), length: z.string().optional(),
  tone: Strs.optional(), references: Strs.optional(), mustHave: Strs.optional(), avoid: Strs.optional(), success: Strs.optional(),
  questions: Strs.optional(), budget: Budget.optional(),
});
export const BRIEF_LISTS = ['tone', 'references', 'mustHave', 'avoid', 'success', 'questions'] as const;
export const BRIEF_TEXT = ['goal', 'audience', 'platform', 'length'] as const;

export const RoundOption = z.strictObject({
  id: Id, title: z.string().min(1), summary: z.string().optional(), shapes: z.array(Id).optional(), tradeoffs: z.string().optional(),
  cost: z.string().optional(), taste: z.string().optional(),
});
export const ROUND_STATUS = ['open', 'proposed', 'decided', 'dropped'] as const;
export const Round = z.strictObject({
  id: Id, goal: z.string(), fidelity: Level, status: z.enum(ROUND_STATUS), options: z.array(RoundOption).optional(),
  chosen: Id.optional(), why: z.string().optional(), notes: z.string().optional(),
});
export const LogEntry = z.strictObject({ id: Id, by: Who, text: z.string(), at: z.string().optional() });
export const SpendEntry = z.strictObject({ id: Id, level: Level, what: z.string(), ms: Num.min(0), round: Id.optional() });

export const BoardSchema = z.strictObject({
  michelangeloBoard: z.literal(BOARD_FORMAT),
  project: z.string().optional(),
  brief: Brief.optional(),
  shapes: z.array(z.record(z.string(), z.unknown())).optional(), // each shape is checked by its type's schema
  rounds: z.array(Round).optional(),
  log: z.array(LogEntry).optional(),
  spend: z.array(SpendEntry).optional(),
});

/** Key order of each entity when written: id first, geometry, the type's own fields, then common fields. */
const SHAPE_HEAD = ['id', 'type', 'x', 'y', 'w', 'h', 'rot'];
const SHAPE_TAIL = ['label', 'color', 'by', 'parent', 'locked', 'tags'];
const SHAPE_OWN: Record<ShapeType, string[]> = {
  frame: [], note: ['text'], text: ['text', 'size'], rect: ['text', 'fill'], ellipse: ['text', 'fill'], arrow: ['from', 'to', 'text'],
  draw: ['points'], image: ['src'], still: ['t', 'comp', 'fidelity'], timeline: ['comp', 'from', 'to'],
  pin: ['target', 'u', 'v', 'text', 'status', 'reply'],
};
export const SHAPE_KEYS: Record<ShapeType, string[]> = Object.fromEntries(SHAPE_TYPES.map((t) => [t, [...SHAPE_HEAD, ...SHAPE_OWN[t], ...SHAPE_TAIL]])) as Record<ShapeType, string[]>;
export const KEY_ORDER = {
  brief: ['goal', 'audience', 'platform', 'length', 'tone', 'references', 'mustHave', 'avoid', 'success', 'questions', 'budget'],
  budget: ['cpuMin', 'maxLevel'],
  rounds: ['id', 'goal', 'fidelity', 'status', 'options', 'chosen', 'why', 'notes'],
  options: ['id', 'title', 'summary', 'shapes', 'tradeoffs', 'cost', 'taste'],
  log: ['id', 'by', 'text', 'at'],
  spend: ['id', 'level', 'what', 'ms', 'round'],
};

/** Values the writer omits (filled back in by readers that need them). */
export const SHAPE_DEFAULTS: Record<string, unknown> = { rot: 0, locked: false, tags: [] };
export const TYPE_DEFAULTS: Partial<Record<ShapeType, Record<string, unknown>>> = {
  arrow: { x: 0, y: 0 }, pin: { x: 0, y: 0, u: 0.5, v: 0.5, status: 'open' }, text: { size: 24 }, still: { fidelity: 'thumb' },
};
/** The default size of each shape type, for layout (the page's SHAPE_DEFS may refine it). */
export const DEFAULT_SIZE: Record<ShapeType, [number, number]> = {
  frame: [800, 500], note: [200, 200], text: [200, 40], rect: [200, 120], ellipse: [200, 120], arrow: [0, 0], draw: [0, 0],
  image: [320, 240], still: [270, 480], timeline: [1200, 160], pin: [0, 0],
};
export const STILL_WIDTH: Record<string, number> = { thumb: 270, half: 540, full: 1080 };

export interface BoardProblem extends MglErrorInfo { severity: 'error' }
type Reporter = (path: Path, code: string, message: string, fix: string, extra?: Partial<MglErrorInfo>) => void;

/** Allowed keys of the object at a path (for did-you-mean). */
function keysAt(raw: Record<string, unknown>, path: Path): string[] {
  const [t, i, sub] = path;
  if (path.length === 0) return Object.keys(BoardSchema.shape);
  if (t === 'brief') return path.length === 1 ? KEY_ORDER.brief : KEY_ORDER.budget;
  if (t === 'shapes' && typeof i === 'number') {
    const type = ((raw.shapes as Record<string, unknown>[] | undefined)?.[i] ?? {}).type as ShapeType;
    return SHAPE_KEYS[type] ?? [];
  }
  if (t === 'rounds') return sub === 'options' ? KEY_ORDER.options : KEY_ORDER.rounds;
  if (t === 'log') return KEY_ORDER.log;
  if (t === 'spend') return KEY_ORDER.spend;
  return [];
}

export function describe(path: Path, raw: Record<string, unknown>): string {
  const [t, i, ...rest] = path;
  if (typeof t === 'string' && typeof i === 'number') {
    const e = (raw[t] as Record<string, unknown>[] | undefined)?.[i];
    const id = e && typeof e.id === 'string' ? `"${e.id}"` : `#${i + 1}`;
    const kind = t === 'shapes' ? (typeof e?.type === 'string' ? e.type : 'shape') : t === 'log' ? 'log entry' : t === 'spend' ? 'spend entry' : 'round';
    return `${kind} ${id}${rest.length ? ' ' + rest.join('.') : ''}`;
  }
  return path.join('.') || 'the board';
}

/** Turn zod issues into problems: unknown keys with did-you-mean, missing vs wrong type, enum choices. */
export function reportZod(issues: z.core.$ZodIssue[], raw: Record<string, unknown>, err: Reporter, prefix: Path = []) {
  for (const issue of issues) {
    const path = [...prefix, ...(issue.path as Path)];
    const where = describe(path, raw);
    if (issue.code === 'unrecognized_keys') {
      const allowed = keysAt(raw, path);
      for (const k of issue.keys) {
        const dym = suggest(k, allowed);
        err([...path, k], 'E_UNKNOWN_KEY', `${where}: "${k}" is not a known property.`,
          dym.length ? `did you mean "${dym[0]}"?` : `allowed: ${allowed.join(', ')}.`, dym.length ? { didYouMean: dym } : {});
      }
      continue;
    }
    const at = lookupPath(raw, path);
    if ((issue.code === 'invalid_type' || issue.code === 'invalid_union') && !at.present) {
      err(path, 'E_MISSING', `${where} is required.`, `add "${String(path[path.length - 1])}".`);
      continue;
    }
    if (issue.code === 'invalid_value') {
      const vals = issue.values.map((v) => JSON.stringify(v));
      const dym = typeof at.value === 'string' ? suggest(at.value, issue.values.map(String)) : [];
      err(path, 'E_SCHEMA', `${where}: must be ${vals.join(' or ')}, found ${foundText(at.value)}.`, dym.length ? `did you mean "${dym[0]}"?` : `use one of ${vals.join(', ')}.`, dym.length ? { didYouMean: dym } : {});
      continue;
    }
    if (issue.code === 'invalid_type' || issue.code === 'invalid_union') {
      const want = expectedText(issue);
      err(path, 'E_SCHEMA', `${where}: must be ${want ?? 'another type'}, found ${foundText(at.value)}.`, fixFor(path));
      continue;
    }
    err(path, 'E_SCHEMA', `${where}: ${issue.message}.`, fixFor(path));
  }
}

function fixFor(path: Path): string {
  const k = String(path[path.length - 1]);
  if (k === 'id' || k === 'parent' || k === 'target' || k === 'round' || k === 'chosen') return 'ids are lowercase letters, digits, "-" and "_", e.g. "n3".';
  if (k === 't' || k === 'from' || k === 'to') return 'a time is frames (75) or "2.5s", "1:02.5", "00:00:02:15"; an arrow end is a shape id or [x, y].';
  if (k === 'color') return `use one of ${PALETTE.join(', ')}.`;
  if (k === 'fidelity') return path[0] === 'rounds' ? 'a level 0..4 (0 sketch, 1 frames, 2 sheet, 3 draft, 4 final).' : 'use thumb, half or full.';
  if (k === 'level' || k === 'maxLevel') return 'a level 0..4 (0 sketch, 1 frames, 2 sheet, 3 draft, 4 final).';
  if (k === 'points') return 'a list of [x, y] pairs relative to the shape\'s x/y.';
  return 'compare with docs/plans/BOARD.md §3 (the board file).';
}

/**
 * Validate a parsed board object. Returns the board (x/y filled with 0 where missing) or throws an MglError
 * whose `problems` list every error.
 */
export function validateBoard(raw: unknown, lineOf: (p: Path) => number | undefined = () => undefined): BoardFile {
  const problems: BoardProblem[] = [];
  const err: Reporter = (path, code, message, fix, extra = {}) => {
    const l = lineOf(path);
    problems.push({ severity: 'error', code, message: l ? `line ${l}: ${message}` : message, fix, path: path.join('.'), ...(l ? { line: l } : {}), ...extra });
  };
  const bail = () => {
    const { severity: _s, ...info } = problems[0]!;
    throw new MglError({ ...info, problems: problems.slice(0, 50).map(({ severity: _x, ...p }) => p) });
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    err([], 'E_SCHEMA', 'the board file must be a JSON object.', `start with {"michelangeloBoard": ${BOARD_FORMAT}}.`);
    bail();
  }
  const r = raw as Record<string, unknown>;
  if (r.michelangeloBoard !== BOARD_FORMAT) {
    err(['michelangeloBoard'], 'E_VERSION', `"michelangeloBoard" must be ${BOARD_FORMAT} (the board format version), found ${JSON.stringify(r.michelangeloBoard)}.`, `set "michelangeloBoard": ${BOARD_FORMAT} on the first line.`);
  }
  const parsed = BoardSchema.safeParse(r);
  if (!parsed.success) reportZod(parsed.error.issues.filter((i) => !(i.path[0] === 'michelangeloBoard')), r, err);
  const shapes: Record<string, unknown>[] = [];
  if (Array.isArray(r.shapes)) r.shapes.forEach((s: unknown, i: number) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return; // reported above
    const o = s as Record<string, unknown>;
    const type = o.type;
    if (typeof type !== 'string' || !(SHAPE_TYPES as readonly string[]).includes(type)) {
      const dym = typeof type === 'string' ? suggest(type, SHAPE_TYPES) : [];
      if (type === undefined) err(['shapes', i, 'type'], 'E_MISSING', `${describe(['shapes', i], r)}: "type" is required.`, `add "type": one of ${SHAPE_TYPES.join(', ')}.`);
      else err(['shapes', i, 'type'], 'E_SCHEMA', `${describe(['shapes', i], r)}: ${JSON.stringify(type)} is not a shape type.`, dym.length ? `did you mean "${dym[0]}"?` : `use one of ${SHAPE_TYPES.join(', ')}.`, dym.length ? { didYouMean: dym } : {});
      return;
    }
    const res = SHAPE_SCHEMAS[type as ShapeType].safeParse(o);
    if (!res.success) { reportZod(res.error.issues, r, err, ['shapes', i]); return; }
    shapes.push({ ...res.data, x: res.data.x ?? 0, y: res.data.y ?? 0 });
  });
  if (problems.length) bail();
  const board = { ...(parsed.data as Record<string, unknown>) } as unknown as BoardFile;
  if (board.shapes) board.shapes = shapes as never;
  checkRefs(board, err);
  if (problems.length) bail();
  return board;
}

/** References and uniqueness: shape ids, parents (frames, no cycles), arrow ends, pin targets, round options. */
export function checkRefs(b: BoardFile, err: Reporter) {
  const shapes = b.shapes ?? [];
  const byId = new Map<string, (typeof shapes)[number]>();
  shapes.forEach((s, i) => {
    if (byId.has(s.id)) err(['shapes', i, 'id'], 'E_DUPLICATE_ID', `shape id "${s.id}" is used twice.`, 'give each shape its own id (or remove "id" and let the board generate one).');
    byId.set(s.id, s);
  });
  const ids = [...byId.keys()];
  const missing = (id: string, what: string, path: Path, fix?: string) => {
    const dym = suggest(id, ids);
    err(path, 'E_REF', `${what} "${id}", which does not exist.`, fix ?? (dym.length ? `did you mean "${dym[0]}"?` : 'use the id of an existing shape (mgl board show <file> --json lists them).'), dym.length ? { didYouMean: dym } : {});
  };
  shapes.forEach((s, i) => {
    if (s.parent !== undefined) {
      const p = byId.get(s.parent);
      if (!p) missing(s.parent, `${s.type} "${s.id}" has parent`, ['shapes', i, 'parent']);
      else if (p.type !== 'frame') err(['shapes', i, 'parent'], 'E_REF', `${s.type} "${s.id}" has parent "${s.parent}", which is a ${p.type}, not a frame.`, 'a parent must be a frame; remove "parent" or use a frame id.');
      else {
        // cycles: a frame inside itself
        const seen = new Set([s.id]);
        let cur: string | undefined = s.parent;
        while (cur) {
          if (seen.has(cur)) { err(['shapes', i, 'parent'], 'E_REF', `frame "${s.id}" is inside itself (parent cycle through "${cur}").`, 'remove "parent" from one of the frames.'); break; }
          seen.add(cur);
          cur = byId.get(cur)?.parent;
        }
      }
    }
    if (s.type === 'arrow') for (const end of ['from', 'to'] as const) {
      const v = s[end];
      if (typeof v === 'string' && !byId.has(v)) missing(v, `arrow "${s.id}" ${end}`, ['shapes', i, end], `use a shape id, or a point [x, y].`);
    }
    if (s.type === 'pin' && !byId.has(s.target)) missing(s.target, `pin "${s.id}" targets`, ['shapes', i, 'target']);
  });
  const roundIds = new Set<string>(), optionIds = new Set<string>();
  (b.rounds ?? []).forEach((r, i) => {
    if (roundIds.has(r.id)) err(['rounds', i, 'id'], 'E_DUPLICATE_ID', `round id "${r.id}" is used twice.`, 'give each round its own id.');
    roundIds.add(r.id);
    const own = new Set<string>();
    (r.options ?? []).forEach((o, j) => {
      if (optionIds.has(o.id)) err(['rounds', i, 'options', j, 'id'], 'E_DUPLICATE_ID', `option id "${o.id}" is used twice.`, 'give each option its own id (e.g. r2a, r2b).');
      optionIds.add(o.id); own.add(o.id);
      (o.shapes ?? []).forEach((sid, k) => { if (!byId.has(sid)) missing(sid, `option "${o.id}" shows shape`, ['rounds', i, 'options', j, 'shapes', k]); });
    });
    if (r.chosen !== undefined && !own.has(r.chosen)) {
      const dym = suggest(r.chosen, [...own]);
      err(['rounds', i, 'chosen'], 'E_REF', `round "${r.id}" chose "${r.chosen}", which is not one of its options.`, dym.length ? `did you mean "${dym[0]}"?` : own.size ? `use one of ${[...own].join(', ')}.` : 'add the option first (round.option).');
    }
  });
  for (const t of ['log', 'spend'] as const) {
    const seen = new Set<string>();
    (b[t] ?? []).forEach((e, i) => {
      if (seen.has(e.id)) err([t, i, 'id'], 'E_DUPLICATE_ID', `${t} id "${e.id}" is used twice.`, 'give each entry its own id.');
      seen.add(e.id);
    });
  }
  (b.spend ?? []).forEach((e, i) => {
    if (e.round !== undefined && !roundIds.has(e.round)) err(['spend', i, 'round'], 'E_REF', `spend "${e.id}" is for round "${e.round}", which does not exist.`, `use one of ${[...roundIds].join(', ') || '(no rounds yet)'}, or remove "round".`);
  });
}
