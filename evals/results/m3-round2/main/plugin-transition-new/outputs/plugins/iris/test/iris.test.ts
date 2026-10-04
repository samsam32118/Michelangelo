import { test, assert, loadPlugin, renderTransition, difference, meanColor } from 'michelangelo/testing';

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
  const W = dst.width, H = dst.height;
  const centre: [number, number, number, number] = [W / 2 - 10, H / 2 - 10, 20, 20];
  const corner: [number, number, number, number] = [0, 0, 10, 10];
  const far: [number, number, number, number] = [W - 10, H - 10, 10, 10];
  assert.deepEqual(meanColor(dst, centre), meanColor(to, centre));
  assert.deepEqual(meanColor(dst, corner), meanColor(from, corner));
  assert.deepEqual(meanColor(dst, far), meanColor(from, far));
});
