import { describe, expect, it } from 'vitest';
import { drawBoard, drawShape, hitTest, SHAPE_DEFS, shapeBounds, arrowEnds, pinPoint, stillTimecode, drawGrid } from '../../src/board/shared/shapes.js';
import { SHAPE_TYPES, type Shape } from '../../src/board/shared/types.js';
import { palette, chrome, PALETTE_NAMES } from '../../src/board/shared/palette.js';
import { clipsAt, stillAt } from '../../src/board/shared/outline.js';
import { FakeCtx, OUTLINE, env } from './board-shared-fakectx.js';

const SHAPES: Shape[] = [
  { id: 'f1', type: 'frame', x: 0, y: 0, w: 900, h: 600, label: 'Brief' },
  { id: 'n1', type: 'note', x: 40, y: 60, text: 'Open on the phone going into a drawer, then a long word: supercalifragilisticexpialidocious', color: 'yellow', by: 'human', parent: 'f1' },
  { id: 'n2', type: 'note', x: 300, y: 60, label: 'hook', text: 'x '.repeat(400), by: 'ai' },
  { id: 't1', type: 'text', x: 40, y: 300, text: 'Act 1\nthe trick', size: 32 },
  { id: 't2', type: 'text', x: 40, y: 400, w: 120, text: 'wrapped free text in a narrow box' },
  { id: 'g1', type: 'rect', x: 400, y: 300, text: 'CTA', fill: 'solid', color: 'blue' },
  { id: 'g2', type: 'ellipse', x: 650, y: 300, w: 160, h: 100, text: 'circle', fill: 'tint', rot: 30 },
  { id: 'g3', type: 'rect', x: 0, y: 700, w: 0, h: 0 },
  { id: 'a1', type: 'arrow', from: 'n1', to: 's1', text: 'becomes' } as Shape,
  { id: 'a2', type: 'arrow', x: 0, y: 0, from: [10, 10], to: [200, 50] },
  { id: 'a3', type: 'arrow', x: 0, y: 0, from: 'g2', to: 'gone' },
  { id: 'd1', type: 'draw', x: 100, y: 800, points: [[0, 0], [10, 5], [20, 20], [40, 10]] },
  { id: 'd2', type: 'draw', x: 100, y: 900, points: [[0, 0]] },
  { id: 'd3', type: 'draw', x: 100, y: 950, points: [] },
  { id: 'i1', type: 'image', x: 1000, y: 700, src: 'refs/mood.png' },
  { id: 's1', type: 'still', x: 1000, y: 60, t: '2.5s', fidelity: 'thumb', by: 'ai' },
  { id: 's2', type: 'still', x: 1300, y: 60, t: 'bogus', fidelity: 'half' },
  { id: 'l1', type: 'timeline', x: 0, y: 1100 },
  { id: 'l2', type: 'timeline', x: 0, y: 1300, from: '10s', to: '20s', comp: 'main', label: 'middle' },
  { id: 'p1', type: 'pin', x: 0, y: 0, target: 's1', u: 0.5, v: 0.2, text: 'title too small', by: 'human' } as Shape,
  { id: 'p2', type: 'pin', x: 0, y: 0, target: 'n1', status: 'resolved', text: 'ok', reply: 'made it bigger' } as Shape,
  { id: 'p3', type: 'pin', x: 5, y: 5, target: 'gone' } as Shape,
];
const byId = new Map(SHAPES.map((s) => [s.id, s]));
const lookup = (id: string) => byId.get(id);
const bounds = (id: string) => { const s = lookup(id); return s ? shapeBounds(s, lookup) : undefined; };

describe('board shared shapes', () => {
  it('covers every shape type', () => {
    expect(Object.keys(SHAPE_DEFS).sort()).toEqual([...SHAPE_TYPES].sort());
    expect(new Set(SHAPES.map((s) => s.type))).toEqual(new Set(SHAPE_TYPES));
    expect(SHAPE_DEFS.frame.size).toEqual([800, 500]);
    expect(SHAPE_DEFS.note.size).toEqual([200, 200]);
    expect(SHAPE_DEFS.timeline.size).toEqual([1200, 160]);
  });

  for (const theme of ['light', 'dark'] as const) for (const extra of [{}, { selected: true, flash: 'ai' as const }, { zoom: 0.1 }, { zoom: 6, selected: true, flash: 'human' as const }]) {
    it(`draws every shape without throwing (${theme}, ${JSON.stringify(extra)})`, () => {
      for (const outline of [OUTLINE, null]) for (const s of SHAPES) {
        const ctx = new FakeCtx();
        drawShape(ctx, s, env({ theme, outline, stillCaption: (id) => (id === 's1' ? '0:02.50  beach, title' : undefined), ...extra }, bounds));
        expect(ctx.balanced, s.id).toBe(true);
        expect(ctx.calls.length, s.id).toBeGreaterThan(0);
      }
    });
  }

  it('drawBoard draws frames first and pins last, numbering open pins', () => {
    const ctx = new FakeCtx();
    const shuffled = [...SHAPES].reverse();
    drawBoard(ctx, shuffled, env({ outline: OUTLINE }, bounds), (s) => (s.type === 'pin' ? { selected: true } : undefined));
    expect(ctx.balanced).toBe(true);
    const texts = ctx.texts();
    expect(texts.indexOf('Brief')).toBeLessThan(texts.indexOf('CTA'));
    expect(texts).toContain('title too small');
    expect(texts).toContain('↳ made it bigger');
    expect(texts).toContain('✓');
  });

  it('notes wrap text, stills show timecode and caption, timeline draws clips', () => {
    let ctx = new FakeCtx();
    drawShape(ctx, SHAPES[1]!, env());
    expect(ctx.texts().length).toBeGreaterThan(2);
    for (const t of ctx.texts()) expect(t.length * 0.6 * 11).toBeLessThan(200);
    ctx = new FakeCtx();
    drawShape(ctx, byId.get('s1')!, env({ outline: OUTLINE }));
    expect(ctx.texts()).toContain('0:02.50');
    expect(ctx.texts()).toContain('thumb');
    ctx = new FakeCtx();
    drawShape(ctx, byId.get('s1')!, env({ outline: OUTLINE, image: () => ({ width: 270, height: 480 }), stillCaption: () => '0:02.50  beach, title' }));
    expect(ctx.count('drawImage')).toBe(1);
    expect(ctx.texts().some((t) => t.includes('beach, title'))).toBe(true);
    ctx = new FakeCtx();
    drawShape(ctx, byId.get('l1')!, env({ outline: OUTLINE }));
    expect(ctx.texts()).toEqual(expect.arrayContaining(['beach.mov', 'desk.mov']));
    ctx = new FakeCtx();
    drawShape(ctx, byId.get('l1')!, env());
    expect(ctx.texts()[0]).toMatch(/no linked project/);
  });

  it('bounds: defaults, stills by fidelity and aspect, text estimate, rotation, arrows and pins', () => {
    expect(shapeBounds(byId.get('f1')!, lookup)).toEqual({ x: 0, y: 0, w: 900, h: 600 });
    expect(shapeBounds(byId.get('g1')!, lookup)).toEqual({ x: 400, y: 300, w: 200, h: 120 });
    expect(shapeBounds(byId.get('s1')!, lookup)).toEqual({ x: 1000, y: 60, w: 270, h: 480 });
    expect(shapeBounds(byId.get('s2')!, lookup)).toEqual({ x: 1300, y: 60, w: 540, h: 960 });
    const land = { ...OUTLINE, comps: [{ id: 'main', size: [1920, 1080] as [number, number], fps: 30, length: 900 }] };
    expect(shapeBounds(byId.get('s1')!, lookup, land).h).toBe(152);
    const t1 = shapeBounds(byId.get('t1')!, lookup);
    expect(t1.h).toBeCloseTo(32 * 1.3 * 2);
    expect(t1.w).toBeGreaterThan(100);
    const g2 = shapeBounds(byId.get('g2')!, lookup);
    expect(g2.w).toBeGreaterThan(160);
    expect(g2.x + g2.w / 2).toBeCloseTo(730);
    const a2 = shapeBounds(byId.get('a2')!, lookup);
    expect(a2).toEqual({ x: 10, y: 10, w: 190, h: 40 });
    const [a, b] = arrowEnds(byId.get('a1') as Extract<Shape, { type: 'arrow' }>, bounds);
    expect(a[0]).toBeGreaterThan(240 - 1); // leaves n1 on its right edge (x 40..240) + pad
    expect(b[0]).toBeLessThan(1000);
    expect(pinPoint(byId.get('p1') as Extract<Shape, { type: 'pin' }>, bounds)).toEqual([1135, 60 + 96]);
    const pb = shapeBounds(byId.get('p1')!, lookup);
    expect(pb.y + pb.h).toBe(156);
    expect(shapeBounds(byId.get('d1')!, lookup)).toEqual({ x: 100, y: 800, w: 40, h: 20 });
    expect(shapeBounds(byId.get('d3')!, lookup)).toEqual({ x: 100, y: 950, w: 0, h: 0 });
  });

  it('hitTest', () => {
    const f = byId.get('f1')!;
    expect(hitTest(f, [450, 300], lookup)).toBe(false); // frame interior is empty space
    expect(hitTest(f, [2, 300], lookup)).toBe(true); // border
    expect(hitTest(f, [20, -12], lookup)).toBe(true); // title tab
    expect(hitTest(byId.get('n1')!, [100, 100], lookup)).toBe(true);
    expect(hitTest(byId.get('n1')!, [250, 100], lookup)).toBe(false);
    expect(hitTest(byId.get('n1')!, [243, 100], lookup, 4)).toBe(true);
    const e = byId.get('g2')!;
    expect(hitTest(e, [730, 350], lookup)).toBe(true);
    expect(hitTest({ ...e, rot: 0 } as Shape, [652, 302], lookup)).toBe(false); // ellipse corner
    expect(hitTest(byId.get('a2')!, [105, 30], lookup)).toBe(true);
    expect(hitTest(byId.get('a2')!, [105, 80], lookup)).toBe(false);
    expect(hitTest(byId.get('d1')!, [110, 805], lookup)).toBe(true);
    expect(hitTest(byId.get('d1')!, [100, 830], lookup)).toBe(false);
    expect(hitTest(byId.get('p1')!, [1135, 140], lookup)).toBe(true);
    expect(hitTest(byId.get('p1')!, [1135, 200], lookup)).toBe(false);
    expect(hitTest(byId.get('s1')!, [1100, 300], lookup)).toBe(true);
  });

  it('palette, chrome, grid, outline helpers', () => {
    for (const n of PALETTE_NAMES) for (const t of ['light', 'dark'] as const) {
      const p = palette(n, t);
      for (const c of [p.fill, p.stroke, p.text]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(chrome('dark').ai).not.toBe(chrome('dark').human);
    const ctx = new FakeCtx();
    drawGrid(ctx, { x: 0, y: 0, w: 480, h: 240 }, 1, 'light');
    expect(ctx.count('fillRect')).toBeGreaterThan(50);
    expect(clipsAt(OUTLINE, 'main', 60)).toEqual(['beach', 'title']);
    expect(clipsAt(OUTLINE, 'main', 450)).toEqual(['desk']);
    expect(stillAt(OUTLINE, { t: '15s' })).toEqual({ comp: 'main', frame: 450, fps: 30 });
    expect(stillTimecode(byId.get('s2') as Extract<Shape, { type: 'still' }>, OUTLINE)).toBe('bogus');
  });
});
