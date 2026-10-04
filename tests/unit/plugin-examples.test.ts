import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runPluginTests, type PluginTestResult } from '../../src/plugin/test-runner.js';
import { loadRegistry } from '../../src/plugin/loader.js';
import { testProject } from '../../src/plugin/testing.js';
import { REPO, tempProjectDir } from './plugin-fixtures.js';

const EXAMPLES = ['glitch', 'clock-wipe', 'confetti', 'lower-third-pro'];
let dir: string;
const results = new Map<string, PluginTestResult>();

beforeAll(async () => {
  // copies, so .preview.png and test output never land in the repository
  dir = tempProjectDir('mgl-examples-');
  for (const n of EXAMPLES) cpSync(join(REPO, 'examples', 'plugins', n), join(dir, 'plugins', n), { recursive: true });
  await Promise.all(EXAMPLES.map(async (n) => { results.set(n, await runPluginTests(join(dir, 'plugins', n))); }));
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('example plugins', () => {
  it('are all listed', () => {
    expect(readdirSync(join(REPO, 'examples', 'plugins')).filter((f) => !f.startsWith('.')).sort()).toEqual([...EXAMPLES].sort());
  });

  it.each(EXAMPLES)('%s passes plugin test (manifest, definition, type-check, tests)', (n) => {
    const r = results.get(n)!;
    expect(r.ok, r.output).toBe(true);
    expect(r.passed).toBeGreaterThanOrEqual(3);
  });

  it.each(EXAMPLES)('%s imports only the public API', (n) => {
    const root = join(REPO, 'examples', 'plugins', n);
    for (const sub of ['src', 'test']) for (const f of readdirSync(join(root, sub))) {
      const imports = [...readFileSync(join(root, sub, f), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.every((s) => s === 'michelangelo/plugin' || s === 'michelangelo/testing'), `${n}/${sub}/${f}: ${imports.join(', ')}`).toBe(true);
    }
  });

  it('all four load together into one registry when allowed', async () => {
    const plugins = Object.fromEntries(EXAMPLES.map((n) => [n, '^1.0.0']));
    const r = await loadRegistry(testProject({ plugins }), dir, { allowUntrusted: true });
    expect(r.problems).toEqual([]);
    expect(r.effects.has('glitch') && r.transitions.has('clock-wipe') && r.generators.has('confetti') && r.templates.has('lower-third-pro')).toBe(true);
    expect(r.commands.has('lower-third-pro.add')).toBe(true);
  });
});
