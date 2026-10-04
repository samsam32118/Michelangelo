// @vitest-environment node
/** Regressions for the render review (2026-10-04): alpha flattening, keyframed source fx, split animations, crop decode size, comp-px adjustment fx, nested captions in SRT. */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import { evaluate, type EvaluateOptions } from '../../src/render/evaluate.js';
import { MediaFrames, decodeSize, mediaRequests } from '../../src/render/frames.js';
import { flattenAlpha, render, subtitleCues } from '../../src/render/pipeline.js';
import { skiaRenderer } from '../../src/render/skia/index.js';
import { PluginRegistry } from '../../src/plugin/registry.js';
import { definePlugin, defineEffect, defineTextAnimation } from '../../src/plugin/api.js';
import type { Clip, ProjectFile } from '../../src/core/schema/index.js';
import type { DisplayList, FrameProvider, LayerNode, MediaSource, RGBAFrame, TextLayouter } from '../../src/render/types.js';
import type { MediaBackend, VideoReader } from '../../src/media/types.js';
import { tempDir } from './media-fixtures.js';

const layouter: TextLayouter = {
  layout(text, st) {
    const w = Math.max(1, text.length * st.size * 0.5), h = st.size * st.lineHeight;
    return { w, h, size: st.size, lines: [{ text, x: 0, y: 0, w, baseline: st.size }], words: [{ text, x: 0, y: 0, w, h, line: 0 }] };
  },
};

const registry = new PluginRegistry().add(definePlugin({
  name: 'review-test',
  effects: [
    defineEffect({ type: 'bright', describe: 'b', params: z.object({ v: z.number().default(0) }), source: (p) => [{ filter: 'eq', args: { brightness: p.v } }], draw({ src, dst }) { dst.ctx.drawImage(src.canvas, 0, 0); } }),
    defineEffect({ type: 'srconly', describe: 's', params: z.object({ v: z.number().default(0) }), source: (p) => [{ filter: 'eq', args: { brightness: p.v } }] }),
    // copies the layer shifted right by dx px (a px-sized parameter)
    defineEffect({ type: 'shift', describe: 's', params: z.object({ dx: z.number().default(0) }), draw({ src, dst, params }) { dst.ctx.drawImage(src.canvas, params.dx, 0); } }),
  ],
  textAnimations: [defineTextAnimation({ id: 'fade', describe: 'f', state: (p) => ({ opacity: p }), easing: 'linear' })],
}));

const opts: EvaluateOptions = {
  layouter,
  registry,
  assetKind: (id) => (id.startsWith('img') ? 'image' : 'video'),
  media: (id) => (id === 'vid' ? { width: 320, height: 240, duration: 100 } : undefined),
};

function project(clips: Partial<Clip>[], extra: Partial<ProjectFile> = {}): ProjectFile {
  return {
    michelangelo: 1,
    assets: [{ id: 'vid', src: 'v.mp4' }],
    comps: [{ id: 'main', size: [320, 240], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }],
    ...extra,
    clips: clips.map((c, i) => ({ id: `c${i}`, track: 'V1', at: 0, len: 30, ...c }) as Clip),
  } as ProjectFile;
}

describe('non-alpha outputs flatten translucency over black', () => {
  it('flattenAlpha premultiplies onto black and makes every pixel opaque', () => {
    const f: RGBAFrame = { width: 3, height: 1, data: new Uint8Array([255, 255, 255, 128, 10, 20, 30, 255, 200, 200, 200, 0]) };
    flattenAlpha(f);
    expect([...f.data]).toEqual([128, 128, 128, 255, 10, 20, 30, 255, 0, 0, 0, 255]);
  });

  const t = tempDir('mgl-review-alpha-');
  afterAll(() => t.cleanup());
  it('a half-transparent white solid in a comp without bg encodes as mid grey in mp4', async () => {
    const p: ProjectFile = { michelangelo: 1, comps: [{ id: 'main', size: [64, 64], fps: 30 }], tracks: [{ id: 'V1', comp: 'main' }], clips: [{ id: 's', track: 'V1', at: 0, len: 5, color: '#ffffff', opacity: 0.5 }] } as ProjectFile;
    const out = join(t.dir, 'op.mp4');
    await render(p, out, { baseDir: t.dir, segments: 1 });
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
    const mid = raw[32 * 64 + 32]!;
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(160);
  });
});

describe('keyframed source-stage effects', () => {
  it('run at the layer stage when the effect has a draw, so the decoder filter stays fixed', () => {
    const p = project([{ asset: 'vid', fx: [{ type: 'bright', v: [[0, 0], [29, 0.5]] }] as never }]);
    const a = evaluate(p, 'main', 5, opts).nodes[0] as LayerNode, b = evaluate(p, 'main', 20, opts).nodes[0] as LayerNode;
    expect((a.source as MediaSource).filters).toEqual([]);
    expect((b.source as MediaSource).filters).toEqual([]);
    expect(a.fx.map((e) => e.type)).toEqual(['bright']);
    expect(b.fx[0]!.params.v).toBeGreaterThan(a.fx[0]!.params.v as number);
    // constant params stay at the source stage
    const c = evaluate(project([{ asset: 'vid', fx: [{ type: 'bright', v: 0.2 }] as never }]), 'main', 5, opts).nodes[0] as LayerNode;
    expect((c.source as MediaSource).filters).toEqual([{ filter: 'eq', args: { brightness: 0.2 } }]);
  });

  it('a source-only effect with changing filters never keeps more than the total reader cap open, and close() closes all', async () => {
    let open = 0, peak = 0, closed = 0;
    const backend = {
      async openVideo() {
        open++; peak = Math.max(peak, open);
        const r: VideoReader = { async frame() { return { width: 2, height: 2, data: new Uint8Array(16) }; }, async close() { open--; closed++; } };
        return r;
      },
    } as Partial<MediaBackend> as MediaBackend;
    const fr = new MediaFrames({ backend, baseDir: '/p', maxTotalReaders: 6 });
    const p = project([{ asset: 'vid', len: 60, fx: [{ type: 'srconly', v: [[0, 0], [59, 0.5]] }] as never }]);
    for (let f = 0; f < 60; f++) {
      const src = (evaluate(p, 'main', f, opts).nodes[0] as LayerNode).source as MediaSource;
      await fr.get(src, { w: 32, h: 24 });
      expect(fr.openReaders).toBeLessThanOrEqual(6);
    }
    await fr.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBeLessThanOrEqual(7); // the evicted reader closes asynchronously
    expect(open).toBe(0);
    expect(closed).toBeGreaterThan(50);
  });
});

describe('split text clips', () => {
  const anim = { in: 'fade', out: 'fade', by: 'all', len: 10 };
  const opacityAt = (p: ProjectFile, f: number) => {
    const n = evaluate(p, 'main', f, opts).nodes[0] as LayerNode;
    return n.source.type === 'text' ? n.source.animate!.units[0]!.opacity : NaN;
  };
  it('the first part does not play the out animation before the cut; the out plays at the end of the original clip', () => {
    const whole = project([{ text: 'Hi', len: 90, animate: anim as never }]);
    // what clip.split writes: the second part carries the clock on
    const split = project([{ text: 'Hi', len: 45, animate: anim as never }, { text: 'Hi', at: 45, len: 45, clock: 45, animate: anim as never }]);
    for (const f of [5, 30, 40, 44, 45, 50, 85, 89]) expect(opacityAt(split, f)).toBeCloseTo(opacityAt(whole, f), 6);
    expect(opacityAt(split, 44)).toBe(1);
  });
  it('a lone clip (no continuation) still plays its out animation at its end', () => {
    const p = project([{ text: 'Hi', len: 45, animate: anim as never }, { text: 'Other', at: 45, len: 45, animate: anim as never }]);
    expect(opacityAt(p, 44)).toBeLessThan(0.2);
  });
});

describe('cropped media decodes larger by the crop factor', () => {
  it('decodeSize scales by the crop and caps at the source size', () => {
    const s = { type: 'media', crop: [160, 120, 0, 0], size: { w: 320, h: 240 } } as unknown as MediaSource;
    expect(decodeSize(s, 160, 120)).toEqual({ w: 320, h: 240 });
    expect(decodeSize(s, 40, 30)).toEqual({ w: 80, h: 60 });
    expect(decodeSize({ ...s, crop: undefined } as MediaSource, 40, 30)).toEqual({ w: 40, h: 30 });
  });

  it('the renderer and the prefetch ask for the full frame at the size that keeps the crop sharp', async () => {
    const p = project([{ asset: 'vid', crop: [160, 120, 0, 0], fit: 'cover' }], { comps: [{ id: 'main', size: [160, 120], fps: 30 }] });
    const list = evaluate(p, 'main', 0, opts);
    const reqs = mediaRequests(list.nodes, [1, 0, 0, 1, 0, 0]);
    expect(reqs[0]!.size).toEqual({ w: 320, h: 240 });
    const asked: { w: number; h: number }[] = [];
    const frames: FrameProvider = { async get(_s, max) { asked.push(max); return { width: 320, height: 240, data: new Uint8Array(320 * 240 * 4) }; } };
    const session = await skiaRenderer.open({ width: 160, height: 120, registry });
    await session.drawFrame(list, frames);
    await session.close();
    expect(asked[0]).toEqual({ w: 320, h: 240 });
  });
});

describe('adjustment-layer effects are resolution independent', () => {
  const list = (): DisplayList => {
    const base = { matrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number], opacity: 1, blend: 'normal' as const, masks: [], localFrame: 0, seed: 0 };
    return {
      compId: 'main', width: 100, height: 100, frame: 0, rate: { num: 30, den: 1 }, bg: '#000000',
      nodes: [
        { type: 'layer', clipId: 'strip', box: { w: 10, h: 100 }, fx: [], source: { type: 'solid', color: '#ffffff' }, ...base },
        { type: 'adjustment', clipId: 'adj', box: { w: 100, h: 100 }, fx: [{ type: 'shift', params: { dx: 40 } }], ...base },
      ],
    };
  };
  const lumaAt = (f: RGBAFrame, x: number, y: number) => f.data[(y * f.width + x) * 4]!;
  it('a px parameter covers the same part of the frame at full and half resolution', async () => {
    const none: FrameProvider = { async get() { throw new Error('no media'); } };
    const full = await skiaRenderer.open({ width: 100, height: 100, registry });
    const half = await skiaRenderer.open({ width: 50, height: 50, registry });
    const a = await full.drawFrame(list(), none), b = await half.drawFrame(list(), none);
    await full.close(); await half.close();
    // the shifted copy of the strip sits at comp x 40..50
    expect(lumaAt(a, 45, 50)).toBeGreaterThan(200);
    expect(lumaAt(b, 22, 25)).toBeGreaterThan(200);
    expect(lumaAt(a, 30, 50)).toBeLessThan(30);
    expect(lumaAt(b, 15, 25)).toBeLessThan(30);
  });
});

describe('SRT/VTT export includes captions inside nested comps', () => {
  it('places nested cues at their absolute times (offset, in, speed, window)', () => {
    const p = {
      michelangelo: 1,
      comps: [{ id: 'main', size: [320, 240], fps: 30 }, { id: 'kid', size: [320, 240], fps: 30 }],
      tracks: [{ id: 'V1', comp: 'main' }, { id: 'C1', comp: 'main' }, { id: 'K1', comp: 'kid' }],
      clips: [
        { id: 'top', track: 'C1', at: 0, len: 300, captions: true },
        { id: 'nest', track: 'V1', at: 60, len: 60, comp: 'kid', in: 30 },
        { id: 'kcap', track: 'K1', at: 0, len: 300, captions: true },
      ],
      cues: [
        { id: 'q1', clip: 'top', at: 0, len: 30, text: 'top one' },
        { id: 'q2', clip: 'kcap', at: 40, len: 30, text: 'kid one' },
        { id: 'q3', clip: 'kcap', at: 200, len: 30, text: 'kid hidden' },
      ],
    } as unknown as ProjectFile;
    const cues = subtitleCues(p, 'main');
    expect(cues.map((c) => c.text)).toEqual(['top one', 'kid one']);
    // kid frame 40 shows at main 60 + (40 − 30) = 70 → 2.333 s; ends at kid 70 → main 100
    expect(cues[1]!.start).toBeCloseTo(70 / 30, 6);
    expect(cues[1]!.end).toBeCloseTo(100 / 30, 6);
  });
});
