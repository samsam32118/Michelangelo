/** Regression tests for the clip edit commands (review 1, group core). */
import { describe, it, expect } from 'vitest';
import { makeProject } from './commands-fixtures.js';
import type { Clip, ProjectFile } from '../../src/core/schema/index.js';
import { interpolate } from '../../src/render/keyframes.js';
import { parseSpeed } from '../../src/core/time.js';

/** the source frame a media clip shows at comp frame f (as evaluate computes it), or undefined when not on screen */
function shown(clips: Clip[], track: string, f: number): number | undefined {
  const c = clips.find((x) => x.track === track && f >= x.at && f < x.at + x.len);
  if (!c) return undefined;
  const t = f - c.at;
  const sp = parseSpeed(c.speed ?? 1);
  return (c.in ?? 0) + (sp.num === 0 ? 0 : Math.floor((t * sp.num) / sp.den));
}

const withCam = (clips: Clip[], extra: (p: ProjectFile) => void = () => {}) => (p: ProjectFile) => {
  p.assets = [{ id: 'cam', src: 'cam.mp4' }, { id: 'music', src: 'music.wav' }];
  p.clips = clips;
  extra(p);
};

describe('clip.freeze', () => {
  it('splits and ripples the linked (detached) audio too, leaving a silent gap', async () => {
    const { edit, project } = makeProject({ edit: withCam([{ id: 'a', track: 'V1', at: 0, len: 100, asset: 'cam' }]) });
    await edit({ op: 'clip.detach-audio', id: 'a' });
    await edit({ op: 'clip.freeze', id: 'a', at: 50, len: 10 });
    const cl = project.data.clips!;
    const audio = cl.filter((c) => c.track === 'A1').sort((x, y) => x.at - y.at);
    expect(audio.map((c) => [c.at, c.len, c.in ?? 0])).toEqual([[0, 50, 0], [60, 50, 50]]);
    // picture and sound show the same source frame after the hold
    for (const f of [0, 49, 60, 80, 109]) expect(shown(cl, 'V1', f)).toBe(shown(cl, 'A1', f));
    expect(shown(cl, 'A1', 55)).toBeUndefined();
    expect(cl.find((c) => c.id === 'a-hold')).toMatchObject({ at: 50, len: 10, in: 50, speed: 0, muted: true });
  });
  it('works at the first frame of the clip (the clip moves after the hold)', async () => {
    const { edit, clip } = makeProject({ edit: withCam([{ id: 'a', track: 'V1', at: 10, len: 30, asset: 'cam', in: 4 }]) });
    await edit({ op: 'clip.freeze', id: 'a', at: 10, len: 5 });
    expect(clip('a-hold')).toMatchObject({ at: 10, len: 5, in: 4 });
    expect(clip('a')).toMatchObject({ at: 15, len: 30, in: 4 });
  });
  it('collapses the hold keyframes to the value at the frozen moment', async () => {
    const { edit, clip } = makeProject({ edit: withCam([{ id: 'a', track: 'V1', at: 0, len: 100, asset: 'cam', x: [[0, 0], [100, 1000]], fx: [{ type: 'blur', radius: [[0, 0], [100, 50]] }] }]) });
    await edit({ op: 'clip.freeze', id: 'a', at: 50, len: 10 });
    expect(clip('a-hold').x).toBe(500);
    expect(clip('a-hold').fx![0]!.radius).toBe(25);
    // the tail keeps its motion continuous
    expect(interpolate(clip('a-2').x as never, 0)).toBe(500);
  });
  it('refuses on a locked clip', async () => {
    const { edit } = makeProject({ edit: withCam([{ id: 'a', track: 'V1', at: 0, len: 100, asset: 'cam', locked: true }]) });
    await expect(edit({ op: 'clip.freeze', id: 'a', at: 50, len: 10 }, true)).rejects.toMatchObject({ code: 'E_LOCKED' });
  });
});

describe('frame-exact cuts', () => {
  it('refuses a split between source frames at fractional speed, and keeps content at an exact one', async () => {
    const { edit, project } = makeProject({ edit: withCam([{ id: 'a', track: 'V1', at: 0, len: 20, asset: 'cam', speed: '1/2' }]) });
    await expect(edit({ op: 'clip.split', id: 'a', at: 3 }, true)).rejects.toMatchObject({ code: 'E_RANGE', fix: expect.stringContaining('2 or 4') });
    const before = Array.from({ length: 20 }, (_v, f) => shown(project.data.clips!, 'V1', f));
    await edit({ op: 'clip.split', id: 'a', at: 4 });
    expect(Array.from({ length: 20 }, (_v, f) => shown(project.data.clips!, 'V1', f))).toEqual(before);
  });
  it('splits a nested comp at another rate in child frames', async () => {
    const { edit, clip } = makeProject({ edit: (p) => {
      p.comps.push({ id: 'kid', size: [100, 100], fps: 60, length: 600 });
      p.clips = [{ id: 'n', track: 'V1', at: 0, len: 100, comp: 'kid' }];
    } });
    await edit({ op: 'clip.split', id: 'n', at: 30 });
    expect(clip('n-2')).toMatchObject({ at: 30, in: 60 });
  });
});

describe('roll / slide / trim at the source edge', () => {
  const base = withCam([
    { id: 'a', track: 'V1', at: 0, len: 20, asset: 'cam' },
    { id: 'b', track: 'V1', at: 20, len: 20, asset: 'cam', in: 2 },
  ]);
  it('roll refuses instead of shifting the next clip\'s content', async () => {
    const { edit } = makeProject({ edit: base });
    await expect(edit({ op: 'clip.roll', id: 'a', by: -5 }, true)).rejects.toMatchObject({ code: 'E_RANGE', fix: expect.stringContaining('earliest start of "b" is 18') });
    await expect(edit({ op: 'clip.roll', id: 'a', by: -2 })).resolves.toMatchObject({ ok: true });
  });
  it('slide refuses when the next clip has no source before it', async () => {
    const { edit } = makeProject({ edit: withCam([
      { id: 'a', track: 'V1', at: 0, len: 20, asset: 'cam' },
      { id: 'm', track: 'V1', at: 20, len: 10, asset: 'cam' },
      { id: 'b', track: 'V1', at: 30, len: 20, asset: 'cam' },
    ]) });
    await expect(edit({ op: 'clip.slide', id: 'm', by: -5 }, true)).rejects.toMatchObject({ code: 'E_RANGE' });
  });
  it('trim computes the earliest start with the speed', async () => {
    const { edit, clip } = makeProject({ edit: withCam([{ id: 'a', track: 'V1', at: 100, len: 20, asset: 'cam', in: 10, speed: 2 }]) });
    await expect(edit({ op: 'clip.trim', id: 'a', start: 94 }, true)).rejects.toMatchObject({ code: 'E_RANGE', fix: expect.stringContaining('earliest start of "a" is 95') });
    await edit({ op: 'clip.trim', id: 'a', start: 95 });
    expect(clip('a')).toMatchObject({ at: 95, len: 25, in: 0 });
  });
});

describe('locks', () => {
  it('slip, speed, roll and slide respect locked clips (including neighbours)', async () => {
    const { edit } = makeProject({ edit: withCam([
      { id: 'a', track: 'V1', at: 0, len: 20, asset: 'cam', in: 10, locked: true },
      { id: 'b', track: 'V1', at: 20, len: 20, asset: 'cam', in: 10 },
    ]) });
    for (const cmd of [{ op: 'clip.slip', id: 'a', by: 2 }, { op: 'clip.speed', id: 'a', speed: 2 }, { op: 'clip.roll', id: 'a', by: 2 }, { op: 'clip.slide', id: 'b', by: 2 }]) {
      await expect(edit(cmd, true), cmd.op).rejects.toMatchObject({ code: 'E_LOCKED' });
    }
  });
});

describe('clip.remove ripple with link groups', () => {
  it('shifts the whole group by one amount (L-cut stays in sync)', async () => {
    const { edit, clip } = makeProject({ edit: withCam([
      { id: 'a', track: 'V1', at: 0, len: 100, asset: 'cam', link: 'A', muted: true },
      { id: 'aa', track: 'A1', at: 0, len: 120, asset: 'cam', link: 'A' },
      { id: 'b', track: 'V1', at: 100, len: 100, asset: 'cam', link: 'B', muted: true },
      { id: 'ba', track: 'A1', at: 120, len: 80, asset: 'cam', link: 'B' },
    ]) });
    await edit({ op: 'clip.remove', id: 'a', ripple: true });
    expect(clip('b').at).toBe(0);
    expect(clip('ba').at).toBe(20);
  });
});

describe('clip.nest and clip.detach-audio integrity', () => {
  it('nests linked clips together, dedupes ids', async () => {
    const { edit, project, clip } = makeProject({ edit: withCam([{ id: 'a', track: 'V1', at: 30, len: 10, asset: 'cam' }]) });
    await edit({ op: 'clip.detach-audio', id: 'a' });
    const r = await edit({ op: 'clip.nest', ids: ['a', 'a'] });
    const nc = clip(r.out[0]!.id as string);
    expect(nc).toMatchObject({ at: 30, len: 10 });
    const nestTracks = new Set(project.data.tracks!.filter((t) => t.comp === nc.comp).map((t) => t.id));
    expect(nestTracks.has(clip('a').track) && nestTracks.has(clip('a-audio').track)).toBe(true);
  });
  it('unlinked=true leaves the partner outside and unlinks it', async () => {
    const { edit, clip } = makeProject({ edit: withCam([{ id: 'a', track: 'V1', at: 30, len: 10, asset: 'cam' }]) });
    await edit({ op: 'clip.detach-audio', id: 'a' });
    await edit({ op: 'clip.nest', ids: ['a'], unlinked: true });
    expect(clip('a').link).toBeUndefined();
    expect(clip('a-audio')).toMatchObject({ track: 'A1', at: 30 });
    expect(clip('a-audio').link).toBeUndefined();
  });
  it('puts the comp clip of an audio-only nest on a free visual track', async () => {
    const { edit, clip } = makeProject({ edit: withCam([
      { id: 'shot', track: 'V1', at: 0, len: 100, asset: 'cam' },
      { id: 'title', track: 'T1', at: 0, len: 100, text: 'Hi' },
      { id: 'vo', track: 'A1', at: 10, len: 50, asset: 'music' },
    ]) });
    const r = await edit({ op: 'clip.nest', ids: ['vo'] });
    const nc = clip(r.out[0]!.id as string);
    expect(['V1', 'T1']).not.toContain(nc.track);
    expect(nc).toMatchObject({ at: 10, len: 50 });
  });
  it('refuses a second detach-audio', async () => {
    const { edit } = makeProject({ edit: withCam([{ id: 'a', track: 'V1', at: 0, len: 10, asset: 'cam' }]) });
    await edit({ op: 'clip.detach-audio', id: 'a' });
    await expect(edit({ op: 'clip.detach-audio', id: 'a', track: 'A2' }, true)).rejects.toMatchObject({ code: 'E_ARG', message: expect.stringContaining('already detached') });
  });
});

describe('comp.set fps', () => {
  it('keeps adjacent clips adjacent and rescales effect, trim and animate timings', async () => {
    const { edit, clip } = makeProject({ edit: withCam([
      { id: 'a', track: 'V1', at: 1, len: 2, asset: 'cam' },
      { id: 'b', track: 'V1', at: 3, len: 10, asset: 'cam' },
      { id: 't', track: 'T1', at: 0, len: 60, text: 'Hi', animate: { in: 'fade', stagger: 6, len: 10 }, fx: [{ type: 'blur', radius: [[0, 0], [60, 10]] }] },
      { id: 's', track: 'T1', at: 60, len: 30, shape: { type: 'rect', size: [10, 10], trim: [[0, 0], [30, 1]] } },
    ]) });
    await edit({ op: 'comp.set', id: 'main', fps: 24 });
    expect(clip('a').at + clip('a').len).toBe(clip('b').at);
    await edit({ op: 'comp.set', id: 'main', fps: 48 });
    expect(clip('t').fx![0]!.radius).toEqual([[0, 0], [96, 10]]);
    expect(clip('t').animate).toMatchObject({ stagger: 10, len: 16 });
    expect(clip('s').shape!.trim).toEqual([[0, 0], [48, 1]]);
  });
  it('leaves a nested comp clip\'s child-frame in alone and rescales parents that nest the comp', async () => {
    const { edit, clip } = makeProject({ edit: (p) => {
      p.comps.push({ id: 'kid', size: [100, 100], fps: 30, length: 300 });
      p.tracks!.push({ id: 'K1', comp: 'kid' });
      p.comps.push({ id: 'grand', size: [100, 100], fps: 30, length: 300 });
      p.tracks!.push({ id: 'G1', comp: 'grand' });
      p.clips = [
        { id: 'n', track: 'V1', at: 0, len: 60, comp: 'kid', in: 30 },
        { id: 'g', track: 'K1', at: 0, len: 60, comp: 'grand', in: 15 },
      ];
    } });
    await edit({ op: 'comp.set', id: 'kid', fps: 60 });
    expect(clip('n')).toMatchObject({ in: 60, len: 60 });
    expect(clip('g')).toMatchObject({ in: 15, len: 120 });
  });
});

describe('fx.add with a plugin that did not load', () => {
  it('names the plugin problem instead of listing built-ins', async () => {
    const { edit } = makeProject({
      services: { pluginProblems: [{ code: 'E_PLUGIN_LOAD', severity: 'error', message: 'plugin "film-tint" failed to load from plugins/film-tint/src/index.ts: boom', fix: 'fix the import error', path: 'project.plugins.film-tint' }] },
      edit: withCam([{ id: 'bg', track: 'V1', at: 0, len: 10, asset: 'cam' }], (p) => { p.project = { plugins: { 'film-tint': '^0.1.0' } }; }),
    });
    await expect(edit({ op: 'fx.add', id: 'bg', type: 'film-tint', amount: 0.4 }, true)).rejects.toMatchObject({ code: 'E_PLUGIN_LOAD', message: expect.stringContaining('boom'), fix: 'fix the import error' });
    // a typo of a built-in still gets did-you-mean
    await expect(edit({ op: 'fx.add', id: 'bg', type: 'blurr' }, true)).rejects.toMatchObject({ code: 'E_UNKNOWN_EFFECT' });
  });
  it('without plugin problems wired, says the listed plugin is not loaded', async () => {
    const { edit } = makeProject({ edit: withCam([{ id: 'bg', track: 'V1', at: 0, len: 10, asset: 'cam' }], (p) => { p.project = { plugins: { 'film-tint': '^0.1.0' } }; }) });
    await expect(edit({ op: 'fx.add', id: 'bg', type: 'film-tint' }, true)).rejects.toMatchObject({ message: expect.stringContaining('project plugin "film-tint"'), fix: expect.stringContaining('mgl plugin list') });
  });
});
