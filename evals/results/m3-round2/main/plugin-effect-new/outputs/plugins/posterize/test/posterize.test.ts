import { test, assert, loadPlugin, renderEffect, difference } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const effect = plugin.effects![0]!;

function channelValues(surface: { pixels(): Uint8ClampedArray }) {
  const px = surface.pixels();
  const seen = new Set<number>();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    seen.add(px[i]!); seen.add(px[i + 1]!); seen.add(px[i + 2]!);
  }
  return seen;
}

test('default is 4 levels per channel', () => {
  const { dst } = renderEffect(effect, {});
  for (const v of channelValues(dst)) assert.ok([0, 85, 170, 255].includes(v), `unexpected value ${v}`);
});

test('3 levels gives only 0, 128 and 255', () => {
  const { dst } = renderEffect(effect, { levels: 3 });
  const values = channelValues(dst);
  for (const v of values) assert.ok([0, 128, 255].includes(v), `unexpected value ${v}`);
  assert.ok(values.size >= 2);
});

test('256 levels leaves the layer unchanged and alpha is kept', () => {
  const { dst, src } = renderEffect(effect, { levels: 256 });
  assert.ok(difference(dst, src) < 0.5);
  const s = src.pixels(), d = dst.pixels();
  for (let i = 3; i < s.length; i += 4) assert.equal(d[i], s[i]);
});
