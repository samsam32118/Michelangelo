/**
 * The writer: one entity per line, `id` first, a fixed key order, defaults omitted, tables in file order.
 * Same input → same bytes (so diffs show only real changes).
 */
import { KEY_ORDER, TABLES, type ProjectFile, type TableName, type Clip } from './schema/index.js';

/** Values equal to these are omitted when writing (they are the defaults filled in on read). */
export const DEFAULTS: Partial<Record<TableName, Record<string, unknown>>> = {
  clips: { in: 0, speed: 1, opacity: 1, scale: 1, rotate: 0, blend: 'normal', gain: 0, muted: false, hidden: false, locked: false, loop: false, clock: 0, anchor: [0.5, 0.5] },
  tracks: { audio: false, hidden: false, muted: false, locked: false },
  buses: { gain: 0, muted: false },
};

function isDefault(table: TableName, key: string, value: unknown): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value) && value.length === 0 && (key === 'fx' || key === 'masks' || key === 'tags')) return true;
  const d = DEFAULTS[table]?.[key];
  if (d === undefined) return false;
  return JSON.stringify(d) === JSON.stringify(value);
}

/** Inline JSON with ", " and ": " separators; objects keep their key order. */
export function inline(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(inline).join(', ') + ']';
  const parts: string[] = [];
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === undefined) continue;
    parts.push(JSON.stringify(k) + ': ' + inline(x));
  }
  return '{' + parts.join(', ') + '}';
}

export function orderEntity(table: TableName, e: Record<string, unknown>, omitDefaults = true): Record<string, unknown> {
  const order = KEY_ORDER[table];
  const out: Record<string, unknown> = {};
  const keys = Object.keys(e);
  const known = order.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !order.includes(k)).sort();
  for (const k of [...known, ...rest]) {
    const v = e[k];
    if (omitDefaults && isDefault(table, k, v)) continue;
    out[k] = v;
  }
  return out;
}

export function entityLine(table: TableName, e: object): string {
  return inline(orderEntity(table, e as Record<string, unknown>));
}

/** Sort clips by comp (table order), track (table order), start, then id; cues by clip order, start. */
export function sortEntities(p: ProjectFile): ProjectFile {
  const trackIndex = new Map((p.tracks ?? []).map((t, i) => [t.id, i]));
  const trackComp = new Map((p.tracks ?? []).map((t) => [t.id, t.comp]));
  const compIndex = new Map(p.comps.map((c, i) => [c.id, i]));
  const key = (c: Clip) => [compIndex.get(trackComp.get(c.track) ?? '') ?? 1e9, trackIndex.get(c.track) ?? 1e9, c.at] as const;
  const clips = p.clips ? [...p.clips].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }) : undefined;
  const clipIndex = new Map((clips ?? []).map((c, i) => [c.id, i]));
  const cues = p.cues ? [...p.cues].sort((a, b) => (clipIndex.get(a.clip) ?? 1e9) - (clipIndex.get(b.clip) ?? 1e9) || a.at - b.at) : undefined;
  const out: ProjectFile = { ...p };
  if (clips) out.clips = clips;
  if (cues) out.cues = cues;
  return out;
}

export function formatProject(p0: ProjectFile): string {
  const p = sortEntities(p0);
  const head: Record<string, unknown> = { michelangelo: p.michelangelo };
  if (p.$schema) head.$schema = p.$schema;
  const lines: string[] = [];
  lines.push(inline(head).slice(0, -1) + ',');
  if (p.project && Object.keys(p.project).length) {
    const proj: Record<string, unknown> = {};
    // known keys in a stable order, then any others (a field is never dropped on save)
    const order = ['name', 'platform', 'main', 'plugins', 'commercial', 'credits'];
    const src = p.project as Record<string, unknown>;
    for (const k of [...order, ...Object.keys(src).filter((x) => !order.includes(x)).sort()]) if (src[k] !== undefined) proj[k] = src[k];
    lines.push('"project": ' + inline(proj) + ',');
  }
  for (const t of TABLES) {
    const rows = (p as Record<string, unknown>)[t] as object[] | undefined;
    if (!rows || (rows.length === 0 && t !== 'comps')) continue;
    lines.push(`"${t}": [`);
    rows.forEach((r, i) => lines.push(entityLine(t, r) + (i < rows.length - 1 ? ',' : '')));
    lines.push('],');
  }
  // drop the trailing comma of the last table
  const last = lines.length - 1;
  lines[last] = lines[last]!.replace(/,$/, '');
  lines.push('}');
  return lines.join('\n') + '\n';
}
