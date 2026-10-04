import { test, assert, loadPlugin, effectFilters, renderGenerator, testLevels, coverage, difference } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const telephone = plugin.effects!.find((e) => e.type === 'telephone')!;
const meter = plugin.generators!.find((g) => g.type === 'level-meter')!;

test('telephone is an audio effect with a band-limiting chain', async () => {
  assert.equal(telephone.draw, undefined);
  const f = await effectFilters(telephone, {});
  assert.deepEqual(f.audio.map((x) => x.filter), ['highpass', 'lowpass', 'acrusher', 'volume']);
  assert.match(f.audioGraph, /^highpass=f=300:poles=2,lowpass=f=3400/);
});

test('grit 0 drops the crusher', async () => {
  const f = await effectFilters(telephone, { grit: 0, low: 500 });
  assert.equal(f.audioGraph, 'highpass=f=500:poles=2,lowpass=f=3400:poles=2,volume=volume=3dB');
});

test('the meter follows the sound level', () => {
  assert.equal(meter.audioSource!({ asset: 'vo', width: 40, height: 300, hold: 15 }), 'vo');
  const quiet = renderGenerator(meter, { asset: 'vo' }, 0, { audio: { ...testLevels(0), rms: new Float32Array(300).fill(0.1) } }).dst;
  const loud = renderGenerator(meter, { asset: 'vo' }, 0, { audio: { ...testLevels(0), rms: new Float32Array(300).fill(0.9) } }).dst;
  assert.equal(quiet.width, 40);
  assert.equal(quiet.height, 300);
  assert.ok(difference(quiet, loud) > 5);
  assert.ok(coverage(loud) > 0.9);
});

test('the same frame renders the same', () => {
  const a = renderGenerator(meter, { asset: 'vo' }, 12).dst;
  assert.equal(difference(a, renderGenerator(meter, { asset: 'vo' }, 12).dst), 0);
});
