import { test, assert, loadPlugin, renderEffect, distinctLevels, difference, pixel } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const effect = plugin.effects![0]!;

test('default 4 levels leaves at most 4 values per channel', () => {
  const { dst } = renderEffect(effect, {});
  for (const c of ['r', 'g', 'b'] as const) assert.ok(distinctLevels(dst, c) <= 4, `${c}: ${distinctLevels(dst, c)}`);
});

test('3 levels maps every channel to 0, 128 or 255 and keeps alpha', () => {
  const { dst, src } = renderEffect(effect, { levels: 3 });
  for (const c of ['r', 'g', 'b'] as const) assert.ok(distinctLevels(dst, c) <= 3, `${c}: ${distinctLevels(dst, c)}`);
  const [r, g, b, a] = pixel(dst, 10, 10);
  for (const v of [r, g, b]) assert.ok([0, 128, 255].includes(v!), `value ${v}`);
  assert.equal(a, pixel(src, 10, 10)[3]);
});

test('256 levels leaves the layer unchanged', () => {
  const { dst, src } = renderEffect(effect, { levels: 256 });
  assert.ok(difference(dst, src) < 0.5);
});
