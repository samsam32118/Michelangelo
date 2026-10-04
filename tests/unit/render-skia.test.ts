import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { skiaRenderer } from '../../src/render/skia/index.js';
import { evaluate, type EvaluateOptions } from '../../src/render/evaluate.js';
import { createTextLayouter } from '../../src/render/text.js';
import { PluginRegistry } from '../../src/plugin/registry.js';
import { definePlugin, defineTransition, defineEffect } from '../../src/plugin/api.js';
import type { Clip, ProjectFile } from '../../src/core/schema/index.js';
import type { FrameProvider, RenderSession, RGBAFrame, ResolvedTextStyle } from '../../src/render/types.js';

const W = 200, H = 120;

const registry = new PluginRegistry().add(definePlugin({
  name: 'test',
  transitions: [defineTransition({
    type: 'crossfade', describe: 'mix', params: z.object({}),
    draw({ from, to, dst, progress }) {
      dst.ctx.globalAlpha = 1 - progress; dst.ctx.drawImage(from.canvas, 0, 0);
      dst.ctx.globalCompositeOperation = 'lighter';
      dst.ctx.globalAlpha = progress; dst.ctx.drawImage(to.canvas, 0, 0);
    },
  })],
  effects: [defineEffect({
    type: 'invert', describe: 'invert rgb', params: z.object({}),
    draw({ src, dst }) { const px = src.pixels(); for (let i = 0; i < px.length; i += 4) { px[i] = 255 - px[i]!; px[i + 1] = 255 - px[i + 1]!; px[i + 2] = 255 - px[i + 2]!; } src.commit(); dst.ctx.drawImage(src.canvas, 0, 0); },
  })],
}));

/** A synthetic media source: left half red, right half blue, at the requested size. */
const frames: FrameProvider = {
  async get(_src, max): Promise<RGBAFrame> {
    const w = Math.min(max.w, 160), h = Math.min(max.h, 90);
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x < w / 2 ? 255 : 0; data[i + 2] = x < w / 2 ? 0 : 255; data[i + 3] = 255;
    }
    return { width: w, height: h, data };
  },
};

let session: RenderSession;
let opts: EvaluateOptions;
beforeAll(async () => {
  session = await skiaRenderer.open({ width: W, height: H, registry });
  opts = { layouter: session.layouter, registry, assetKind: () => 'video', media: () => ({ width: 160, height: 90, duration: 10 }) };
});

function project(clips: Partial<Clip>[], bg = '#000000'): ProjectFile {
  return {
    michelangelo: 1,
    assets: [{ id: 'vid', src: 'v.mp4' }],
    comps: [{ id: 'main', size: [W, H], fps: 30, bg }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }, { id: 'V3', comp: 'main' }],
    clips: clips.map((c, i) => ({ id: `c${i}`, track: `V${i + 1}`, at: 0, len: 30, ...c }) as Clip),
  };
}

async function draw(p: ProjectFile, f = 0) {
  const img = await session.drawFrame(evaluate(p, 'main', f, opts), frames);
  expect(img.width).toBe(W);
  expect(img.data.length).toBe(W * H * 4);
  return (x: number, y: number) => Array.from(img.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
}
const near = (a: number[], b: number[], tol = 3) => a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThanOrEqual(tol));

describe('skia renderer', () => {
  it('draws the background and solid colours', async () => {
    near((await draw(project([]), 0))(5, 5), [0, 0, 0, 255]);
    const px = await draw(project([{ color: '#ff0000' }]));
    near(px(0, 0), [255, 0, 0, 255]);
    near(px(W - 1, H - 1), [255, 0, 0, 255]);
  });

  it('blends screen vs multiply', async () => {
    const screen = await draw(project([{ color: '#808080' }, { color: '#808080', blend: 'screen' }]));
    const mult = await draw(project([{ color: '#808080' }, { color: '#808080', blend: 'multiply' }]));
    near(screen(50, 50), [192, 192, 192, 255]);
    near(mult(50, 50), [64, 64, 64, 255]);
  });

  it('applies opacity', async () => {
    near((await draw(project([{ color: '#ffffff', opacity: 0.5 }])))(10, 10), [128, 128, 128, 255]);
  });

  it('cuts with an ellipse mask: centre kept, corners removed', async () => {
    const px = await draw(project([{ color: '#ffffff', masks: [{ shape: 'ellipse', box: [0, 0, W, H] }] }]));
    near(px(W / 2, H / 2), [255, 255, 255, 255]);
    near(px(2, 2), [0, 0, 0, 255]);
    const inv = await draw(project([{ color: '#ffffff', masks: [{ shape: 'ellipse', box: [0, 0, W, H], invert: true }] }]));
    near(inv(W / 2, H / 2), [0, 0, 0, 255]);
    near(inv(2, 2), [255, 255, 255, 255]);
  });

  it('rotates layers around the anchor', async () => {
    const p = project([{ shape: { type: 'rect', size: [100, 10], fill: '#00ff00' }, x: 100, y: 60, rotate: 90 }]);
    const px = await draw(p);
    near(px(100, 100), [0, 255, 0, 255]);
    near(px(140, 60), [0, 0, 0, 255]);
  });

  it('renders text with pixels in the expected region only', async () => {
    const px = await draw(project([{ text: 'HI', style: { size: 60, color: '#ffffff' }, x: 100, y: 60 }]));
    let lit = 0, outside = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = px(x, y)[0]!;
      if (v > 128) { if (x > 50 && x < 150 && y > 20 && y < 100) lit++; else outside++; }
    }
    expect(lit).toBeGreaterThan(200);
    expect(outside).toBe(0);
  });

  it('highlights the active caption word', async () => {
    const p = project([{ id: 'subs', captions: true, style: { size: 30, color: '#ffffff', highlight: '#ff0000' } }]);
    p.cues = [{ id: 'q', clip: 'subs', at: 0, len: 30, text: 'AA BB', words: [0, 15] }];
    const px = await draw(p, 20);
    let red = 0, white = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const [r, g] = px(x, y);
      if (r! > 200 && g! < 60) { red++; expect(x).toBeGreaterThan(W / 2 - 5); }
      if (r! > 200 && g! > 200) white++;
    }
    expect(red).toBeGreaterThan(50);
    expect(white).toBeGreaterThan(50);
  });

  it('draws *marked* caption words in emphasisColor (the spoken word keeps highlight)', async () => {
    const p = project([{ id: 'subs', captions: true, style: { size: 30, color: '#ffffff', highlight: '#ff0000', emphasisColor: '#00ff00' } }]);
    p.cues = [{ id: 'q', clip: 'subs', at: 0, len: 30, text: 'AA *BB*', words: [0, 15] }];
    const count = async (f: number) => {
      const px = await draw(p, f);
      let red = 0, green = 0, star = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const [r, g, b] = px(x, y);
        if (r! > 200 && g! < 60) red++;
        if (g! > 200 && r! < 60 && b! < 60) { green++; expect(x).toBeGreaterThan(W / 2 - 5); }
        if (r! > 200 && g! > 200 && b! > 200) star++;
      }
      return { red, green, star };
    };
    const a = await count(5); // AA spoken (red), BB emphasised (green)
    expect(a.red).toBeGreaterThan(50);
    expect(a.green).toBeGreaterThan(50);
    expect(a.star).toBe(0); // no white: the asterisks are not drawn
    const b = await count(20); // BB spoken: highlight wins
    expect(b.green).toBe(0);
    expect(b.red).toBeGreaterThan(50);
  });

  it('draws media frames with fit and runs layer effects', async () => {
    const px = await draw(project([{ asset: 'vid', fit: 'contain' }]));
    near(px(30, 60), [255, 0, 0, 255]);
    near(px(170, 60), [0, 0, 255, 255]);
    const inv = await draw(project([{ asset: 'vid', fit: 'contain', fx: [{ type: 'invert' }] }]));
    near(inv(30, 60), [0, 255, 255, 255]);
  });

  it('crossfades at the midpoint of a transition', async () => {
    const p = project([{ id: 'a', color: '#ff0000', len: 30 }, { id: 'b', color: '#0000ff', at: 30, len: 30, track: 'V1', transition: { in: { type: 'crossfade', len: 10 } } }]);
    const px = await draw(p, 30);
    near(px(50, 50), [128, 0, 128, 255], 4);
    near((await draw(p, 36))(50, 50), [0, 0, 255, 255]);
  });

  it('shows a layer only through its alpha matte', async () => {
    const p = project([{ color: '#ffffff', matte: { clip: 'm' } }, { id: 'm', shape: { type: 'rect', size: [50, 50] }, x: 50, y: 60 }]);
    const px = await draw(p);
    near(px(50, 60), [255, 255, 255, 255]);
    near(px(150, 60), [0, 0, 0, 255]);
  });

  it('renders a nested comp into its box', async () => {
    const p = project([{ comp: 'kid', x: 50, y: 30 }]);
    p.comps.push({ id: 'kid', size: [40, 20], fps: 30, bg: '#00ff00', length: 30 });
    p.tracks!.push({ id: 'K', comp: 'kid' });
    const px = await draw(p);
    near(px(50, 30), [0, 255, 0, 255]);
    near(px(100, 60), [0, 0, 0, 255]);
  });
});

describe('skia renderer: shapes, adjustment, styled text', () => {
  it('trims outlines, fills gradients, stars and paths', async () => {
    const trim = await draw(project([{ shape: { type: 'rect', size: [100, 100], fill: 'none', stroke: '#ffffff', strokeWidth: 6, trim: 0.25 }, x: 100, y: 60 }]));
    near(trim(70, 10), [255, 255, 255, 255]); // top edge, first quarter of the outline
    near(trim(50, 100), [0, 0, 0, 255]); // bottom-left corner region not drawn
    const grad = await draw(project([{ shape: { type: 'rect', size: [W, H], gradient: { type: 'linear', stops: [[0, '#000000'], [1, '#ffffff']] } } }]));
    expect(grad(10, 60)[0]!).toBeLessThan(40);
    expect(grad(190, 60)[0]!).toBeGreaterThan(215);
    const star = await draw(project([{ shape: { type: 'star', size: [100, 100], fill: '#ff0000' }, x: 100, y: 60 }]));
    near(star(100, 60), [255, 0, 0, 255]);
    near(star(55, 15), [0, 0, 0, 255]);
    const path = await draw(project([{ shape: { type: 'path', d: 'M0 0 L40 0 L40 40 Z', size: [40, 40], fill: '#00ff00' }, x: 100, y: 60 }]));
    near(path(115, 50), [0, 255, 0, 255]);
    near(path(85, 75), [0, 0, 0, 255]);
  });

  it('applies adjustment effects to everything below, within masks', async () => {
    const px = await draw(project([{ color: '#ff0000' }, { adjustment: true, fx: [{ type: 'invert' }], masks: [{ shape: 'rect', box: [0, 0, 100, H] }] }]));
    near(px(50, 60), [0, 255, 255, 255]);
    near(px(150, 60), [255, 0, 0, 255]);
  });

  it('feathers masks and uses luma mattes', async () => {
    const f = await draw(project([{ color: '#ffffff', masks: [{ shape: 'rect', box: [100, -100, 300, H + 200], feather: 20 }] }]));
    expect(f(100, 60)[0]!).toBeGreaterThan(60);
    expect(f(100, 60)[0]!).toBeLessThan(200);
    near(f(190, 60), [255, 255, 255, 255], 6);
    const luma = await draw(project([{ color: '#ffffff', matte: { clip: 'm', mode: 'luma' } }, { id: 'm', color: '#808080' }]));
    near(luma(50, 60), [128, 128, 128, 255], 6);
  });

  it('draws background boxes, strokes and animated units', async () => {
    const bg = await draw(project([{ text: 'x', style: { size: 20, color: '#000000', bg: '#0000ff', bgPadding: 30 }, x: 100, y: 60 }]));
    near(bg(75, 40), [0, 0, 255, 255]);
    const reg = new PluginRegistry().add(definePlugin({ name: 'anim', textAnimations: [{ id: 'up', describe: 'u', state: (p) => ({ opacity: p, dy: (1 - p) * 30 }), easing: 'linear' }] }));
    const p = project([{ text: 'HI HI', style: { size: 30, stroke: '#ff0000', strokeWidth: 3 }, animate: { in: 'up', by: 'word', stagger: 0, len: 10 } }]);
    const list = evaluate(p, 'main', 5, { ...opts, registry: Object.assign(Object.create(registry), { textAnimations: reg.textAnimations }) });
    const img = await session.drawFrame(list, frames);
    let red = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i]! > 60 && img.data[i + 1]! < 30) red++;
    expect(red).toBeGreaterThan(20);
  });
});

describe('text layouter', () => {
  const lay = createTextLayouter();
  const st = (o: Partial<ResolvedTextStyle> = {}): ResolvedTextStyle => ({ font: 'Inter', size: 40, color: '#fff', align: 'center', lineHeight: 1.2, letterSpacing: 0, weight: 700, ...o });
  it('wraps at maxWidth and reports word boxes', () => {
    const l = lay.layout('one two three four five six', st({ maxWidth: 200 }));
    expect(l.lines.length).toBeGreaterThan(1);
    expect(Math.max(...l.lines.map((x) => x.w))).toBeLessThanOrEqual(200.5);
    expect(l.words.map((w) => w.text)).toEqual(['one', 'two', 'three', 'four', 'five', 'six']);
    expect(l.h).toBeCloseTo(l.lines.length * 48, 0);
  });
  it('shrinks to fit maxLines and a box; uppercases; bold is wider', () => {
    const l = lay.layout('one two three four five six', st({ maxWidth: 200, maxLines: 1 }));
    expect(l.lines).toHaveLength(1);
    expect(l.size).toBeLessThan(40);
    const b = lay.layout('a long title that must fit', st({ box: [300, 60] }));
    expect(b.w).toBe(300);
    expect(b.h).toBe(60);
    expect(b.lines.length * b.size * 1.2).toBeLessThanOrEqual(60.5);
    expect(lay.layout('abc', st({ uppercase: true })).lines[0]!.text).toBe('ABC');
    expect(lay.layout('Hello', st({ weight: 900 })).w).toBeGreaterThan(lay.layout('Hello', st({ weight: 400 })).w);
  });
});
