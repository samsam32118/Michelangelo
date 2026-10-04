/** Structural checks of a plugin's exported definition (shared by the loader and `plugin test`). */
import type { PluginDef } from './api.js';

export const PLUGIN_KINDS = ['effect', 'transition', 'generator', 'template', 'command', 'check', 'importer', 'exporter', 'style', 'text-animation', 'motion-preset', 'provider'] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/** PluginDef field holding each kind's items, and the key each item is known by. */
export const KIND_FIELDS: Record<PluginKind, { field: keyof PluginDef; key: 'type' | 'id' | 'op' }> = {
  effect: { field: 'effects', key: 'type' },
  transition: { field: 'transitions', key: 'type' },
  generator: { field: 'generators', key: 'type' },
  template: { field: 'templates', key: 'id' },
  command: { field: 'commands', key: 'op' },
  check: { field: 'checks', key: 'id' },
  importer: { field: 'importers', key: 'id' },
  exporter: { field: 'exporters', key: 'id' },
  style: { field: 'styles', key: 'id' },
  'text-animation': { field: 'textAnimations', key: 'id' },
  'motion-preset': { field: 'motionPresets', key: 'id' },
  provider: { field: 'providers', key: 'id' },
};

interface ZodLike { safeParse(v: unknown): { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } } }
const isZod = (v: unknown): v is ZodLike => !!v && typeof (v as ZodLike).safeParse === 'function';

/**
 * Problems with a plugin's default export, as "message (fix: ...)" strings; empty when valid.
 * `deep` also checks that every params schema parses `{}` (all params have defaults).
 */
export function checkPluginDef(def: unknown, deep = false): string[] {
  const out: string[] = [];
  if (!def || typeof def !== 'object') return ['the entry has no default export object (fix: end src/index.ts with `export default definePlugin({ name: "...", ... })`).'];
  const d = def as Record<string, unknown>;
  if (typeof d.name !== 'string' || !d.name) out.push('the plugin has no "name" (fix: pass name: "<plugin-name>" to definePlugin).');
  let items = 0;
  for (const [kind, { field, key }] of Object.entries(KIND_FIELDS)) {
    const list = d[field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) { out.push(`"${field}" must be an array (fix: ${field}: [define...(...)]).`); continue; }
    for (const [i, it] of list.entries()) {
      items++;
      const o = (it ?? {}) as Record<string, unknown>;
      const id = o[key];
      const where = `${kind} ${typeof id === 'string' ? `"${id}"` : `#${i}`}`;
      if (typeof id !== 'string' || !id) { out.push(`${where} has no "${key}" (fix: give it ${key}: "<name>").`); continue; }
      const describe = kind === 'command' ? o.doc : o.describe;
      if (typeof describe !== 'string' || !describe.trim()) out.push(`${where} has no ${kind === 'command' ? 'doc' : 'describe'} sentence (fix: add ${kind === 'command' ? 'doc' : 'describe'}: "what it does").`);
      if (kind === 'command' && typeof d.name === 'string' && !id.startsWith(d.name + '.')) out.push(`${where} must be named "${d.name}.<verb>" (fix: rename its op, e.g. "${d.name}.${id.split('.').pop()}").`);
      const schema = kind === 'command' ? o.schema : o.params;
      if (['effect', 'transition', 'generator'].includes(kind) || schema !== undefined) {
        if (!isZod(schema)) { out.push(`${where}: ${kind === 'command' ? 'schema' : 'params'} must be a zod object (fix: params: z.object({ ... })).`); continue; }
        if (deep && kind !== 'command') {
          const r = schema.safeParse({});
          if (!r.success) {
            const iss = r.error!.issues[0]!;
            out.push(`${where}: param "${iss.path.join('.')}" has no default (${iss.message}) (fix: add .default(...) so the effect works with no params).`);
          }
        }
      }
      if (kind === 'provider' && o.kind !== 'speak' && o.kind !== 'transcribe') { out.push(`${where} has kind ${JSON.stringify(o.kind)} (fix: kind: "speak" or kind: "transcribe").`); continue; }
      if (kind === 'motion-preset' && !['in', 'out', 'emphasis', 'loop'].includes(o.phase as string)) out.push(`${where} has phase ${JSON.stringify(o.phase)} (fix: phase: "in", "out", "emphasis" or "loop").`);
      const providerFn = o.kind === 'speak' ? 'speak' : 'transcribe';
      const fn = { effect: o.draw ?? o.source ?? o.audio, transition: o.draw, generator: o.draw, template: o.build, command: o.apply, check: o.run, importer: o.import, exporter: o.export, style: true, 'text-animation': o.state, 'motion-preset': o.keys, provider: o[providerFn] }[kind as PluginKind];
      if (typeof fn !== 'function' && fn !== true) out.push(`${where} has no ${kind === 'effect' ? 'draw, source or audio' : ({ transition: 'draw', generator: 'draw', template: 'build', command: 'apply', check: 'run', importer: 'import', exporter: 'export', 'text-animation': 'state', 'motion-preset': 'keys', provider: providerFn } as Record<string, string>)[kind]} function (fix: implement it).`);
      if (kind === 'provider' && o.kind === 'speak' && typeof o.voices !== 'function') out.push(`${where} has no voices function (fix: implement voices(), it may return []).`);
    }
  }
  if (!items && !out.length) out.push('the plugin defines nothing (fix: add effects, transitions, generators, templates, commands, checks, importers, exporters, styles, text animations, motion presets or providers).');
  return out;
}

/** Kinds a plugin definition actually provides. */
export function kindsOf(def: PluginDef): PluginKind[] {
  return (Object.entries(KIND_FIELDS) as [PluginKind, { field: keyof PluginDef }][]).filter(([, { field }]) => ((def[field] as unknown[] | undefined) ?? []).length > 0).map(([k]) => k);
}
