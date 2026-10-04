import { describe, it, expect, vi } from 'vitest';
import { makeProject } from './commands-fixtures.js';
import type { ProjectFile } from '../../src/core/schema/index.js';
import type { AudioAnalysis } from '../../src/core/commands/index.js';

const base = (p: ProjectFile) => {
  p.assets = [{ id: 'cam', src: 'cam.mp4' }, { id: 'bed', src: 'bed.mp3' }];
  p.clips = [
    { id: 'v', track: 'V1', at: 0, len: 300, asset: 'cam', in: 30, link: 'g', muted: true },
    { id: 'next', track: 'V1', at: 300, len: 60, color: '#000000' },
    { id: 'title', track: 'T1', at: 0, len: 60, text: 'Hi' },
    { id: 'a', track: 'A1', at: 0, len: 300, asset: 'cam', in: 30, link: 'g' },
    { id: 'bedclip', track: 'A2', at: 0, len: 600, asset: 'bed' },
  ];
};

describe('buses', () => {
  it('adds and changes buses; null removes settings; built-in buses get an entry on demand', async () => {
    const { edit, project } = makeProject({ edit: base });
    await edit({ op: 'bus.add', id: 'vo2', to: 'dialogue', gain: -3 });
    await edit({ op: 'bus.set', id: 'music', gain: -8, duck: { by: 'vo2', db: 6 } });
    expect(project.data.buses).toEqual([{ id: 'vo2', to: 'dialogue', gain: -3 }, { id: 'music', gain: -8, duck: { by: 'vo2', db: 6 } }]);
    await edit({ op: 'bus.set', id: 'music', duck: null, gain: null, muted: true });
    expect(project.data.buses![1]).toEqual({ id: 'music', muted: true });
    await expect(edit({ op: 'bus.add', id: 'vo2' })).rejects.toMatchObject({ code: 'E_DUPLICATE_ID', fix: expect.stringMatching(/bus.set/) });
    const e = await edit({ op: 'bus.set', id: 'musik', gain: 1 }).catch((x) => x);
    expect(e).toMatchObject({ code: 'E_REF', didYouMean: ['music'] });
    await expect(edit({ op: 'bus.add', id: 'title' })).rejects.toMatchObject({ code: 'E_DUPLICATE_ID', fix: expect.stringMatching(/id.rename title/) });
    await expect(edit({ op: 'bus.add', id: 'x', to: 'nowhere' })).rejects.toMatchObject({ code: 'E_REF', fix: expect.stringMatching(/bus.add/) });
  });
  it('ducks music under dialogue by default and normalises to the platform target', async () => {
    const { edit, project } = makeProject({ edit: base });
    await edit({ op: 'audio.duck' });
    expect(project.data.buses).toEqual([{ id: 'music', duck: { by: 'dialogue', db: 9 } }]);
    await edit({ op: 'audio.normalize' });
    expect(project.data.buses![1]).toEqual({ id: 'master', loudness: { lufs: -16, peak: -1 } });
    await edit({ op: 'project.set', platform: 'shorts' });
    await edit({ op: 'audio.normalize', peak: -2 });
    expect(project.data.buses![1]!.loudness).toEqual({ lufs: -14, peak: -2 });
    await expect(edit({ op: 'audio.duck', bus: 'music', by: 'music' })).rejects.toMatchObject({ code: 'E_ARG' });
  });
});

describe('audio.fade and audio.gain', () => {
  it('sets fades and gain (constant or keyframed)', async () => {
    const { edit, clip } = makeProject({ edit: base });
    await edit({ op: 'audio.fade', id: 'bedclip', in: '1s', out: 60 });
    expect(clip('bedclip').fade).toEqual([30, 60]);
    await edit({ op: 'audio.fade', id: 'bedclip', in: 0 });
    expect(clip('bedclip').fade).toEqual([0, 60]);
    await expect(edit({ op: 'audio.fade', id: 'title', in: 40, out: 40 })).rejects.toMatchObject({ code: 'E_RANGE', fix: expect.stringMatching(/≤ 60/) });
    await edit({ op: 'audio.gain', id: 'bedclip', db: -6 });
    expect(clip('bedclip').gain).toBe(-6);
    await edit({ op: 'audio.gain', id: 'bedclip', db: -20, at: '2s' });
    expect(clip('bedclip').gain).toEqual([[0, -6], [60, -20]]);
    await expect(edit({ op: 'audio.gain', id: 'bedclip', db: 0 })).rejects.toMatchObject({ code: 'E_KEYFRAMED', fix: expect.stringMatching(/key.clear/) });
    await expect(edit({ op: 'audio.gain', id: 'title', db: 0 })).rejects.toMatchObject({ code: 'E_NOT_AUDIO' });
  });
});

describe('audio.cut-silences', () => {
  const silences: AudioAnalysis = { duration: 20, silences: [{ start: 0, end: 1.5 }, { start: 2, end: 4 }, { start: 6, end: 6.3 }, { start: 9, end: 12 }] };
  it('ripple-removes padded silent ranges from the clip and its linked clips', async () => {
    const analyzeAudio = vi.fn(async () => silences);
    const { edit, project, clip } = makeProject({ edit: base, services: { analyzeAudio } });
    const dry = await edit({ op: 'audio.cut-silences', id: 'a', pad: 6 }, true);
    expect(dry.out[0]!.removed).toEqual([[0, 9], [36, 84], [246, 300]]);
    expect(clip('a').len).toBe(300);
    const r = await edit({ op: 'audio.cut-silences', id: 'a', pad: 6 });
    expect(analyzeAudio).toHaveBeenCalledWith('cam.mp4', { silenceDb: -40, minSilence: 0.6 });
    expect(r.out[0]).toEqual({ removed: [[0, 9], [36, 84], [246, 300]], seconds: 3.7 });
    expect(r.summary.join(' ')).toMatch(/removed 3.70s/);
    const on = (t: string) => project.data.clips!.filter((c) => c.track === t).sort((x, y) => x.at - y.at).map((c) => [c.at, c.len, c.in]);
    expect(on('V1')).toEqual([[0, 27, 39], [27, 162, 114], [189, 60, undefined]]);
    expect(on('A1')).toEqual([[0, 27, 39], [27, 162, 114]]);
    expect(on('A2')).toEqual([[0, 600, undefined]]);
    expect(project.data.clips!.filter((c) => c.link === 'g')).toHaveLength(4);
  });
  it('explains what is missing', async () => {
    const { edit } = makeProject({ edit: base });
    await expect(edit({ op: 'audio.cut-silences', id: 'a' })).rejects.toMatchObject({ code: 'E_NO_SERVICE', fix: expect.stringMatching(/CLI|SDK/) });
    const { edit: edit2 } = makeProject({ edit: base, services: { analyzeAudio: async () => silences } });
    await expect(edit2({ op: 'audio.cut-silences', id: 'title' })).rejects.toMatchObject({ code: 'E_NOT_AUDIO' });
    const r = await edit2({ op: 'audio.cut-silences', id: 'bedclip', min: '5s' });
    expect(r.summary.join(' ')).toMatch(/no silences/);
  });
});
