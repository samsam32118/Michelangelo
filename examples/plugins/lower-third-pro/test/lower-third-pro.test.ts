import { test, assert, loadPlugin, testProject, runCommandOn, renderProject } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const vertical = () => testProject({ width: 1080, height: 1920, seconds: 6 });

test('lower-third-pro.add places name, role, plate and bar on new tracks', async () => {
  const r = await runCommandOn(vertical(), { op: 'lower-third-pro.add', name: 'Ada Lovelace', role: 'Engineer', at: '1s' }, { plugins: [plugin] });
  const ids = r.out.ids as string[];
  assert.equal(ids.length, 4);
  const clips = r.project.clips!.filter((c) => ids.includes(c.id));
  assert.ok(clips.every((c) => c.at === 30 && c.len === 150));
  assert.ok(clips.some((c) => c.text === 'Ada Lovelace'));
  assert.equal(new Set(clips.map((c) => c.track)).size, 4, 'one track per layer');
  // on a vertical comp the plate stays above the platform caption zone (bottom 22%)
  const plate = clips.find((c) => c.shape?.type === 'rect' && c.opacity !== undefined)!;
  const h = (plate.shape!.size as [number, number])[1];
  assert.ok((plate.y as number) + h / 2 <= 1920 * 0.78);
});

test('the template also works through template.apply, and twice gets unique ids', async () => {
  let p = vertical();
  for (let i = 0; i < 2; i++) p = (await runCommandOn(p, { op: 'template.apply', template: 'lower-third-pro', at: 0, params: { name: `Guest ${i}` } }, { plugins: [plugin] })).project;
  const ids = p.clips!.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(p.clips!.filter((c) => c.tags?.includes('template:lower-third-pro')).length, 6, 'no role: 3 layers each');
});

test('renders a plate in the lower part of the frame', async () => {
  const r = await runCommandOn(testProject({ width: 640, height: 360 }), { op: 'lower-third-pro.add', name: 'Ada', role: 'Engineer' }, { plugins: [plugin] });
  const img = await renderProject(r.project, 20, { plugins: [plugin] });
  // the background clip is #202024; the plate (#111318) and white text appear bottom-left
  const at = (x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
  const lower = [...Array(40).keys()].map((i) => at(40 + i * 3, 290)).filter(([r, g, b]) => !(r === 32 && g === 32 && b === 36));
  assert.ok(lower.length > 20, 'the lower third covers the bottom-left area');
  assert.deepEqual(at(600, 40), [32, 32, 36], 'the top-right corner is untouched');
});
