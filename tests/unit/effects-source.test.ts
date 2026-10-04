import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filtersToString } from '../../src/media/filters.js';
import { surfaceFromRGBA } from '../../src/plugin/surface.js';
import type { Surface } from '../../src/plugin/api.js';
import { effect, runEffect, bars, px, close } from './effects-fixtures.js';

let dir = '';
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'mgl-fx-')); });

/** Run the effect's source-stage filters with ffmpeg over `src` and return the result as a surface. */
function ffmpegApply(src: Surface, filters: string): Surface {
  const inp = join(dir, 'in.rgba'), out = join(dir, 'out.rgba');
  writeFileSync(inp, src.pixels());
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${src.width}x${src.height}`, '-i', inp,
    '-vf', `${filters},format=rgba`, '-f', 'rawvideo', '-pix_fmt', 'rgba', out]);
  return surfaceFromRGBA(src.width, src.height, readFileSync(out));
}

function meanDiff(a: Surface, b: Surface): { mean: number; max: number } {
  const x = a.pixels(), y = b.pixels();
  let s = 0, max = 0;
  for (let i = 0; i < x.length; i += 4) for (let c = 0; c < 3; c++) {
    const d = Math.abs(x[i + c]! - y[i + c]!);
    s += d; if (d > max) max = d;
  }
  return { mean: s / ((x.length / 4) * 3), max };
}

describe('color: layer stage and source stage agree', () => {
  const cases: Record<string, unknown>[] = [
    { brightness: 0.1, contrast: 1.3 },
    { saturation: 0 },
    { saturation: 1.6, hue: 40 },
    { temperature: 0.8, tint: -0.5 },
    { brightness: -0.2, contrast: 0.7, saturation: 1.2, hue: -90, temperature: -0.6, tint: 0.4 },
  ];
  for (const params of cases) {
    it(JSON.stringify(params), () => {
      const src = bars(128, 128), def = effect('color');
      const fs = def.source!(def.params.parse(params) as never);
      expect(fs.length).toBeGreaterThan(0);
      const viaFfmpeg = ffmpegApply(src, filtersToString(fs));
      const viaLayer = runEffect('color', src, params);
      const d = meanDiff(viaFfmpeg, viaLayer);
      expect(d.mean, JSON.stringify(d)).toBeLessThan(1.5);
      expect(d.max).toBeLessThanOrEqual(6);
    });
  }
  it('identity emits no filters and copies the layer', () => {
    const def = effect('color');
    expect(def.source!(def.params.parse({}) as never)).toEqual([]);
    const src = bars(32, 32);
    expect(px(runEffect('color', src), 3, 3)).toEqual(px(src, 3, 3));
  });
  it('saturation 0 is grey; warm temperature raises red over blue', () => {
    const g = px(runEffect('color', bars(64, 64), { saturation: 0 }), 40, 10);
    expect(Math.abs(g[0] - g[1]) + Math.abs(g[1] - g[2])).toBeLessThanOrEqual(2);
    const w = px(runEffect('color', bars(64, 64), { temperature: 1 }), 2, 2);
    expect(w[0]).toBeGreaterThan(w[2] + 40);
  });
});

describe('lut, denoise, sharpen source stage', () => {
  it('lut3d applies a .cube file (an inverting LUT)', () => {
    const cube = join(dir, 'invert.cube');
    const lines = ['LUT_3D_SIZE 2'];
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${1 - r} ${1 - g} ${1 - b}`);
    writeFileSync(cube, lines.join('\n') + '\n');
    const def = effect('lut');
    const fs = def.source!(def.params.parse({ file: 'invert.cube' }) as never);
    expect(fs).toEqual([{ filter: 'lut3d', args: { file: 'invert.cube', interp: 'tetrahedral' } }]);
    expect(def.draw).toBeUndefined();
    const out = ffmpegApply(bars(32, 32), filtersToString(fs, { baseDir: dir }));
    expect(close(px(out, 1, 1), [255 - 0xc0, 255 - 0xc0, 255 - 0xc0, 255], 4)).toBe(true);
    expect(def.params.safeParse({ file: 'look.png' }).success).toBe(false);
  });
  it('denoise and sharpen emit allowed filters that ffmpeg runs', () => {
    for (const [t, p] of [['denoise', { strength: 0.7 }], ['sharpen', { amount: 1 }]] as const) {
      const def = effect(t), fs = def.source!(def.params.parse(p) as never);
      expect(fs.length).toBe(1);
      const out = ffmpegApply(bars(64, 64), filtersToString(fs));
      expect(out.width).toBe(64);
    }
    expect(effect('denoise').source!({ strength: 0 } as never)).toEqual([]);
  });
  it('sharpen: layer stage and ffmpeg unsharp agree on an edge', () => {
    const src = bars(128, 128), def = effect('sharpen'), p = def.params.parse({ amount: 1 });
    const viaFfmpeg = ffmpegApply(src, filtersToString(def.source!(p as never)));
    const viaLayer = runEffect('sharpen', src, { amount: 1 });
    expect(meanDiff(viaFfmpeg, viaLayer).mean).toBeLessThan(4);
  });
});
