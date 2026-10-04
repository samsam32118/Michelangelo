import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { evaluate, evaluateLayers, interpolate, ease, resolveStyle, EASING_FUNCTIONS, compLength, type EvaluateOptions } from '../../src/render/evaluate.js';
import { apply } from '../../src/render/matrix.js';
import { PluginRegistry } from '../../src/plugin/registry.js';
import { definePlugin, defineEffect, defineTransition, defineTextAnimation } from '../../src/plugin/api.js';
import { EASINGS, type Clip, type ProjectFile } from '../../src/core/schema/index.js';
import type { LayerNode, TextLayouter, TransitionNode, MediaSource } from '../../src/render/types.js';

const fakeLayouter: TextLayouter = {
  layout(text, st) {
    const t = st.uppercase ? text.toUpperCase() : text;
    const cw = st.size * 0.5, lh = st.size * st.lineHeight;
    let x = 0;
    const words = t.split(/\s+/).filter(Boolean).map((w) => { const r = { text: w, x, y: 0, w: w.length * cw, h: lh, line: 0 }; x += (w.length + 1) * cw; return r; });
    const w = Math.max(1, t.length * cw);
    return { w, h: lh, size: st.size, lines: [{ text: t, x: 0, y: 0, w, baseline: st.size }], words };
  },
};

const registry = new PluginRegistry().add(definePlugin({
  name: 'test',
  effects: [
    defineEffect({ type: 'blur', describe: 'b', params: z.object({ radius: z.number().default(5), amount: z.number().default(1) }), draw() {} }),
    defineEffect({ type: 'tint', describe: 't', params: z.object({ s: z.number().default(0) }), source: (p) => [{ filter: 'hue', args: { s: p.s } }] }),
  ],
  transitions: [defineTransition({ type: 'crossfade', describe: 'c', params: z.object({ curve: z.string().default('linear') }), draw() {} })],
  textAnimations: [defineTextAnimation({ id: 'fade', describe: 'f', state: (p) => ({ opacity: p, dy: (1 - p) * 20 }), easing: 'linear' })],
  styles: [{ id: 'title', describe: 't', style: { size: 100, color: '#ff0000', font: 'Anton' } }],
}));

const opts: EvaluateOptions = {
  layouter: fakeLayouter,
  registry,
  assetKind: (id) => (id.startsWith('img') ? 'image' : id.startsWith('aud') ? 'audio' : 'video'),
  media: (id) => (id === 'vid' ? { width: 1920, height: 1080, duration: 100 } : undefined),
};

function project(clips: Partial<Clip>[], extra: Partial<ProjectFile> = {}): ProjectFile {
  return {
    michelangelo: 1,
    assets: [{ id: 'vid', src: 'v.mp4' }, { id: 'img', src: 'i.png' }],
    comps: [{ id: 'main', size: [1080, 1920], fps: 30 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }],
    ...extra,
    clips: clips.map((c, i) => ({ id: `c${i}`, track: 'V1', at: 0, len: 30, ...c }) as Clip),
  };
}
const layer = (p: ProjectFile, f: number, i = 0) => evaluate(p, 'main', f, opts).nodes[i] as LayerNode;

describe('keyframes and easing', () => {
  it('every easing starts at 0 and ends at 1 (hold stays at 0)', () => {
    for (const e of EASINGS) {
      expect(ease(e, 0)).toBeCloseTo(0, 6);
      expect(ease(e, 1)).toBeCloseTo(e === 'hold' ? 0 : 1, 6);
      expect(EASING_FUNCTIONS[e]).toBeTypeOf('function');
    }
  });
  it('interpolates linearly, with the segment easing of the starting key, and holds at the edges', () => {
    const k: [number, number, unknown?][] = [[0, 0], [10, 100, 'hold'], [20, 200, 'inQuad'], [30, 300]];
    expect(interpolate(k as never, -5)).toBe(0);
    expect(interpolate(k as never, 5)).toBe(50);
    expect(interpolate(k as never, 15)).toBe(100);
    expect(interpolate(k as never, 25)).toBeCloseTo(225);
    expect(interpolate(k as never, 40)).toBe(300);
    expect(interpolate(7 as never, 3)).toBe(7);
  });
  it('supports cubic-bezier arrays and vector values', () => {
    expect(interpolate([[0, 0, [0.42, 0, 0.58, 1]], [10, 1]] as never, 5)).toBeCloseTo(0.5, 4);
    expect(interpolate([[0, 0, [0.42, 0, 0.58, 1]], [10, 1]] as never, 2)).toBeLessThan(0.2);
    expect(interpolate([[0, [1, 2]], [10, [3, 4]]] as never, 5)).toEqual([2, 3]);
    expect(interpolate([[0, 1], [10, [3, 5]]] as never, 5)).toEqual([2, 3]);
  });
});

describe('transform', () => {
  it('defaults: centred in the comp, anchor in the middle of the box', () => {
    const n = layer(project([{ color: '#ff0000' }]), 0);
    expect(n.box).toEqual({ w: 1080, h: 1920 });
    expect(apply(n.matrix, 0, 0)).toEqual([0, 0]);
    const t = layer(project([{ text: 'abcd', x: 100, y: 200, anchor: [0, 0] }]), 0);
    expect(t.box).toEqual({ w: 4 * 36, h: 72 * 1.2 });
    expect(apply(t.matrix, 0, 0)).toEqual([100, 200]);
  });
  it('rotates clockwise around the anchor and scales per axis', () => {
    const n = layer(project([{ shape: { type: 'rect', size: [100, 50] }, x: 500, y: 500, rotate: 90, scale: [2, 1] }]), 0);
    const [x, y] = apply(n.matrix, 100, 25); // right-middle of the box
    expect(x).toBeCloseTo(500);
    expect(y).toBeCloseTo(600);
  });
  it('a child follows its parent\'s motion since the parent\'s first frame', () => {
    const p = project([
      { id: 'par', shape: { type: 'rect', size: [10, 10] }, x: [[0, 500], [10, 600]], y: 500, len: 60 },
      { id: 'kid', track: 'V2', shape: { type: 'rect', size: [10, 10] }, x: 700, y: 500, parent: 'par', len: 60 },
    ]);
    const kid0 = layer(p, 0, 1), kid10 = layer(p, 10, 1);
    expect(apply(kid0.matrix, 5, 5)[0]).toBeCloseTo(700);
    expect(apply(kid10.matrix, 5, 5)[0]).toBeCloseTo(800);
    const rot = project([
      { id: 'par', shape: { type: 'rect', size: [10, 10] }, x: 500, y: 500, rotate: [[0, 0], [10, 90]], len: 60 },
      { id: 'kid', track: 'V2', shape: { type: 'rect', size: [10, 10] }, x: 600, y: 500, parent: 'par', len: 60 },
    ]);
    const [kx, ky] = apply(layer(rot, 10, 1).matrix, 5, 5);
    expect(kx).toBeCloseTo(500);
    expect(ky).toBeCloseTo(600);
  });
  it('fades opacity in and out over the fade frames', () => {
    const p = project([{ color: '#fff', fade: [10, 10] }]);
    expect(layer(p, 0).opacity).toBe(0);
    expect(layer(p, 5).opacity).toBeCloseTo(0.5);
    expect(layer(p, 15).opacity).toBe(1);
    expect(layer(p, 29).opacity).toBe(0);
  });
});

describe('media time', () => {
  const src = (p: ProjectFile, f: number) => (layer(p, f).source as MediaSource);
  it('maps comp frames to source frames with rational speed, freeze and remap', () => {
    expect(src(project([{ asset: 'vid', in: 10, speed: '3/2' }]), 5).sourceFrame).toBe(17);
    expect(src(project([{ asset: 'vid', in: 10, speed: 0 }]), 20).sourceFrame).toBe(10);
    expect(src(project([{ asset: 'vid', remap: [[0, 100], [10, 200]] }]), 5).sourceFrame).toBe(150);
    expect(src(project([{ asset: 'vid', in: 2995, len: 30 }]), 20).sourceFrame).toBe(2999); // 100 s × 30 fps: last frame held
    expect(src(project([{ asset: 'vid', in: 2995, len: 30, loop: true }]), 20).sourceFrame).toBe(15);
  });
  it('fits media: cover for video, contain for images', () => {
    const v = layer(project([{ asset: 'vid' }]), 0);
    expect(v.box.h).toBeCloseTo(1920);
    expect(v.box.w).toBeCloseTo(1920 * 16 / 9);
    expect((v.source as MediaSource).fit).toBe('cover');
    expect((layer(project([{ asset: 'img' }]), 0).source as MediaSource).fit).toBe('contain');
    expect(evaluate(project([{ asset: 'aud' }]), 'main', 0, opts).nodes).toHaveLength(0);
  });
  it('split keeps the animation clock and the source position continuous', () => {
    const whole = project([{ text: 'one two three', len: 60, animate: { in: 'fade', by: 'word', stagger: 10, len: 20 } }, { track: 'V2', asset: 'vid', in: 5, len: 60, speed: 2 }]);
    const split = project([
      { text: 'one two three', at: 30, len: 30, clock: 30, animate: { in: 'fade', by: 'word', stagger: 10, len: 20 } },
      { track: 'V2', asset: 'vid', at: 30, in: 65, len: 30, speed: 2 },
    ]);
    for (const f of [30, 35, 41]) {
      const a = evaluate(whole, 'main', f, opts).nodes as LayerNode[], b = evaluate(split, 'main', f, opts).nodes as LayerNode[];
      expect((b[0]!.source as { animate: unknown }).animate).toEqual((a[0]!.source as { animate: unknown }).animate);
      expect((b[1]!.source as MediaSource).sourceFrame).toBe((a[1]!.source as MediaSource).sourceFrame);
    }
    const st = (layer(whole, 15).source as { animate: { units: { opacity: number }[] } }).animate.units;
    expect(st.map((u) => u.opacity)).toEqual([0.75, 0.25, 0]);
  });
});

describe('nested comps', () => {
  const p = project([{ comp: 'kid', at: 10, len: 100 }], {
    comps: [{ id: 'main', size: [1080, 1920], fps: 30 }, { id: 'kid', size: [640, 360], fps: 24, length: 48 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'K1', comp: 'kid' }],
  });
  p.clips!.push({ id: 'k', track: 'K1', at: 0, len: 48, color: '#00ff00' } as Clip);
  const child = (pp: ProjectFile, f: number) => (layer(pp, f).source as { list: { frame: number } | null }).list;
  it('maps parent frames to child frames at 24 in 30', () => {
    expect(layer(p, 10).box).toEqual({ w: 640, h: 360 });
    expect(child(p, 10)!.frame).toBe(0);
    expect(child(p, 40)!.frame).toBe(24);
    expect(child(p, 41)!.frame).toBe(24);
    expect(child(p, 42)!.frame).toBe(25);
    expect(child(p, 69)!.frame).toBe(47);
    expect(child(p, 70)).toBeNull();
    const looped = structuredClone(p);
    looped.clips![0]!.loop = true;
    expect(child(looped, 70)!.frame).toBe(0);
    expect(compLength(p, 'kid')).toBe(48);
  });
});

describe('transitions', () => {
  const p = project([
    { id: 'a', asset: 'vid', in: 100, len: 30 },
    { id: 'b', asset: 'vid', at: 30, in: 50, len: 30, transition: { in: { type: 'crossfade', len: 10 } } },
  ]);
  it('is centred on the cut with handles on both sides', () => {
    expect((evaluate(p, 'main', 24, opts).nodes[0] as LayerNode).clipId).toBe('a');
    const t25 = evaluate(p, 'main', 25, opts).nodes[0] as TransitionNode;
    expect(t25.type).toBe('transition');
    expect(t25.progress).toBe(0);
    expect(t25.transition).toEqual({ type: 'crossfade', params: { curve: 'linear' } });
    expect(((t25.to[0] as LayerNode).source as MediaSource).sourceFrame).toBe(45); // b started 5 frames early
    const t30 = evaluate(p, 'main', 30, opts).nodes[0] as TransitionNode;
    expect(t30.progress).toBe(0.5);
    const t34 = evaluate(p, 'main', 34, opts).nodes[0] as TransitionNode;
    expect(t34.progress).toBeCloseTo(0.9);
    expect(((t34.from[0] as LayerNode).source as MediaSource).sourceFrame).toBe(134); // a extended past its end
    expect((evaluate(p, 'main', 35, opts).nodes[0] as LayerNode).clipId).toBe('b');
  });
  it('honours align start/end, from nothing and to nothing', () => {
    const start = structuredClone(p);
    start.clips![1]!.transition!.in!.align = 'start';
    expect(evaluate(start, 'main', 29, opts).nodes[0]!.type).toBe('layer');
    expect((evaluate(start, 'main', 30, opts).nodes[0] as TransitionNode).progress).toBe(0);
    const end = structuredClone(p);
    end.clips![1]!.transition!.in!.align = 'end';
    expect((evaluate(end, 'main', 20, opts).nodes[0] as TransitionNode).progress).toBe(0);
    expect(evaluate(end, 'main', 30, opts).nodes[0]!.type).toBe('layer');
    const lone = project([{ color: '#fff', at: 10, len: 30, transition: { in: { type: 'crossfade', len: 6 }, out: { type: 'crossfade', len: 4 } } }]);
    const tin = evaluate(lone, 'main', 10, opts).nodes[0] as TransitionNode;
    expect(tin.from).toEqual([]);
    expect(tin.to).toHaveLength(1);
    const tout = evaluate(lone, 'main', 38, opts).nodes[0] as TransitionNode;
    expect(tout.to).toEqual([]);
    expect(tout.progress).toBe(0.5);
    expect(evaluate(lone, 'main', 9, opts).nodes).toHaveLength(0);
  });
  it('names unknown transitions with a fix', () => {
    const bad = project([{ color: '#fff', transition: { in: { type: 'crosfade', len: 4 } } }]);
    expect(() => evaluate(bad, 'main', 0, opts)).toThrow(/crosfade/);
    try { evaluate(bad, 'main', 0, opts); } catch (e) { expect((e as { fix: string }).fix).toMatch(/crossfade/); }
  });
});

describe('captions', () => {
  const p = (words?: number[], maxWords?: number) => project([{ id: 'subs', captions: true, len: 60, style: { maxWords } }], {
    cues: [{ id: 'q1', clip: 'subs', at: 0, len: 30, text: 'one two three', ...(words ? { words } : {}) }],
  });
  it('marks words past, active and future from word offsets or evenly spread', () => {
    for (const w of [[0, 10, 20], undefined]) {
      const s = layer(p(w), 15).source as { words: { text: string; state: string }[]; text: string };
      expect(s.words.map((x) => x.state)).toEqual(['past', 'active', 'future']);
      expect(s.text).toBe('one two three');
    }
    expect(evaluate(p(), 'main', 40, opts).nodes).toHaveLength(0);
  });
  it('pages by maxWords', () => {
    const s = layer(p([0, 10, 20], 2), 25).source as { text: string; words: { state: string }[] };
    expect(s.text).toBe('three');
    expect(s.words[0]!.state).toBe('active');
  });
  it('balances the pages: 4 words at maxWords 3 show 2 + 2, never 3 + 1', () => {
    const four = (f: number) => (layer(project([{ id: 'subs', captions: true, len: 60, style: { maxWords: 3 } }], {
      cues: [{ id: 'q1', clip: 'subs', at: 0, len: 40, text: 'one two three four', words: [0, 10, 20, 30] }],
    }), f).source as { text: string }).text;
    expect(four(5)).toBe('one two');
    expect(four(15)).toBe('one two');
    expect(four(25)).toBe('three four');
    expect(four(35)).toBe('three four');
  });
});

describe('effects, masks, mattes, styles', () => {
  it('resolves keyframed params and fills defaults; source-stage effects go to filters', () => {
    const n = layer(project([{ asset: 'vid', fx: [{ type: 'blur', amount: [[0, 0], [10, 1]] }, { type: 'tint', s: 2 }, { type: 'blur', enabled: false }] }]), 5);
    expect(n.fx).toEqual([{ type: 'blur', params: { radius: 5, amount: 0.5 } }]);
    expect((n.source as MediaSource).filters).toEqual([{ filter: 'hue', args: { s: 2 } }]);
    expect(() => layer(project([{ color: '#fff', fx: [{ type: 'blurr' }] }]), 0)).toThrow(/blurr/);
    expect(() => layer(project([{ color: '#fff', fx: [{ type: 'blur', radius: 'x' }] }]), 0)).toThrow(/radius/);
  });
  it('resolves clip-space masks to layer px', () => {
    const n = layer(project([{ shape: { type: 'rect', size: [200, 100] }, masks: [{ shape: 'ellipse', space: 'clip', box: [0, 0, 0.5, 1] }, { shape: 'rect', box: [1, 2, 3, 4] }] }]), 0);
    expect(n.masks[0]!.box).toEqual([0, 0, 100, 100]);
    expect(n.masks[1]!.box).toEqual([1, 2, 3, 4]);
  });
  it('a matte clip is hidden and referenced unless keep', () => {
    const p = project([{ id: 'fill', color: '#f00', matte: { clip: 'm' } }, { id: 'm', track: 'V2', text: 'HI' }]);
    const nodes = evaluate(p, 'main', 0, opts).nodes as LayerNode[];
    expect(nodes.map((n) => n.clipId)).toEqual(['fill']);
    expect(nodes[0]!.matte!.node.clipId).toBe('m');
    expect(nodes[0]!.matte!.mode).toBe('alpha');
    p.clips![0]!.matte!.keep = true;
    expect(evaluate(p, 'main', 0, opts).nodes).toHaveLength(2);
  });
  it('resolves styles through project styles, base chains, built-ins and inline overrides', () => {
    const p = project([], { styles: [{ id: 'big', base: 'title', size: 140 }, { id: 'loud', base: 'big', color: '#00ff00' }] });
    const s = resolveStyle({ base: 'loud', italic: true }, p, registry.styles);
    expect(s).toMatchObject({ font: 'Anton', size: 140, color: '#00ff00', italic: true, align: 'center', lineHeight: 1.2, weight: 700 });
    expect(resolveStyle(undefined, p, registry.styles)).toMatchObject({ font: 'Inter', size: 72, color: '#ffffff' });
    expect(() => resolveStyle('nope', p, registry.styles)).toThrow(/nope/);
  });
  it('evaluateLayers gives comp-px boxes', () => {
    const boxes = evaluateLayers(project([{ text: 'abcd', x: 100, y: 200, anchor: [0, 0] }, { track: 'V2', color: '#000', hidden: true }]), 'main', 0, opts);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ clipId: 'c0', kind: 'text', text: 'abcd', fontPx: 72 });
    boxes[0]!.box.forEach((v, i) => expect(v).toBeCloseTo([100, 200, 144, 86.4][i]!));
  });
  it('skips hidden tracks and clips outside their span', () => {
    const p = project([{ color: '#fff', at: 10, len: 5 }]);
    expect(evaluate(p, 'main', 9, opts).nodes).toHaveLength(0);
    expect(evaluate(p, 'main', 14, opts).nodes).toHaveLength(1);
    expect(evaluate(p, 'main', 15, opts).nodes).toHaveLength(0);
    p.tracks![0]!.hidden = true;
    expect(evaluate(p, 'main', 12, opts).nodes).toHaveLength(0);
  });
});
