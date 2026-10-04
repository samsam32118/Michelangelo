// Grader validation: a real solution driven through the Michelangelo CLI of this checkout (linked into the temp
// dir the way the sandbox has it installed). The grader itself never uses Michelangelo except to run the
// agent's plugin test and a still, as the task prescribes.
import { join, dirname, resolve } from 'node:path';
import { mkdirSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from '../_lib/proc.mjs';
import { QUOTES } from './setup.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const SRC = `import { definePlugin, defineTemplate, z } from 'michelangelo/plugin';

const params = z.object({
  quote: z.string().default('Quote'),
  author: z.string().default('Someone'),
  accent: z.string().default('#22c55e'),
});

/** A quote card: dark panel, accent bar on the left, quote and author fading in. */
const quoteCard = defineTemplate({
  id: 'quote-card',
  describe: 'An animated quote card: quote text, author line and an accent bar on the left (4 s).',
  params,
  build({ params: raw, comp, rate, at, len }) {
    const p = params.parse(raw);
    const [W, H] = comp.size;
    const n = len ?? Math.round((4 * rate.num) / rate.den);
    const cw = Math.round(W * 0.84), ch = Math.round(H * 0.42), cx = Math.round(W / 2), cy = Math.round(H / 2);
    const left = cx - cw / 2, fade: [number, number] = [Math.min(10, Math.floor(n / 4)), 0];
    return {
      clips: [
        { id: 'panel', track: 'panel', at, len: n, shape: { type: 'rect', size: [cw, ch], fill: '#111827' }, x: cx, y: cy, fade },
        { id: 'bar', track: 'bar', at, len: n, shape: { type: 'rect', size: [18, ch - 60], fill: p.accent }, x: Math.round(left + 40), y: cy, fade },
        { id: 'quote', track: 'quote', at, len: n, text: p.quote, style: { size: 54, color: '#ffffff', align: 'left', box: [cw - 140, ch - 180], maxLines: 4 }, x: cx + 30, y: cy - 50, fade },
        { id: 'author', track: 'author', at, len: n, text: '- ' + p.author, style: { size: 38, color: '#d1d5db', align: 'left', box: [cw - 140, 60] }, x: cx + 30, y: Math.round(cy + ch / 2 - 70), fade },
      ],
      summary: \`quote card "\${p.quote}"\`,
    };
  },
});

export default definePlugin({ name: 'quote-card', version: '0.1.0', templates: [quoteCard] });
`;

const TEST = `import { test, assert, loadPlugin, testProject, runCommandOn } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);

test('template.apply builds the quote card', async () => {
  const r = await runCommandOn(testProject({ seconds: 5 }), { op: 'template.apply', template: 'quote-card', at: '0.5s', params: { quote: 'Hello', author: 'Ada' } }, { plugins: [plugin] });
  const made = r.project.clips!.filter((c) => c.tags?.includes('template:quote-card'));
  assert.equal(made.length, 4);
  assert.ok(made.some((c) => c.text === 'Hello'));
});
`;

export async function reference(dir) {
  mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
  if (!existsSync(join(dir, 'node_modules/michelangelo'))) symlinkSync(REPO, join(dir, 'node_modules/michelangelo'));
  if (!existsSync(join(dir, 'node_modules/.bin/mgl'))) symlinkSync(join(REPO, 'dist/cli/main.js'), join(dir, 'node_modules/.bin/mgl'));
  process.env.MGL_TRUST_STORE = join(dir, '.trust.json'); // keep the validation out of the real HOME (graders inherit it)
  const mgl = async (...args) => {
    const r = await run(process.execPath, [join(dir, 'node_modules/.bin/mgl'), ...args], { cwd: dir });
    if (r.code) throw new Error(`mgl ${args.join(' ')}: ${r.stdout}${r.stderr}`);
  };
  await mgl('plugin', 'new', 'template', 'quote-card');
  writeFileSync(join(dir, 'plugins/quote-card/src/index.ts'), SRC);
  writeFileSync(join(dir, 'plugins/quote-card/test/quote-card.test.ts'), TEST);
  await mgl('plugin', 'test', 'plugins/quote-card');
  await mgl('plugin', 'trust', 'plugins/quote-card');
  await mgl('edit', 'reel.mgl.json', 'project.set', 'plugins={"quote-card": "^0.1.0"}');
  for (const [i, [at, accent]] of [['1s', '#22c55e'], ['6s', '#ef4444']].entries()) {
    await mgl('edit', 'reel.mgl.json', 'template.apply', 'quote-card', `at=${at}`, 'len=4s', `params=${JSON.stringify({ ...QUOTES[i], accent })}`);
  }
  mkdirSync(join(dir, 'out'), { recursive: true });
  await mgl('render', 'reel.mgl.json', 'out/q1.png', '--still', '3s');
  await mgl('render', 'reel.mgl.json', 'out/q2.png', '--still', '8s');
}
