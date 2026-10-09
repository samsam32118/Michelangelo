/** The board writer: one entity per line, id first, a fixed key order per shape type, defaults omitted. Same input → same bytes. */
import { inline } from '../../core/format.js';
import type { BoardFile, Shape, ShapeType } from '../shared/types.js';
import { KEY_ORDER, SHAPE_DEFAULTS, SHAPE_KEYS, TYPE_DEFAULTS } from './schema.js';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function ordered(e: Record<string, unknown>, order: string[], isDefault: (k: string, v: unknown) => boolean = () => false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(e);
  for (const k of [...order.filter((k) => keys.includes(k)), ...keys.filter((k) => !order.includes(k)).sort()]) {
    const v = e[k];
    if (v === undefined || v === null || isDefault(k, v)) continue;
    out[k] = v;
  }
  return out;
}

export function orderShape(s: Shape | Record<string, unknown>): Record<string, unknown> {
  const type = (s as Shape).type as ShapeType;
  const td = TYPE_DEFAULTS[type] ?? {};
  return ordered(s as Record<string, unknown>, SHAPE_KEYS[type] ?? ['id', 'type'], (k, v) => (k in td ? same(td[k], v) : k in SHAPE_DEFAULTS && same(SHAPE_DEFAULTS[k], v)));
}

export function shapeLine(s: Shape | Record<string, unknown>): string { return inline(orderShape(s)); }

export function entityLine(table: 'shapes' | 'rounds' | 'log' | 'spend', e: object): string {
  if (table === 'shapes') return shapeLine(e as Shape);
  const o = e as Record<string, unknown>;
  if (table === 'rounds') {
    const r = ordered(o, KEY_ORDER.rounds, (k, v) => k === 'options' && Array.isArray(v) && v.length === 0);
    if (Array.isArray(r.options)) r.options = (r.options as Record<string, unknown>[]).map((x) => ordered(x, KEY_ORDER.options, (k, v) => k === 'shapes' && Array.isArray(v) && v.length === 0));
    return inline(r);
  }
  return inline(ordered(o, KEY_ORDER[table]));
}

export function formatBrief(b: NonNullable<BoardFile['brief']>): string {
  const o = ordered(b as Record<string, unknown>, KEY_ORDER.brief, (_k, v) => Array.isArray(v) && v.length === 0);
  if (o.budget && typeof o.budget === 'object') {
    o.budget = ordered(o.budget as Record<string, unknown>, KEY_ORDER.budget);
    if (!Object.keys(o.budget as object).length) delete o.budget;
  }
  return inline(o);
}

/** The whole file. Empty tables and an empty brief are left out. */
export function formatBoard(b: BoardFile): string {
  const head: Record<string, unknown> = { michelangeloBoard: b.michelangeloBoard };
  if (b.project !== undefined) head.project = b.project;
  const lines: string[] = [inline(head).slice(0, -1) + ','];
  if (b.brief) {
    const brief = formatBrief(b.brief);
    if (brief !== '{}') lines.push(`"brief": ${brief},`);
  }
  for (const t of ['shapes', 'rounds', 'log', 'spend'] as const) {
    const rows = b[t] as object[] | undefined;
    if (!rows?.length) continue;
    lines.push(`"${t}": [`);
    rows.forEach((r, i) => lines.push(entityLine(t, r) + (i < rows.length - 1 ? ',' : '')));
    lines.push('],');
  }
  const last = lines.length - 1;
  lines[last] = lines[last]!.replace(/,$/, '');
  if (lines.length === 1) return inline(head) + '\n';
  lines.push('}');
  return lines.join('\n') + '\n';
}
