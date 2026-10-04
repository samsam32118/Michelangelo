import { describe, it, expect, vi } from 'vitest';
import { makeProject } from './commands-fixtures.js';
import type { ProjectFile } from '../../src/core/schema/index.js';

const base = (p: ProjectFile) => {
  p.tracks!.push({ id: 'V2', comp: 'main' });
  p.assets = [{ id: 'cam', src: 'cam.mp4' }];
  p.clips = [
    { id: 'shot', track: 'V1', at: 0, len: 90, asset: 'cam', link: 'g' },
    { id: 'shot-a', track: 'A1', at: 0, len: 90, asset: 'cam', link: 'g' },
    { id: 'title', track: 'T1', at: 0, len: 90, text: 'Hello world', style: { size: 100 }, x: 1700, y: 540, scale: [[0, 0.5], [10, 1]] },
    { id: 'head', track: 'T1', at: 90, len: 60, text: 'A very long headline that will not fit', style: 'title' },
    { id: 'word', track: 'T1', at: 150, len: 30, text: 'Supercalifragilistic', style: { size: 160 } },
    { id: 'dot', track: 'V2', at: 0, len: 90, shape: { type: 'rect', size: [200, 200] }, x: 1900, y: 100, parent: 'title' },
    { id: 'box', track: 'V2', at: 90, len: 90, shape: { type: 'rect', size: [200, 200] }, x: 1900, y: 100 },
  ];
  p.markers = [{ id: 'drop', comp: 'main', at: 45 }];
};

describe('comp.reframe', () => {
  it('copies a 1920x1080 comp to 1080x1920 with to=, keeping the original intact and text inside the frame', async () => {
    const { edit, project, clip } = makeProject({ size: [1920, 1080], edit: base });
    const before = structuredClone(project.data);
    const r = await edit({ op: 'comp.reframe', id: 'main', preset: 'shorts', to: 'vert' });
    expect(r.out[0]).toMatchObject({ id: 'vert' });
    // the original is untouched
    for (const t of ['comps', 'tracks', 'clips', 'markers'] as const) for (const e of before[t]!) expect(project.data[t]!.find((x) => x.id === e.id)).toEqual(e);
    expect(project.data.comps.find((c) => c.id === 'vert')!.size).toEqual([1080, 1920]);
    expect(project.data.tracks!.filter((t) => t.comp === 'vert').map((t) => t.id)).toEqual(['vert-V1', 'vert-T1', 'vert-A1', 'vert-A2', 'vert-V2']);
    expect(project.data.markers!.find((m) => m.comp === 'vert')).toMatchObject({ id: 'vert-drop', at: 45 });
    // media fills the frame; links and parents point inside the copy
    expect(clip('vert-shot')).toMatchObject({ fit: 'cover', link: 'vert-g', track: 'vert-V1' });
    expect(clip('vert-shot-a').link).toBe('vert-g');
    expect(clip('vert-dot').parent).toBe('vert-title');
    // text: x scaled (1700 → 956), then pulled inside the safe area; y scaled
    const t = clip('vert-title');
    const w = 'Hello world'.length * 100 * 0.55;
    expect(t.x as number).toBeGreaterThanOrEqual(w / 2);
    expect(t.x as number).toBeLessThanOrEqual(1080 - w / 2);
    expect(t.y).toBe(960);
    // a long line wraps at ≤ 90 % of the width; a long word shrinks the font
    expect(clip('vert-head').style).toEqual({ base: 'title', maxWidth: 972 });
    const ws = clip('vert-word').style as { size: number; maxWidth: number };
    expect(ws.size).toBeLessThan(160);
    expect('Supercalifragilistic'.length * ws.size * 0.55).toBeLessThanOrEqual(972);
    // shapes leaving the frame are pulled in; parented ones keep their (relative) position
    expect(clip('vert-box').x).toBeLessThanOrEqual(1080 - 100);
    expect(clip('vert-box').y).toBe(178);
    expect(clip('vert-dot').x).toBe(1069);
  });

  it('reframes in place', async () => {
    const { edit, project, clip } = makeProject({ size: [1920, 1080], edit: base });
    await edit({ op: 'comp.reframe', id: 'main', size: [1080, 1080] });
    expect(project.data.comps[0]!.size).toEqual([1080, 1080]);
    expect(project.data.comps).toHaveLength(1);
    expect(clip('title').y).toBe(540);
    expect(clip('shot').fit).toBe('cover');
  });

  it('follows the subject with smoothed x keyframes from motion tracking', async () => {
    const trackMotion = vi.fn(async () => Array.from({ length: 18 }, (_, i) => ({ frame: i * 5, x: 0.3 + (0.4 * i) / 17, y: 0.5 })));
    const probe = vi.fn(async () => ({ kind: 'video' as const, width: 1920, height: 1080, duration: 10 }));
    const { edit, clip } = makeProject({ size: [1920, 1080], edit: base, services: { trackMotion, probe } });
    const r = await edit({ op: 'comp.reframe', id: 'main', preset: 'shorts', to: 'vert', track: true });
    expect(trackMotion).toHaveBeenCalledWith('cam.mp4', expect.objectContaining({ fps: 6, inFrames: 0, lenFrames: 90 }));
    expect(r.out[0]).toMatchObject({ tracked: 'vert-shot' });
    const x = clip('vert-shot').x as [number, number][];
    expect(x.map((k) => k[0])).toEqual(Array.from({ length: 18 }, (_, i) => i * 5));
    expect(x.every((k) => k.length === 2)).toBe(true);
    // the subject moves right, so the media moves left; the media always covers the frame
    const sw = 1920 * (1920 / 1080);
    for (let i = 1; i < x.length; i++) expect(x[i]![1]).toBeLessThanOrEqual(x[i - 1]![1]);
    for (const [, v] of x) { expect(v - sw / 2).toBeLessThanOrEqual(0); expect(v + sw / 2).toBeGreaterThanOrEqual(1080); }
    // the subject (x = 0.3 at the start) sits near the frame centre
    const first = x[0]![1] + (0.3 + 0.4 * (1 / 17) - 0.5) * sw;
    expect(Math.abs(first - 540)).toBeLessThan(5);
    expect(clip('vert-shot').y).toBeUndefined();
    expect(clip('shot').x).toBeUndefined();
  });

  it('explains errors with a fix', async () => {
    const { edit } = makeProject({ size: [1920, 1080], edit: base });
    await expect(edit({ op: 'comp.reframe', id: 'main' })).rejects.toMatchObject({ code: 'E_ARG', fix: expect.stringMatching(/preset=shorts/) });
    await expect(edit({ op: 'comp.reframe', id: 'main', preset: 'shorts', to: 'main' })).rejects.toMatchObject({ code: 'E_DUPLICATE_ID' });
    await expect(edit({ op: 'comp.reframe', id: 'main', preset: 'shorts', track: true })).rejects.toMatchObject({ code: 'E_NO_SERVICE', fix: expect.stringMatching(/track=true/) });
    await expect(edit({ op: 'comp.reframe', id: 'main', preset: 'shorts', track: true, subject: 'title' })).rejects.toMatchObject({ code: 'E_ARG', fix: expect.stringMatching(/shot/) });
  });
});
