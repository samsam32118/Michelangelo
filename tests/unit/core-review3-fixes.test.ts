// @vitest-environment node
/** Regression tests (review 3, core commands): punch-in base y on captions, track.move self-reference, clip.sequence handle notes. */
import { describe, it, expect } from 'vitest';
import type { ProbeInfo } from '../../src/core/commands/index.js';
import { makeProject } from './commands-fixtures.js';

const probe = (info: Record<string, Partial<ProbeInfo>>) => async (src: string): Promise<ProbeInfo> => ({ kind: 'video', hasAudio: true, ...info[src] } as ProbeInfo);

describe('clip.punch-in on a captions clip', () => {
  it('starts from the captions default y (0.68H vertical), not H/2', async () => {
    const { edit, clip } = makeProject({ size: [1080, 1920], edit: (p) => {
      p.clips = [{ id: 'cap', track: 'T1', at: 0, len: 300, captions: true }];
    } });
    await edit({ op: 'clip.punch-in', id: 'cap', box: [270, 480, 540, 960], at: 30, len: 15 });
    const y = clip('cap').y as [number, number, string?][];
    expect(y[0]![1]).toBe(Math.round(1920 * 0.68)); // 1306
  });
  it('uses 0.85H on a landscape comp', async () => {
    const { edit, clip } = makeProject({ size: [1920, 1080], edit: (p) => {
      p.comps[0]!.size = [1920, 1080];
      p.clips = [{ id: 'cap', track: 'T1', at: 0, len: 300, captions: true }];
    } });
    await edit({ op: 'clip.punch-in', id: 'cap', box: [480, 270, 960, 540], at: 30, len: 15 });
    expect((clip('cap').y as [number, number][])[0]![1]).toBe(Math.round(1080 * 0.85));
  });
});

describe('track.move reference checks', () => {
  it('refuses below=/above= the moved track itself and leaves the order alone', async () => {
    const { edit, project } = makeProject();
    const before = project.data.tracks!.map((t) => t.id);
    await expect(edit({ op: 'track.move', id: 'T1', below: 'T1' })).rejects.toMatchObject({ code: 'E_ARG' });
    await expect(edit({ op: 'track.move', id: 'T1', above: 'T1' })).rejects.toMatchObject({ code: 'E_ARG' });
    expect(project.data.tracks!.map((t) => t.id)).toEqual(before);
  });
  it('refuses a reference track in another comp', async () => {
    const { edit } = makeProject({ edit: (p) => {
      p.comps.push({ id: 'inner', size: [1080, 1920], fps: 30, length: 90 } as never);
      p.tracks!.push({ id: 'IV1', comp: 'inner' });
    } });
    await expect(edit({ op: 'track.move', id: 'T1', below: 'IV1' })).rejects.toMatchObject({ code: 'E_ARG' });
  });
  it('still moves relative to another track', async () => {
    const { edit, project } = makeProject();
    await edit({ op: 'track.move', id: 'T1', below: 'V1' });
    expect(project.data.tracks!.map((t) => t.id).slice(0, 2)).toEqual(['T1', 'V1']);
  });
});

describe('clip.sequence transition handles', () => {
  it('notes the held first frames of incoming clips (in=0)', async () => {
    const { edit } = makeProject({ services: { probe: probe({}) } });
    const r = await edit({ op: 'clip.sequence', srcs: ['a.mp4', 'b.mp4'], len: '2s', transition: { type: 'crossfade', len: 15 } });
    const notes = r.notes.join(' ');
    expect(notes).toMatch(/first frame of "b[^"]*" is held for 8 frame/);
    expect(notes).not.toMatch(/last frame/);
  });
  it('with full=true also notes the held last frames of outgoing clips', async () => {
    const { edit } = makeProject({ services: { probe: probe({ 'a.mp4': { duration: 4 }, 'b.mp4': { duration: 3 } }) } });
    const r = await edit({ op: 'clip.sequence', srcs: ['a.mp4', 'b.mp4'], full: true, transition: { type: 'crossfade', len: 15 } });
    const notes = r.notes.join(' ');
    expect(notes).toMatch(/first frame of "b[^"]*" is held for 8 frame/);
    expect(notes).toMatch(/full=true.*last frame of "a[^"]*" is held for 7 frame/);
  });
  it('says nothing about handles for stills or without a transition', async () => {
    const { edit } = makeProject({ services: { probe: probe({}) } });
    const r = await edit({ op: 'clip.sequence', srcs: ['a.png', 'b.png'], len: '2s', transition: { type: 'crossfade', len: 15 } });
    expect(r.notes.join(' ')).not.toMatch(/held/);
    const { edit: e2 } = makeProject({ services: { probe: probe({}) } });
    const r2 = await e2({ op: 'clip.sequence', srcs: ['a.mp4', 'b.mp4'], len: '2s' });
    expect(r2.notes.join(' ')).not.toMatch(/held/);
  });
});
