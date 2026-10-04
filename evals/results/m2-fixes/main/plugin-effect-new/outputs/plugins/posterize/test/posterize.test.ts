import { test, assert, loadPlugin, renderEffect, difference } from 'michelangelo/testing';

const plugin = await loadPlugin(import.meta.url);
const effect = plugin.effects![0]!;

/** The distinct values of R, G and B over the visible pixels. */
function channelValues(surface: { pixels(): Uint8ClampedArray }): Set<number>[] {
  const px = surface.pixels();
  const seen = [new Set<number>(), new Set<number>(), new Set<number>()];
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) seen[c]!.add(px[i + c]!);
  }
  return seen;
}

test('default is 4 levels per channel', () => {
  const { dst } = renderEffect(effect, {});
  const allowed = [0, 85, 170, 255];
  for (const set of channelValues(dst)) {
    assert.ok(set.size <= 4, `channel has ${set.size} values`);
    for (const v of set) assert.ok(allowed.includes(v), `unexpected value ${v}`);
  }
});

test('levels 3 gives only black, mid and full per channel and keeps alpha', () => {
  const { dst, src } = renderEffect(effect, { levels: 3 });
  for (const set of channelValues(dst)) {
    for (const v of set) assert.ok([0, 127, 128, 255].includes(v), `unexpected value ${v}`);
  }
  const s = src.pixels(), d = dst.pixels();
  for (let i = 3; i < s.length; i += 4) assert.equal(d[i], s[i]);
});

test('levels 256 leaves the layer unchanged', () => {
  const { dst, src } = renderEffect(effect, { levels: 256 });
  assert.ok(difference(dst, src) < 0.5);
});
