import { test, assert, loadPlugin, renderTransition, difference, meanColor } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const wipe = plugin.transitions![0]!;
const BLUE = [16, 64, 255]; // the default incoming surface

const near = (c: number[], t: number[]) => c.slice(0, 3).every((v, i) => Math.abs(v - t[i]!) < 4);

test('progress 0 shows the outgoing clip, 1 the incoming clip', () => {
  const a = renderTransition(wipe, 0);
  assert.equal(difference(a.dst, a.from), 0);
  const b = renderTransition(wipe, 1);
  assert.equal(difference(b.dst, b.to), 0);
});

test('a quarter turn clockwise reveals the top-right quadrant only', () => {
  const { dst } = renderTransition(wipe, 0.25);
  assert.ok(near(meanColor(dst, [170, 10, 140, 70]), BLUE), 'top-right should be the incoming clip');
  assert.ok(!near(meanColor(dst, [10, 10, 140, 70]), BLUE), 'top-left should still be the outgoing clip');
  assert.ok(!near(meanColor(dst, [170, 100, 140, 70]), BLUE), 'bottom-right should still be the outgoing clip');
});

test('counter-clockwise sweeps the other way', () => {
  const { dst } = renderTransition(wipe, 0.25, { params: { clockwise: false } });
  assert.ok(near(meanColor(dst, [10, 10, 140, 70]), BLUE));
  assert.ok(!near(meanColor(dst, [170, 10, 140, 70]), BLUE));
});
