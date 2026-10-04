/** An SDK session picks up plugins named by `project.set plugins=...` without being reopened. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { create } from '../../src/sdk/index.js';
import { trustPlugin } from '../../src/plugin/trust.js';
import { tempProjectDir, writeFiles } from './plugin-fixtures.js';

const PLUGIN = `import { definePlugin, defineTemplate, z } from 'michelangelo/plugin';
const params = z.object({ text: z.string().default('hi') });
const stamp = defineTemplate({
  id: 'stamp', describe: 'a text stamp', params,
  build({ params: raw, at, len }) { const p = params.parse(raw); return { clips: [{ id: 'text', track: 'text', at, len: len ?? 30, text: p.text }] }; },
});
export default definePlugin({ name: 'stamper', version: '1.0.0', templates: [stamp] });
`;
let dir: string;

beforeAll(() => {
  dir = tempProjectDir('mgl-sdk-reload-');
  writeFiles(dir, {
    'plugins/stamper/package.json': JSON.stringify({ name: 'stamper', version: '1.0.0', type: 'module', main: 'src/index.ts', michelangelo: { api: '^1.0.0', kinds: ['template'] } }),
    'plugins/stamper/src/index.ts': PLUGIN,
  });
  process.env.MGL_TRUST_STORE = join(dir, '.trusted.json');
  trustPlugin(join(dir, 'plugins', 'stamper'));
});
afterAll(() => { delete process.env.MGL_TRUST_STORE; rmSync(dir, { recursive: true, force: true }); });

describe('SDK session and project.set plugins', () => {
  it('loads a newly named plugin on the same session, and drops it again on undo', async () => {
    const p = await create(join(dir, 'a.mgl.json'), { preset: 'shorts' });
    expect(p.registry.templates.has('stamp')).toBe(false);
    await expect(p.edit({ op: 'template.apply', template: 'stamp', at: 0 })).rejects.toMatchObject({ code: 'E_UNKNOWN_TEMPLATE' });

    await p.edit({ op: 'project.set', plugins: { stamper: '^1.0.0' } });
    expect(p.registry.templates.has('stamp')).toBe(true);
    expect(p.pluginProblems).toEqual([]);
    await p.edit({ op: 'template.apply', template: 'stamp', at: 0, params: { text: 'HELLO' } });
    expect(p.clips({}).some((c) => (c as { text?: string }).text === 'HELLO')).toBe(true);

    await p.undo(2);
    expect(p.registry.templates.has('stamp')).toBe(false);
  });

  it('a dry run of project.set plugins does not load the plugin', async () => {
    const p = await create(join(dir, 'b.mgl.json'), { preset: 'shorts' });
    await p.dryRun({ op: 'project.set', plugins: { stamper: '^1.0.0' } });
    expect(p.registry.templates.has('stamp')).toBe(false);
  });
});
