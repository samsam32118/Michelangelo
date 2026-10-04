import { describe, it, expect } from 'vitest';
import { MediaFrames, mediaRequests, pool } from '../../src/render/frames.js';
import type { MediaBackend, VideoReader } from '../../src/media/types.js';
import type { DisplayNode, MediaSource, RGBAFrame } from '../../src/render/types.js';

const SRC_W = 400, SRC_H = 200;
const frameOf = (max: { w: number; h: number } | undefined, tag: number): RGBAFrame => {
  const s = Math.min(1, (max?.w ?? SRC_W) / SRC_W, (max?.h ?? SRC_H) / SRC_H);
  const w = Math.round(SRC_W * s), h = Math.round(SRC_H * s);
  const data = new Uint8Array(w * h * 4);
  data[0] = tag;
  return { width: w, height: h, data };
};

function fakeBackend() {
  const log = { opens: [] as { file: string; maxSize?: { w: number; h: number } }[], reads: [] as [number, number][], images: 0, grabs: 0, closed: 0 };
  const backend = {
    async openVideo(file, o) {
      const id = log.opens.length;
      log.opens.push({ file, ...(o.maxSize ? { maxSize: o.maxSize } : {}) });
      let pos = -1;
      const r: VideoReader = {
        async frame(sf) { if (sf < pos) throw new Error('backward read'); pos = sf; log.reads.push([id, sf]); return frameOf(o.maxSize, sf & 255); },
        async close() { log.closed++; },
      };
      return r;
    },
    async decodeImage(_f, max) { log.images++; return frameOf(max, 1); },
    async grab(_f, sf, _r, o) { log.grabs++; return frameOf(o?.maxSize, sf & 255); },
  } as Partial<MediaBackend> as MediaBackend;
  return { backend, log };
}

const src = (sourceFrame: number, o: Partial<MediaSource> = {}): MediaSource =>
  ({ type: 'media', assetId: 'a', src: 'a.mp4', kind: 'video', sourceFrame, rate: { num: 30, den: 1 }, filters: [], fit: 'cover', ...o });

describe('MediaFrames (sequential)', () => {
  it('keeps one reader open across sequential frames and decodes at the drawn size', async () => {
    const { backend, log } = fakeBackend();
    const fr = new MediaFrames({ backend, baseDir: '/p' });
    for (let f = 0; f < 10; f++) expect((await fr.get(src(f), { w: 100, h: 50 })).data[0]).toBe(f);
    expect(log.opens).toEqual([{ file: '/p/a.mp4', maxSize: { w: 100, h: 50 } }]);
    // a repeat request (prefetch then draw) is served without decoding again
    await fr.get(src(9), { w: 100, h: 50 });
    expect(log.reads.length).toBe(10);
    await fr.close();
    expect(log.closed).toBe(1);
  });

  it('gives two clips of the same asset their own readers (no ping-pong seeking)', async () => {
    const { backend, log } = fakeBackend();
    const fr = new MediaFrames({ backend, baseDir: '/p' });
    for (let f = 0; f < 5; f++) {
      await fr.get(src(f), { w: 100, h: 50 });
      await fr.get(src(500 + f), { w: 100, h: 50 });
    }
    expect(log.opens.length).toBe(2);
    expect(log.reads.filter(([id]) => id === 0).map(([, f]) => f)).toEqual([0, 1, 2, 3, 4]);
    expect(log.reads.filter(([id]) => id === 1).map(([, f]) => f)).toEqual([500, 501, 502, 503, 504]);
  });

  it('reopens a reader larger when the layer is drawn bigger, not when smaller', async () => {
    const { backend, log } = fakeBackend();
    const fr = new MediaFrames({ backend, baseDir: '/p' });
    await fr.get(src(0), { w: 100, h: 50 });
    await fr.get(src(1), { w: 60, h: 30 });
    expect(log.opens.length).toBe(1);
    await fr.get(src(2), { w: 200, h: 100 });
    expect(log.opens.length).toBe(2);
    expect(log.opens[1]!.maxSize).toEqual({ w: 250, h: 126 });
    await fr.get(src(3), { w: 210, h: 105 });
    expect(log.opens.length).toBe(2);
  });

  it('decodes images once and re-decodes only when drawn larger', async () => {
    const { backend, log } = fakeBackend();
    const fr = new MediaFrames({ backend, baseDir: '/p' });
    const img = src(0, { kind: 'image', src: '/abs/logo.png' });
    await fr.get(img, { w: 100, h: 50 });
    await fr.get(img, { w: 80, h: 40 });
    expect(log.images).toBe(1);
    await fr.get(img, { w: 300, h: 150 });
    expect(log.images).toBe(2);
    // at full source size: never again
    await fr.get(img, { w: 900, h: 450 });
    await fr.get(img, { w: 1000, h: 500 });
    expect(log.images).toBe(3);
  });
});

describe('MediaFrames (random) and helpers', () => {
  it('grabs frames for stills, coalescing identical requests', async () => {
    const { backend, log } = fakeBackend();
    const fr = new MediaFrames({ backend, baseDir: '/p', mode: 'random' });
    await Promise.all([fr.prefetch(src(40), { w: 100, h: 50 }), fr.prefetch(src(40), { w: 100, h: 50 }), fr.prefetch(src(7), { w: 100, h: 50 })]);
    expect(log.grabs).toBe(2);
    expect((await fr.get(src(40), { w: 90, h: 45 })).data[0]).toBe(40);
    expect(log.grabs).toBe(2);
    expect(log.opens.length).toBe(0);
  });

  it('computes the size the renderer will ask for, through nested comps and transitions', () => {
    const media = src(0);
    const layer = (matrix: [number, number, number, number, number, number], source: unknown, box = { w: 400, h: 200 }): DisplayNode =>
      ({ type: 'layer', clipId: 'x', box, matrix, opacity: 1, blend: 'normal', fx: [], masks: [], localFrame: 0, seed: 1, source }) as DisplayNode;
    const nested = layer([0.5, 0, 0, 0.5, 0, 0], { type: 'comp', list: { compId: 'c', width: 100, height: 100, frame: 0, rate: { num: 30, den: 1 }, nodes: [layer([1, 0, 0, 1, 0, 0], media)] } }, { w: 100, h: 100 });
    const tr: DisplayNode = { type: 'transition', clipId: 't', transition: { type: 'crossfade', params: {} }, progress: 0.5, from: [layer([2, 0, 0, 2, 0, 0], media)], to: [] };
    const r = mediaRequests([nested, tr], [0.5, 0, 0, 0.5, 0, 0]);
    expect(r.map((x) => x.size)).toEqual([{ w: 100, h: 50 }, { w: 400, h: 200 }]);
  });

  it('pool keeps order and limits concurrency', async () => {
    let live = 0, peak = 0;
    const out = await pool([1, 2, 3, 4, 5, 6], 2, async (x) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return x * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
});
