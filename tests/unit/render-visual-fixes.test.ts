/**
 * Renderer fixes: masks at reduced render scale, path shapes without a size, keyframed mask boxes, shape trim
 * start/offset and line caps/joins, source-stage effects on non-media clips, audio-reactive generators.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import type { ProjectFile } from '../../src/core/schema/index.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import { defineGenerator, definePlugin, z } from '../../src/plugin/api.js';
import { evaluate, maskBoxAt, shapeBox, type EvaluateOptions } from '../../src/render/evaluate.js';
import { createTextLayouter } from '../../src/render/text.js';
import { pathBounds, pathLength } from '../../src/render/path.js';
import { trimDash } from '../../src/render/skia/shapes.js';
import { renderStills } from '../../src/render/pipeline.js';
import { computeLevels, bandEdges, analyzeLevels } from '../../src/media/levels.js';
import type { LayerNode, RGBAFrame } from '../../src/render/types.js';
import { ff, tempDir } from './media-fixtures.js';

let dir: string, cleanup: () => void;
beforeAll(() => {
  ({ dir, cleanup } = tempDir('mgl-visual-'));
  // 1 s of silence then 1 s of a loud tone: an audio-reactive generator must see the change
  ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=f=1000:r=48000:d=1', '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1', join(dir, 'beat.wav')]);
});
afterAll(() => cleanup());

const px = (img: RGBAFrame, x: number, y: number) => { const i = (Math.round(y) * img.width + Math.round(x)) * 4; return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!]; };

const base = (clips: object[], extra: Partial<ProjectFile> = {}): ProjectFile => ({
  michelangelo: 1,
  comps: [{ id: 'main', size: [1920, 1080], fps: 30 }],
  tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }],
  clips,
  ...extra,
} as ProjectFile);

describe('masks at reduced render scale (draft, look)', () => {
  // explore repro: a 60 % black solid with an inverted, feathered, rounded spotlight hole past x = 960
  const p = base([
    { id: 'bg', track: 'V1', at: 0, len: 30, color: '#ffffff' },
    { id: 'd', track: 'V2', at: 0, len: 30, color: '#000000', opacity: 0.6, masks: [{ shape: 'rect', box: [1085, 282, 830, 236], feather: 6, radius: 20, invert: true }] },
  ]);
  for (const scale of [1, 0.5, 0.81, 0.25]) {
    it(`keeps the hole at scale ${scale}`, async () => {
      const [s] = await renderStills(p, { baseDir: dir, frames: [5], scale });
      const at = (x: number, y: number) => px(s!.image, x * scale, y * scale)[0]!;
      expect(at(1500, 400)).toBeGreaterThan(240); // inside the hole: the white bg
      expect(at(1880, 400)).toBeGreaterThan(240); // the right end of the hole (past 0.81 × 1920)
      expect(at(500, 400)).toBeLessThan(120); // outside: darkened
    });
  }
});

describe('path shapes without a size', () => {
  it('use the path bounding box for the layer box', () => {
    expect(pathBounds('M 0 0 L 700 0 L 700 300')).toEqual({ x: 0, y: 0, w: 700, h: 300 });
    expect(shapeBox({ shape: { type: 'path', d: 'M 0 0 L 700 0 L 700 300' } })).toEqual({ w: 700, h: 300 });
    const arc = pathBounds('M 0 50 A 50 50 0 0 1 100 50')!; // a half circle bulging up to y = 0
    expect(arc.y).toBeCloseTo(0, 0);
    expect(arc.w).toBeCloseTo(100, 5);
    expect(pathLength('M 0 0 L 30 40 Z')).toBeCloseTo(100, 6);
    expect(shapeBox({ shape: { type: 'rect' } })).toEqual({ w: 200, h: 200 });
  });

  it('draw the whole stroke (both segments), not a 200 px stub', async () => {
    const p = base([
      { id: 'bg', track: 'V1', at: 0, len: 30, color: '#000000' },
      { id: 'pth', track: 'V2', at: 0, len: 30, shape: { type: 'path', d: 'M 0 0 L 700 0 L 700 300', fill: 'none', stroke: '#ffffff', strokeWidth: 10 } },
    ]);
    const [s] = await renderStills(p, { baseDir: dir, frames: [0], scale: 0.5 });
    // box 700 × 300 centred: origin at (610, 390) comp px
    expect(px(s!.image, (610 + 600) / 2, 390 / 2)[0]).toBeGreaterThan(200); // far along the first segment
    expect(px(s!.image, 1310 / 2, (390 + 250) / 2)[0]).toBeGreaterThan(200); // on the second segment
  });
});

describe('keyframed mask boxes', () => {
  it('interpolate per frame (constant boxes unchanged)', () => {
    expect(maskBoxAt([10, 20, 30, 40], 99)).toEqual([10, 20, 30, 40]);
    const keys = [[0, [0, 0, 100, 100]], [10, [100, 50, 200, 100], 'linear']];
    expect(maskBoxAt(keys, 5)).toEqual([50, 25, 150, 100]);
    expect(maskBoxAt(keys, 20)).toEqual([100, 50, 200, 100]);
    const opts: EvaluateOptions = { layouter: createTextLayouter(), registry: builtinRegistry(), assetKind: () => 'video' };
    const p = base([{ id: 's', track: 'V1', at: 10, len: 30, color: '#fff', masks: [{ shape: 'rect', box: [[0, [0, 0, 100, 100]], [10, [100, 50, 200, 100]]] }, { shape: 'ellipse', space: 'clip', box: [[0, [0, 0, 0.5, 0.5]], [10, [0.5, 0.5, 0.5, 0.5]]] }] }]);
    const n = evaluate(p, 'main', 15, opts).nodes[0] as LayerNode;
    expect(n.masks[0]!.box).toEqual([50, 25, 150, 100]);
    expect(n.masks[1]!.box).toEqual([0.25 * 1920, 0.25 * 1080, 0.5 * 1920, 0.5 * 1080]);
  });
});

describe('shape trim start/offset, line caps and joins', () => {
  it('trimDash: whole, empty, a window, and a window that wraps past the path start', () => {
    expect(trimDash(100, 0, 1, 0)).toBeNull();
    expect(trimDash(100, 0.3, 0.3, 0)).toBe('none');
    expect(trimDash(100, 0.2, 0.5, 0)).toEqual({ dash: [30, 201], offset: -20 });
    const w = trimDash(100, 0.5, 0.9, 0.3); // drawn: 0.8 .. 1.2 → [0, 0.2) and [0.8, 1)
    expect(w).not.toBe('none');
    const d = (w as { dash: number[] }).dash;
    expect(d[0]).toBeCloseTo(20); expect(d[1]).toBeCloseTo(60); expect(d[2]).toBeCloseTo(21);
  });

  it('renders only the trimmed window of a line, with square caps', async () => {
    const p = base([
      { id: 'bg', track: 'V1', at: 0, len: 30, color: '#000000' },
      { id: 'ln', track: 'V2', at: 0, len: 30, x: 960, y: 540, shape: { type: 'line', points: [[0, 50], [1000, 50]], stroke: '#ffffff', strokeWidth: 20, trimStart: 0.5, trim: 1, lineCap: 'square', lineJoin: 'miter' } },
    ]);
    const [s] = await renderStills(p, { baseDir: dir, frames: [0], scale: 0.5 });
    // layer box 1000 × 50 centred at (960, 540): x from 460; the line at y = 540 - 25 + 50 = 565
    const y = 565 / 2;
    expect(px(s!.image, (460 + 200) / 2, y)[0]).toBeLessThan(30); // first half trimmed away
    expect(px(s!.image, (460 + 800) / 2, y)[0]).toBeGreaterThan(200);
    expect(px(s!.image, (460 + 1000 + 6) / 2, y)[0]).toBeGreaterThan(200); // the square cap reaches past the end
  });
});

describe('source-stage effects on non-media clips', () => {
  it('an adjustment clip with a source-only effect (lut) is E_FX_STAGE with a fix, not a silent no-op', () => {
    const opts: EvaluateOptions = { layouter: createTextLayouter(), registry: builtinRegistry(), assetKind: () => 'video' };
    const p = base([{ id: 'adj', track: 'V1', at: 0, len: 30, adjustment: true, fx: [{ type: 'lut', file: 'look.cube' }] }]);
    expect(() => evaluate(p, 'main', 0, opts)).toThrowError(expect.objectContaining({ code: 'E_FX_STAGE', fix: expect.stringContaining('fx.remove adj fx=0') }));
    // a layer-stage effect on the adjustment still works
    const q = base([{ id: 'adj', track: 'V1', at: 0, len: 30, adjustment: true, fx: [{ type: 'blur', radius: 4 }] }]);
    expect((evaluate(q, 'main', 0, opts).nodes[0] as LayerNode).fx.map((f) => f.type)).toEqual(['blur']);
  });
});

describe('audio-reactive generators', () => {
  it('computeLevels: per-frame RMS 0..1 and a 16-band spectrum peaking at the tone', () => {
    const sr = 22050, pcm = new Float32Array(sr * 2);
    for (let i = sr; i < 2 * sr; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sr);
    const lv = computeLevels(pcm, sr, { num: 30, den: 1 });
    expect(lv.rms.length).toBe(60);
    expect(lv.rms[10]).toBe(0);
    expect(lv.rms[45]).toBeGreaterThan(0.8); // -9 dBFS → (60-9)/60
    const row = Array.from(lv.spectrum.subarray(45 * 16, 46 * 16));
    const edges = bandEdges(16, sr, 2048);
    const bin = Math.round((1000 / sr) * 2048);
    const want = edges.findIndex((e, i) => bin >= e && bin < edges[i + 1]!);
    expect(row.indexOf(Math.max(...row))).toBe(want);
  });

  it('the renderer passes draw({ audio }) for generators with audioSource, indexed by source frame', async () => {
    const reg = builtinRegistry().add(definePlugin({
      name: 'meter',
      generators: [defineGenerator({
        type: 'meter', describe: 'white when loud', params: z.object({ src: z.string() }),
        audioSource: (p) => p.src,
        draw({ dst, audio }) {
          const v = audio ? audio.rms[audio.frame] ?? 0 : -1;
          dst.ctx.fillStyle = v < 0 ? '#ff0000' : v > 0.5 ? '#ffffff' : '#000000';
          dst.ctx.fillRect(0, 0, dst.width, dst.height);
        },
      })],
    }), 'test');
    const p = base([{ id: 'g', track: 'V1', at: 0, len: 60, gen: { type: 'meter', src: 'beat' } }], { assets: [{ id: 'beat', src: 'beat.wav' }] } as Partial<ProjectFile>);
    const st = await renderStills(p, { baseDir: dir, frames: [10, 45], scale: 0.1, registry: reg });
    expect(px(st[0]!.image, 10, 10).slice(0, 3)).toEqual([0, 0, 0]); // silent second
    expect(px(st[1]!.image, 10, 10).slice(0, 3)).toEqual([255, 255, 255]); // the tone
    // cached: a second analysis is the same data
    const a = await analyzeLevels(join(dir, 'beat.wav'), { num: 30, den: 1 }, { cacheDir: dir });
    const b = await analyzeLevels(join(dir, 'beat.wav'), { num: 30, den: 1 }, { cacheDir: dir });
    expect(b.rms.length).toBe(a.rms.length);
    expect(Math.max(...Array.from(b.rms, (v, i) => Math.abs(v - a.rms[i]!)))).toBeLessThan(1e-3);
  });
});
