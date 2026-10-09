/**
 * A best-effort local copy of the board ops, for optimistic updates (and the detached page of `mgl board export`).
 * The server's applyOps is the truth: the page replaces this result with the server's state as soon as it arrives.
 * Throws on an op it cannot apply; the caller then waits for the server.
 */
import type { BoardFile, BoardOp, Brief, Round, Shape, ShapeType, Who } from '../shared/types.js';
import { shapeBounds } from '../shared/shapes.js';
import { center } from '../shared/geometry.js';

export const ID_PREFIX: Record<ShapeType, string> = { frame: 'f', note: 'n', text: 't', rect: 'g', ellipse: 'g', arrow: 'a', draw: 'd', image: 'i', still: 's', timeline: 'l', pin: 'p' };

export function allIds(b: BoardFile): Set<string> {
  const ids = new Set<string>();
  for (const t of ['shapes', 'rounds', 'log', 'spend'] as const) for (const e of (b[t] ?? []) as { id: string }[]) ids.add(e.id);
  for (const r of b.rounds ?? []) for (const o of r.options ?? []) ids.add(o.id);
  return ids;
}

/** the next free readable id with a prefix (n3, s4, r2), counting `taken` too */
export function nextId(b: BoardFile, prefix: string, taken: Iterable<string> = []): string {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let n = 0;
  for (const id of [...allIds(b), ...taken]) { const m = re.exec(id); if (m) n = Math.max(n, Number(m[1])); }
  return `${prefix}${n + 1}`;
}

const withChildren = (shapes: Shape[], ids: string[]): Set<string> => {
  const out = new Set(ids);
  for (let grew = true; grew;) { grew = false; for (const s of shapes) if (s.parent && out.has(s.parent) && !out.has(s.id)) { out.add(s.id); grew = true; } }
  return out;
};

/** apply ops to a deep copy; returns the copy and the ids it touched */
export function applyLocal(board: BoardFile, ops: BoardOp[], by: Who): { board: BoardFile; changed: string[] } {
  const b = structuredClone(board) as BoardFile;
  const changed = new Set<string>();
  b.shapes ??= [];
  const shape = (id: string): Shape => { const s = b.shapes!.find((x) => x.id === id); if (!s) throw new Error(`no shape ${id}`); return s; };
  const lookup = (id: string) => b.shapes!.find((x) => x.id === id);
  for (const o of ops) {
    switch (o.op) {
      case 'shape.add': {
        const s = { by, ...structuredClone(o.shape) } as Shape;
        s.id ??= nextId(b, ID_PREFIX[s.type]);
        if (allIds(b).has(s.id)) throw new Error(`id ${s.id} exists`);
        if (s.x === undefined || s.y === undefined) { if (s.type !== 'arrow' && s.type !== 'pin') throw new Error('placement is the server\'s'); s.x ??= 0; s.y ??= 0; }
        b.shapes.push(s);
        changed.add(s.id);
        break;
      }
      case 'shape.set': {
        const s = shape(o.id) as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(o.props)) { if (k === 'id' || k === 'type') continue; if (v === null) delete s[k]; else s[k] = v; }
        changed.add(o.id);
        break;
      }
      case 'shape.remove': {
        const ids = o.ids ?? (o.id ? [o.id] : []);
        const gone = withChildren(b.shapes, ids);
        for (const s of b.shapes) if (s.type === 'pin' && gone.has(s.target)) gone.add(s.id);
        for (const s of b.shapes) if (s.type === 'arrow' && !gone.has(s.id)) for (const k of ['from', 'to'] as const) {
          const v = s[k];
          if (typeof v === 'string' && gone.has(v)) { const t = lookup(v); if (t) s[k] = center(shapeBounds(t, lookup)).map(Math.round) as [number, number]; changed.add(s.id); }
        }
        b.shapes = b.shapes.filter((s) => !gone.has(s.id));
        gone.forEach((id) => changed.add(id));
        break;
      }
      case 'shape.move': {
        for (const id of withChildren(b.shapes, o.ids)) {
          const s = shape(id);
          if (s.type === 'arrow') { for (const k of ['from', 'to'] as const) { const v = s[k]; if (Array.isArray(v)) s[k] = [v[0] + o.dx, v[1] + o.dy]; } }
          else { s.x += o.dx; s.y += o.dy; }
          changed.add(id);
        }
        break;
      }
      case 'shape.order': {
        const set = new Set(o.ids), list: Shape[] = b.shapes, moving: Shape[] = list.filter((s) => set.has(s.id)), rest: Shape[] = list.filter((s) => !set.has(s.id));
        if (o.to === 'front') b.shapes = [...rest, ...moving];
        else if (o.to === 'back') b.shapes = [...moving, ...rest];
        else {
          const arr: Shape[] = b.shapes, step = o.to === 'forward' ? 1 : -1;
          const idx: number[] = arr.map((s, i) => (set.has(s.id) ? i : -1)).filter((i) => i >= 0);
          for (const i of step > 0 ? idx.reverse() : idx) { const j = i + step; if (j >= 0 && j < arr.length && !set.has(arr[j]!.id)) [arr[i], arr[j]] = [arr[j]!, arr[i]!]; }
        }
        o.ids.forEach((id) => changed.add(id));
        break;
      }
      case 'brief.set': {
        const br = (b.brief ??= {}) as Record<string, unknown>;
        const { op: _op, add, remove, ...fields } = o as Record<string, unknown> & { add?: Record<string, string[]>; remove?: Record<string, string[]> };
        for (const [k, v] of Object.entries(fields)) {
          if (v === null) delete br[k];
          else if (k === 'budget') { const bu = { ...(br.budget as object ?? {}) } as Record<string, unknown>; for (const [bk, bv] of Object.entries(v as object)) { if (bv === null) delete bu[bk]; else bu[bk] = bv; } if (Object.keys(bu).length) br.budget = bu; else delete br.budget; }
          else br[k] = v;
        }
        for (const [k, v] of Object.entries(add ?? {})) br[k] = [...((br[k] as string[]) ?? []), ...v];
        for (const [k, v] of Object.entries(remove ?? {})) { br[k] = ((br[k] as string[]) ?? []).filter((x) => !v.includes(x)); if (!(br[k] as string[]).length) delete br[k]; }
        b.brief = br as Brief;
        changed.add('brief');
        break;
      }
      case 'round.open': {
        const id = o.id ?? nextId(b, 'r');
        (b.rounds ??= []).push({ id, goal: o.goal, fidelity: o.fidelity ?? 0, status: 'open' });
        changed.add(id);
        break;
      }
      case 'round.option': {
        const r = round(b, o.round);
        const opts = (r.options ??= []);
        const ex = o.option.id ? opts.find((x) => x.id === o.option.id) : undefined;
        if (ex) Object.assign(ex, o.option);
        else {
          const used = allIds(b);
          let n = 0;
          while (used.has(`${r.id}${String.fromCharCode(97 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ''}`)) n++;
          opts.push({ ...o.option, id: o.option.id ?? `${r.id}${String.fromCharCode(97 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ''}` });
        }
        changed.add(r.id);
        break;
      }
      case 'round.decide': {
        const r = round(b, o.round);
        r.status = 'decided'; r.chosen = o.chosen; if (o.why) r.why = o.why;
        changed.add(r.id);
        break;
      }
      case 'round.set': { Object.assign(round(b, o.round), o.props); changed.add(o.round); break; }
      case 'pin.add': {
        const id = nextId(b, 'p');
        b.shapes.push({ id, type: 'pin', x: 0, y: 0, target: o.target, u: o.u ?? 0.5, v: o.v ?? 0.5, text: o.text, by } as Shape);
        changed.add(id);
        break;
      }
      case 'pin.resolve': { const s = shape(o.id); if (s.type === 'pin') { s.status = 'resolved'; if (o.reply) s.reply = o.reply; } changed.add(o.id); break; }
      case 'say': { const id = nextId(b, 'm'); (b.log ??= []).push({ id, by, text: o.text, at: new Date().toISOString() }); changed.add(id); break; }
      case 'still.add': {
        if (o.x === undefined || o.y === undefined) throw new Error('placement is the server\'s');
        const id = nextId(b, 's');
        b.shapes.push({ id, type: 'still', x: o.x, y: o.y, t: o.t, by, ...(o.comp ? { comp: o.comp } : {}), ...(o.fidelity ? { fidelity: o.fidelity } : {}), ...(o.parent ? { parent: o.parent } : {}) } as Shape);
        changed.add(id);
        break;
      }
      case 'spend.add': { const id = nextId(b, 'c'); (b.spend ??= []).push({ id, level: o.level, what: o.what, ms: o.ms, ...(o.round ? { round: o.round } : {}) }); changed.add(id); break; }
      default: throw new Error(`${o.op} is applied by the server`);
    }
  }
  return { board: b, changed: [...changed] };
}

function round(b: BoardFile, id: string): Round {
  const r = (b.rounds ?? []).find((x) => x.id === id);
  if (!r) throw new Error(`no round ${id}`);
  return r;
}
