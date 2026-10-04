/**
 * The plugin registry: every effect, transition, generator, template, check, importer, exporter, style
 * and text animation known for a project (built-ins + the plugins the project names).
 */
import type { PluginDef, EffectDef, TransitionDef, GeneratorDef, CheckDef, ImporterDef, ExporterDef, StyleDef, TextAnimationDef, MotionPresetDef, ProviderDef } from './api.js';
import type { TemplateDef, Catalog, CommandDef } from '../core/commands/registry.js';

export class PluginRegistry {
  effects = new Map<string, EffectDef>();
  transitions = new Map<string, TransitionDef>();
  generators = new Map<string, GeneratorDef>();
  templates = new Map<string, TemplateDef>();
  checks = new Map<string, CheckDef>();
  importers = new Map<string, ImporterDef>();
  exporters = new Map<string, ExporterDef>();
  styles = new Map<string, StyleDef>();
  textAnimations = new Map<string, TextAnimationDef>();
  motionPresets = new Map<string, MotionPresetDef>();
  /** providers by kind, then id */
  providers = new Map<string, Map<string, ProviderDef>>();
  commands = new Map<string, CommandDef>();
  /** plugin name → { version, source: 'builtin' | path } */
  plugins = new Map<string, { version: string; source: string }>();

  add(def: PluginDef, source = 'builtin'): this {
    this.plugins.set(def.name, { version: def.version ?? '0.0.0', source });
    const put = <T extends { type?: string; id?: string }>(m: Map<string, T>, items: T[] | undefined, kind: string) => {
      for (const it of items ?? []) {
        const key = (it.type ?? it.id)!;
        if (m.has(key) && source !== 'builtin') throw new Error(`plugin ${def.name}: ${kind} "${key}" is already defined`);
        m.set(key, it);
      }
    };
    put(this.effects, def.effects, 'effect');
    put(this.transitions, def.transitions, 'transition');
    put(this.generators, def.generators, 'generator');
    put(this.templates, def.templates, 'template');
    put(this.checks, def.checks, 'check');
    put(this.importers, def.importers, 'importer');
    put(this.exporters, def.exporters, 'exporter');
    put(this.styles, def.styles, 'style');
    put(this.textAnimations, def.textAnimations, 'text animation');
    put(this.motionPresets, def.motionPresets, 'motion preset');
    for (const pr of def.providers ?? []) {
      if (!this.providers.has(pr.kind)) this.providers.set(pr.kind, new Map());
      this.providers.get(pr.kind)!.set(pr.id, pr);
    }
    for (const c of def.commands ?? []) this.commands.set(c.op, c);
    return this;
  }

  catalog(): Catalog {
    return {
      effects: new Map([...this.effects].map(([k, v]) => [k, { params: v.params, describe: v.describe, stages: { draw: typeof v.draw === 'function', source: typeof v.source === 'function', audio: typeof v.audio === 'function' } }])),
      transitions: new Map([...this.transitions].map(([k, v]) => [k, { params: v.params, describe: v.describe }])),
      generators: new Map([...this.generators].map(([k, v]) => [k, { params: v.params, describe: v.describe }])),
      templates: this.templates,
      textAnimations: new Map([...this.textAnimations].map(([k, v]) => [k, { describe: v.describe }])),
      styles: new Map([...this.styles].map(([k, v]) => [k, { describe: v.describe, style: v.style }])),
      motionPresets: this.motionPresets,
    };
  }
}
