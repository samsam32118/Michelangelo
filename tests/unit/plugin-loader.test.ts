import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadRegistry } from '../../src/plugin/loader.js';
import { trustPlugin, untrustPlugin, listTrusted, hashPlugin } from '../../src/plugin/trust.js';
import { listCommands } from '../../src/core/commands/registry.js';
import { MglError } from '../../src/core/errors.js';
import { testProject, runCommandOn } from '../../src/plugin/testing.js';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { tempProjectDir, writeFiles } from './plugin-fixtures.js';

const manifest = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name, version: '1.2.0', type: 'module', main: 'src/index.ts', michelangelo: { api: '^1.0.0', kinds: ['effect'] }, ...extra });

const TINT = `import { definePlugin, defineEffect, z } from 'michelangelo/plugin';
export default definePlugin({ name: 'tinty', effects: [defineEffect({
  type: 'tinty', describe: 'Paints visible pixels a colour.',
  params: z.object({ color: z.string().default('#00ff00') }),
  draw({ src, dst, params }) {
    dst.ctx.drawImage(src.canvas, 0, 0);
    dst.ctx.globalCompositeOperation = 'source-in';
    dst.ctx.fillStyle = params.color;
    dst.ctx.fillRect(0, 0, dst.width, dst.height);
  },
})] });
`;

let dir: string, store: string;
const project = (plugins: Record<string, string>): ProjectFile => testProject({ plugins });

beforeAll(() => {
  dir = tempProjectDir();
  store = join(dir, 'trust.json');
  writeFiles(dir, {
    'plugins/tinty/package.json': manifest('tinty'),
    'plugins/tinty/src/index.ts': TINT,
    'plugins/future/package.json': manifest('future', { michelangelo: { api: '^2.0.0', kinds: ['effect'] } }),
    'plugins/future/src/index.ts': 'export default {}',
    'plugins/broken/package.json': manifest('broken'),
    'plugins/broken/src/index.ts': 'export default { name: "broken", effects: [{ type: "x" }] };',
    'plugins/cmdplug/package.json': manifest('cmdplug', { michelangelo: { api: '^1.0.0', kinds: ['command'] } }),
    'plugins/cmdplug/src/index.ts': `import { definePlugin, z } from 'michelangelo/plugin';
export default definePlugin({ name: 'cmdplug', commands: [{ op: 'cmdplug.rename-project', group: 'cmdplug', doc: 'Set the project name.', schema: z.strictObject({ name: z.string() }), example: { name: 'x' },
  apply(ctx, p) { ctx.project.project = { ...(ctx.project.project ?? {}), name: String(p.name) }; ctx.summary('renamed'); } }] });
`,
    // an npm-installed plugin (compiled JavaScript)
    'node_modules/npmfx/package.json': JSON.stringify({ name: 'npmfx', version: '3.0.0', type: 'module', exports: { '.': { import: './dist/index.js' } }, michelangelo: { api: '^1.0.0', kinds: ['style'] } }),
    'node_modules/npmfx/dist/index.js': 'export default { name: "npmfx", styles: [{ id: "npm-style", describe: "a style", style: { color: "#ff0000" } }] };',
    'package.json': JSON.stringify({ name: 'proj', private: true, dependencies: { npmfx: '^3.0.0' } }),
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('loadRegistry', () => {
  it('starts from the built-ins', async () => {
    const r = await loadRegistry(project({}), dir, { trustStore: store });
    expect(r.problems).toEqual([]);
    expect(r.registry).toBe(r);
    expect(r.effects.size).toBeGreaterThan(5);
  });

  it('refuses an untrusted plugin next to the project, with the trust command as the fix', async () => {
    const r = await loadRegistry(project({ tinty: '^1.0.0' }), dir, { trustStore: store });
    expect(r.effects.has('tinty')).toBe(false);
    const p = r.problems.find((x) => x.code === 'E_PLUGIN_UNTRUSTED')!;
    expect(p.severity).toBe('error');
    expect(p.renderOnly).toBe(true);
    expect(p.fix).toMatch(/^mgl plugin trust .*plugins\/tinty$/);
    await expect(loadRegistry(project({ tinty: '^1.0.0' }), dir, { trustStore: store, strict: true })).rejects.toMatchObject({ code: 'E_PLUGIN_UNTRUSTED' });
  });

  it('loads a trusted plugin; editing it revokes trust', async () => {
    const e = trustPlugin(join(dir, 'plugins/tinty'), { trustStore: store });
    expect(e.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(listTrusted({ trustStore: store }).map((x) => x.name)).toEqual(['tinty']);
    const r = await loadRegistry(project({ tinty: '^1.0.0' }), dir, { trustStore: store });
    expect(r.problems).toEqual([]);
    expect(r.effects.get('tinty')?.describe).toMatch(/Paints/);
    expect(r.loaded).toMatchObject([{ name: 'tinty', version: '1.2.0', trust: 'store', kinds: ['effect'] }]);
    expect(r.plugins.get('tinty')?.source).toBe(join(dir, 'plugins/tinty'));
    // a .preview.png does not change the hash; a source edit does
    const h = hashPlugin(join(dir, 'plugins/tinty'));
    writeFiles(dir, { 'plugins/tinty/.preview.png': 'x' });
    expect(hashPlugin(join(dir, 'plugins/tinty'))).toBe(h);
    appendFileSync(join(dir, 'plugins/tinty/src/index.ts'), '\n// edited\n');
    const r2 = await loadRegistry(project({ tinty: '^1.0.0' }), dir, { trustStore: store });
    expect(r2.problems[0]).toMatchObject({ code: 'E_PLUGIN_UNTRUSTED' });
    expect(r2.problems[0]!.message).toMatch(/changed since it was trusted/);
    trustPlugin(join(dir, 'plugins/tinty'), { trustStore: store });
    expect(listTrusted({ trustStore: store })).toHaveLength(1);
  });

  it('honours MGL_TRUST_STORE and allowUntrusted', async () => {
    const other = join(dir, 'other-trust.json');
    process.env.MGL_TRUST_STORE = other;
    try {
      const r = await loadRegistry(project({ tinty: '*' }), dir);
      expect(r.problems[0]?.code).toBe('E_PLUGIN_UNTRUSTED');
      const r2 = await loadRegistry(project({ tinty: '*' }), dir, { allowUntrusted: true });
      expect(r2.loaded[0]?.trust).toBe('allowed');
      trustPlugin(join(dir, 'plugins/tinty'));
      expect((await loadRegistry(project({ tinty: '*' }), dir)).loaded[0]?.trust).toBe('store');
      expect(untrustPlugin('tinty')).toHaveLength(1);
    } finally { delete process.env.MGL_TRUST_STORE; }
  });

  it('checks the plugin API range and the version range', async () => {
    const r = await loadRegistry(project({ future: '*', tinty: '^2.0.0' }), dir, { allowUntrusted: true });
    const api = r.problems.find((p) => p.code === 'E_PLUGIN_API')!;
    expect(api.message).toMatch(/needs plugin API \^2\.0\.0; this Michelangelo provides 1\./);
    expect(api.fix).toMatch(/update Michelangelo/);
    const ver = r.problems.find((p) => p.code === 'E_PLUGIN_VERSION')!;
    expect(ver.message).toMatch(/version 1\.2\.0, outside the range "\^2\.0\.0"/);
    expect(ver.fix).toMatch(/\^1\.2\.0/);
  });

  it('reports missing and invalid plugins with fixes', async () => {
    const r = await loadRegistry(project({ nope: '^1.0.0', broken: '*' }), dir, { allowUntrusted: true });
    expect(r.problems.find((p) => p.code === 'E_PLUGIN_NOT_FOUND')?.fix).toMatch(/mgl plugin new effect nope/);
    const bad = r.problems.find((p) => p.code === 'E_PLUGIN_INVALID')!;
    expect(bad.message).toMatch(/effect "x" has no describe/);
    try { await loadRegistry(project({ nope: '^1.0.0' }), dir, { strict: true }); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(MglError);
      expect((e as MglError).fix).toBeTruthy();
    }
  });

  it('npm plugins need trust too, even when the project depends on them (a clone can ship node_modules)', async () => {
    const r0 = await loadRegistry(project({ npmfx: '^3.0.0' }), dir, { trustStore: store });
    expect(r0.problems[0]).toMatchObject({ code: 'E_PLUGIN_UNTRUSTED' });
    expect(r0.problems[0]!.fix).toMatch(/mgl plugin trust .*node_modules[/\\]npmfx/);
    expect(r0.loaded).toEqual([]);
    trustPlugin(join(dir, 'node_modules/npmfx'), { trustStore: store });
    const r = await loadRegistry(project({ npmfx: '^3.0.0' }), dir, { trustStore: store });
    expect(r.problems).toEqual([]);
    expect(r.loaded[0]).toMatchObject({ name: 'npmfx', trust: 'store' });
    expect(r.styles.has('npm-style')).toBe(true);
    writeFiles(dir, { 'package.json': JSON.stringify({ name: 'proj', private: true }) });
    untrustPlugin('npmfx', { trustStore: store });
    try {
      const r2 = await loadRegistry(project({ npmfx: '^3.0.0' }), dir, { trustStore: store });
      expect(r2.problems[0]).toMatchObject({ code: 'E_PLUGIN_UNTRUSTED' });
      expect(r2.problems[0]!.fix).toMatch(/npm install npmfx/);
    } finally {
      writeFiles(dir, { 'package.json': JSON.stringify({ name: 'proj', private: true, dependencies: { npmfx: '^3.0.0' } }) });
    }
  });

  it('registers plugin commands once, so they run through the command registry', async () => {
    trustPlugin(join(dir, 'plugins/cmdplug'), { trustStore: store });
    const p = project({ cmdplug: '*' });
    for (let i = 0; i < 2; i++) {
      const r = await loadRegistry(p, dir, { trustStore: store });
      expect(r.problems).toEqual([]);
      expect(r.commands.has('cmdplug.rename-project')).toBe(true);
    }
    expect(listCommands().filter((c) => c.op === 'cmdplug.rename-project')).toHaveLength(1);
    const out = await runCommandOn(p, { op: 'cmdplug.rename-project', name: 'Renamed' });
    expect(out.project.project?.name).toBe('Renamed');
  });

  it('reads plugins from mgl.config.json too', async () => {
    writeFiles(dir, { 'mgl.config.json': JSON.stringify({ plugins: { tinty: '^1.0.0' } }) });
    try {
      const r = await loadRegistry(project({}), dir, { trustStore: store });
      expect(r.effects.has('tinty')).toBe(true);
    } finally { rmSync(join(dir, 'mgl.config.json')); }
  });

  it('a loaded effect renders through the pipeline', async () => {
    const p = project({ tinty: '^1.0.0' });
    p.clips![0]!.fx = [{ type: 'tinty', color: '#0000ff' }];
    const registry = await loadRegistry(p, dir, { trustStore: store, strict: true });
    const { renderStills } = await import('../../src/render/pipeline.js');
    const [still] = await renderStills(p, { baseDir: dir, registry, frames: [5] });
    const d = still!.image.data;
    expect([d[0], d[1], d[2], d[3]]).toEqual([0, 0, 255, 255]);
  });
});
