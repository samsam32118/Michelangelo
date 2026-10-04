import { test, assert, loadPlugin, renderTransition, difference, meanColor, pixel } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const transition = plugin.transitions![0]!;

test('progress 0 is the outgoing clip, 1 the incoming clip', () => {
  const a = renderTransition(transition, 0);
  assert.equal(difference(a.dst, a.from), 0);
  const b = renderTransition(transition, 1);
  assert.equal(difference(b.dst, b.to), 0);
});

test('halfway: the centre is incoming, the corners outgoing', () => {
  const { dst, to, from } = renderTransition(transition, 0.5);
  const cx = Math.floor(dst.width / 2), cy = Math.floor(dst.height / 2);
  assert.deepEqual(meanColor(dst, [cx - 10, cy - 10, 20, 20]), meanColor(to, [cx - 10, cy - 10, 20, 20]));
  assert.deepEqual(pixel(dst, 0, 0), pixel(from, 0, 0));
  assert.deepEqual(pixel(dst, dst.width - 1, dst.height - 1), pixel(from, dst.width - 1, dst.height - 1));
});
