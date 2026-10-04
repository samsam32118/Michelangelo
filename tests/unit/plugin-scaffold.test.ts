import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldPlugin, SCAFFOLD_KINDS } from '../../src/plugin/scaffold.js';
import { runPluginTests, type PluginTestResult } from '../../src/plugin/test-runner.js';
import { trustPlugin } from '../../src/plugin/trust.js';
import { loadRegistry } from '../../src/plugin/loader.js';
import { testProject } from '../../src/plugin/testing.js';
import { tempProjectDir } from './plugin-fixtures.js';

let dir: string;
const results = new Map<string, PluginTestResult>();

beforeAll(async () => {
  dir = tempProjectDir('mgl-scaffold-');
  for (const k of SCAFFOLD_KINDS) scaffoldPlugin(k, `my-${k}`, dir);
  // 4 at a time: each run is a few node processes
  const queue = [...SCAFFOLD_KINDS];
  await Promise.all([0, 1, 2, 3].map(async () => {
    for (let k = queue.shift(); k; k = queue.shift()) results.set(k, await runPluginTests(join(dir, 'plugins', `my-${k}`)));
  }));
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('scaffoldPlugin', () => {
  it('writes the plugin folder', () => {
    const root = join(dir, 'plugins', 'my-effect');
    for (const f of ['package.json', 'src/index.ts', 'test/my-effect.test.ts', 'evals/my-effect-basic/task.md', 'evals/my-effect-basic/meta.json', 'README.md']) expect(existsSync(join(root, f)), f).toBe(true);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg).toMatchObject({ name: 'my-effect', type: 'module', main: 'src/index.ts', michelangelo: { api: '^1.0.0', kinds: ['effect'] } });
    expect(readFileSync(join(root, 'src/index.ts'), 'utf8')).toMatch(/from 'michelangelo\/plugin'/);
    expect(JSON.parse(readFileSync(join(root, 'evals/my-effect-basic/meta.json'), 'utf8'))).toMatchObject({ tags: ['plugins', 'effect'], timeout_min: 15 });
  });

  it.each([...SCAFFOLD_KINDS])('%s: passes its own checks and tests out of the box', (kind) => {
    const r = results.get(kind)!;
    expect(r.output).toContain('✓ manifest');
    expect(r.ok, r.output).toBe(true);
    expect(r.passed).toBeGreaterThanOrEqual(1);
    expect(r.failed).toBe(0);
    expect(r.steps.find((s) => s.step === 'typecheck')?.ok).toBe(true);
    if (['effect', 'transition', 'generator'].includes(kind)) expect(r.preview && existsSync(r.preview)).toBe(true);
  });

  it('refuses bad names, unknown kinds and existing folders', () => {
    expect(() => scaffoldPlugin('effect', 'Bad Name', dir)).toThrow(/not a valid plugin name/);
    expect(() => scaffoldPlugin('widget' as never, 'w', dir)).toThrow(/not a plugin kind/);
    expect(() => scaffoldPlugin('effect', 'my-effect', dir)).toThrow(/already exists/);
  });

  it('a scaffolded effect loads once trusted', async () => {
    const store = join(dir, 'trust.json');
    trustPlugin(join(dir, 'plugins', 'my-effect'), { trustStore: store });
    const r = await loadRegistry(testProject({ plugins: { 'my-effect': '^0.1.0' } }), dir, { trustStore: store });
    expect(r.problems).toEqual([]);
    expect(r.effects.has('my-effect')).toBe(true);
  });
});

describe('runPluginTests', () => {
  it('reports a failing test, a broken manifest and a missing default', async () => {
    const d = tempProjectDir('mgl-runner-');
    try {
      const root = scaffoldPlugin('effect', 'oops', d).dir;
      writeFileSync(join(root, 'test', 'extra.test.ts'), `import { test, assert } from 'michelangelo/testing';\ntest('fails', () => { assert.equal(1, 2); });\n`);
      const r = await runPluginTests(root, { typecheck: false });
      expect(r.ok).toBe(false);
      expect(r.failed).toBe(1);
      expect(r.passed).toBe(2);
      expect(r.output).toMatch(/✗ tests: 1 failed/);

      writeFileSync(join(root, 'src', 'index.ts'), `import { defineEffect, z } from 'michelangelo/plugin';\nexport default { name: 'oops', effects: [defineEffect({ type: 'oops', describe: 'x', params: z.object({ n: z.number() }), draw() {} })] };\n`);
      const r2 = await runPluginTests(root, { typecheck: false });
      expect(r2.steps.find((s) => s.step === 'definition')).toMatchObject({ ok: false });
      expect(r2.output).toMatch(/param "n" has no default/);

      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ ...pkg, michelangelo: { api: '^9.0.0', kinds: ['effect'] } }));
      const r3 = await runPluginTests(root);
      expect(r3.ok).toBe(false);
      expect(r3.steps).toHaveLength(1);
      expect(r3.output).toMatch(/needs plugin API \^9\.0\.0/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 60_000);

  it('a type error in the plugin fails the type-check step', async () => {
    const d = tempProjectDir('mgl-runner-');
    try {
      const root = scaffoldPlugin('generator', 'typo', d).dir;
      const src = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
      writeFileSync(join(root, 'src', 'index.ts'), src.replace('c.lineWidth = p.width;', 'c.lineWidth = p.widht;'));
      const r = await runPluginTests(root);
      const tc = r.steps.find((s) => s.step === 'typecheck')!;
      expect(tc.ok).toBe(false);
      expect(tc.detail).toMatch(/src\/index\.ts\(\d+,\d+\): error TS2551/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 60_000);
});
