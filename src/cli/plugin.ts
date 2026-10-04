/** `mgl plugin new|test|trust|list`. */
import { basename, dirname, relative, resolve } from 'node:path';
import { fail } from '../core/errors.js';
import { Project } from '../sdk/project.js';
import { clip, str, type Args, type Out } from './io.js';

const shown = (f: string) => { const r = relative(process.cwd(), f); return r && !r.startsWith('..') ? r : f; };

export async function plugin(a: Args, o: Out) {
  const [sub, ...rest] = a.pos;
  const m = await import('../plugin/index.js');
  switch (sub) {
    case 'new': {
      const [kind, name] = rest;
      if (!kind || !name) fail('E_USAGE', 'plugin new needs a kind and a name.', `mgl plugin new effect film-burn (kinds: ${m.SCAFFOLD_KINDS.join(', ')})`);
      // --dir is the project folder; "--dir plugins" (the plugins folder itself) is accepted too
      let dir = resolve(str(a, 'dir') ?? '.');
      if (basename(dir) === 'plugins') dir = dirname(dir);
      const r = m.scaffoldPlugin(kind as never, name, dir);
      const rel = shown(r.dir);
      o.line(`created ${rel} (${r.files.length} files): ${r.files.map((f) => relative(r.dir, f)).join(', ')}`);
      o.hint(`next: edit ${rel}/src/index.ts, then mgl plugin test ${rel}`);
      o.hint(`use it: mgl plugin trust ${rel} && mgl edit <file> project.set plugins='{"${name}": "^0.1.0"}'`);
      o.set({ dir: r.dir, files: r.files });
      return;
    }
    case 'test': {
      const dir = rest[0];
      if (!dir) fail('E_USAGE', 'plugin test needs the plugin folder.', 'mgl plugin test plugins/film-burn');
      const r = await m.runPluginTests(resolve(dir), { typecheck: !a.flags['no-typecheck'] });
      const lines = r.output.split('\n').filter(Boolean);
      o.line(...lines.map((l) => clip(l, 200)));
      if (!r.ok) o.exit = 1;
      o.set({ dir: resolve(dir), passed: r.passed, failed: r.failed, steps: r.steps, preview: r.preview, testsOk: r.ok });
      return;
    }
    case 'trust': {
      const dir = rest[0];
      if (!dir) fail('E_USAGE', 'plugin trust needs the plugin folder.', 'mgl plugin trust plugins/film-burn');
      const e = m.trustPlugin(resolve(dir));
      o.line(`trusted ${e.name} (${e.hash.slice(0, 19)}…) in ${m.trustStorePath()}`);
      o.hint('plugins are code that runs on this machine; re-run trust after every change to the plugin.');
      o.set({ trusted: e, store: m.trustStorePath() });
      return;
    }
    case 'list': {
      const file = rest[0];
      if (file) {
        const p = await Project.open(file);
        const reg = await m.loadRegistry(p.data, p.dir);
        const lines: string[] = [];
        for (const [name, info] of reg.plugins) lines.push(`${name.padEnd(18)} ${info.version.padEnd(8)} ${info.source === 'builtin' ? 'builtin' : shown(info.source)}`);
        for (const pr of reg.problems) lines.push(`${pr.severity === 'error' ? 'error' : 'warn'} ${pr.code}: ${clip(pr.message, 180)}`, `  fix: ${pr.fix}`);
        o.line(...lines);
        o.set({ plugins: [...reg.plugins].map(([name, i]) => ({ name, ...i })), loaded: reg.loaded, problems: reg.problems });
        return;
      }
      const { builtinPlugins } = await import('../builtin/index.js');
      const trusted = m.listTrusted();
      const count = (def: Record<string, unknown>) => ['effects', 'transitions', 'generators', 'templates', 'styles', 'textAnimations', 'checks', 'commands'].map((k) => [k, (def[k] as unknown[] | undefined)?.length ?? 0] as const).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ');
      for (const def of builtinPlugins) o.line(`${def.name.padEnd(18)} ${(def.version ?? '-').padEnd(8)} builtin: ${count(def as unknown as Record<string, unknown>)}`);
      o.line(`trusted (${m.trustStorePath()}): ${trusted.length ? trusted.map((t) => `${t.name} ${shown(t.path)}`).join(', ') : 'none'}`);
      o.hint('a project\'s plugins: mgl plugin list <file>');
      o.set({ builtin: builtinPlugins.map((d) => ({ name: d.name, version: d.version ?? null })), trusted });
      return;
    }
    default:
      fail('E_USAGE', sub ? `"plugin ${sub}" is not a plugin command.` : 'plugin needs a subcommand.', 'mgl plugin new <kind> <name> | test <dir> | trust <dir> | list [file]');
  }
}
