/**
 * Loading the plugins a project names (`"project": {"plugins": {"glitch": "^1.0.0"}}`, or mgl.config.json):
 * resolve ./plugins/<name> next to the project, then node_modules; check the manifest's plugin-API range,
 * the version range and trust; import the entry; add it to a registry that starts from the built-ins.
 *
 * Problems are returned, not thrown (so `show` / `check` still work); `strict: true` throws the first.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MglError } from '../core/errors.js';
import type { Problem } from '../core/load.js';
import type { ProjectFile } from '../core/schema/index.js';
import { defineCommand, listCommands, type CommandDef } from '../core/commands/registry.js';
import { builtinRegistry } from '../builtin/index.js';
import { PLUGIN_API_VERSION, type PluginDef } from './api.js';
import type { PluginRegistry } from './registry.js';
import { satisfies, validRange } from './semver.js';
import { isTrusted, listTrusted } from './trust.js';
import { checkPluginDef, kindsOf, type PluginKind } from './validate.js';
import { registerSourceHook } from './resolve.js';

export interface LoadOptions {
  /** trust store file (default: $MGL_TRUST_STORE or ~/.config/michelangelo/trusted.json) */
  trustStore?: string;
  /** load plugins next to the project even when they are not trusted */
  allowUntrusted?: boolean;
  /** throw the first problem as an MglError (render / look) */
  strict?: boolean;
}

export interface LoadedPlugin {
  name: string;
  version: string;
  dir: string;
  entry: string;
  /** why it was allowed to load: trust store entry, npm dependency of the project, or allowUntrusted */
  trust: 'store' | 'npm' | 'allowed';
  kinds: PluginKind[];
}

export interface LoadRegistryResult {
  registry: PluginRegistry;
  problems: Problem[];
  loaded: LoadedPlugin[];
}

/** The registry itself, carrying `registry` (itself), `problems` and `loaded`, so it can be used either way. */
export type LoadedRegistry = PluginRegistry & LoadRegistryResult;

export interface PluginManifest {
  name: string;
  version: string;
  api: string;
  kinds: string[];
  pkg: Record<string, unknown>;
}

const readJson = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

/** Where a plugin named by a project lives: ./plugins/<name> next to the project, then node_modules upward. */
export function locatePlugin(name: string, projectDir: string): { dir: string; local: boolean } | undefined {
  const local = join(projectDir, 'plugins', name);
  if (existsSync(join(local, 'package.json'))) return { dir: local, local: true };
  for (let d = resolve(projectDir); ; d = dirname(d)) {
    const nm = join(d, 'node_modules', name);
    if (existsSync(join(nm, 'package.json'))) return { dir: nm, local: false };
    if (dirname(d) === d) return undefined;
  }
}

/** Read and check a plugin's package.json. Throws MglError (E_PLUGIN_MANIFEST / E_PLUGIN_API). */
export function readManifest(dir: string): PluginManifest {
  const file = join(dir, 'package.json');
  let pkg: Record<string, unknown>;
  try { pkg = readJson(file); } catch (e) {
    throw new MglError({ code: 'E_PLUGIN_MANIFEST', message: `${file} cannot be read (${(e as Error).message}).`, fix: 'make package.json valid JSON with "name", "version", "type": "module" and "michelangelo": {"api": "^1.0.0", "kinds": [...]}.' });
  }
  const mg = pkg.michelangelo as { api?: unknown; kinds?: unknown } | undefined;
  const name = typeof pkg.name === 'string' ? pkg.name : '';
  if (!name) throw new MglError({ code: 'E_PLUGIN_MANIFEST', message: `${file} has no "name".`, fix: 'add "name": "<plugin-name>" (the name the project lists in project.plugins).' });
  if (!mg || typeof mg.api !== 'string') throw new MglError({ code: 'E_PLUGIN_MANIFEST', message: `plugin "${name}": package.json has no "michelangelo": {"api": ...} manifest.`, fix: 'add "michelangelo": {"api": "^1.0.0", "kinds": ["effect"]} to its package.json.' });
  if (!validRange(mg.api)) throw new MglError({ code: 'E_PLUGIN_MANIFEST', message: `plugin "${name}": "michelangelo.api" is "${mg.api}", which is not a semver range.`, fix: 'use a range like "^1.0.0".' });
  if (!satisfies(PLUGIN_API_VERSION, mg.api)) {
    throw new MglError({ code: 'E_PLUGIN_API', message: `plugin "${name}" needs plugin API ${mg.api}; this Michelangelo provides ${PLUGIN_API_VERSION}.`,
      fix: Number(mg.api.replace(/^\D*/, '').split('.')[0]) > Number(PLUGIN_API_VERSION.split('.')[0]) ? 'update Michelangelo (npm install michelangelo@latest), or use an older version of the plugin.' : `update the plugin to the current API (set "michelangelo.api" to "^${PLUGIN_API_VERSION}" once it works with it).` });
  }
  const kinds = Array.isArray(mg.kinds) ? mg.kinds.filter((k): k is string => typeof k === 'string') : [];
  return { name, version: typeof pkg.version === 'string' ? pkg.version : '0.0.0', api: mg.api, kinds, pkg };
}

/** The module file to import: exports ("." → import/default), main, then src/index.ts / index.js. */
export function pluginEntry(dir: string, pkg: Record<string, unknown>): string {
  const pick = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return pick(o['.'] ?? o.import ?? o.node ?? o.default);
    }
    return undefined;
  };
  const cands = [pick(pkg.exports), typeof pkg.main === 'string' ? pkg.main : undefined, 'src/index.ts', 'src/index.js', 'index.ts', 'index.js'];
  for (const c of cands) {
    if (!c) continue;
    const f = resolve(dir, c);
    if (existsSync(f) && statSync(f).isFile()) return f;
  }
  throw new MglError({ code: 'E_PLUGIN_LOAD', message: `plugin folder ${dir} has no entry module (looked for "exports", "main", src/index.ts, index.js).`, fix: 'set "main": "src/index.ts" in its package.json and export default definePlugin({...}) from that file.' });
}

/** Dependencies declared by the package.json nearest to the project. */
function projectDependencies(projectDir: string): Set<string> {
  for (let d = resolve(projectDir); ; d = dirname(d)) {
    const f = join(d, 'package.json');
    if (existsSync(f)) {
      try {
        const pkg = readJson(f);
        return new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap((k) => Object.keys((pkg[k] as Record<string, string> | undefined) ?? {})));
      } catch { return new Set(); }
    }
    if (dirname(d) === d) return new Set();
  }
}

/** Plugins named by the project, plus those in mgl.config.json next to it (the project wins). */
export function wantedPlugins(project: ProjectFile, projectDir: string): Record<string, string> {
  let cfg: Record<string, string> = {};
  const f = join(projectDir, 'mgl.config.json');
  if (existsSync(f)) {
    try { cfg = ((readJson(f).plugins as Record<string, string> | undefined) ?? {}); } catch { /* the CLI reports a broken config */ }
  }
  return { ...cfg, ...(project.project?.plugins ?? {}) };
}

const shown = (dir: string) => {
  const r = relative(process.cwd(), dir);
  return r && !r.startsWith('..') && !isAbsolute(r) ? r : dir;
};

function importFix(e: NodeJS.ErrnoException & { url?: string }, dir: string): string {
  if (e.code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING') return 'Node does not run TypeScript inside node_modules: publish the plugin with compiled JavaScript ("main": "dist/index.js"), or copy it into ./plugins/ next to the project.';
  if (e.code === 'ERR_MODULE_NOT_FOUND' && /michelangelo/.test(e.message)) return 'install Michelangelo where the plugin can find it: npm install michelangelo (in the project folder).';
  if (e.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' || /strip-only|type stripping/i.test(e.message)) return 'use erasable TypeScript only (no enums, namespaces or parameter properties), or compile the plugin to JavaScript.';
  return `run "mgl plugin test ${shown(dir)}" to see the full error, fix the plugin, then re-run "mgl plugin trust ${shown(dir)}" if it lives next to the project.`;
}

/** Make sure a plugin's commands are in the core command registry (once; plugin code may have registered them already). */
function registerCommands(def: PluginDef, problems: Problem[]): void {
  const known = new Map(listCommands().map((c) => [c.op, c]));
  for (const c of def.commands ?? []) {
    const have = known.get(c.op);
    if (!have) { defineCommand(c as CommandDef); continue; }
    if (have !== c && (have.doc !== c.doc || have.group !== c.group)) {
      problems.push({ code: 'E_PLUGIN_CONFLICT', severity: 'warning', message: `plugin "${def.name}": command "${c.op}" is already defined; the first definition is used.`, fix: `rename the command (ops are "${def.name}.<verb>"), or remove the other plugin from project.plugins.` });
    }
  }
}

/** Load the project's plugins on top of the built-ins. */
export async function loadRegistry(project: ProjectFile, projectDir: string, opts: LoadOptions = {}): Promise<LoadedRegistry> {
  const registry = builtinRegistry();
  const problems: Problem[] = [];
  const loaded: LoadedPlugin[] = [];
  const problem = (code: string, message: string, fix: string, name: string) =>
    problems.push({ code, severity: 'error', message, fix, path: `project.plugins.${name}`, renderOnly: true });
  let deps: Set<string> | undefined;

  for (const [name, range] of Object.entries(wantedPlugins(project, projectDir))) {
    if (registry.plugins.get(name)?.source === 'builtin') continue;
    const at = locatePlugin(name, projectDir);
    if (!at) {
      problem('E_PLUGIN_NOT_FOUND', `plugin "${name}" is not installed: no plugins/${name}/ next to the project and no node_modules/${name}.`,
        `scaffold it with "mgl plugin new effect ${name}", install it with "npm install ${name}", or remove it from project.plugins.`, name);
      continue;
    }
    try {
      const m = readManifest(at.dir);
      if (range && range !== '*' && !validRange(range)) {
        problem('E_PLUGIN_VERSION', `project.plugins.${name} is "${range}", which is not a semver range.`, `use a range like "^${m.version}".`, name);
        continue;
      }
      if (range && !satisfies(m.version, range)) {
        problem('E_PLUGIN_VERSION', `plugin "${name}" is version ${m.version}, outside the range "${range}" the project asks for.`,
          `change the range (mgl edit <file> project.set plugins='{"${name}": "^${m.version}"}') or install a matching version.`, name);
        continue;
      }
      let trust: LoadedPlugin['trust'] | undefined;
      if (isTrusted(at.dir, name, opts)) trust = 'store';
      else if (!at.local && (deps ??= projectDependencies(projectDir)).has(name)) trust = 'npm';
      else if (opts.allowUntrusted) trust = 'allowed';
      if (!trust) {
        problem('E_PLUGIN_UNTRUSTED', `untrusted plugin "${name}" (${shown(at.dir)}): plugins run as code on this machine, so they load only once trusted${isTrustedName(name, opts) ? '; its files changed since it was trusted' : ''}.`,
          at.local ? `mgl plugin trust ${shown(at.dir)}` : `add it to the project's package.json dependencies (npm install ${name}), or run: mgl plugin trust ${shown(at.dir)}`, name);
        continue;
      }
      const entry = pluginEntry(at.dir, m.pkg);
      let mod: Record<string, unknown>;
      try {
        registerSourceHook();
        mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
      } catch (e) {
        problem('E_PLUGIN_LOAD', `plugin "${name}" failed to load from ${shown(entry)}: ${(e as Error).message.split('\n')[0]}`, importFix(e as NodeJS.ErrnoException, at.dir), name);
        continue;
      }
      const def = (mod.default ?? mod.plugin) as PluginDef;
      const bad = checkPluginDef(def);
      if (bad.length) {
        problem('E_PLUGIN_INVALID', `plugin "${name}": ${bad[0]!.replace(/ \(fix: .*\)\.?$/, '.')}${bad.length > 1 ? ` (+${bad.length - 1} more)` : ''}`, bad[0]!.match(/\(fix: (.*)\)\.?$/)?.[1] ?? `run "mgl plugin test ${shown(at.dir)}".`, name);
        continue;
      }
      if (def.name !== name) problems.push({ code: 'W_PLUGIN_NAME', severity: 'warning', message: `plugin "${name}" calls itself "${def.name}" in definePlugin.`, fix: `use name: "${name}" in definePlugin (the package name).` });
      try { registry.add({ ...def, name, version: def.version ?? m.version }, at.dir); } catch (e) {
        problem('E_PLUGIN_CONFLICT', (e as Error).message + '.', `rename the clashing item in plugin "${name}" (prefix it with the plugin name), or remove one of the plugins from project.plugins.`, name);
        continue;
      }
      registerCommands(def, problems);
      loaded.push({ name, version: m.version, dir: at.dir, entry, trust, kinds: kindsOf(def) });
    } catch (e) {
      if (!(e instanceof MglError)) throw e;
      problem(e.code, e.message, e.fix, name);
    }
  }

  if (opts.strict) {
    const errs = problems.filter((p) => p.severity === 'error');
    if (errs.length) throw new MglError({ ...errs[0]!, problems: errs.slice(1) });
  }
  return Object.assign(registry, { registry, problems, loaded });
}

function isTrustedName(name: string, opts: LoadOptions): boolean {
  try { return listTrusted(opts).some((e) => e.name === name); } catch { return false; }
}
