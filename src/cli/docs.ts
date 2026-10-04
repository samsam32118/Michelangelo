/** `mgl docs`: the skill, a reference topic, one command (from the registry), the command list, or an effect/template/... */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { fail, suggest } from '../core/errors.js';
import { listCommands, type CommandDef } from '../core/commands/index.js';
import { shellExampleLine } from './shell.js';
import { builtinRegistry } from '../builtin/index.js';
import type { PluginRegistry } from '../plugin/registry.js';
import { MAX_LINES, type Args, type Out } from './io.js';

/** The package root (src/cli or dist/cli → two levels up). */
export const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const REFERENCE_DIR = join(PKG_ROOT, 'docs', 'reference');
export const SCHEMA_FILE = join(PKG_ROOT, 'schema', 'v1.json');

type Def = { type: string; innerType?: z.ZodType; options?: z.ZodType[]; element?: z.ZodType; entries?: Record<string, string>; values?: unknown[]; items?: z.ZodType[]; valueType?: z.ZodType; checks?: { _zod: { def: { check: string; format?: string } } }[] };
const defOf = (s: z.ZodType) => (s as unknown as { _zod: { def: Def } })._zod.def;

/** A compact type for a zod schema: number, string, time, "a"|"b", number[], [number, number], number|keys, easing ... */
export function typeText(s: z.ZodType): string {
  const d = defOf(s);
  switch (d.type) {
    case 'optional': case 'default': case 'prefault': case 'readonly': case 'catch': return typeText(d.innerType!);
    case 'nullable': return `${typeText(d.innerType!)}|null`;
    case 'string': return 'string';
    case 'number': return d.checks?.some((c) => c._zod.def.format === 'safeint') ? 'int' : 'number';
    case 'int': return 'int';
    case 'boolean': return 'boolean';
    case 'literal': return d.values!.map((v) => JSON.stringify(v)).join('|');
    case 'enum': {
      const vals = Object.values(d.entries!);
      return vals.includes('outCubic') ? 'easing' : vals.map((v) => JSON.stringify(v)).join('|');
    }
    case 'union': {
      // keyframe lists ([[frame, value, easing?], ...]) read as "keys"
      const parts = [...new Set(d.options!.map((o) => (isKeyList(o) ? 'keys' : typeText(o))))];
      if (parts.length === 2 && parts.includes('string') && parts.includes('int')) return 'time';
      if (parts.includes('easing')) return 'easing';
      return parts.join('|');
    }
    case 'array': { const t = typeText(d.element!); return t.includes('|') ? `(${t})[]` : `${t}[]`; }
    case 'tuple': return `[${d.items!.map(typeText).join(', ')}]`;
    case 'object': case 'record': return 'object';
    default: return d.type === 'unknown' || d.type === 'any' ? 'any' : d.type;
  }
}

function isKeyList(s: z.ZodType): boolean {
  const d = defOf(s);
  if (d.type !== 'array') return false;
  const e = defOf(d.element!);
  return e.type === 'union' ? e.options!.every((o) => defOf(o).type === 'tuple') : e.type === 'tuple' && typeText(d.element!).startsWith('[time');
}

export interface FieldDoc { name: string; type: string; required: boolean; describe?: string; default?: unknown }

function defaultOf(s: z.ZodType): unknown {
  const d = defOf(s) as Def & { defaultValue?: unknown };
  if (d.type === 'default') return typeof d.defaultValue === 'function' ? (d.defaultValue as () => unknown)() : d.defaultValue;
  return d.innerType ? defaultOf(d.innerType) : undefined;
}

export function fieldsOf(schema: z.ZodObject): FieldDoc[] {
  return Object.entries(schema.shape as Record<string, z.ZodType>).map(([name, s]) => {
    const t = typeText(s);
    const f: FieldDoc = { name, type: name === 'fx' && t === 'time' ? 'index|type' : t, required: !s.isOptional() };
    if (s.description) f.describe = s.description;
    const dv = defaultOf(s);
    if (dv !== undefined) f.default = dv;
    return f;
  });
}

/** The doc of one command: op, sentence, fields, example (CLI and JSON). */
export function commandDoc(def: CommandDef): string[] {
  const fields = fieldsOf(def.schema);
  const catchall = (def.schema as unknown as { _zod: { def: { catchall?: z.ZodType } } })._zod.def.catchall;
  const loose = catchall !== undefined && defOf(catchall).type !== 'never';
  const lines = [`${def.op} (${def.group}): ${def.doc}`, 'fields:'];
  for (const f of fields) lines.push(`  ${f.name}${f.required ? '' : '?'}: ${f.type}${def.primary === f.name ? '  (bare word)' : ''}${f.describe ? ` · ${f.describe}` : ''}`);
  if (loose) lines.push('  ...any other property or dotted path (e.g. y=380, style.color=#ffcc00)');
  lines.push(`example: ${shellExampleLine(def)}`);
  lines.push(`json:    ${JSON.stringify({ op: def.op, ...def.example })}`);
  return lines;
}

/** Commands grouped, one line each. */
export function commandList(): string[] {
  const groups = new Map<string, CommandDef[]>();
  for (const c of listCommands()) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  const lines: string[] = [];
  for (const [g, cs] of groups) lines.push(`${g}: ${cs.map((c) => c.op).join(', ')}`);
  return lines;
}

export function commandLines(): string[] {
  return listCommands().map((c) => `${c.op.padEnd(22)} ${c.doc.split(/(?<=\.)\s/)[0]}`);
}

export function topics(): string[] {
  return existsSync(REFERENCE_DIR) ? readdirSync(REFERENCE_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() : [];
}

/** Docs for an effect, transition, generator, template, style or text animation of a registry. */
export function catalogDoc(reg: PluginRegistry, kind: string | undefined, id: string): string[] | undefined {
  const kinds: [string, Map<string, { describe?: string; params?: z.ZodType }>][] = [['effect', reg.effects], ['transition', reg.transitions], ['generator', reg.generators], ['template', reg.templates as never], ['style', reg.styles as never], ['animation', reg.textAnimations as never]];
  for (const [k, m] of kinds) {
    if (kind && kind !== k) continue;
    const it = m.get(id);
    if (!it) continue;
    const lines = [`${k} ${id}: ${it.describe ?? ''}`];
    const params = it.params as z.ZodObject | undefined;
    if (params && 'shape' in params) {
      lines.push('params:');
      for (const f of fieldsOf(params)) lines.push(`  ${f.name}: ${f.type}${f.default !== undefined ? ` = ${JSON.stringify(f.default)}` : ''}${f.describe ? ` · ${f.describe}` : ''}`);
    }
    const style = (it as { style?: unknown }).style;
    if (style) lines.push(`style: ${JSON.stringify(style)}`);
    if (k === 'effect') lines.push(`use: mgl edit <file> fx.add <clip> type=${id}`);
    if (k === 'transition') lines.push(`use: mgl edit <file> transition.set <clip> type=${id} len=0.5s`);
    if (k === 'generator') lines.push(`use: mgl edit <file> clip.add gen='{"type": "${id}"}' len=3s`);
    if (k === 'template') lines.push(`use: mgl edit <file> template.apply ${id} at=1s params='{...}'`);
    if (k === 'style') lines.push(`use: "style": "${id}" on a text or captions clip`);
    return lines;
  }
  return undefined;
}

export async function docs(a: Args, o: Out) {
  const [topic, sub] = a.pos;
  if (a.flags.all) o.unbounded = true;
  if (!topic) {
    const skill = readFileSync(join(PKG_ROOT, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');
    o.line(...skill.trim().split('\n'));
    if (!o.unbounded && skill.split('\n').length > MAX_LINES) o.set({ truncated: true });
    o.set({ topic: 'skill', file: join(PKG_ROOT, 'SKILL.md'), topics: topics() });
    return;
  }
  if (topic === 'commands') {
    o.line(...(a.flags.all ? commandLines() : commandList()));
    o.hint('one command: mgl docs <op>   (e.g. mgl docs clip.split)');
    o.set({ topic, commands: listCommands().map((c) => ({ op: c.op, group: c.group, doc: c.doc })) });
    return;
  }
  if (topic === 'schema') {
    o.line(`JSON Schema of the project file: ${SCHEMA_FILE}`, 'reference it from a project with "$schema"; field reference: mgl docs format');
    o.set({ topic, file: SCHEMA_FILE });
    return;
  }
  const file = join(REFERENCE_DIR, `${topic}.md`);
  if (/^[a-z-]+$/.test(topic) && existsSync(file)) {
    // a guide asked for by name is printed whole (SKILL.md points agents at them): the 40-line cap is for command output
    o.unbounded = true;
    o.line(...readFileSync(file, 'utf8').trim().split('\n'));
    o.set({ topic, file });
    return;
  }
  const cmd = listCommands().find((c) => c.op === topic);
  if (cmd) {
    o.line(...commandDoc(cmd));
    o.set({ topic, command: { op: cmd.op, group: cmd.group, doc: cmd.doc, primary: cmd.primary, fields: fieldsOf(cmd.schema), example: cmd.example } });
    return;
  }
  const reg = builtinRegistry();
  const kind = sub ? topic : undefined;
  const item = catalogDoc(reg, kind, sub ?? topic);
  if (item) { o.line(...item); o.set({ topic: sub ?? topic, kind: kind ?? null }); return; }
  const names = [...topics(), 'commands', 'schema', ...listCommands().map((c) => c.op), ...reg.effects.keys(), ...reg.transitions.keys(), ...reg.templates.keys(), ...reg.generators.keys()];
  const dym = suggest(sub ?? topic, names);
  fail('E_UNKNOWN_TOPIC', `no docs for "${[topic, sub].filter(Boolean).join(' ')}".`, dym.length ? `did you mean "${dym[0]}"? (topics: ${topics().join(', ')})` : `topics: ${topics().join(', ')}; commands: mgl docs commands`);
}
