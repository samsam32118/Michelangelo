import { test, assert, loadPlugin, renderEffect, meanColor, difference } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const effect = plugin.effects![0]!;

test('the identity matrix leaves the layer unchanged', () => {
  const { dst, src } = renderEffect(effect, {});
  assert.ok(difference(dst, src) < 0.5);
});

test('rows swap channels and offsets lift them, alpha kept', () => {
  const { dst, src } = renderEffect(effect, { red: [0, 0, 1, 0], green: [0, 1, 0, 0], blue: [1, 0, 0, 0] });
  const [sr, , sb] = meanColor(src);
  const [r, , b, a] = meanColor(dst);
  assert.ok(Math.abs(r - sb) < 2 && Math.abs(b - sr) < 2, `swapped ${r},${b} vs ${sb},${sr}`);
  assert.equal(a, 255);
  const lifted = renderEffect(effect, { red: [0, 0, 0, 0.5], green: [0, 0, 0, 0], blue: [0, 0, 0, 1] }).dst;
  const [lr, lg, lb] = meanColor(lifted);
  assert.ok(Math.abs(lr - 128) < 2 && lg < 2 && lb > 253, `offsets ${lr},${lg},${lb}`);
});
