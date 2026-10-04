import { test, assert, loadPlugin, testProject, runCommandOn, renderProject, renderEffect, renderGenerator, meanColor, difference, coverage } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const fx = (t: string) => plugin.effects!.find((e) => e.type === t)!;
const gen = (t: string) => plugin.generators!.find((g) => g.type === t)!;
const vertical = () => testProject({ width: 1080, height: 1920, seconds: 4 });
const apply = (p: ReturnType<typeof testProject>, template: string, params: Record<string, unknown>, at = 0) =>
  runCommandOn(p, { op: 'template.apply', template, at, len: 60, params }, { plugins: [plugin] });

test('paper-boil holds a pose for `step` frames, then moves', () => {
  const a = renderEffect(fx('paper-boil'), { step: 3, shift: 6 }, { frame: 0 });
  const b = renderEffect(fx('paper-boil'), { step: 3, shift: 6 }, { frame: 2 });
  const c = renderEffect(fx('paper-boil'), { step: 3, shift: 6 }, { frame: 3 });
  assert.ok(difference(a.dst, b.dst) < 0.01, 'same pose inside a step');
  assert.ok(difference(a.dst, c.dst) > 0, 'new pose on the next step');
});

test('ink-flat paints the silhouette one colour', () => {
  const { dst } = renderEffect(fx('ink-flat'), { color: '#ff0000' });
  const [r, g, b] = meanColor(dst);
  assert.ok(r > 240 && g < 15 && b < 15, `mean ${r},${g},${b}`);
});

test('paper-field is mostly the field colour, and its dust changes between steps', () => {
  const a = renderGenerator(gen('paper-field'), { color: '#1f3fe0' }, 0);
  const [r, g, b] = meanColor(a.dst);
  assert.ok(b > r && b > g && b > 150, `mean ${r},${g},${b}`);
  assert.ok(difference(a.dst, renderGenerator(gen('paper-field'), { color: '#1f3fe0' }, 3).dst) > 0);
});

test('dot-grid reveals its rows over `reveal` frames', () => {
  const p = { cols: 10, rows: 6, lit: 2, cell: 12, gap: 3, x: 160, y: 90, reveal: 12 };
  const early = coverage(renderGenerator(gen('dot-grid'), p, 0).dst), late = coverage(renderGenerator(gen('dot-grid'), p, 20).dst);
  assert.ok(early > 0 && late > early * 2, `coverage ${early} -> ${late}`);
});

test('paper-number: a torn scrap under the text, dropping in with held poses', async () => {
  const r = await apply(vertical(), 'paper-number', { text: '74%', size: 300, y: 600 });
  const clips = r.project.clips!.filter((c) => c.tags?.includes('template:paper-number'));
  assert.equal(clips.length, 2);
  const ink = clips.find((c) => c.text === '74%')!, scrap = clips.find((c) => c.shape?.type === 'path')!;
  assert.ok(scrap.shape!.d!.startsWith('M'));
  const y = ink.y as [number, number, string?][];
  assert.equal(y.at(-1)![1], 600, 'comes to rest at y');
  assert.ok(y.slice(0, -1).every((k) => k[2] === 'hold'), 'stepped, not eased');
  assert.ok(ink.fx!.some((f) => f.type === 'paper-boil'));
});

test('tape-label: paper, text and two pieces of tape that follow the rotation', async () => {
  const r = await apply(vertical(), 'tape-label', { text: 'ONE STUDY', x: 540, y: 300, rotate: 0 });
  const clips = r.project.clips!.filter((c) => c.tags?.includes('template:tape-label'));
  assert.equal(clips.length, 4);
  const a = clips.find((c) => c.id.endsWith('tape-a'))!, b = clips.find((c) => c.id.endsWith('tape-b'))!;
  assert.ok((a.x as number) < 540 && (b.x as number) > 540, 'one at each end');
  assert.equal(new Set(clips.map((c) => c.track)).size, 4, 'one track per layer');
});

test('applied twice, ids stay unique; the result renders paper pixels', async () => {
  let p = vertical();
  for (const text of ['74%', '0.3%']) p = (await apply(p, 'paper-number', { text, from: 'none', y: 700, size: 300, pad: 120 })).project;
  const ids = p.clips!.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const img = await renderProject(p, 20, { plugins: [plugin] });
  // the background clip is #202024; the cream scrap (#f4f1e6) covers the middle of the frame
  const at = (x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
  const paper = [...Array(40).keys()].map((i) => at(300 + i * 12, 505)).filter(([r, g, b]) => r! > 200 && g! > 200 && b! > 190);
  assert.ok(paper.length > 20, `paper pixels across the scrap: ${paper.length}`);
  assert.deepEqual(at(40, 40), [32, 32, 36], 'the corner is untouched');
});
