/** Regression tests for the plugin review findings: resolution, trust hashing, names, scaffold clashes, semver. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { satisfies, compareVersions, parseVersion } from '../../src/plugin/semver.js';
import { entryProblem, hashPlugin, trustPlugin } from '../../src/plugin/trust.js';
import { loadRegistry, locatePlugin, validPluginName } from '../../src/plugin/loader.js';
import { builtinClash, scaffoldPlugin } from '../../src/plugin/scaffold.js';
import { hookSource, libraryModules, libraryTypes } from '../../src/plugin/resolve.js';
import { runPluginTests } from '../../src/plugin/test-runner.js';
import { testProject } from '../../src/plugin/testing.js';
import { MglError } from '../../src/core/errors.js';
import { writeFiles } from './plugin-fixtures.js';
import { mgl } from './cli-fixtures.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const manifest = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'src/index.ts', michelangelo: { api: '^1.0.0', kinds: ['style'] }, ...extra });
const STYLE = (name: string) => `export default { name: '${name}', styles: [{ id: '${name}-style', describe: 'a style', style: { color: '#ff0000' } }] };\n`;

describe('semver prereleases (§11)', () => {
  it('compares prerelease identifiers one by one, numeric ones numerically', () => {
    expect(satisfies('1.0.0-rc.10', '>=1.0.0-rc.9')).toBe(true);
    expect(satisfies('1.0.0-beta.11', '^1.0.0-beta.2')).toBe(true);
    expect(satisfies('1.0.0-beta.1', '^1.0.0-beta.2')).toBe(false);
    const c = (a: string, b: string) => Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!));
    expect(c('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(c('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
    expect(c('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1);
    expect(c('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(c('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
  });
});

describe('trust hash', () => {
  let dir: string;
  beforeAll(() => { dir = tmp('mgl-trust-'); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('covers out/ (a "main" can point there): editing it changes the hash', () => {
    const p = join(dir, 'p1');
    writeFiles(p, { 'package.json': manifest('p1', { main: 'out/index.js' }), 'out/index.js': STYLE('p1') });
    const h = hashPlugin(p);
    writeFileSync(join(p, 'out/index.js'), 'globalThis.EVIL = 1;\n' + STYLE('p1'));
    expect(hashPlugin(p)).not.toBe(h);
  });

  it('hashes symlink targets inside the folder and refuses symlinks that leave it', () => {
    const p = join(dir, 'p2');
    writeFiles(p, { 'package.json': manifest('p2'), 'src/real.ts': STYLE('p2') });
    symlinkSync(join(p, 'src/real.ts'), join(p, 'src/index.ts'));
    const h = hashPlugin(p);
    writeFileSync(join(p, 'src/real.ts'), STYLE('p2') + '// changed\n');
    expect(hashPlugin(p)).not.toBe(h);
    writeFileSync(join(dir, 'outside.ts'), STYLE('p2'));
    symlinkSync(join(dir, 'outside.ts'), join(p, 'src/other.ts'));
    expect(() => hashPlugin(p)).toThrow(/outside the plugin folder/);
    rmSync(join(p, 'src/other.ts'));
  });

  it('refuses an entry under node_modules/ or outside the plugin folder (trust and load)', async () => {
    const p = join(dir, 'plugins', 'p3');
    writeFiles(p, { 'package.json': manifest('p3', { main: 'node_modules/x/index.js' }), 'node_modules/x/index.js': STYLE('p3') });
    expect(entryProblem(p, join(p, 'node_modules/x/index.js'))).toMatch(/node_modules/);
    expect(() => trustPlugin(p, { trustStore: join(dir, 't.json') })).toThrow(/node_modules/);
    writeFiles(p, { 'package.json': manifest('p3', { main: '../../evil.js' }) });
    writeFileSync(join(dir, 'evil.js'), STYLE('p3'));
    expect(entryProblem(p, join(dir, 'evil.js'))).toMatch(/outside the plugin folder/);
    const r = await loadRegistry(testProject({ plugins: { p3: '*' } }), dir, { allowUntrusted: true });
    expect(r.problems[0]).toMatchObject({ code: 'E_PLUGIN_ENTRY' });
    expect(r.loaded).toEqual([]);
  });
});

describe('plugin names and npm trust', () => {
  it('validates names against the npm grammar (no paths)', async () => {
    for (const ok of ['glitch', 'film-tint', '@me/fx', 'a.b_c']) expect(validPluginName(ok)).toBe(true);
    for (const bad of ['../evil', '/etc', 'a/b', 'Upper', '', '..']) expect(validPluginName(bad)).toBe(false);
    expect(locatePlugin('../../x', tmpdir())).toBeUndefined();
    const r = await loadRegistry(testProject({ plugins: { '../x': '*' } }), tmpdir());
    expect(r.problems[0]).toMatchObject({ code: 'E_PLUGIN_NAME' });
  });

  it('a committed node_modules plugin listed in package.json does not run without trust', async () => {
    const d = tmp('mgl-npm-');
    try {
      const marker = join(d, 'RAN');
      writeFiles(d, {
        'package.json': JSON.stringify({ dependencies: { evil: '1.0.0' } }),
        'node_modules/evil/package.json': manifest('evil', { main: 'index.js' }),
        'node_modules/evil/index.js': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); ${STYLE('evil')}`,
      });
      const r = await loadRegistry(testProject({ plugins: { evil: '^1.0.0' } }), d, { trustStore: join(d, 't.json') });
      expect(r.problems[0]).toMatchObject({ code: 'E_PLUGIN_UNTRUSTED' });
      expect(() => readFileSync(marker)).toThrow();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('scaffold', () => {
  it('rejects names that clash with built-ins', () => {
    const d = tmp('mgl-scaf-');
    try {
      expect(builtinClash('effect', 'blur')).toMatch(/built-in effect/);
      expect(builtinClash('command', 'clip')).toMatch(/clip\./);
      expect(builtinClash('effect', 'film-tint')).toBeUndefined();
      expect(() => scaffoldPlugin('effect', 'blur', d)).toThrow(MglError);
      expect(() => scaffoldPlugin('command', 'cue', d)).toThrow(/cue\./);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('library resolution', () => {
  it('maps michelangelo, /plugin and /testing to this copy, with type declarations for each', () => {
    const mods = libraryModules();
    expect(Object.keys(mods).sort()).toEqual(['michelangelo', 'michelangelo/plugin', 'michelangelo/testing']);
    const types = libraryTypes();
    for (const f of Object.values(types)) expect(f).toMatch(/\.(d\.ts|ts)$/);
    expect(Object.keys(types).sort()).toEqual(Object.keys(mods).sort());
    expect(hookSource()).toContain('michelangelo/');
  });

  it('the plugins.md loop works from a folder with no node_modules (render loads the scaffold)', async () => {
    const d = tmp('mgl-loop-');
    try {
      const run = async (...a: string[]) => { const r = await mgl(a, { cwd: d }); expect(r.code, r.stdout + r.stderr).toBe(0); return r; };
      await run('new', 'shorts', '-o', 'demo.mgl.json');
      await run('edit', 'demo.mgl.json', 'clip.add', 'id=bg', 'track=V1', 'len=2s', 'gen={"type": "gradient"}');
      await run('plugin', 'new', 'effect', 'film-tint');
      await run('plugin', 'trust', 'plugins/film-tint');
      await run('edit', 'demo.mgl.json', 'project.set', 'plugins={"film-tint": "^0.1.0"}');
      await run('edit', 'demo.mgl.json', 'fx.add', 'bg', 'type=film-tint', 'amount=0.4');
      const r = await run('render', 'demo.mgl.json', 'out/tint.png', '--still', '1s');
      expect(r.stdout).toMatch(/wrote out\/tint\.png/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 120_000);
});

describe('plugin test', () => {
  it('a fresh scaffold passes, in a folder without node_modules/michelangelo; a failure names the failing step', async () => {
    const d = tmp('mgl-ptest-');
    try {
      const root = scaffoldPlugin('effect', 'fresh-fx', d).dir;
      const r = await runPluginTests(root);
      expect(r.output).not.toMatch(/✗/);
      expect(r.ok).toBe(true);
      writeFileSync(join(root, 'src', 'index.ts'), readFileSync(join(root, 'src', 'index.ts'), 'utf8').replace('p.amount;', 'p.amont;'));
      const r2 = await runPluginTests(root, {});
      expect(r2.ok).toBe(false);
      expect(r2.output).toMatch(/FAILED: typecheck \(\d+ error\(s\)\)/);
      expect(r2.output).not.toMatch(/0 test\(s\) failed/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 120_000);

  it('reports an item that clashes with a built-in', async () => {
    const d = tmp('mgl-pclash-');
    try {
      const root = scaffoldPlugin('effect', 'not-blur', d).dir;
      const f = join(root, 'src', 'index.ts');
      writeFileSync(f, readFileSync(f, 'utf8').replace("type: 'not-blur'", "type: 'blur'"));
      const r = await runPluginTests(root, { typecheck: false });
      expect(r.steps.find((s) => s.step === 'definition')).toMatchObject({ ok: false });
      expect(r.output).toMatch(/effect "blur" is already defined by a built-in/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 60_000);
});
