/** The built-ins through the real evaluate → Skia renderer path (params parsed from a project). */
import { describe, it, expect, beforeAll } from 'vitest';
import { skiaRenderer } from '../../src/render/skia/index.js';
import { evaluate, type EvaluateOptions } from '../../src/render/evaluate.js';
import { builtinRegistry } from '../../src/builtin/index.js';
import type { Clip, ProjectFile } from '../../src/core/schema/index.js';
import type { FrameProvider, RenderSession, MediaSource } from '../../src/render/types.js';

const W = 120, H = 80;
const registry = builtinRegistry();
const frames: FrameProvider = { async get(_s, m) { const w = Math.min(m.w, 160), h = Math.min(m.h, 90); return { width: w, height: h, data: new Uint8Array(w * h * 4).fill(255) }; } };
let session: RenderSession, opts: EvaluateOptions;
beforeAll(async () => {
  session = await skiaRenderer.open({ width: W, height: H, registry });
  opts = { layouter: session.layouter, registry, assetKind: () => 'video', media: () => ({ width: 160, height: 90, duration: 10 }) };
});

const project = (clips: Partial<Clip>[]): ProjectFile => ({
  michelangelo: 1,
  assets: [{ id: 'vid', src: 'v.mp4' }],
  comps: [{ id: 'main', size: [W, H], fps: 30, bg: '#000000' }],
  tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }],
  clips: clips.map((c, i) => ({ id: `c${i}`, track: 'V1', at: 0, len: 30, ...c }) as Clip),
});

async function at(p: ProjectFile, f: number, x: number, y: number) {
  const img = await session.drawFrame(evaluate(p, 'main', f, opts), frames);
  const i = (y * img.width + x) * 4;
  return [...img.data.subarray(i, i + 4)];
}

describe('built-ins in the renderer', () => {
  it('generator + layer effect + transition', async () => {
    const p = project([
      { gen: { type: 'gradient', colors: ['#ff0000', '#ff0000'] }, fx: [{ type: 'color', saturation: 0 }] },
      { at: 30, len: 30, color: '#0000ff', transition: { in: { type: 'dip', len: 10, color: 'white' } } } as Partial<Clip>,
    ]);
    const grey = await at(p, 5, 60, 40);
    expect(Math.abs(grey[0]! - grey[1]!)).toBeLessThanOrEqual(2);
    expect(grey[0]).toBeGreaterThan(40);
    expect(await at(p, 30, 60, 40)).toEqual([255, 255, 255, 255]);
    expect(await at(p, 45, 60, 40)).toEqual([0, 0, 255, 255]);
  });
  it('media clips get source-stage filters instead of the layer draw', () => {
    const p = project([{ asset: 'vid', fx: [{ type: 'color', brightness: 0.2 }, { type: 'lut', file: 'a.cube' }, { type: 'blur', radius: 4 }] }]);
    const list = evaluate(p, 'main', 0, opts);
    const node = list.nodes[0] as { source: MediaSource; fx: { type: string }[] };
    expect(node.source.filters.map((f) => f.filter)).toEqual(['lutrgb', 'lut3d']);
    expect(node.fx.map((f) => f.type)).toEqual(['blur']);
  });
  it('bad params fail with a fix', () => {
    const p = project([{ color: '#fff', fx: [{ type: 'blur', radius: -3 }] } as Partial<Clip>]);
    expect(() => evaluate(p, 'main', 0, opts)).toThrow(/radius/);
  });
});
