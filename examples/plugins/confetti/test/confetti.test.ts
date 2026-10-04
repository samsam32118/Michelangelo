import { test, assert, loadPlugin, renderGenerator, difference, coverage, distinctLevels } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const confetti = plugin.generators![0]!;

test('draws coloured pieces over a transparent layer', () => {
  const { dst } = renderGenerator(confetti, {}, 0, { width: 320, height: 568 });
  const cov = coverage(dst);
  assert.ok(cov > 0.01 && cov < 0.6, `coverage ${cov}`);
  assert.ok(distinctLevels(dst, 'r') >= 3, 'several colours');
});

test('pieces move over time and the same frame renders the same', () => {
  const a = renderGenerator(confetti, {}, 10).dst;
  const b = renderGenerator(confetti, {}, 10).dst;
  const c = renderGenerator(confetti, {}, 20).dst;
  assert.equal(difference(a, b), 0);
  assert.ok(difference(a, c) > 0.5);
});

test('the seed changes the layout; count changes density', () => {
  const a = renderGenerator(confetti, { seed: 1 }, 5).dst;
  const b = renderGenerator(confetti, { seed: 2 }, 5).dst;
  assert.ok(difference(a, b) > 0.5);
  const few = coverage(renderGenerator(confetti, { count: 20 }, 5).dst);
  const many = coverage(renderGenerator(confetti, { count: 400 }, 5).dst);
  assert.ok(many > few * 3);
});
