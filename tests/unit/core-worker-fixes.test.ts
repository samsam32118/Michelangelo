/** Regression tests: track order, track choice, id.rename scoping, new layout commands, animated masks, shape trims, gen.asset, fx stages. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Project, emptyProject } from '../../src/sdk/project.js';
import { formatProject } from '../../src/core/format.js';
import { parseProjectText, normaliseAndValidate } from '../../src/core/load.js';
import { applyPatch, diffProjects, getCommand, invertPatch, runCommand, type Catalog, type ProbeInfo } from '../../src/core/commands/index.js';
import { kvCommand } from '../../src/cli/kv.js';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { fakeCatalog, makeProject } from './commands-fixtures.js';

function onDisk(d: ProjectFile): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'mgl-cw-')), 'p.mgl.json');
  writeFileSync(file, formatProject(d));
  return file;
}
const trackOrder = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as ProjectFile).tracks!.map((t) => t.id);

describe('track.move persists the new order (1)', () => {
  it('saves, records history, and undoes/redoes the reorder', async () => {
    const file = onDisk(emptyProject({ length: 900 }));
    const p = await Project.open(file);
    await p.edit({ op: 'track.add', id: 'X' });
    expect(trackOrder(file)).toEqual(['V1', 'T1', 'A1', 'A2', 'X']);
    const r = await p.edit({ op: 'track.move', id: 'X', to: 'bottom' });
    expect(r.changes).toEqual([expect.objectContaining({ kind: 'change', table: 'tracks', id: 'X' })]);
    expect(trackOrder(file)).toEqual(['X', 'V1', 'T1', 'A1', 'A2']);
    await p.edit({ op: 'track.move', id: 'V1', above: 'T1' });
    expect(trackOrder(file)).toEqual(['X', 'T1', 'V1', 'A1', 'A2']);
    const q = await Project.open(file);
    await q.undo();
    expect(trackOrder(file)).toEqual(['X', 'V1', 'T1', 'A1', 'A2']);
    await q.undo();
    expect(trackOrder(file)).toEqual(['V1', 'T1', 'A1', 'A2', 'X']);
    await q.redo(2);
    expect(trackOrder(file)).toEqual(['X', 'T1', 'V1', 'A1', 'A2']);
  });
  it('diff/apply/invert round-trips arbitrary reorders with adds, removes and changes', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 200; n++) {
      const a = emptyProject();
      a.tracks = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, comp: 'main' }));
      const b = structuredClone(a);
      b.tracks = b.tracks!.filter(() => rnd() > 0.2).sort(() => rnd() - 0.5);
      if (rnd() > 0.5) b.tracks.splice(Math.floor(rnd() * b.tracks.length), 0, { id: `new${n}`, comp: 'main' });
      if (b.tracks.length && rnd() > 0.5) b.tracks[0]!.hidden = true;
      const patch = diffProjects(a, b);
      expect(applyPatch(a, patch).tracks!.map((t) => JSON.stringify(t))).toEqual(b.tracks.map((t) => JSON.stringify(t)));
      expect(applyPatch(b, invertPatch(patch)).tracks).toEqual(a.tracks);
    }
  });
});

describe('track.add takes its id as the bare word (2)', () => {
  it('fills id from the positional word', () => {
    expect(getCommand('track.add').primary).toBe('id');
    expect(kvCommand('track.add', ['A3', 'audio=true', 'bus=sfx'])).toEqual({ op: 'track.add', id: 'A3', audio: true, bus: 'sfx' });
  });
});

describe('a missing track: the fix offers track.add first (3)', () => {
  it('in commands', async () => {
    const { edit } = makeProject();
    const e = await edit({ op: 'clip.add', id: 'camB', track: 'V2', text: 'x' }).catch((x) => x);
    expect(e.code).toBe('E_REF');
    expect(e.fix).toMatch(/^add it: mgl edit <file> track\.add id=V2/);
    expect(e.fix).toMatch(/did you mean "V1"/);
    const a = await edit({ op: 'clip.move', id: 'nope', track: 'A3' }).catch((x) => x);
    expect(a.code).toBe('E_REF');
  });
  it('in the loader', () => {
    const d = emptyProject();
    d.clips = [{ id: 'c', track: 'V2', at: 0, len: 10, text: 'x' }];
    const e = (() => { try { normaliseAndValidate(structuredClone(d) as never); } catch (x) { return x as { problems: { fix: string }[] }; } })();
    expect(e!.problems[0]!.fix).toMatch(/^add the track: mgl edit <file> track\.add id=V2/);
    const raw = structuredClone(d) as unknown as { clips: { at: unknown }[] };
    raw.clips[0]!.at = '1s';
    const e2 = (() => { try { normaliseAndValidate(raw as never); } catch (x) { return x as { problems: { fix: string }[] }; } })();
    expect(e2!.problems[0]!.fix).toMatch(/^add the track: mgl edit <file> track\.add id=V2/);
  });
});

describe('clip.add track choice (4)', () => {
  it('after=<clip> uses that clip\'s track', async () => {
    const { edit, clip } = makeProject({ edit: (p) => { p.assets = [{ id: 'v1', src: 'v1.mp4' }]; p.clips = [{ id: 'day1', track: 'V1', at: 0, len: 90, asset: 'v1' }]; } });
    await edit({ op: 'clip.add', src: 'v2.mp4', id: 'day2', after: 'day1', len: 60 });
    expect(clip('day2')).toMatchObject({ track: 'V1', at: 90 });
  });
  it('never places an overlay under an opaque full-frame nested comp clip', async () => {
    const { edit, clip, project } = makeProject({ edit: (p) => {
      p.assets = [{ id: 'cam', src: 'cam.mp4' }];
      p.tracks!.splice(2, 0, { id: 'V2', comp: 'main' }, { id: 'V3', comp: 'main' });
      p.clips = [{ id: 'a', track: 'V1', at: 0, len: 90, asset: 'cam' }, { id: 'b', track: 'V1', at: 90, len: 90, asset: 'cam', in: 90 }];
    } });
    await edit({ op: 'clip.nest', ids: ['a', 'b'], id: 'cut' });
    const host = clip('cut-clip').track;
    const order = () => project.data.tracks!.filter((t) => t.comp === 'main' && !t.audio).map((t) => t.id);
    await edit({ op: 'clip.add', id: 'wm', text: 'DRAFT', at: 0, len: 180 });
    await edit({ op: 'clip.add', id: 'tc', gen: { type: 'counter' }, at: 0, len: 180 });
    for (const id of ['wm', 'tc']) expect(order().indexOf(clip(id).track)).toBeGreaterThan(order().indexOf(host));
    // a transparent overlay does not push later clips up: a clip can still go under text
    await edit({ op: 'clip.add', id: 'lt', text: 'lower third', at: 200, len: 30 });
    expect(order().indexOf(clip('lt').track)).toBeGreaterThanOrEqual(0);
  });
});

describe('id.rename only rewrites references of the renamed entity type (5)', () => {
  it('renaming a clip named like a bus leaves track.bus alone', async () => {
    const { edit, clip, project } = makeProject({ edit: (p) => { p.assets = [{ id: 'm', src: 'music.wav' }]; p.clips = [{ id: 'music', track: 'A2', at: 0, len: 30, asset: 'm' }]; } });
    await edit({ op: 'id.rename', id: 'music', to: 'music-bed' });
    expect(clip('music-bed').track).toBe('A2');
    expect(project.data.tracks!.find((t) => t.id === 'A2')!.bus).toBe('music');
    await edit({ op: 'bus.set', id: 'music', gain: -8 });
    expect(project.data.buses).toEqual([{ id: 'music', gain: -8 }]);
  });
  it('renaming an asset rewrites gen.asset (9)', async () => {
    const { edit, clip } = makeProject({ edit: (p) => { p.assets = [{ id: 'vo', src: 'vo.wav' }]; p.clips = [{ id: 'w', track: 'V1', at: 0, len: 30, gen: { type: 'waveform', asset: 'vo' } }]; } });
    await edit({ op: 'id.rename', id: 'vo', to: 'voice' });
    expect(clip('w').gen).toEqual({ type: 'waveform', asset: 'voice' });
    await expect(edit({ op: 'asset.remove', id: 'voice' })).rejects.toMatchObject({ code: 'E_IN_USE' });
  });
});

const probe = (sizes: Record<string, Partial<ProbeInfo>>) => async (src: string): Promise<ProbeInfo> => ({ kind: 'video', hasAudio: true, ...sizes[src] } as ProbeInfo);

describe('clip.duplicate (6)', () => {
  it('copies keyframes, effects and masks; places after the original; linked partners on request', async () => {
    const { edit, clip, project } = makeProject({ edit: (p) => {
      p.assets = [{ id: 'cam', src: 'cam.mp4' }];
      p.clips = [
        { id: 's', track: 'V1', at: 0, len: 60, asset: 'cam', link: 's', opacity: [[0, 0], [10, 1]], fx: [{ type: 'blur', radius: 4 }], masks: [{ shape: 'rect', box: [0, 0, 100, 100] }] },
        { id: 's-audio', track: 'A1', at: 0, len: 60, asset: 'cam', link: 's' },
      ];
    } });
    const r = await edit({ op: 'clip.duplicate', id: 's' });
    const id = r.out[0]!.id as string;
    expect(clip(id)).toMatchObject({ track: 'V1', at: 60, len: 60, opacity: [[0, 0], [10, 1]], fx: [{ type: 'blur', radius: 4 }], masks: [{ shape: 'rect', box: [0, 0, 100, 100] }] });
    expect(clip(id).link).toBeUndefined();
    const r2 = await edit({ op: 'clip.duplicate', id: 's', at: 120, newId: 's2', linked: true });
    expect(r2.out[0]!.created).toHaveLength(2);
    const copies = project.data.clips!.filter((c) => c.link === 's2');
    expect(copies.map((c) => [c.track, c.at])).toEqual([['V1', 120], ['A1', 120]]);
    // same time on another track
    await edit({ op: 'clip.duplicate', id: 's', track: 'T1', newId: 'over' });
    expect(clip('over')).toMatchObject({ track: 'T1', at: 0 });
    await expect(edit({ op: 'clip.duplicate', id: 's', track: 'T1', at: 30 })).rejects.toMatchObject({ code: 'E_OVERLAP' });
  });
});

describe('clip.punch-in (6)', () => {
  it('writes scale/x/y keyframes that frame the box, clamped so no edge shows', async () => {
    const { edit, clip } = makeProject({ size: [1920, 1080], services: { probe: probe({ 'screen.mp4': { width: 1920, height: 1080 } }) }, edit: (p) => {
      p.comps[0]!.size = [1920, 1080];
      p.assets = [{ id: 'screen', src: 'screen.mp4' }];
      p.clips = [{ id: 'sc', track: 'V1', at: 30, len: 300, asset: 'screen' }];
    } });
    await edit({ op: 'clip.punch-in', id: 'sc', box: [960, 540, 480, 270], at: 60, len: 15, hold: 60, out: 15 });
    const c = clip('sc');
    expect(c.scale).toEqual([[30, 1, 'inOutCubic'], [45, 4], [105, 4, 'inOutCubic'], [120, 1]]);
    expect(c.x).toEqual([[30, 960, 'inOutCubic'], [45, 0], [105, 0, 'inOutCubic'], [120, 960]]);
    expect(c.y).toEqual([[30, 540, 'inOutCubic'], [45, 0], [105, 0, 'inOutCubic'], [120, 540]]);
    await expect(edit({ op: 'clip.punch-in', id: 'sc', box: [0, 0, 100, 100] })).rejects.toMatchObject({ code: 'E_KEYFRAMED', fix: expect.stringMatching(/key\.clear/) });
    // a box at the right edge: clamped so the right edge of the picture stays at the frame edge
    const { edit: e2, clip: c2 } = makeProject({ size: [1920, 1080], services: { probe: probe({ 'screen.mp4': { width: 1920, height: 1080 } }) }, edit: (p) => {
      p.comps[0]!.size = [1920, 1080];
      p.assets = [{ id: 'screen', src: 'screen.mp4' }];
      p.clips = [{ id: 'sc', track: 'V1', at: 0, len: 300, asset: 'screen' }];
    } });
    const r = await e2({ op: 'clip.punch-in', id: 'sc', box: [1700, 0, 480, 270], len: 0 });
    const x = c2('sc').x as number, s = c2('sc').scale as number;
    expect(s).toBe(4);
    expect(x + s * 960).toBeCloseTo(1920, 5); // right edge on the frame edge
    expect(r.notes.join(' ')).toMatch(/no edge/);
  });
});

describe('layout.grid (6)', () => {
  it('places clips in cells, cover crops with a clip-space mask, contain letterboxes', async () => {
    const { edit, clip } = makeProject({ services: { probe: probe({ 'a.mp4': { width: 1920, height: 1080 }, 'b.mp4': { width: 1920, height: 1080 } }) }, edit: (p) => {
      p.assets = [{ id: 'a', src: 'a.mp4' }, { id: 'b', src: 'b.mp4' }];
      p.tracks!.splice(1, 0, { id: 'V2', comp: 'main' });
      p.clips = [{ id: 'top', track: 'V1', at: 0, len: 60, asset: 'a' }, { id: 'bot', track: 'V2', at: 0, len: 60, asset: 'b' }];
    } });
    const r = await edit({ op: 'layout.grid', ids: ['top', 'bot'], cols: 1 });
    expect(r.out[0]!.cells).toEqual([{ id: 'top', box: [0, 0, 1080, 960] }, { id: 'bot', box: [0, 960, 1080, 960] }]);
    // 16:9 media in a 1080x1920 comp (cover) has a 3413.33x1920 box; scaled to cover a 1080x960 cell
    const t = clip('top');
    expect(t).toMatchObject({ x: 540, y: 480, scale: 0.5 });
    expect(t.masks).toHaveLength(1);
    const m = t.masks![0]!;
    expect(m).toMatchObject({ shape: 'rect', space: 'clip' });
    expect((m.box as number[])[2]).toBeCloseTo(1080 / 1706.667, 4);
    expect(clip('bot')).toMatchObject({ x: 540, y: 1440 });
    // re-running with contain replaces the crop mask
    await edit({ op: 'layout.grid', ids: ['top', 'bot'], cols: 1, fit: 'contain', gap: 20 });
    expect(clip('top').masks).toBeUndefined();
    expect(clip('top').scale).toBeCloseTo(1080 / 3413.333, 4);
  });
});

describe('clip.sequence full=true (6)', () => {
  it('uses each file\'s full length from the probe', async () => {
    const { edit, project } = makeProject({ services: { probe: probe({ 'a.mp4': { duration: 4 }, 'b.mp4': { duration: 2.5 } }) } });
    await edit({ op: 'clip.sequence', srcs: ['a.mp4', 'b.mp4', 'c.png'], full: true });
    expect(project.data.clips!.map((c) => [c.at, c.len])).toEqual([[0, 120], [120, 75], [195, 60]]);
    await expect(edit({ op: 'clip.sequence', srcs: ['a.mp4'], full: true, len: 30 })).rejects.toMatchObject({ code: 'E_ARG' });
  });
});

describe('animated mask boxes (7)', () => {
  it('loads keyframed boxes with time strings, adds them by command, and retimes them with comp.set fps', async () => {
    const d = emptyProject({ length: 900 });
    d.clips = [{ id: 'r', track: 'T1', at: 0, len: 90, adjustment: true, masks: [{ shape: 'rect', box: [[0, [0, 0, 100, 100]], ['1s' as never, [50, 50, 200, 200], 'inOutCubic']] }] }];
    const r = parseProjectText(JSON.stringify(d));
    expect(r.project.clips![0]!.masks![0]!.box).toEqual([[0, [0, 0, 100, 100]], [30, [50, 50, 200, 200], 'inOutCubic']]);
    const { edit, clip } = makeProject({ edit: (p) => { p.clips = [{ id: 'r', track: 'T1', at: 0, len: 90, adjustment: true }]; } });
    await edit({ op: 'mask.add', id: 'r', shape: 'rect', box: [[0, [0, 0, 100, 100]], ['2s', [10, 10, 100, 100]]] });
    expect(clip('r').masks![0]!.box).toEqual([[0, [0, 0, 100, 100]], [60, [10, 10, 100, 100]]]);
    await expect(edit({ op: 'mask.add', id: 'r', shape: 'rect', box: [[0, [0, 0, 100, 0]]] })).rejects.toMatchObject({ code: 'E_MASK' });
    await edit({ op: 'comp.set', id: 'main', fps: 60 });
    expect(clip('r').masks![0]!.box).toEqual([[0, [0, 0, 100, 100]], [120, [10, 10, 100, 100]]]);
    await edit({ op: 'key.shift', id: 'r', by: 6 });
    expect(clip('r').masks![0]!.box).toEqual([[6, [0, 0, 100, 100]], [126, [10, 10, 100, 100]]]);
  });
});

describe('shape trimStart / trimOffset / lineCap / lineJoin (8)', () => {
  it('validates, normalises keyframe times, and keys them', async () => {
    const d = emptyProject({ length: 900 });
    d.clips = [{ id: 's', track: 'T1', at: 0, len: 90, shape: { type: 'path', d: 'M0 0 L100 0', trimStart: [[0, 0], ['1s' as never, 0.5]], trimOffset: 0.25, lineCap: 'round', lineJoin: 'bevel' } }];
    const r = parseProjectText(JSON.stringify(d));
    expect(r.project.clips![0]!.shape!.trimStart).toEqual([[0, 0], [30, 0.5]]);
    const bad = structuredClone(d); bad.clips![0]!.shape!.lineCap = 'pointy' as never;
    expect(() => parseProjectText(JSON.stringify(bad))).toThrow(/lineCap|butt/);
    const { edit, clip } = makeProject({ edit: (p) => { p.clips = [{ id: 's', track: 'T1', at: 0, len: 90, shape: { type: 'rect', size: [10, 10] } }]; } });
    await edit({ op: 'key.set', id: 's', prop: 'shape.trimOffset', at: 30, value: 1.5 });
    expect(clip('s').shape!.trimOffset).toEqual([[0, 0], [30, 1.5]]);
  });
  it('a bad shape.trim in clip.add names the trim format, not a generic text example (12)', async () => {
    const { edit } = makeProject();
    const e = await edit({ op: 'clip.add', shape: { type: 'path', d: 'M0 0', trim: [[0, [0, 0]], [45, [0, 1]]] } }).catch((x) => x);
    expect(e.code).toBe('E_ARG');
    expect(e.fix).toMatch(/shape\.trim is a number/);
    expect(e.fix).not.toMatch(/text=Hello/);
  });
});

describe('gen.asset is a checked reference (9)', () => {
  it('reports a missing or soundless asset', () => {
    const d = emptyProject();
    d.assets = [{ id: 'logo', src: 'logo.png' }];
    d.clips = [{ id: 'w', track: 'V1', at: 0, len: 30, gen: { type: 'waveform', asset: 'voice' } }];
    expect(() => normaliseAndValidate(structuredClone(d) as never)).toThrow(/follows asset "voice", which does not exist/);
    d.clips[0]!.gen!.asset = 'logo';
    expect(() => normaliseAndValidate(structuredClone(d) as never)).toThrow(/has no sound/);
    d.assets.push({ id: 'voice', src: 'voice.wav' });
    d.clips[0]!.gen!.asset = 'voice';
    expect(() => normaliseAndValidate(structuredClone(d) as never)).not.toThrow();
  });
});

describe('fx stages and bus effects (11)', () => {
  const catalog: Catalog = {
    ...fakeCatalog,
    effects: new Map([
      ...fakeCatalog.effects,
      ['highpass', { params: z.object({ freq: z.number().default(80) }), stages: { audio: true } }],
      ['denoise', { params: z.object({ amount: z.number().default(0.5) }), stages: { source: true } }],
    ]),
  };
  const setup = (p: ProjectFile) => {
    p.assets = [{ id: 'vo', src: 'vo.wav' }, { id: 'cam', src: 'cam.mp4' }, { id: 'silent', src: 'silent.mp4' }, { id: 'logo', src: 'logo.png' }];
    p.clips = [
      { id: 'voice', track: 'A1', at: 0, len: 30, asset: 'vo' },
      { id: 'shot', track: 'V1', at: 0, len: 30, asset: 'cam' },
      { id: 'mute', track: 'V1', at: 30, len: 30, asset: 'silent' },
      { id: 'pic', track: 'T1', at: 0, len: 30, asset: 'logo' },
      { id: 'title', track: 'T1', at: 30, len: 30, text: 'Hi' },
    ];
  };
  const make = () => makeProject({ services: { catalog, probe: probe({ 'silent.mp4': { hasAudio: false } }) }, edit: setup });
  it('refuses an audio-only effect on a clip without sound, with a bus fix', async () => {
    const { edit, clip } = make();
    for (const id of ['title', 'pic', 'mute']) {
      const e = await edit({ op: 'fx.add', id, type: 'highpass' }).catch((x) => x);
      expect(e).toMatchObject({ code: 'E_ARG', fix: expect.stringMatching(/fx\.add bus=/) });
    }
    await edit({ op: 'fx.add', id: 'voice', type: 'highpass' });
    await edit({ op: 'fx.add', id: 'shot', type: 'highpass' });
    expect(clip('shot').fx).toEqual([{ type: 'highpass' }]);
  });
  it('refuses a video-only effect on an audio clip', async () => {
    const { edit } = make();
    await expect(edit({ op: 'fx.add', id: 'voice', type: 'denoise' })).rejects.toMatchObject({ code: 'E_ARG' });
    await expect(edit({ op: 'fx.add', id: 'voice', type: 'blur' })).resolves.toBeTruthy(); // no stage info: unchecked
  });
  it('adds, sets, moves and removes bus effects', async () => {
    const { edit, project } = make();
    await edit({ op: 'fx.add', bus: 'dialogue', type: 'highpass', freq: 100 });
    await edit({ op: 'fx.add', bus: 'dialogue', type: 'blur', at: 0 });
    expect(project.data.buses).toEqual([{ id: 'dialogue', fx: [{ type: 'blur' }, { type: 'highpass', freq: 100 }] }]);
    await expect(edit({ op: 'fx.add', bus: 'dialogue', type: 'denoise' })).rejects.toMatchObject({ code: 'E_ARG' });
    await edit({ op: 'fx.set', bus: 'dialogue', fx: 'highpass', freq: 120 });
    await edit({ op: 'fx.move', bus: 'dialogue', fx: 'highpass', to: 0 });
    await edit({ op: 'fx.remove', bus: 'dialogue', fx: 'blur' });
    expect(project.data.buses).toEqual([{ id: 'dialogue', fx: [{ type: 'highpass', freq: 120 }] }]);
    await edit({ op: 'fx.remove', bus: 'dialogue', fx: 0 });
    expect(project.data.buses).toEqual([{ id: 'dialogue' }]);
    await expect(edit({ op: 'fx.add', bus: 'nobus', type: 'highpass' })).rejects.toMatchObject({ code: 'E_REF' });
    await expect(edit({ op: 'fx.add', type: 'highpass' })).rejects.toMatchObject({ code: 'E_ARG' });
    await expect(edit({ op: 'fx.add', id: 'voice', bus: 'music', type: 'highpass' })).rejects.toMatchObject({ code: 'E_ARG' });
  });
  it('runCommand without a catalog stays permissive', async () => {
    const d = emptyProject(); setup(d);
    const r = await runCommand(normaliseAndValidate(d as never).project, { op: 'fx.add', id: 'voice', type: 'denoise' });
    expect(r.project.clips!.find((c) => c.id === 'voice')!.fx).toEqual([{ type: 'denoise' }]);
  });
});
