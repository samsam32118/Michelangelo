// @vitest-environment node
/** motion.apply / motion.clear: presets expanded into plain keyframes, merged with existing keys, and removed again. */
import { describe, it, expect } from 'vitest';
import { makeProject } from './text-fixtures.js';
import { getCommand } from '../../src/core/commands/index.js';
import { interpolate } from '../../src/render/keyframes.js';
import { evaluate } from '../../src/render/evaluate.js';
import { createTextLayouter } from '../../src/render/text.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { definePlugin, defineMotionPreset } from '../../src/plugin/api.js';
import type { ProjectFile, Clip } from '../../src/core/schema/index.js';

const base = (p: ProjectFile) => {
  p.assets = [{ id: 'beach', src: 'beach.mp4' }];
  p.tracks!.push({ id: 'V2', comp: 'main' }, { id: 'V3', comp: 'main' });
  p.clips = [
    { id: 'shot', track: 'V1', at: 0, len: 150, asset: 'beach' },
    { id: 'title', track: 'T1', at: 0, len: 90, text: 'Hello', y: 600 },
    { id: 'box', track: 'V2', at: 30, len: 90, shape: { type: 'rect', size: [400, 200], fill: '#ff4d6d' }, x: 300, opacity: 0.8 },
    { id: 'chip', track: 'V3', at: 0, len: 90, shape: { type: 'rect', size: [300, 100], fill: '#ffd166' }, y: 1200 },
  ];
};
const at = (v: unknown, f: number) => interpolate(v as never, f);
const tagsOf = (c: Clip) => (c.tags ?? []).filter((t) => t.startsWith('motion:'));

describe('motion.apply', () => {
  it('expands in/out/emphasis/loop on a text clip into keys relative to rest, and the rest state returns', async () => {
    const { edit, project } = makeProject({ edit: base });
    const r = await edit({ op: 'motion.apply', id: 'title', in: 'pop', out: 'fade', emphasis: 'pulse@1s', loop: 'float' });
    const c = project.clip('title')!;
    // in: pop from 30% scale and transparent to rest at its end
    expect(at(c.scale, 0)).toBeCloseTo(0.3);
    expect(at(c.opacity, 0)).toBe(0);
    const inEnd = (c.scale as [number, number][]).find((k) => k[1] === 1)![0];
    expect(at(c.scale, inEnd)).toBe(1);
    expect(at(c.opacity, inEnd)).toBe(1);
    // emphasis at 1s returns to rest; out ends transparent on the last frame
    expect(at(c.scale, 30)).toBe(1);
    expect(at(c.scale, 36)).toBeGreaterThan(1.05);
    expect(at(c.scale, 50)).toBe(1);
    expect(at(c.opacity, 89)).toBe(0);
    expect(at(c.opacity, 70)).toBe(1);
    // the loop floats y around its rest (600) and ends where it starts
    const ys = c.y as [number, number][];
    expect(ys[0]![1]).toBe(600);
    expect(ys.at(-1)![1]).toBe(600);
    expect(Math.min(...ys.map((k) => k[1]))).toBeLessThan(600);
    expect(tagsOf(c)).toEqual([
      expect.stringMatching(/^motion:in=pop-in@0-\d+:scale,opacity$/),
      expect.stringMatching(/^motion:out=fade-out@\d+-89:opacity$/),
      'motion:emphasis=pulse@30-45:scale',
      expect.stringMatching(/^motion:loop=float@0-89:y$/),
    ]);
    expect(r.summary.join(' ')).toMatch(/pop-in/);
    // keys stay valid for the schema: frames are integers and rise
    for (const prop of ['x', 'y', 'scale', 'rotate', 'opacity'] as const) {
      const v = c[prop];
      if (!Array.isArray(v) || !Array.isArray(v[0])) continue;
      const fs = (v as unknown as [number][]).map((k) => k[0]);
      expect(fs.every((f, i) => Number.isInteger(f) && (i === 0 || f > fs[i - 1]!))).toBe(true);
    }
  });

  it('works on media and shape clips; values multiply/add onto the clip\'s own rest values', async () => {
    const { edit, project } = makeProject({ edit: base });
    await edit({ op: 'motion.apply', id: 'shot', loop: 'ken-burns-in' });
    const s = project.clip('shot')!;
    expect(s.scale).toEqual([[0, 1, 'inOutSine'], [149, 1.12]]);
    await edit({ op: 'motion.apply', id: 'box', in: 'slide-right', out: 'zoom' });
    const b = project.clip('box')!;
    expect(at(b.x, 0)).toBeLessThan(300); // slides right into x=300
    expect(at(b.x, 30)).toBe(300);
    expect(at(b.opacity, 0)).toBe(0);
    expect(at(b.opacity, 40)).toBe(0.8); // opacity multiplies the clip's 0.8
    expect(at(b.scale, 89)).toBeCloseTo(0.5);
  });

  it('loops repeat seamlessly between the in and out on the same property (rotate turns accumulate)', async () => {
    const { edit, project } = makeProject({ edit: base });
    await edit({ op: 'motion.apply', id: 'chip', in: 'spin', loop: 'spin', period: '1s' });
    const c = project.clip('chip')!;
    const rot = c.rotate as [number, number, string?][];
    const inEnd = Number(/@0-(\d+)/.exec(tagsOf(c)[0]!)![1]);
    expect(at(rot, inEnd)).toBe(0);
    // 72 frames after the in: about 2 turns, continuing (no jump back to 0)
    expect(rot.at(-1)![1] % 360).toBe(0);
    expect(rot.at(-1)![1]).toBeGreaterThanOrEqual(720);
    for (let i = 1; i < rot.length; i++) expect(rot[i]![1]).toBeGreaterThanOrEqual(rot[i - 1]![1] - 180.0001);
    // a breathing loop on a clip with no in: whole clip, each cycle back at rest
    await edit({ op: 'motion.apply', id: 'title', loop: 'breathe', period: '1s' });
    const t = project.clip('title')!;
    expect(t.scale).toEqual(expect.arrayContaining([[0, 1, 'inOutSine'], [30, 1, 'inOutSine'], [59, 1, 'inOutSine'], [89, 1]]));
  });

  it('staggers ids, accepts per-phase params and refuses unknown params and presets with a fix', async () => {
    const { edit, project } = makeProject({ edit: base });
    await edit({ op: 'motion.apply', ids: ['title', 'chip'], in: 'slide-up', stagger: 6, params: { 'in.distance': 250 } });
    expect(project.clip('title')!.y).toEqual([[0, 850, 'outCubic'], [15, 600]]);
    expect(project.clip('chip')!.y).toEqual([[6, 1450, 'outCubic'], [21, 1200]]);
    await expect(edit({ op: 'motion.apply', id: 'box', in: 'pop', params: { distanse: 3 } })).rejects.toMatchObject({ code: 'E_PARAMS' });
    await expect(edit({ op: 'motion.apply', id: 'box', in: 'slide-up', params: { distanse: 3 } })).rejects.toMatchObject({ code: 'E_PARAMS', didYouMean: ['distance'] });
    await expect(edit({ op: 'motion.apply', id: 'box', in: 'popp' })).rejects.toMatchObject({ code: 'E_UNKNOWN_MOTION', didYouMean: expect.arrayContaining(['pop']) });
    await expect(edit({ op: 'motion.apply', id: 'box', in: 'float' })).rejects.toMatchObject({ code: 'E_UNKNOWN_MOTION', fix: expect.stringMatching(/loop=float/) });
    await expect(edit({ op: 'motion.apply', id: 'box' })).rejects.toMatchObject({ code: 'E_ARG' });
  });

  it('refuses to overlap existing keyframes (with a fix) and merges around them', async () => {
    const { edit, project } = makeProject({ edit: base });
    await edit({ op: 'key.set', id: 'title', prop: 'scale', at: 40, value: 1.3 });
    const e = await edit({ op: 'motion.apply', id: 'title', in: 'pop' }).catch((x) => x);
    expect(e).toMatchObject({ code: 'E_KEYFRAMED', fix: expect.stringMatching(/key\.clear title prop=scale/) });
    // keys entirely before the motion are kept and the motion is relative to where they end
    await edit({ op: 'key.clear', id: 'title', prop: 'scale', value: 1 });
    await edit({ op: 'key.set', id: 'title', prop: 'x', at: 0, value: 400 });
    await edit({ op: 'key.set', id: 'title', prop: 'x', at: 10, value: 500 });
    await edit({ op: 'motion.apply', id: 'title', emphasis: 'shake@1s' });
    const x = project.clip('title')!.x as [number, number][];
    expect(x.slice(0, 2)).toEqual([[0, 400], [10, 500]]);
    expect(x[2]![0]).toBe(30);
    expect(x[2]![1]).toBe(500);
    expect(x.at(-1)![1]).toBe(500);
    // a loop and an emphasis on the same property clash, with advice
    await expect(edit({ op: 'motion.apply', id: 'chip', emphasis: 'pulse', loop: 'breathe' })).rejects.toMatchObject({ code: 'E_KEYFRAMED', fix: expect.stringMatching(/float|drift/) });
    // existing motion on the property names motion.clear as the fix
    await edit({ op: 'motion.apply', id: 'chip', loop: 'breathe' });
    await expect(edit({ op: 'motion.apply', id: 'chip', emphasis: 'pulse' })).rejects.toMatchObject({ code: 'E_KEYFRAMED', fix: expect.stringMatching(/motion\.clear chip phase=/) });
    // audio clips and locked clips are refused
    project.data.clips!.push({ id: 'vo', track: 'A1', at: 0, len: 60, asset: 'beach' });
    await expect(edit({ op: 'motion.apply', id: 'vo', in: 'fade' })).rejects.toMatchObject({ code: 'E_ARG' });
  });

  it('fits a loop between an in and an out on the same property (shared boundary keys), and refuses keys animating across', async () => {
    const { edit, project } = makeProject({ edit: base });
    await edit({ op: 'motion.apply', id: 'chip', in: 'pop@0.5s', out: 'zoom', loop: 'breathe' });
    const c = project.clip('chip')!;
    const s = c.scale as [number, number, string?][];
    const fs = s.map((k) => k[0]);
    expect(fs.every((f, i) => i === 0 || f > fs[i - 1]!)).toBe(true);
    const tag = (ph: string) => tagsOf(c).find((t) => t.startsWith(`motion:${ph}=`))!;
    const inEnd = Number(/@\d+-(\d+)/.exec(tag('in'))![1]), outStart = Number(/@(\d+)-/.exec(tag('out'))![1]);
    expect(tag('loop')).toBe(`motion:loop=breathe@${inEnd}-${outStart}:scale`);
    expect(at(s, inEnd)).toBe(1);
    expect(at(s, outStart)).toBe(1);
    expect(at(s, Math.round((inEnd + outStart) / 2))).toBeGreaterThan(1.02);
    await edit({ op: 'motion.clear', id: 'chip', phase: 'loop' });
    expect(tagsOf(project.clip('chip')!).length).toBe(2);
    expect(at(project.clip('chip')!.scale, Math.round((inEnd + outStart) / 2))).toBe(1);
    // hand keys at 0 and 80 with different values animate across 30..45: an emphasis there is refused
    await edit({ op: 'key.set', id: 'title', prop: 'rotate', at: 0, value: 0 });
    await edit({ op: 'key.set', id: 'title', prop: 'rotate', at: 80, value: 20 });
    await expect(edit({ op: 'motion.apply', id: 'title', emphasis: 'wiggle@1s' })).rejects.toMatchObject({ code: 'E_KEYFRAMED' });
  });

  it('re-applying a phase replaces it; motion.clear restores the rest values and keeps other keys', async () => {
    const { edit, project } = makeProject({ edit: base });
    await edit({ op: 'motion.apply', id: 'box', in: 'pop', loop: 'sway', out: 'fade' });
    await edit({ op: 'motion.apply', id: 'box', in: 'fade' });
    const b = () => project.clip('box')!;
    expect(tagsOf(b()).filter((t) => t.startsWith('motion:in='))).toEqual([expect.stringMatching(/^motion:in=fade-in@/)]);
    expect(b().scale).toBeUndefined(); // pop's scale keys are gone
    await edit({ op: 'motion.clear', id: 'box', phase: 'loop' });
    expect(b().rotate).toBeUndefined();
    expect(tagsOf(b()).some((t) => t.includes('loop'))).toBe(false);
    await edit({ op: 'motion.clear', id: 'box' });
    expect(b().opacity).toBe(0.8);
    expect(b().x).toBe(300);
    expect(b().tags).toBeUndefined();
    await expect(edit({ op: 'motion.clear', id: 'box' })).rejects.toMatchObject({ code: 'E_NO_MOTION', fix: expect.stringMatching(/key\.clear/) });
    // undo brings it all back in one step
    await edit({ op: 'motion.apply', id: 'title', in: 'drop', out: 'drop' });
    expect(project.clip('title')!.y).not.toBe(600);
    await edit({ op: 'motion.clear', id: 'title', phase: 'in' });
    expect(tagsOf(project.clip('title')!)).toEqual([expect.stringMatching(/^motion:out=drop-out/)]);
    expect(at(project.clip('title')!.y, 0)).toBe(600);
  });

  it('presets from a plugin catalog are used', async () => {
    const reg = builtinRegistry().add(definePlugin({
      name: 'wobble', motionPresets: [defineMotionPreset({ id: 'tilt-in', phase: 'in', describe: 'Tilt into place.', keys: ({ len }) => ({ rotate: [[0, -20, 'outCubic'], [len, 0]] }) })],
    }), '/plugins/wobble');
    const catalog = { ...reg.catalog(), motionPresets: reg.motionPresets };
    const { edit, project } = makeProject({ edit: base, services: { catalog } });
    await edit({ op: 'motion.apply', id: 'chip', in: 'tilt', len: 10 });
    expect(project.clip('chip')!.rotate).toEqual([[0, -20, 'outCubic'], [10, 0]]);
  });

  it('the example runs, and the renderer shows the motion (offscreen before the whip, at rest after)', async () => {
    const { edit, project } = makeProject({ edit: base });
    const def = getCommand('motion.apply');
    await expect(edit({ op: 'motion.apply', ...def.example })).resolves.toBeTruthy();
    await expect(edit({ op: 'motion.clear', ...getCommand('motion.clear').example })).resolves.toBeTruthy();
    await edit({ op: 'motion.apply', id: 'chip', in: 'whip' });
    const layouter = createTextLayouter();
    const registry = builtinRegistry();
    const node = (f: number) => evaluate(project.data, 'main', f, { layouter, registry, assetKind: () => 'video' }).nodes.find((n) => n.clipId === 'chip')! as { matrix: number[]; opacity: number };
    expect(node(0).matrix[4]).toBeGreaterThan(1080); // fully right of the frame (translate x)
    expect(Math.abs(node(30).matrix[4]! - (540 - 150))).toBeLessThan(1); // at rest: centre 540 minus half the 300 px box
  });
});
