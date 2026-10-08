import { test, assert, loadPlugin, runCommandOn, testProject } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const { stem, shotHash, blenderCommand } = await import('../src/index.js');

test('the plugin defines maquette.shot and maquette.still', () => {
  assert.deepEqual(plugin.commands!.map((c) => c.op).sort(), ['maquette.shot', 'maquette.still']);
});

test('shot names become safe file stems', () => {
  assert.equal(stem('shots/a_pop.py'), 'a_pop');
  assert.equal(stem('C:\\x\\My Shot!.usda'), 'My-Shot');
  assert.equal(stem('.py'), 'shot');
});

test('the render hash changes with the shot and the settings, and only then', async () => {
  const a = await shotHash(['0.1.0', 'def build(m): pass', 'kit', '720x900', '']);
  assert.equal(a, await shotHash(['0.1.0', 'def build(m): pass', 'kit', '720x900', '']));
  assert.notEqual(a, await shotHash(['0.1.0', 'def build(m): pass ', 'kit', '720x900', '']));
  assert.notEqual(a, await shotHash(['0.1.0', 'def build(m): pass', 'kit', '360x450', '']));
  assert.match(a, /^[0-9a-f]{10}$/);
});

test('Blender starts as a binary with -b, or as a Python with bpy', () => {
  const keep = { b: process.env.MAQUETTE_BLENDER, p: process.env.MAQUETTE_PYTHON };
  process.env.MAQUETTE_BLENDER = '/opt/blender/blender';
  assert.deepEqual(blenderCommand('/k/render_shot.py', ['--shot', 's.py']), ['/opt/blender/blender', ['-b', '--factory-startup', '--python', '/k/render_shot.py', '--', '--shot', 's.py']]);
  delete process.env.MAQUETTE_BLENDER;
  process.env.MAQUETTE_PYTHON = '/venv/bin/python';
  assert.deepEqual(blenderCommand('/k/render_shot.py', ['--x']), ['/venv/bin/python', ['/k/render_shot.py', '--x']]);
  if (keep.b === undefined) delete process.env.MAQUETTE_BLENDER; else process.env.MAQUETTE_BLENDER = keep.b;
  if (keep.p === undefined) delete process.env.MAQUETTE_PYTHON; else process.env.MAQUETTE_PYTHON = keep.p;
});

test('maquette.shot refuses files that are not shots, before starting Blender', async () => {
  const p = testProject();
  await assert.rejects(runCommandOn(p, { op: 'maquette.shot', shot: 'clip.mp4', track: 'V1' }), /not a shot file/);
});

test('maquette.shot renders a cheap draft unless quality=final is asked for', () => {
  const shot = plugin.commands!.find((c) => c.op === 'maquette.shot')!;
  assert.ok(shot.schema.safeParse({ shot: 's.py', track: 'V1', quality: 'final' }).success);
  assert.ok(!shot.schema.safeParse({ shot: 's.py', track: 'V1', quality: 'best' }).success);
  assert.match(shot.doc, /quality=draft \(the default\)/);
});
