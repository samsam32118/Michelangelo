import { describe, it, expect } from 'vitest';
import { makeProject } from './text-fixtures.js';
import builtinText, { TEXT_ANIMATION_IDS, styles } from '../../src/builtin/text/index.js';
import { BUILTIN_STYLES } from '../../src/core/load.js';
import type { ProjectFile } from '../../src/core/schema/index.js';

const base = (p: ProjectFile) => {
  p.clips = [{ id: 'title', track: 'T1', at: 0, len: 90, text: 'Hello' }, { id: 'subs', track: 'V1', at: 0, len: 90, captions: true }, { id: 'box', track: 'V1', at: 90, len: 30, shape: { type: 'rect', size: [100, 100] } }];
  p.cues = [{ id: 'c1', clip: 'subs', at: 0, len: 30, text: 'one two', words: [0, 15] }];
};

describe('builtin text plugin', () => {
  it('provides every built-in style the loader accepts and the animation presets', () => {
    expect(styles.map((s) => s.id).sort()).toEqual([...BUILTIN_STYLES].sort());
    for (const id of ['none', 'fade', 'pop', 'slide-up', 'slide-down', 'slide-left', 'typewriter', 'blur-in', 'bounce', 'scale-in', 'drop', 'wave']) expect(TEXT_ANIMATION_IDS).toContain(id);
    expect(builtinText.name).toBe('builtin-text');
  });
  it('animations rest at p = 1 and pop overshoots', () => {
    for (const a of builtinText.textAnimations!) {
      const s = a.state(1);
      expect(s.opacity ?? 1).toBeCloseTo(1);
      expect(s.dx ?? 0).toBeCloseTo(0);
      expect(s.dy ?? 0).toBeCloseTo(0);
      expect(s.scale ?? 1).toBeCloseTo(1);
      expect(s.blur ?? 0).toBeCloseTo(0);
    }
    const pop = builtinText.textAnimations!.find((a) => a.id === 'pop')!;
    expect(pop.state(0).scale).toBeCloseTo(0.6);
    expect(pop.state(0.6).scale).toBeCloseTo(1.08);
    expect(pop.state(0).opacity).toBe(0);
  });
});

describe('text.set and text.animate', () => {
  it('sets clip text and cue text (re-estimating words unless kept)', async () => {
    const { project, edit } = makeProject({ edit: base });
    await edit({ op: 'text.set', id: 'title', text: 'Three tips' });
    expect(project.clip('title')!.text).toBe('Three tips');
    await edit({ op: 'text.set', id: 'c1', text: 'uno dos', keepWords: true });
    expect(project.data.cues![0]!.words).toEqual([0, 15]);
    await edit({ op: 'text.set', id: 'c1', text: 'a much longer line' });
    expect(project.data.cues![0]!.words).toHaveLength(4);
    await expect(edit({ op: 'text.set', id: 'box', text: 'x' })).rejects.toMatchObject({ code: 'E_NOT_TEXT' });
    await expect(edit({ op: 'text.set', id: 'titel', text: 'x' })).rejects.toMatchObject({ code: 'E_REF', fix: expect.stringMatching(/title/) });
  });
  it('validates presets, converts times, and removes fields with null', async () => {
    const { project, edit } = makeProject({ edit: base });
    await edit({ op: 'text.animate', id: 'title', in: 'pop', out: 'fade', by: 'word', stagger: 3, len: '0.5s' });
    expect(project.clip('title')!.animate).toEqual({ in: 'pop', out: 'fade', by: 'word', stagger: 3, len: 15 });
    await edit({ op: 'text.animate', id: 'title', out: null, stagger: null });
    expect(project.clip('title')!.animate).toEqual({ in: 'pop', by: 'word', len: 15 });
    const err = await edit({ op: 'text.animate', id: 'title', in: 'popp' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'E_UNKNOWN_ANIMATION', didYouMean: expect.arrayContaining(['pop']) });
    await expect(edit({ op: 'text.animate', id: 'title', by: 'letter' })).rejects.toMatchObject({ code: 'E_ARG' });
    await expect(edit({ op: 'text.animate', id: 'subs', in: 'fade' })).rejects.toMatchObject({ code: 'E_NOT_TEXT' });
    await expect(edit({ op: 'text.animate', id: 'title', len: 0 })).rejects.toMatchObject({ code: 'E_RANGE' });
    await edit({ op: 'text.animate', id: 'title', in: null, by: null, len: null });
    expect(project.clip('title')!.animate).toBeUndefined();
  });
  it('accepts plugin animations listed by the catalog', async () => {
    const { project, edit } = makeProject({ edit: base });
    (project.services.catalog as unknown as { textAnimations: Map<string, unknown> }).textAnimations = new Map([['glitch-in', {}]]);
    await edit({ op: 'text.animate', id: 'title', in: 'glitch-in' });
    expect(project.clip('title')!.animate!.in).toBe('glitch-in');
  });
});

describe('styles', () => {
  it('adds, sets and removes project styles', async () => {
    const { project, edit } = makeProject({ edit: base });
    await edit({ op: 'style.add', id: 'brand', base: 'caption', color: '#00e5ff', size: 70 });
    expect(project.data.styles).toEqual([{ id: 'brand', base: 'caption', color: '#00e5ff', size: 70 }]);
    await expect(edit({ op: 'style.add', id: 'brand' })).rejects.toMatchObject({ code: 'E_DUPLICATE_ID' });
    await expect(edit({ op: 'style.add', id: 'x', base: 'nope' })).rejects.toMatchObject({ code: 'E_REF' });
    await expect(edit({ op: 'style.add', id: 'y', colour: '#fff' })).rejects.toMatchObject({ code: 'E_ARG', didYouMean: ['color'] });
    await edit({ op: 'style.set', id: 'brand', color: '#ffcc00', size: null, stroke: '#000000' });
    expect(project.data.styles![0]).toEqual({ id: 'brand', base: 'caption', color: '#ffcc00', stroke: '#000000' });
    await edit({ op: 'style.add', id: 'brand2', base: 'brand' });
    await expect(edit({ op: 'style.set', id: 'brand', base: 'brand2' })).rejects.toMatchObject({ code: 'E_CYCLE' });
    await expect(edit({ op: 'style.set', id: 'caption', size: 10 })).rejects.toMatchObject({ code: 'E_REF', fix: expect.stringMatching(/style.add/) });
    await edit({ op: 'clip.set', id: 'title', style: 'brand' });
    await expect(edit({ op: 'style.remove', id: 'brand' })).rejects.toMatchObject({ code: 'E_IN_USE', message: expect.stringMatching(/clip title.*style brand2/) });
    await edit([{ op: 'style.remove', id: 'brand2' }, { op: 'clip.set', id: 'title', style: null }, { op: 'style.remove', id: 'brand' }]);
    expect(project.data.styles).toBeUndefined();
  });
});
