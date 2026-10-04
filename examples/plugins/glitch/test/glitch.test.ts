import { test, assert, loadPlugin, renderEffect, difference, pixel } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const glitch = plugin.effects![0]!;

test('amount 0 leaves the layer unchanged', () => {
  const { dst, src } = renderEffect(glitch, { amount: 0 });
  assert.ok(difference(dst, src) < 0.5);
});

test('amount 1 splits channels and shifts slices', () => {
  const { dst, src } = renderEffect(glitch, { amount: 1, slices: 12 });
  assert.ok(difference(dst, src) > 2, 'the glitched frame should differ from the source');
  // somewhere the red and blue channels no longer agree with the source bars
  let split = 0;
  for (let y = 0; y < 120; y += 4) for (let x = 0; x < 320; x += 4) {
    const a = pixel(dst, x, y), b = pixel(src, x, y);
    if (a[0] !== b[0] || a[2] !== b[2]) split++;
  }
  assert.ok(split > 20, `expected channel differences, got ${split}`);
});

test('deterministic per (seed, frame), different across seeds and held frames', () => {
  const a = renderEffect(glitch, { amount: 1 }, { frame: 6 }).dst;
  const b = renderEffect(glitch, { amount: 1 }, { frame: 6 }).dst;
  const c = renderEffect(glitch, { amount: 1, seed: 7 }, { frame: 6 }).dst;
  const held = renderEffect(glitch, { amount: 1 }, { frame: 7 }).dst;
  assert.equal(difference(a, b), 0);
  assert.equal(difference(a, held), 0, 'hold=3: frames 6 and 7 share a pattern');
  assert.ok(difference(a, c) > 0.5);
});
