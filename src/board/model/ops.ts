/**
 * Board ops (docs/plans/BOARD.md §5): validated with zod, applied in a batch on a copy (atomic: any invalid op throws
 * an MglError and the board is untouched), then the whole result is re-validated. Pure apart from the clock
 * (ctx.now, default: now).
 */
import { z } from 'zod';
import { MglError, fail, suggest } from '../../core/errors.js';
import { SHAPE_TYPES, type BoardFile, type BoardOp, type Outline, type Round, type Shape, type ShapeType, type Who } from '../shared/types.js';
import { BRIEF_LISTS, Brief, DEFAULT_SIZE, FIDELITIES, KEY_ORDER, ROUND_STATUS, RoundOption, SHAPE_KEYS, SHAPE_SCHEMAS, STILL_WIDTH, TimeLike, VariantPath, reportZod, validateBoard } from './schema.js';
import { compOf, framesToTime, timeToFrames } from './outline.js';

export interface OpsContext { by: Who; outline?: Outline | null; now?: string }
export interface OpsResult { board: BoardFile; changed: string[]; created: string[] }

/** Id prefix per shape type (n3, s4, ...); rounds r, log m, spend c. */
export const ID_PREFIX: Record<ShapeType, string> = { frame: 'f', note: 'n', text: 't', rect: 'g', ellipse: 'g', arrow: 'a', draw: 'd', image: 'i', still: 's', timeline: 'l', pin: 'p' };

const Id = z.string().min(1);
const Ids = z.array(Id).min(1);
const Level = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const Num = z.number().finite();
const by = { by: z.enum(['human', 'ai']).optional() };
const op = <T extends string>(name: T) => ({ op: z.literal(name), ...by });
/** every field optional and nullable (null removes it) */
const nullable = (shape: Record<string, z.ZodType>) => Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, (v instanceof z.ZodOptional ? (v.unwrap() as z.ZodType) : v).nullable().optional()]));

export const OP_SCHEMAS = {
  'shape.add': z.strictObject({ ...op('shape.add'), shape: z.record(z.string(), z.unknown()) }),
  'shape.set': z.strictObject({ ...op('shape.set'), id: Id, props: z.record(z.string(), z.unknown()) }),
  'shape.remove': z.strictObject({ ...op('shape.remove'), id: Id.optional(), ids: Ids.optional() }),
  'shape.move': z.strictObject({ ...op('shape.move'), ids: Ids, dx: Num, dy: Num }),
  'shape.order': z.strictObject({ ...op('shape.order'), ids: Ids, to: z.enum(['front', 'back', 'forward', 'backward']) }),
  'brief.set': z.strictObject({ ...op('brief.set'), ...nullable(Brief.shape as Record<string, z.ZodType>), add: z.record(z.string(), z.array(z.string())).optional(), remove: z.record(z.string(), z.array(z.string())).optional() }),
  'round.open': z.strictObject({ ...op('round.open'), goal: z.string().min(1), fidelity: Level.optional(), id: Id.optional() }),
  'round.option': z.strictObject({ ...op('round.option'), round: Id, option: z.record(z.string(), z.unknown()) }),
  'round.decide': z.strictObject({ ...op('round.decide'), round: Id, chosen: Id, why: z.string().optional() }),
  'round.set': z.strictObject({ ...op('round.set'), round: Id, props: z.strictObject({ status: z.enum(ROUND_STATUS).optional(), notes: z.string().nullable().optional(), goal: z.string().min(1).optional(), fidelity: Level.optional() }) }),
  'pin.add': z.strictObject({ ...op('pin.add'), target: Id, u: Num.min(0).max(1).optional(), v: Num.min(0).max(1).optional(), text: z.string().min(1) }),
  'pin.resolve': z.strictObject({ ...op('pin.resolve'), id: Id, reply: z.string().optional() }),
  say: z.strictObject({ ...op('say'), text: z.string().min(1), re: z.union([Id, Ids]).optional() }),
  'still.add': z.strictObject({ ...op('still.add'), t: TimeLike, comp: Id.optional(), fidelity: z.enum(FIDELITIES).optional(), x: Num.optional(), y: Num.optional(), parent: Id.optional(), project: VariantPath.optional() }),
  'storyboard.make': z.strictObject({ ...op('storyboard.make'), frame: z.string().min(1).optional(), every: TimeLike.optional(), cuts: z.boolean().optional(), fidelity: z.enum(FIDELITIES).optional() }),
  'spend.add': z.strictObject({ ...op('spend.add'), level: Level, what: z.string().min(1), ms: Num.min(0), round: Id.optional() }),
} as const;
export const OP_NAMES = Object.keys(OP_SCHEMAS) as (keyof typeof OP_SCHEMAS)[];

/** One example per op, for fixes. */
export const OP_EXAMPLES: Record<string, string> = {
  'shape.add': 'shape.add note text="Open on the drawer" x=40 y=60',
  'shape.set': 'shape.set n1 text="New text" color=blue',
  'shape.remove': 'shape.remove n1',
  'shape.move': 'shape.move ids=n1,n2 dx=100 dy=0',
  'shape.order': 'shape.order ids=n1 to=front',
  'brief.set': 'brief.set goal="30 s Short about X" audience="students" success="viewer can do the trick"',
  'round.open': 'round.open "pick the opening" fidelity=1',
  'round.option': 'round.option r1 title="Drawer close-up" tradeoffs="strong hook; needs a new shot" shapes=s1',
  'round.decide': 'round.decide r1 chosen=r1a why="the hook is the trick itself"',
  'round.set': 'round.set r1 status=dropped',
  'pin.add': 'pin.add s1 u=0.5 v=0.2 text="title too small"',
  'pin.resolve': 'pin.resolve p1 reply="title is now 96 px"',
  say: 'say "Two options are up in round r2" re=m4',
  'still.add': 'still.add 2.5s fidelity=half',
  'storyboard.make': 'storyboard.make every=3s',
  'spend.add': 'spend.add level=1 what="still s1" ms=180',
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

class State {
  changed = new Set<string>();
  created = new Set<string>();
  constructor(public b: BoardFile, public ctx: OpsContext) {}
  get shapes(): Shape[] { return (this.b.shapes ??= []); }
  get rounds(): Round[] { return (this.b.rounds ??= []); }
  shape(id: string, what = 'shape'): Shape {
    const s = this.shapes.find((x) => x.id === id);
    if (!s) {
      const dym = suggest(id, this.shapes.map((x) => x.id));
      fail('E_REF', `${what} "${id}" does not exist.`, dym.length ? `did you mean "${dym[0]}"?` : this.shapes.length ? 'use an id from mgl board show <file> --json.' : 'the board has no shapes yet.', dym.length ? { didYouMean: dym } : {});
    }
    return s;
  }
  round(id: string): Round {
    const r = this.rounds.find((x) => x.id === id);
    if (!r) {
      const dym = suggest(id, this.rounds.map((x) => x.id));
      fail('E_REF', `round "${id}" does not exist.`, dym.length ? `did you mean "${dym[0]}"?` : this.rounds.length ? `rounds: ${this.rounds.map((x) => x.id).join(', ')}.` : `open one first: ${OP_EXAMPLES['round.open']}.`, dym.length ? { didYouMean: dym } : {});
    }
    return r;
  }
  allIds(): Set<string> {
    const ids = new Set<string>();
    for (const t of ['shapes', 'rounds', 'log', 'spend'] as const) for (const e of (this.b[t] ?? []) as { id: string }[]) ids.add(e.id);
    for (const r of this.b.rounds ?? []) for (const o of r.options ?? []) ids.add(o.id);
    return ids;
  }
  nextId(prefix: string): string {
    const re = new RegExp(`^${prefix}(\\d+)$`);
    let n = 0;
    for (const id of this.allIds()) { const m = re.exec(id); if (m) n = Math.max(n, Number(m[1])); }
    return `${prefix}${n + 1}`;
  }
  touch(id: string, created = false) { this.changed.add(id); if (created) this.created.add(id); }
  who(o: { by?: Who }): Who { return o.by ?? this.ctx.by; }
  /** approximate bounds for layout (the page's SHAPE_DEFS draw the real thing) */
  bounds(s: Shape, depth = 0): { x: number; y: number; w: number; h: number } {
    if (s.type === 'still') {
      const w = s.w ?? STILL_WIDTH[s.fidelity ?? 'thumb']!;
      return { x: s.x, y: s.y, w, h: s.h ?? Math.round(w * this.aspect()) };
    }
    if (s.type === 'arrow') {
      const pts = (['from', 'to'] as const).map((k) => this.endPoint(s[k], depth + 1)).filter((p): p is [number, number] => !!p);
      if (!pts.length) return { x: s.x, y: s.y, w: 0, h: 0 };
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    if (s.type === 'draw' && s.points.length) {
      const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]);
      return { x: s.x + Math.min(...xs), y: s.y + Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    const [dw, dh] = DEFAULT_SIZE[s.type];
    return { x: s.x, y: s.y, w: s.w ?? dw, h: s.h ?? dh };
  }
  /** h / w of the linked comp (9:16 without a project) */
  aspect(): number {
    const c = this.ctx.outline ? compOf(this.ctx.outline) : undefined;
    return c ? c.size[1] / c.size[0] : 16 / 9;
  }
  /** depth: arrows bound to arrows (refused by the ops, possible by hand) must not recurse forever */
  endPoint(v: string | [number, number] | undefined, depth = 0): [number, number] | undefined {
    if (Array.isArray(v)) return v;
    if (typeof v !== 'string' || depth > 8) return undefined;
    const t = this.shapes.find((x) => x.id === v);
    if (!t) return undefined;
    const r = this.bounds(t, depth);
    return [r.x + r.w / 2, r.y + r.h / 2];
  }
  /** A free spot: right of the last shape of the same type (gap 30), else right of everything (gap 60); inside `parent` when given. */
  place(type: ShapeType, parent?: string): [number, number] {
    const pool = this.shapes.filter((s) => s.type !== 'pin' && (parent ? s.parent === parent : true));
    const last = [...pool].reverse().find((s) => s.type === type);
    if (last) { const r = this.bounds(last); return [r.x + r.w + 30, r.y]; }
    if (parent) { const f = this.bounds(this.shape(parent)); return [f.x + 40, f.y + 70]; }
    const top = pool.filter((s) => !s.parent);
    if (!top.length) return [0, 0];
    const rs = top.map((s) => this.bounds(s));
    return [Math.max(...rs.map((r) => r.x + r.w)) + 60, Math.min(...rs.map((r) => r.y))];
  }
  /** a shape and every shape inside it (frames nest) */
  withChildren(ids: string[]): string[] {
    const out = new Set(ids);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of this.shapes) if (s.parent && out.has(s.parent) && !out.has(s.id)) { out.add(s.id); grew = true; }
    }
    return [...out];
  }
}

/** zod issues of an op → one MglError (unknown keys get a did-you-mean against the op's own fields). */
function opError(name: string, o: Record<string, unknown>, issues: z.core.$ZodIssue[], allowed: (path: PropertyKey[]) => string[]): never {
  const first = issues[0]!;
  const ex = OP_EXAMPLES[name] ? ` e.g. mgl board edit <file> ${OP_EXAMPLES[name]}` : '';
  if (first.code === 'unrecognized_keys') {
    const keys = allowed(first.path);
    const k = first.keys[0]!;
    const dym = suggest(k, keys);
    const where = first.path.length ? `${first.path.join('.')}.` : '';
    fail('E_UNKNOWN_KEY', `${name}: "${where}${k}" is not a field of ${name}.`, dym.length ? `did you mean "${dym[0]}"?` : `fields: ${keys.join(', ')}.`, dym.length ? { didYouMean: dym } : {});
  }
  let err: MglError | undefined;
  reportZod([first], o, (path, code, message, fix, extra) => { err ??= new MglError({ code, message: `${name}: ${message.replace(/^the board/, 'the op')}`, fix: `${fix.startsWith('compare with') ? 'see docs/plans/BOARD.md §5 (ops).' : fix}${ex}`, path: path.join('.'), ...extra }); });
  throw err ?? new MglError({ code: 'E_SCHEMA', message: `${name}: ${first.message}.`, fix: ex.trim() || 'see docs/plans/BOARD.md §5.' });
}

/** Validate a shape object against its type's schema (errors name the shape and field). */
function checkShape(s: Record<string, unknown>, opName: string): Shape {
  const type = s.type as ShapeType;
  const res = SHAPE_SCHEMAS[type].safeParse(s);
  if (res.success) return { ...res.data, x: res.data.x ?? 0, y: res.data.y ?? 0 } as unknown as Shape;
  const first = res.error.issues[0]!;
  if (first.code === 'unrecognized_keys') {
    const k = first.keys[0]!, dym = suggest(k, SHAPE_KEYS[type]);
    fail('E_UNKNOWN_KEY', `${opName}: "${k}" is not a property of a ${type}.`, dym.length ? `did you mean "${dym[0]}"?` : `${type} properties: ${SHAPE_KEYS[type].join(', ')}.`, dym.length ? { didYouMean: dym } : {});
  }
  let err: MglError | undefined;
  reportZod([first], { shapes: [s] }, (path, code, message, fix, extra) => { err ??= new MglError({ code, message: `${opName}: ${message}`, fix, path: path.slice(2).join('.'), ...extra }); }, ['shapes', 0]);
  throw err!;
}

function checkType(type: unknown, opName: string): ShapeType {
  if (typeof type === 'string' && (SHAPE_TYPES as readonly string[]).includes(type)) return type as ShapeType;
  if (type === undefined) fail('E_MISSING', `${opName}: the shape needs a "type".`, `types: ${SHAPE_TYPES.join(', ')}. e.g. mgl board edit <file> ${OP_EXAMPLES['shape.add']}`);
  const dym = typeof type === 'string' ? suggest(type, SHAPE_TYPES) : [];
  return fail('E_SCHEMA', `${opName}: ${JSON.stringify(type)} is not a shape type.`, dym.length ? `did you mean "${dym[0]}"?` : `types: ${SHAPE_TYPES.join(', ')}.`, dym.length ? { didYouMean: dym } : {});
}

function checkNewId(st: State, id: unknown, what: string) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) fail('E_SCHEMA', `${what}: id ${JSON.stringify(id)} is not valid.`, 'ids are lowercase letters, digits, "-" and "_" (e.g. n3); or leave "id" out to get one generated.');
  if (st.allIds().has(id)) fail('E_DUPLICATE_ID', `${what}: id "${id}" is already used.`, 'pick another id, or leave "id" out to get one generated.');
}

function checkParent(st: State, parent: unknown, opName: string) {
  if (parent === undefined) return;
  const p = st.shape(String(parent), `${opName}: parent`);
  if (p.type !== 'frame') fail('E_REF', `${opName}: parent "${p.id}" is a ${p.type}, not a frame.`, 'a parent must be a frame (shape.add frame ...).');
}

/** A still's time against the linked project (when there is one). */
function checkStillTime(st: State, t: string | number, comp: string | undefined, opName: string) {
  const o = st.ctx.outline;
  if (!o) { try { timeToFrames(t, 30); } catch (e) { if (e instanceof MglError) fail(e.code, `${opName}: ${e.message}`, e.fix); throw e; } return; }
  if (comp !== undefined && !o.comps.some((c) => c.id === comp)) {
    const dym = suggest(comp, o.comps.map((c) => c.id));
    fail('E_REF', `${opName}: comp "${comp}" is not in the project.`, dym.length ? `did you mean "${dym[0]}"?` : `comps: ${o.comps.map((c) => c.id).join(', ')}.`);
  }
  const c = compOf(o, comp)!;
  let f: number;
  try { f = timeToFrames(t, c.fps); } catch (e) { if (e instanceof MglError) fail(e.code, `${opName}: ${e.message}`, e.fix); throw e; }
  if (f < 0 || (c.length > 0 && f >= c.length)) fail('E_TIME_RANGE', `${opName}: t ${JSON.stringify(t)} is outside comp "${c.id}" (0 to ${framesToTime(c.length, c.fps)}).`, `use a time from 0 to ${framesToTime(Math.max(0, c.length - 1), c.fps)}.`);
}

function refShape(st: State, id: string, opName: string, field: string): Shape { return st.shape(id, `${opName}: ${field}`); }

/** An arrow end or a pin target must be another shape that is not an arrow or a pin (no self-binding, no chains). */
function refTarget(st: State, id: string, self: string, opName: string, field: string) {
  if (id === self) fail('E_ARG', `${opName}: ${field} "${id}" is the shape itself.`, field.startsWith('arrow') ? 'bind the arrow to another shape, or give a point [x, y].' : 'pin it on another shape.');
  const t = refShape(st, id, opName, field);
  if (t.type === 'arrow' || t.type === 'pin') fail('E_ARG', `${opName}: ${field} "${id}" is a ${t.type}; ${field.startsWith('arrow') ? 'arrows bind to' : 'pins go on'} a still, note, frame or other shape.`, field.startsWith('arrow') ? 'bind it to the shape that arrow or pin points at, or give a point [x, y].' : 'pin it on the shape the arrow or pin points at.');
}

type Handler = (st: State, o: Record<string, unknown>) => void;

const HANDLERS: Record<string, Handler> = {
  'shape.add'(st, o) {
    const s = clone(o.shape as Record<string, unknown>);
    const type = checkType(s.type, 'shape.add');
    if (s.id !== undefined) checkNewId(st, s.id, 'shape.add'); else s.id = st.nextId(ID_PREFIX[type]);
    s.by ??= st.who(o);
    checkParent(st, s.parent, 'shape.add');
    if (type === 'arrow') for (const k of ['from', 'to']) if (typeof s[k] === 'string') refTarget(st, s[k] as string, s.id as string, 'shape.add', `arrow ${k}`);
    if (type === 'pin') { if (typeof s.target !== 'string') fail('E_MISSING', 'shape.add: a pin needs "target" (a shape id).', `use ${OP_EXAMPLES['pin.add']}`); refTarget(st, s.target, s.id as string, 'shape.add', 'pin target'); }
    if (type === 'still' && (typeof s.t === 'string' || typeof s.t === 'number')) checkStillTime(st, s.t, s.comp as string | undefined, 'shape.add');
    if (s.x === undefined && s.y === undefined && type !== 'arrow' && type !== 'pin') [s.x, s.y] = st.place(type, s.parent as string | undefined);
    const shape = checkShape(s, 'shape.add');
    st.shapes.push(shape);
    st.touch(shape.id, true);
  },
  'shape.set'(st, o) {
    const s = st.shape(o.id as string, 'shape.set:');
    const props = o.props as Record<string, unknown>;
    for (const k of ['id', 'type']) if (k in props) fail('E_ARG', `shape.set: "${k}" cannot be changed.`, k === 'type' ? 'remove the shape and add a new one of the other type.' : 'add a copy with the new id and remove the old one.');
    const next = { ...s } as Record<string, unknown>;
    for (const [k, v] of Object.entries(props)) { if (v === null) delete next[k]; else next[k] = v; }
    if ('parent' in props && props.parent !== null) checkParent(st, props.parent, 'shape.set');
    if (s.type === 'arrow') for (const k of ['from', 'to']) if (typeof props[k] === 'string') refTarget(st, props[k] as string, s.id, 'shape.set', `arrow ${k}`);
    if (s.type === 'pin' && typeof props.target === 'string') refTarget(st, props.target, s.id, 'shape.set', 'pin target');
    if (s.type === 'still' && ('t' in props || 'comp' in props)) checkStillTime(st, next.t as string, next.comp as string | undefined, 'shape.set');
    const shape = checkShape(next, 'shape.set');
    st.shapes[st.shapes.indexOf(s)] = shape;
    st.touch(shape.id);
  },
  'shape.remove'(st, o) {
    const ids = (o.ids as string[] | undefined) ?? (o.id !== undefined ? [o.id as string] : []);
    if (!ids.length) fail('E_MISSING', 'shape.remove needs "id" or "ids".', `e.g. mgl board edit <file> ${OP_EXAMPLES['shape.remove']}`);
    for (const id of ids) { const s = st.shape(id, 'shape.remove:'); if (s.locked) fail('E_LOCKED', `shape.remove: "${id}" is locked.`, `unlock it first: shape.set ${id} locked=null`); }
    const gone = new Set(st.withChildren(ids));
    // pins on removed shapes go with them
    for (let grew = true; grew;) { grew = false; for (const s of st.shapes) if (s.type === 'pin' && gone.has(s.target) && !gone.has(s.id)) { gone.add(s.id); grew = true; } }
    // arrows bound to a removed shape keep their last point
    for (const s of st.shapes) if (s.type === 'arrow' && !gone.has(s.id)) for (const k of ['from', 'to'] as const) {
      const v = s[k];
      if (typeof v === 'string' && gone.has(v)) { const p = st.endPoint(v); if (p) s[k] = [Math.round(p[0]), Math.round(p[1])]; else delete s[k]; st.touch(s.id); }
    }
    st.b.shapes = st.shapes.filter((s) => !gone.has(s.id));
    for (const r of st.b.rounds ?? []) for (const opt of r.options ?? []) if (opt.shapes?.some((x) => gone.has(x))) {
      opt.shapes = opt.shapes.filter((x) => !gone.has(x));
      if (!opt.shapes.length) delete opt.shapes;
      st.touch(r.id);
    }
    if (st.b.brief?.references?.some((x) => gone.has(x))) { st.b.brief.references = st.b.brief.references.filter((x) => !gone.has(x)); st.touch('brief'); }
    for (const id of gone) st.touch(id);
  },
  'shape.move'(st, o) {
    const ids = o.ids as string[];
    for (const id of ids) { const s = st.shape(id, 'shape.move:'); if (s.locked) fail('E_LOCKED', `shape.move: "${id}" is locked.`, `unlock it first: shape.set ${id} locked=null`); }
    const dx = o.dx as number, dy = o.dy as number;
    for (const id of st.withChildren(ids)) {
      const s = st.shape(id);
      if (s.type === 'pin') continue; // a pin follows its target
      if (s.type !== 'arrow') { s.x += dx; s.y += dy; } // an arrow's place is its ends
      if (s.type === 'arrow') for (const k of ['from', 'to'] as const) { const v = s[k]; if (Array.isArray(v)) s[k] = [v[0] + dx, v[1] + dy]; }
      st.touch(id);
    }
  },
  'shape.order'(st, o) {
    const ids = o.ids as string[];
    for (const id of ids) st.shape(id, 'shape.order:');
    const sel = new Set(ids);
    const list = st.shapes;
    const to = o.to as string;
    if (to === 'front' || to === 'back') {
      const picked = list.filter((s) => sel.has(s.id)), rest = list.filter((s) => !sel.has(s.id));
      st.b.shapes = to === 'front' ? [...rest, ...picked] : [...picked, ...rest];
    } else if (to === 'forward') {
      for (let i = list.length - 2; i >= 0; i--) if (sel.has(list[i]!.id) && !sel.has(list[i + 1]!.id)) [list[i], list[i + 1]] = [list[i + 1]!, list[i]!];
    } else {
      for (let i = 1; i < list.length; i++) if (sel.has(list[i]!.id) && !sel.has(list[i - 1]!.id)) [list[i], list[i - 1]] = [list[i - 1]!, list[i]!];
    }
    for (const id of ids) st.touch(id);
  },
  'brief.set'(st, o) {
    const brief = clone(st.b.brief ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'op' || k === 'by' || k === 'add' || k === 'remove') continue;
      if (v === null) delete brief[k];
      else if (k === 'budget') {
        const b0 = { ...(brief.budget as object ?? {}) } as Record<string, unknown>;
        for (const [bk, bv] of Object.entries(v as object)) { if (bv === null) delete b0[bk]; else b0[bk] = bv; }
        if (Object.keys(b0).length) brief.budget = b0; else delete brief.budget;
      } else brief[k] = v;
    }
    for (const mode of ['add', 'remove'] as const) for (const [k, items] of Object.entries((o[mode] as Record<string, string[]> | undefined) ?? {})) {
      if (!(BRIEF_LISTS as readonly string[]).includes(k)) {
        const dym = suggest(k, BRIEF_LISTS);
        fail('E_ARG', `brief.set: ${mode} works on list fields; "${k}" is not one.`, dym.length ? `did you mean "${dym[0]}"?` : `list fields: ${BRIEF_LISTS.join(', ')}.`);
      }
      const cur = (brief[k] as string[] | undefined) ?? [];
      brief[k] = mode === 'add' ? [...cur, ...items.filter((x) => !cur.includes(x))] : cur.filter((x) => !items.includes(x));
      if (!(brief[k] as string[]).length) delete brief[k];
    }
    const res = Brief.safeParse(brief);
    if (!res.success) opError('brief.set', { brief } as Record<string, unknown>, res.error.issues.map((i) => ({ ...i, path: ['brief', ...i.path] })), () => KEY_ORDER.brief);
    st.b.brief = res.data as BoardFile['brief'];
    st.touch('brief');
  },
  'round.open'(st, o) {
    const id = o.id === undefined ? st.nextId('r') : (checkNewId(st, o.id, 'round.open'), o.id as string);
    const last = [...st.rounds].reverse().find((r) => r.status === 'decided');
    st.rounds.push({ id, goal: o.goal as string, fidelity: (o.fidelity as Round['fidelity'] | undefined) ?? last?.fidelity ?? 0, status: 'open' });
    st.touch(id, true);
  },
  'round.option'(st, o) {
    const r = st.round(o.round as string);
    const opt = clone(o.option as Record<string, unknown>);
    const existing = typeof opt.id === 'string' ? r.options?.find((x) => x.id === opt.id) : undefined;
    if (r.status === 'decided' || r.status === 'dropped') fail('E_ROUND_CLOSED', `round.option: round "${r.id}" is ${r.status}.`, `reopen it (round.set ${r.id} status=open) or open a new round (round.open "...").`);
    let merged: Record<string, unknown>;
    if (existing) {
      merged = { ...existing };
      for (const [k, v] of Object.entries(opt)) { if (v === null) delete merged[k]; else merged[k] = v; }
    } else {
      if (opt.id !== undefined) checkNewId(st, opt.id, 'round.option');
      else {
        const used = st.allIds();
        let n = 0;
        const letter = (i: number) => (i < 26 ? String.fromCharCode(97 + i) : `${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`);
        while (used.has(`${r.id}${letter(n)}`)) n++;
        opt.id = `${r.id}${letter(n)}`;
      }
      if (typeof opt.title !== 'string' || !opt.title) fail('E_MISSING', 'round.option: the option needs a "title".', `e.g. mgl board edit <file> ${OP_EXAMPLES['round.option']}`);
      merged = { id: opt.id, ...opt };
    }
    const res = RoundOption.safeParse(merged);
    if (!res.success) opError('round.option', { option: merged }, res.error.issues.map((i) => ({ ...i, path: ['option', ...i.path] })), () => KEY_ORDER.options);
    for (const sid of res.data.shapes ?? []) refShape(st, sid, 'round.option', 'option shape');
    const options = (r.options ??= []);
    if (existing) options[options.indexOf(existing)] = res.data as never; else options.push(res.data as never);
    if (r.status === 'open' && options.length >= 2) r.status = 'proposed';
    st.touch(r.id); st.touch(res.data.id, !existing);
  },
  'round.decide'(st, o) {
    const r = st.round(o.round as string);
    const chosen = o.chosen as string;
    const ids = (r.options ?? []).map((x) => x.id);
    if (!ids.includes(chosen)) {
      const byTitle = (r.options ?? []).find((x) => x.title.toLowerCase() === chosen.toLowerCase());
      const dym = suggest(chosen, ids);
      fail('E_REF', `round.decide: "${chosen}" is not an option of round "${r.id}".`, byTitle ? `use its id: chosen=${byTitle.id}` : dym.length ? `did you mean "${dym[0]}"?` : ids.length ? `options: ${ids.join(', ')}.` : `add options first: ${OP_EXAMPLES['round.option']}`);
    }
    r.status = 'decided';
    r.chosen = chosen;
    if (o.why !== undefined) r.why = o.why as string;
    st.touch(r.id);
  },
  'round.set'(st, o) {
    const r = st.round(o.round as string);
    const props = o.props as Record<string, unknown>;
    if (props.status === 'decided' && !r.chosen) fail('E_ARG', `round.set: round "${r.id}" has no chosen option.`, `use round.decide ${r.id} chosen=<option id> why="..."`);
    const rec = r as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(props)) { if (v === null) delete rec[k]; else if (v !== undefined) rec[k] = v; }
    if (props.status && props.status !== 'decided') { delete r.chosen; delete r.why; }
    st.touch(r.id);
  },
  'pin.add'(st, o) {
    const t = st.shape(o.target as string, 'pin.add: target');
    if (t.type === 'pin' || t.type === 'arrow') fail('E_ARG', `pin.add: "${t.id}" is a ${t.type}; pin feedback on a still, note, frame or other shape.`, 'pin it on the shape the arrow or pin points at.');
    const id = st.nextId('p');
    const pin: Record<string, unknown> = { id, type: 'pin', target: t.id, text: o.text, by: st.who(o) };
    if (o.u !== undefined) pin.u = o.u;
    if (o.v !== undefined) pin.v = o.v;
    st.shapes.push(checkShape(pin, 'pin.add'));
    st.touch(id, true);
  },
  'pin.resolve'(st, o) {
    const p = st.shape(o.id as string, 'pin.resolve:');
    if (p.type !== 'pin') fail('E_ARG', `pin.resolve: "${p.id}" is a ${p.type}, not a pin.`, 'give a pin id (p1, p2, ...).');
    p.status = 'resolved';
    if (o.reply !== undefined) p.reply = o.reply as string;
    st.touch(p.id);
  },
  say(st, o) {
    const id = st.nextId('m');
    const re = o.re === undefined ? [] : Array.isArray(o.re) ? (o.re as string[]) : [o.re as string];
    const log = (st.b.log ??= []);
    for (const r of re) if (!log.some((m) => m.id === r)) {
      const dym = suggest(r, log.map((m) => m.id));
      fail('E_REF', `say: re "${r}" is not a log message.`, dym.length ? `did you mean "${dym[0]}"?` : log.length ? `answer one of ${log.slice(-3).map((m) => m.id).join(', ')}.` : 'there are no messages to answer yet; leave "re" out.');
    }
    log.push({ id, by: st.who(o), text: o.text as string, at: st.ctx.now ?? new Date().toISOString(), ...(re.length ? { re: [...new Set(re)] } : {}) });
    st.touch(id, true);
  },
  'still.add'(st, o) {
    checkStillTime(st, o.t as string, o.comp as string | undefined, 'still.add');
    checkParent(st, o.parent, 'still.add');
    const s: Record<string, unknown> = { id: st.nextId('s'), type: 'still', t: o.t, by: st.who(o) };
    for (const k of ['comp', 'fidelity', 'parent', 'project']) if (o[k] !== undefined) s[k] = o[k];
    const [px, py] = o.x === undefined || o.y === undefined ? st.place('still', o.parent as string | undefined) : [0, 0];
    s.x = o.x ?? px; s.y = o.y ?? py;
    st.shapes.push(checkShape(s, 'still.add'));
    st.touch(s.id as string, true);
  },
  'storyboard.make'(st, o) {
    const out = st.ctx.outline;
    if (!out) fail('E_NO_PROJECT', 'storyboard.make needs a linked project (the board has none, or it did not load).', 'set "project" in the board file to the .mgl.json path, or use the project file: mgl board edit video.mgl.json storyboard.make every=3s');
    if (o.every !== undefined && o.cuts) fail('E_ARG', 'storyboard.make: give "every" or "cuts", not both.', 'e.g. storyboard.make every=3s, or storyboard.make cuts=true');
    const c = compOf(out)!;
    const tracks = new Set(out.tracks.filter((t) => t.comp === c.id && !t.audio).map((t) => t.id));
    const starts = [...new Set(out.clips.filter((x) => tracks.has(x.track)).map((x) => x.at))].filter((f) => f >= 0 && (c.length <= 0 || f < c.length)).sort((a, b) => a - b);
    const useCuts = o.cuts === true || (o.every === undefined && starts.length > 0);
    let frames: number[];
    if (useCuts) {
      if (!starts.length) fail('E_ARG', `storyboard.make: comp "${c.id}" has no visual clips, so it has no cuts.`, 'use every=3s, or add clips first.');
      // a cut's first frame is often mid-entrance (text sliding in): sample a little later, before the next cut
      frames = starts.map((f, i) => f + Math.max(0, Math.min(Math.round(c.fps * 0.5), Math.floor(((starts[i + 1] ?? c.length) - f) / 2))));
    } else {
      if (c.length <= 0) fail('E_ARG', `storyboard.make: comp "${c.id}" is empty (length 0).`, 'add clips (or set the comp length) first.');
      let step: number;
      try { step = timeToFrames((o.every as string | number | undefined) ?? '3s', c.fps); } catch (e) { if (e instanceof MglError) fail(e.code, `storyboard.make: ${e.message}`, e.fix); throw e; }
      if (step <= 0) fail('E_ARG', 'storyboard.make: "every" must be more than 0.', 'e.g. every=3s');
      // offset the samples: at t=0 entrance animations have not started (an empty first frame misleads)
      const off = Math.min(Math.floor(step / 2), Math.round(c.fps * 0.5));
      frames = [];
      for (let f = off; f < c.length; f += step) frames.push(f);
    }
    if (frames.length > 60) fail('E_TOO_MANY', `storyboard.make would make ${frames.length} stills (at most 60).`, `use a longer interval, e.g. every=${framesToTime(Math.ceil(c.length / 30), c.fps)}.`);
    const fid = (o.fidelity as string | undefined) ?? 'thumb';
    const w = STILL_WIDTH[fid]!, h = Math.round((w * c.size[1]) / c.size[0]);
    const cols = Math.min(5, frames.length), rows = Math.ceil(frames.length / 5), pad = 40, top = 70, gx = 30, gy = 30 + 28; // 28: the still's caption
    const [fx, fy] = st.place('frame');
    const fw = pad * 2 + cols * w + (cols - 1) * gx, fh = top + rows * h + (rows - 1) * gy + 28 + pad;
    const frameId = st.nextId('f');
    st.shapes.push(checkShape({ id: frameId, type: 'frame', x: fx, y: fy, w: fw, h: fh, label: (o.frame as string | undefined) ?? 'Storyboard', by: st.who(o) }, 'storyboard.make'));
    st.touch(frameId, true);
    frames.forEach((f, i) => {
      const s: Record<string, unknown> = { id: st.nextId('s'), type: 'still', x: fx + pad + (i % 5) * (w + gx), y: fy + top + Math.floor(i / 5) * (h + gy), t: framesToTime(f, c.fps), by: st.who(o), parent: frameId };
      if (o.fidelity !== undefined) s.fidelity = o.fidelity;
      if (c.id !== out.main) s.comp = c.id;
      st.shapes.push(checkShape(s, 'storyboard.make'));
      st.touch(s.id as string, true);
    });
  },
  'spend.add'(st, o) {
    if (o.round !== undefined) st.round(o.round as string);
    const id = st.nextId('c');
    const e: Record<string, unknown> = { id, level: o.level, what: o.what, ms: Math.round(o.ms as number) };
    if (o.round !== undefined) e.round = o.round;
    (st.b.spend ??= []).push(e as never);
    st.touch(id, true);
  },
};

/** Fields an op takes, for did-you-mean on unknown keys. */
function opFields(name: string, o: Record<string, unknown>, st: State) {
  return (path: PropertyKey[]): string[] => {
    if (!path.length) return Object.keys(OP_SCHEMAS[name as keyof typeof OP_SCHEMAS].shape).filter((k) => k !== 'op' && k !== 'by');
    if (path[0] === 'props' && name === 'shape.set') return SHAPE_KEYS[st.shapes.find((s) => s.id === o.id)?.type ?? 'note'];
    if (path[0] === 'props' && name === 'round.set') return ['status', 'notes', 'goal', 'fidelity'];
    return [];
  };
}

/** Validate one op object (shape only; references are checked when it is applied). */
export function parseOp(raw: unknown, st?: State): BoardOp {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('E_COMMAND', `an op must be a JSON object, got ${JSON.stringify(raw)?.slice(0, 60)}.`, 'e.g. {"op": "say", "text": "hello"}');
  const o = raw as Record<string, unknown>;
  const name = o.op;
  if (typeof name !== 'string') fail('E_COMMAND', 'the op has no "op" name.', `ops: ${OP_NAMES.join(', ')}.`);
  const schema = OP_SCHEMAS[name as keyof typeof OP_SCHEMAS];
  if (!schema) {
    const dym = suggest(name, OP_NAMES);
    fail('E_UNKNOWN_OP', `"${name}" is not a board op.`, dym.length ? `did you mean "${dym[0]}"? (e.g. ${OP_EXAMPLES[dym[0]!]})` : `ops: ${OP_NAMES.join(', ')}.`, dym.length ? { didYouMean: dym } : {});
  }
  const res = schema.safeParse(o);
  if (!res.success) opError(name, o, res.error.issues, opFields(name, o, st ?? new State({ michelangeloBoard: 1 }, { by: 'ai' })));
  return o as unknown as BoardOp;
}

/** Prefix an error's message, and the problem that repeats it (the CLI prints each distinct problem once). */
function relabel(e: MglError, prefix: string): void {
  const old = e.message;
  e.message = prefix + old;
  for (const p of e.problems ?? []) if (p.message === old) p.message = e.message;
}

/** Apply ops in order on a copy; throws MglError (naming the op) on the first invalid one. */
export function applyOps(b: BoardFile, ops: BoardOp[], ctx: OpsContext): OpsResult {
  if (!Array.isArray(ops) || !ops.length) fail('E_COMMAND', 'no ops given.', 'give one op or a list: [{"op": "say", "text": "hi"}].');
  const st = new State(clone(b), ctx);
  ops.forEach((raw, i) => {
    try {
      const o = parseOp(raw, st) as unknown as Record<string, unknown>;
      HANDLERS[o.op as string]!(st, o);
    } catch (e) {
      if (e instanceof MglError && ops.length > 1) relabel(e, `op ${i + 1} of ${ops.length}: `);
      throw e;
    }
  });
  for (const t of ['shapes', 'rounds', 'log', 'spend'] as const) if (st.b[t] && !st.b[t]!.length) delete st.b[t];
  let board: BoardFile;
  try { board = validateBoard(clone(st.b)); } catch (e) {
    if (e instanceof MglError) relabel(e, 'after the ops: ');
    throw e;
  }
  return { board, changed: [...st.changed], created: [...st.created] };
}
