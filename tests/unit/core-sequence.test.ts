/** marker.beats and clip.sequence. */
import { describe, it, expect } from 'vitest';
import { makeProject } from './commands-fixtures.js';
import { getCommand } from '../../src/core/commands/index.js';
import type { ProjectFile } from '../../src/core/schema/index.js';

// beats every 0.5 s from 0.25 s (15 frames at 30 fps, first at frame 7.5 → 8)
const beats = Array.from({ length: 40 }, (_v, i) => 1 + i * 0.5);
const services = { analyzeAudio: async () => ({ duration: 30, silences: [], beats, bpm: 120 }) };
const withMusic = (extra: (p: ProjectFile) => void = () => {}) => (p: ProjectFile) => {
  p.assets = [{ id: 'song', src: 'song.mp3' }, { id: 'cam', src: 'cam.mp4' }];
  p.clips = [{ id: 'bed', track: 'A2', at: 30, len: 150, asset: 'song', in: 60 }];
  extra(p);
};

describe('marker.beats', () => {
  it('adds markers at the beats inside the used source range, mapped to comp frames', async () => {
    const { edit, project } = makeProject({ services, edit: withMusic() });
    const r = await edit({ op: 'marker.beats', clip: 'bed' });
    // source 2s..7s (frames 60..210) plays at comp 30..180; beats at 2, 2.5, ... 6.5 s
    expect(r.out[0]!.frames).toEqual([30, 45, 60, 75, 90, 105, 120, 135, 150, 165]);
    expect(project.data.markers!.map((m) => m.id).slice(0, 3)).toEqual(['beat1', 'beat2', 'beat3']);
    expect(r.out[0]!.bpm).toBe(120);
  });
  it('every, max, min and re-running replace', async () => {
    const { edit, project } = makeProject({ services, edit: withMusic() });
    await edit({ op: 'marker.beats', clip: 'bed', every: 2, max: 3 });
    expect(project.data.markers!.map((m) => m.at)).toEqual([30, 60, 90]);
    await edit({ op: 'marker.beats', clip: 'bed', every: 4 });
    expect(project.data.markers!.map((m) => m.at)).toEqual([30, 90, 150]);
    await expect(edit({ op: 'marker.beats', clip: 'bed', min: 50 }, true)).rejects.toMatchObject({ code: 'E_NO_BEATS' });
  });
  it('respects speed', async () => {
    const { edit } = makeProject({ services, edit: withMusic((p) => { p.clips![0]!.speed = 2; p.clips![0]!.len = 75; }) });
    const r = await edit({ op: 'marker.beats', clip: 'bed' });
    expect((r.out[0]!.frames as number[]).slice(0, 3)).toEqual([30, 38, 45]);
  });
  it('refuses a non-media clip', async () => {
    const { edit } = makeProject({ services, edit: withMusic((p) => p.clips!.push({ id: 't', track: 'T1', at: 0, len: 10, text: 'x' })) });
    await expect(edit({ op: 'marker.beats', clip: 't' }, true)).rejects.toMatchObject({ code: 'E_ARG' });
  });
});

describe('clip.sequence', () => {
  it('places items back to back, adding assets as needed', async () => {
    const { edit, project } = makeProject({ services, edit: withMusic() });
    const r = await edit({ op: 'clip.sequence', srcs: ['a.mp4', 'cam.mp4', 'b.png'], len: '1s', fit: 'cover', transition: { type: 'crossfade', len: 6 } });
    const ids = r.out[0]!.ids as string[];
    const cl = ids.map((id) => project.data.clips!.find((c) => c.id === id)!);
    expect(cl.map((c) => [c.track, c.at, c.len, c.asset])).toEqual([['V1', 0, 30, 'a'], ['V1', 30, 30, 'cam'], ['V1', 60, 30, 'b']]);
    expect(cl[0]!.transition).toBeUndefined();
    expect(cl[1]).toMatchObject({ fit: 'cover', transition: { in: { type: 'crossfade', len: 6 } } });
    expect(project.data.assets!.map((a) => a.id)).toEqual(['song', 'cam', 'a', 'b']);
  });
  it('cuts on markers: each item lasts until the next marker, the last the median interval', async () => {
    const { edit, project } = makeProject({ services, edit: withMusic() });
    await edit({ op: 'marker.beats', clip: 'bed', every: 2 });
    const r = await edit({ op: 'clip.sequence', assets: ['cam', 'cam', 'cam'], on: 'markers' });
    const cl = (r.out[0]!.ids as string[]).map((id) => project.data.clips!.find((c) => c.id === id)!);
    expect(cl.map((c) => [c.at, c.len])).toEqual([[30, 30], [60, 30], [90, 30]]);
  });
  it('cuts on the beats of a clip; extra items continue at the median interval', async () => {
    const { edit, project } = makeProject({ services, edit: withMusic((p) => { p.clips![0]!.len = 40; }) });
    const r = await edit({ op: 'clip.sequence', assets: ['cam', 'cam', 'cam', 'cam'], on: 'beats', clip: 'bed' });
    const cl = (r.out[0]!.ids as string[]).map((id) => project.data.clips!.find((c) => c.id === id)!);
    expect(cl.map((c) => [c.at, c.len])).toEqual([[30, 15], [45, 15], [60, 15], [75, 15]]);
    expect(r.notes.join(' ')).toContain('median');
  });
  it('refuses overlaps with a fix', async () => {
    const { edit } = makeProject({ services, edit: withMusic((p) => p.clips!.push({ id: 'x', track: 'V1', at: 40, len: 10, asset: 'cam' })) });
    await expect(edit({ op: 'clip.sequence', assets: ['cam', 'cam'], len: '1s' }, true)).rejects.toMatchObject({ code: 'E_OVERLAP', fix: expect.stringContaining('at=50') });
  });
  it('needs exactly one of srcs/assets, and clip= for on=beats', async () => {
    const { edit } = makeProject({ services, edit: withMusic() });
    await expect(edit({ op: 'clip.sequence', len: '1s' }, true)).rejects.toMatchObject({ code: 'E_ARG' });
    await expect(edit({ op: 'clip.sequence', assets: ['cam'], on: 'beats' }, true)).rejects.toMatchObject({ code: 'E_ARG' });
  });
  it('the documented examples run', async () => {
    const { edit } = makeProject({ services, edit: withMusic() });
    await edit({ op: 'marker.beats', ...getCommand('marker.beats').example });
    await expect(edit({ op: 'clip.sequence', ...getCommand('clip.sequence').example })).resolves.toMatchObject({ ok: true });
  });
});
