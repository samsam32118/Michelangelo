import { test, assert, loadPlugin, renderEffect, distinctLevels, meanColor } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const effect = plugin.effects![0]!;

for (const levels of [2, 3, 4]) {
  test(`levels ${levels} leaves at most ${levels} values per colour channel`, () => {
    const { dst } = renderEffect(effect, { levels });
    for (const ch of ['r', 'g', 'b'] as const) {
      const n = distinctLevels(dst, ch);
      assert.ok(n <= levels, `${ch}: ${n} distinct values`);
    }
  });
}

test('defaults to 4 levels', () => {
  const { dst } = renderEffect(effect, {});
  for (const ch of ['r', 'g', 'b'] as const) assert.ok(distinctLevels(dst, ch) <= 4);
});

test('keeps alpha and roughly the mean colour', () => {
  const { dst, src } = renderEffect(effect, { levels: 8 });
  const a = meanColor(dst), b = meanColor(src);
  assert.equal(a[3], b[3]);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(a[c]! - b[c]!) < 12, `channel ${c}: ${a[c]} vs ${b[c]}`);
});
