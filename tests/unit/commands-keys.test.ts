import { describe, it, expect } from 'vitest';
import { makeProject } from './commands-fixtures.js';
import type { ProjectFile } from '../../src/core/schema/index.js';

const base = (p: ProjectFile) => {
  p.clips = [
    { id: 'title', track: 'T1', at: 30, len: 90, text: 'Hello', y: 400 },
    { id: 'box', track: 'V1', at: 0, len: 60, shape: { type: 'rect', size: [100, 100] }, fx: [{ type: 'blur', radius: 4 }] },
  ];
};

describe('key.set', () => {
  it('converts a constant into keyframes, keeping the old value at frame 0', async () => {
    const { edit, clip } = makeProject({ edit: base });
    await edit({ op: 'key.set', id: 'title', prop: 'y', at: 15, value: 500, ease: 'outCubic' });
    expect(clip('title').y).toEqual([[0, 400], [15, 500, 'outCubic']]);
    // default value when the property was unset (x = comp centre)
    await edit({ op: 'key.set', id: 'title', prop: 'x', at: '1s', value: 100 });
    expect(clip('title').x).toEqual([[0, 540], [30, 100]]);
    // at frame 0 there is no extra key
    await edit({ op: 'key.set', id: 'title', prop: 'opacity', at: 0, value: 0 });
    expect(clip('title').opacity).toEqual([[0, 0]]);
  });
  it('replaces a key at the same frame (keeping its easing), keeps keys sorted, and accepts abs comp time', async () => {
    const { edit, clip } = makeProject({ edit: base });
    await edit({ op: 'key.set', id: 'title', prop: 'y', at: 20, value: 500, ease: 'inQuad' });
    await edit({ op: 'key.set', id: 'title', prop: 'y', at: 10, value: 450 });
    await edit({ op: 'key.set', id: 'title', prop: 'y', at: 20, value: 520 });
    expect(clip('title').y).toEqual([[0, 400], [10, 450], [20, 520, 'inQuad']]);
    await edit({ op: 'key.set', id: 'title', prop: 'y', at: 60, abs: true, value: 600 });
    expect(clip('title').y).toEqual([[0, 400], [10, 450], [20, 520, 'inQuad'], [30, 600]]);
  });
  it('keys shape.trim and effect params, validated by the catalog', async () => {
    const { edit, clip } = makeProject({ edit: base });
    await edit({ op: 'key.set', id: 'box', prop: 'shape.trim', at: 30, value: 0.5 });
    expect(clip('box').shape!.trim).toEqual([[0, 1], [30, 0.5]]);
    await edit({ op: 'key.set', id: 'box', prop: 'fx.blur.radius', at: 10, value: 20 });
    expect(clip('box').fx![0]!.radius).toEqual([[0, 4], [10, 20]]);
    await expect(edit({ op: 'key.set', id: 'box', prop: 'fx.blur.radios', at: 10, value: 20 })).rejects.toMatchObject({ code: 'E_PARAMS', fix: expect.stringMatching(/radius/) });
    await expect(edit({ op: 'key.set', id: 'box', prop: 'fx.0.radius', at: 10, value: -1 })).rejects.toMatchObject({ code: 'E_PARAMS' });
    await expect(edit({ op: 'key.set', id: 'title', prop: 'shape.trim', at: 1, value: 0.5 })).rejects.toMatchObject({ code: 'E_PROP' });
  });
  it('rejects unknown properties with did-you-mean and wrong values with a fix', async () => {
    const { edit } = makeProject({ edit: base });
    const e = await edit({ op: 'key.set', id: 'title', prop: 'opacty', at: 1, value: 1 }).catch((x) => x);
    expect(e).toMatchObject({ code: 'E_PROP', didYouMean: ['opacity'] });
    expect(e.fix).toMatch(/did you mean "opacity"/);
    await expect(edit({ op: 'key.set', id: 'title', prop: 'x', at: 1, value: 'left' })).rejects.toMatchObject({ code: 'E_VALUE', fix: expect.any(String) });
  });
});

describe('key.remove / key.clear / key.shift', () => {
  it('removes keys, collapsing to a constant', async () => {
    const { edit, clip } = makeProject({ edit: base });
    await edit({ op: 'key.set', id: 'title', prop: 'y', at: 15, value: 500 });
    await expect(edit({ op: 'key.remove', id: 'title', prop: 'y', at: 7 })).rejects.toMatchObject({ code: 'E_NO_KEY', fix: expect.stringMatching(/0, 15/) });
    await edit({ op: 'key.remove', id: 'title', prop: 'y', at: 15 });
    expect(clip('title').y).toBe(400);
    await expect(edit({ op: 'key.remove', id: 'title', prop: 'y', at: 0 })).rejects.toMatchObject({ code: 'E_NOT_KEYFRAMED' });
  });
  it('clears to the value at frame 0 or a given value', async () => {
    const { edit, clip } = makeProject({ edit: base });
    await edit({ op: 'key.set', id: 'title', prop: 'y', at: 15, value: 500 });
    await edit({ op: 'key.clear', id: 'title', prop: 'y' });
    expect(clip('title').y).toBe(400);
    await edit({ op: 'key.set', id: 'title', prop: 'y', at: 15, value: 500 });
    await edit({ op: 'key.clear', id: 'title', prop: 'y', value: 300 });
    expect(clip('title').y).toBe(300);
  });
  it('shifts one or all keyframed properties', async () => {
    const { edit, clip } = makeProject({ edit: base });
    await edit({ op: 'key.set', id: 'box', prop: 'opacity', at: 10, value: 0 });
    await edit({ op: 'key.set', id: 'box', prop: 'fx.blur.radius', at: 10, value: 20 });
    await edit({ op: 'key.shift', id: 'box', by: 5 });
    expect(clip('box').opacity).toEqual([[5, 1], [15, 0]]);
    expect(clip('box').fx![0]!.radius).toEqual([[5, 4], [15, 20]]);
    await edit({ op: 'key.shift', id: 'box', prop: 'opacity', by: -5 });
    expect(clip('box').opacity).toEqual([[0, 1], [10, 0]]);
    await expect(edit({ op: 'key.shift', id: 'title', by: 5 })).rejects.toMatchObject({ code: 'E_NOT_KEYFRAMED', fix: expect.stringMatching(/key.set/) });
  });
});
