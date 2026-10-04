import { describe, it, expect } from 'vitest';
import { makeProject } from './commands-fixtures.js';
import type { ProjectFile } from '../../src/core/schema/index.js';

const base = (p: ProjectFile) => {
  p.assets = [{ id: 'beach', src: 'beach.mp4' }];
  p.clips = [
    { id: 'a', track: 'V1', at: 0, len: 60, asset: 'beach', in: 30 },
    { id: 'b', track: 'V1', at: 60, len: 60, asset: 'beach', in: 2 },
    { id: 'c', track: 'V1', at: 200, len: 30, color: '#ff0000' },
  ];
};

describe('fx.add / fx.set / fx.remove / fx.move', () => {
  it('adds effects validated against the catalog, at a position', async () => {
    const { edit, clip } = makeProject({ edit: base });
    const r = await edit({ op: 'fx.add', id: 'a', type: 'blur', radius: 8 });
    expect(r.out[0]).toEqual({ index: 0 });
    await edit({ op: 'fx.add', id: 'a', type: 'glow', at: 0, amount: 0.3 });
    expect(clip('a').fx).toEqual([{ type: 'glow', amount: 0.3 }, { type: 'blur', radius: 8 }]);
    const e = await edit({ op: 'fx.add', id: 'a', type: 'blurr' }).catch((x) => x);
    expect(e).toMatchObject({ code: 'E_UNKNOWN_EFFECT', didYouMean: ['blur'] });
    const p = await edit({ op: 'fx.add', id: 'a', type: 'blur', size: 3 }).catch((x) => x);
    expect(p.code).toBe('E_PARAMS');
    expect(p.fix).toMatch(/radius, edges/);
    await expect(edit({ op: 'fx.add', id: 'a', type: 'blur', radius: 'big' })).rejects.toMatchObject({ code: 'E_PARAMS' });
  });
  it('sets params by type or index, null removes, and refuses to overwrite keyframes', async () => {
    const { edit, clip } = makeProject({ edit: base });
    await edit([{ op: 'fx.add', id: 'a', type: 'blur', radius: 8 }, { op: 'fx.add', id: 'a', type: 'glow' }]);
    await edit({ op: 'fx.set', id: 'a', fx: 'glow', amount: 0.9, color: '#00ff00' });
    await edit({ op: 'fx.set', id: 'a', fx: 0, radius: null, edges: 'transparent' });
    expect(clip('a').fx).toEqual([{ type: 'blur', edges: 'transparent' }, { type: 'glow', amount: 0.9, color: '#00ff00' }]);
    await expect(edit({ op: 'fx.set', id: 'a', fx: 'vignette', amount: 1 })).rejects.toMatchObject({ code: 'E_NO_FX', fix: expect.stringMatching(/0:blur, 1:glow/) });
    await edit({ op: 'key.set', id: 'a', prop: 'fx.glow.amount', at: 10, value: 0.1 });
    await expect(edit({ op: 'fx.set', id: 'a', fx: 'glow', amount: 0.5 })).rejects.toMatchObject({ code: 'E_KEYFRAMED', fix: expect.stringMatching(/key.clear/) });
  });
  it('moves and removes effects', async () => {
    const { edit, clip } = makeProject({ edit: base });
    await edit([{ op: 'fx.add', id: 'a', type: 'blur' }, { op: 'fx.add', id: 'a', type: 'glow' }]);
    await edit({ op: 'fx.move', id: 'a', fx: 'glow', to: 0 });
    expect(clip('a').fx!.map((f) => f.type)).toEqual(['glow', 'blur']);
    await expect(edit({ op: 'fx.move', id: 'a', fx: 0, to: 5 })).rejects.toMatchObject({ code: 'E_RANGE' });
    await edit({ op: 'fx.remove', id: 'a', fx: 'glow' });
    await edit({ op: 'fx.remove', id: 'a', fx: 0 });
    expect(clip('a').fx).toBeUndefined();
  });
});

describe('transition.set', () => {
  it('sets an in transition, validates type and params, and warns about missing handles', async () => {
    const { edit, clip } = makeProject({ edit: base });
    const r = await edit({ op: 'transition.set', id: 'b', type: 'wipe', len: 10, direction: 'up' });
    expect(clip('b').transition).toEqual({ in: { type: 'wipe', len: 10, direction: 'up' } });
    expect(r.notes.join(' ')).toMatch(/2 frames of media before its in-point but the transition needs 5/);
    await edit({ op: 'transition.set', id: 'b', type: 'wipe', softness: 4 });
    expect(clip('b').transition!.in).toEqual({ type: 'wipe', len: 10, direction: 'up', softness: 4 });
    const e = await edit({ op: 'transition.set', id: 'b', type: 'crossfaed', len: 10 }).catch((x) => x);
    expect(e).toMatchObject({ code: 'E_UNKNOWN_TRANSITION', didYouMean: ['crossfade'] });
    await expect(edit({ op: 'transition.set', id: 'b', type: 'wipe', len: 10, angle: 3 })).rejects.toMatchObject({ code: 'E_PARAMS' });
    await expect(edit({ op: 'transition.set', id: 'b', type: 'crossfade', side: 'out' })).rejects.toMatchObject({ code: 'E_ARG', fix: expect.stringMatching(/len=/) });
  });
  it('warns when there is no neighbour, sets out transitions, and removes with none', async () => {
    const { edit, clip } = makeProject({ edit: base });
    const r = await edit({ op: 'transition.set', id: 'c', type: 'crossfade', len: '0.5s' });
    expect(r.notes.join(' ')).toMatch(/comes from nothing/);
    await edit({ op: 'transition.set', id: 'c', side: 'out', type: 'crossfade', len: 6, align: 'end' });
    expect(clip('c').transition).toEqual({ in: { type: 'crossfade', len: 15 }, out: { type: 'crossfade', len: 6, align: 'end' } });
    await edit({ op: 'transition.set', id: 'c', type: 'none' });
    await edit({ op: 'transition.set', id: 'c', side: 'out', type: 'none' });
    expect(clip('c').transition).toBeUndefined();
    await expect(edit({ op: 'transition.set', id: 'c', type: 'crossfade', len: 31 })).rejects.toMatchObject({ code: 'E_RANGE' });
  });
});
