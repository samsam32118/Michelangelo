import { describe, it, expect } from 'vitest';
import { makeProject } from './commands-fixtures.js';
import type { ProjectFile } from '../../src/core/schema/index.js';

const base = (p: ProjectFile) => {
  p.clips = [
    { id: 'bg', track: 'V1', at: 0, len: 60, color: '#223344' },
    { id: 'title', track: 'T1', at: 0, len: 60, text: 'Hi' },
  ];
};

describe('mask commands', () => {
  it('adds, changes and removes masks', async () => {
    const { edit, clip } = makeProject({ edit: base });
    const r = await edit({ op: 'mask.add', id: 'bg', shape: 'ellipse', box: [100, 100, 800, 800], feather: 20 });
    expect(r.out[0]).toEqual({ index: 0 });
    await edit({ op: 'mask.add', id: 'bg', shape: 'path', d: 'M0 0 L10 0 L5 8 Z', mode: 'subtract' });
    await edit({ op: 'mask.set', id: 'bg', mask: 0, invert: true, feather: null });
    expect(clip('bg').masks).toEqual([{ shape: 'ellipse', box: [100, 100, 800, 800], invert: true }, { shape: 'path', d: 'M0 0 L10 0 L5 8 Z', mode: 'subtract' }]);
    await edit({ op: 'mask.remove', id: 'bg', mask: 1 });
    await edit({ op: 'mask.remove', id: 'bg', mask: 0 });
    expect(clip('bg').masks).toBeUndefined();
  });
  it('explains missing geometry and bad indexes', async () => {
    const { edit } = makeProject({ edit: base });
    await expect(edit({ op: 'mask.add', id: 'bg', shape: 'rect' })).rejects.toMatchObject({ code: 'E_MASK', fix: expect.stringMatching(/box=/) });
    await expect(edit({ op: 'mask.add', id: 'bg', shape: 'path' })).rejects.toMatchObject({ code: 'E_MASK', fix: expect.stringMatching(/d=/) });
    await expect(edit({ op: 'mask.set', id: 'bg', mask: 2, invert: true })).rejects.toMatchObject({ code: 'E_NO_MASK', fix: expect.stringMatching(/mask.add/) });
    await expect(edit({ op: 'mask.add', id: 'bg', shape: 'rect', box: [0, 0, 1, 1], opacity: 2 })).rejects.toMatchObject({ code: 'E_ARG' });
  });
  it('sets and removes a track matte', async () => {
    const { edit, clip } = makeProject({ edit: base });
    await edit({ op: 'matte.set', id: 'bg', clip: 'title', mode: 'luma' });
    expect(clip('bg').matte).toEqual({ clip: 'title', mode: 'luma' });
    await edit({ op: 'matte.set', id: 'bg', clip: 'title', keep: true });
    expect(clip('bg').matte).toEqual({ clip: 'title', mode: 'luma', keep: true });
    await expect(edit({ op: 'matte.set', id: 'bg', clip: 'bg' })).rejects.toMatchObject({ code: 'E_MATTE' });
    await expect(edit({ op: 'matte.set', id: 'bg', clip: 'titel' })).rejects.toMatchObject({ code: 'E_REF', fix: expect.stringMatching(/title/) });
    await edit({ op: 'matte.set', id: 'bg', clip: null });
    expect(clip('bg').matte).toBeUndefined();
  });
});
