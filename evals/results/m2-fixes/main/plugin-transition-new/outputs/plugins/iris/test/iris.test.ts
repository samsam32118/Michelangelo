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
  const cx = Math.round(dst.width / 2), cy = Math.round(dst.height / 2);
  const centre: [number, number, number, number] = [cx - 10, cy - 10, 20, 20];
  assert.deepEqual(meanColor(dst, centre), meanColor(to, centre));
  const corner: [number, number, number, number] = [0, 0, 10, 10];
  assert.deepEqual(meanColor(dst, corner), meanColor(from, corner));
  const far: [number, number, number, number] = [dst.width - 10, dst.height - 10, 10, 10];
  assert.deepEqual(meanColor(dst, far), meanColor(from, far));
});

test('the circle grows with progress', () => {
  const a = renderTransition(transition, 0.3);
  const b = renderTransition(transition, 0.7);
  // A point between centre and corner: outgoing at 0.3, incoming at 0.7.
  const mid: [number, number, number, number] = [Math.round(a.dst.width * 0.25), Math.round(a.dst.height * 0.25), 10, 10];
  assert.deepEqual(meanColor(a.dst, mid), meanColor(a.from, mid));
  assert.deepEqual(meanColor(b.dst, mid), meanColor(b.to, mid));
});
