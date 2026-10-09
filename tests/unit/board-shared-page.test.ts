import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { pageHtml } from '../../src/board/client/page.js';
import { applyLocal, nextId } from '../../src/board/client/local-ops.js';
import { drawBoard, shapeBounds } from '../../src/board/shared/shapes.js';
import type { Ctx2D } from '../../src/board/shared/canvas.js';
import type { BoardFile, Shape } from '../../src/board/shared/types.js';
import { OUTLINE } from './board-shared-fakectx.js';

describe('board page', () => {
  it('pageHtml is a full page that loads the client module, with the a11y anchors', () => {
    const html = pageHtml();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<script type="module" src="/app/client/main.js"></script>');
    for (const id of ['board', 'tools', 'panel', 'timeline', 'mgl-outline', 'toasts', 'help']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('aria-label="Board outline"');
    expect(html).toContain('prefers-color-scheme');
    expect(html).not.toMatch(/\son[a-z]+=/); // no inline handlers (strict CSP)
    expect(html).not.toMatch(/https?:\/\//); // no external requests
  });
});

describe('board local ops (optimistic copy)', () => {
  const base: BoardFile = { michelangeloBoard: 1, shapes: [
    { id: 'f1', type: 'frame', x: 0, y: 0, w: 400, h: 300 },
    { id: 'n1', type: 'note', x: 10, y: 10, parent: 'f1' },
    { id: 'n2', type: 'note', x: 500, y: 10 },
    { id: 'a1', type: 'arrow', x: 0, y: 0, from: 'n1', to: [900, 900] },
    { id: 'p1', type: 'pin', x: 0, y: 0, target: 'n1', text: 'hm' },
  ] as Shape[], rounds: [{ id: 'r1', goal: 'opening', fidelity: 1, status: 'open' }] };

  it('applies the common ops to a copy', () => {
    const r = applyLocal(base, [
      { op: 'shape.move', ids: ['f1'], dx: 5, dy: 5 },
      { op: 'shape.set', id: 'n2', props: { color: 'blue', text: 'hi' } },
      { op: 'shape.add', shape: { type: 'note', x: 1, y: 2, text: 'new' } },
      { op: 'brief.set', goal: 'a goal', add: { tone: ['calm'] } },
      { op: 'round.option', round: 'r1', option: { title: 'A' } },
      { op: 'round.option', round: 'r1', option: { title: 'B' } },
      { op: 'say', text: 'hello' },
      { op: 'shape.order', ids: ['n2'], to: 'back' },
    ], 'human');
    const b = r.board, get = (id: string) => b.shapes!.find((s) => s.id === id)!;
    expect(base.shapes![0]!.x).toBe(0); // the input is untouched
    expect([get('f1').x, get('n1').x]).toEqual([5, 15]);
    expect(get('n2')).toMatchObject({ color: 'blue', text: 'hi' });
    expect(get('n3')).toMatchObject({ text: 'new', by: 'human' });
    expect(b.brief).toEqual({ goal: 'a goal', tone: ['calm'] });
    expect(b.rounds![0]!.options!.map((o) => o.id)).toEqual(['r1a', 'r1b']);
    expect(b.log![0]).toMatchObject({ id: 'm1', by: 'human', text: 'hello' });
    expect(b.shapes![0]!.id).toBe('n2');
    expect(r.changed).toEqual(expect.arrayContaining(['f1', 'n1', 'n2', 'n3', 'brief', 'r1', 'm1']));
  });
  it('remove takes children and pins; bound arrows keep their last point', () => {
    const b = applyLocal(base, [{ op: 'shape.remove', id: 'f1' }], 'ai').board;
    expect(b.shapes!.map((s) => s.id)).toEqual(['n2', 'a1']);
    const a = b.shapes!.find((s) => s.id === 'a1') as Extract<Shape, { type: 'arrow' }>;
    expect(a.from).toEqual([110, 110]);
  });
  it('throws on what only the server can do', () => {
    expect(() => applyLocal(base, [{ op: 'storyboard.make', every: '3s' }], 'ai')).toThrow();
    expect(() => applyLocal(base, [{ op: 'shape.set', id: 'nope', props: {} }], 'ai')).toThrow();
    expect(() => applyLocal(base, [{ op: 'shape.add', shape: { id: 'n1', type: 'note', x: 0, y: 0 } }], 'ai')).toThrow();
    expect(nextId(base, 'n')).toBe('n3');
    expect(nextId(base, 'n', ['n7'])).toBe('n8');
  });
});

describe('board shapes on Skia', () => {
  it('draws on a real @napi-rs/canvas context (the snapshot path), not blank', () => {
    const shapes: Shape[] = [
      { id: 'f1', type: 'frame', x: 0, y: 0, w: 700, h: 500, label: 'Brief' },
      { id: 'n1', type: 'note', x: 30, y: 40, text: 'Open on the phone going into a drawer' },
      { id: 'g1', type: 'ellipse', x: 300, y: 40, text: 'hook', fill: 'tint', color: 'violet', rot: 15 },
      { id: 's1', type: 'still', x: 460, y: 40, t: '2s' },
      { id: 'a1', type: 'arrow', x: 0, y: 0, from: 'n1', to: 's1', text: 'becomes' },
      { id: 'd1', type: 'draw', x: 40, y: 300, points: [[0, 0], [30, 20], [60, 0], [90, 30]] },
      { id: 'l1', type: 'timeline', x: 0, y: 560, w: 700 },
      { id: 'p1', type: 'pin', x: 0, y: 0, target: 's1', u: 0.5, v: 0.3, text: 'bigger title' },
    ] as Shape[];
    const by = new Map(shapes.map((s) => [s.id, s]));
    const cv = createCanvas(760, 760), ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 760, 760);
    ctx.setTransform(1, 0, 0, 1, 30, 30);
    drawBoard(ctx as unknown as Ctx2D, shapes, { zoom: 1, theme: 'light', outline: OUTLINE, image: () => undefined, bounds: (id) => { const s = by.get(id); return s ? shapeBounds(s, (x) => by.get(x), OUTLINE) : undefined; } }, (s) => (s.id === 'p1' ? { selected: true } : undefined));
    const px = ctx.getImageData(0, 0, 760, 760).data;
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i]! < 240 || px[i + 1]! < 240 || px[i + 2]! < 240) ink++;
    expect(ink).toBeGreaterThan(20000);
  });
});
