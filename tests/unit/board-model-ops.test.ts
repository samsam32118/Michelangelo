import { describe, it, expect } from 'vitest';
import { applyOps, parseBoardText, formatBoard } from '../../src/board/model/index.js';
import type { BoardFile, BoardOp, Shape } from '../../src/board/shared/types.js';
import { MglError } from '../../src/core/errors.js';
import { OUTLINE, SAMPLE } from './board-model-fixtures.js';

const base = () => parseBoardText(SAMPLE);
const run = (ops: unknown[], b: BoardFile = base(), outline = OUTLINE) => applyOps(b, ops as BoardOp[], { by: 'ai', outline, now: '2026-10-09T12:00:00Z' });
const shape = (b: BoardFile, id: string) => b.shapes!.find((s) => s.id === id) as Shape & Record<string, unknown>;
const err = (ops: unknown[], b?: BoardFile, outline = OUTLINE): MglError => { try { run(ops, b, outline); } catch (e) { return e as MglError; } throw new Error('no error'); };

describe('board ops', () => {
  it('shape.add generates ids by type, stamps by, places shapes', () => {
    const r = run([{ op: 'shape.add', shape: { type: 'note', text: 'a' } }, { op: 'shape.add', shape: { type: 'rect', x: 5, y: 6 } }, { op: 'shape.add', shape: { type: 'frame', id: 'f-x' } }]);
    expect(r.created).toEqual(['n2', 'g1', 'f-x']);
    expect(shape(r.board, 'n2')).toMatchObject({ by: 'ai', x: 270, y: 60 });
    expect(shape(r.board, 'g1')).toMatchObject({ x: 5, y: 6 });
  });
  it('shape.add errors: type, unknown field, duplicate id, bad parent', () => {
    expect(err([{ op: 'shape.add', shape: { type: 'nite' } }]).fix).toContain('"note"');
    const e = err([{ op: 'shape.add', shape: { type: 'note', txt: 'x' } }]);
    expect(e.code).toBe('E_UNKNOWN_KEY');
    expect(e.fix).toContain('"text"');
    expect(err([{ op: 'shape.add', shape: { type: 'note', id: 'n1' } }]).code).toBe('E_DUPLICATE_ID');
    expect(err([{ op: 'shape.add', shape: { type: 'note', parent: 's1' } }]).message).toContain('not a frame');
    expect(err([{ op: 'shape.add', shape: { type: 'arrow', from: 'n1', to: 'zz' } }]).code).toBe('E_REF');
  });
  it('unknown ops and bad fields', () => {
    const e = err([{ op: 'shape.ad' }]);
    expect(e.code).toBe('E_UNKNOWN_OP');
    expect(e.fix).toContain('shape.add');
    const f = err([{ op: 'shape.move', ids: ['n1'], dx: 'a', dy: 0 }]);
    expect(f.message).toContain('dx');
    expect(err([{ op: 'brief.set', gaol: 'x' }]).fix).toContain('"goal"');
    expect(err([{ op: 'say' }]).code).toBe('E_MISSING');
  });
  it('is atomic: a failing op leaves the board untouched and names the op', () => {
    const b = base();
    const before = formatBoard(b);
    const e = err([{ op: 'say', text: 'hi' }, { op: 'shape.remove', id: 'nope' }], b);
    expect(e.message).toMatch(/^op 2 of 2/);
    expect(formatBoard(b)).toBe(before);
  });
  it('shape.set: null removes, id/type are fixed, values validated', () => {
    const r = run([{ op: 'shape.set', id: 'n1', props: { color: null, text: 'new' } }]);
    expect(shape(r.board, 'n1').color).toBeUndefined();
    expect(shape(r.board, 'n1').text).toBe('new');
    expect(err([{ op: 'shape.set', id: 'n1', props: { type: 'rect' } }]).code).toBe('E_ARG');
    expect(err([{ op: 'shape.set', id: 'n1', props: { color: 'pink' } }]).code).toBe('E_SCHEMA');
    expect(err([{ op: 'shape.set', id: 'n9', props: {} }]).fix).toContain('n1');
  });
  it('shape.remove: frames take children, pins go with targets, arrows keep their last point, option refs drop', () => {
    const r = run([{ op: 'shape.remove', id: 'f-brief' }]);
    expect(r.board.shapes!.map((s) => s.id)).toEqual(['s1', 'a1', 'p1']);
    expect(shape(r.board, 'a1').from).toEqual([140, 160]);
    const r2 = run([{ op: 'shape.remove', ids: ['s1'] }]);
    expect(r2.board.shapes!.find((s) => s.id === 'p1')).toBeUndefined();
    expect(r2.board.rounds![0]!.options![0]!.shapes).toBeUndefined();
    const locked = run([{ op: 'shape.set', id: 'n1', props: { locked: true } }]).board;
    expect(err([{ op: 'shape.remove', id: 'n1' }], locked).code).toBe('E_LOCKED');
  });
  it('shape.move moves frame children and arrow points; shape.order reorders', () => {
    const r = run([{ op: 'shape.add', shape: { type: 'arrow', id: 'a2', from: [0, 0], to: 'n1' } }, { op: 'shape.move', ids: ['f-brief', 'a2'], dx: 10, dy: -5 }]);
    expect(shape(r.board, 'f-brief')).toMatchObject({ x: 10, y: -5 });
    expect(shape(r.board, 'n1')).toMatchObject({ x: 50, y: 55 });
    expect(shape(r.board, 'a2').from).toEqual([10, -5]);
    const ids = (ops: unknown[]) => run(ops).board.shapes!.map((s) => s.id);
    expect(ids([{ op: 'shape.order', ids: ['f-brief'], to: 'front' }])).toEqual(['n1', 's1', 'a1', 'p1', 'f-brief']);
    expect(ids([{ op: 'shape.order', ids: ['p1'], to: 'back' }])[0]).toBe('p1');
    expect(ids([{ op: 'shape.order', ids: ['n1'], to: 'forward' }]).slice(0, 3)).toEqual(['f-brief', 's1', 'n1']);
    expect(ids([{ op: 'shape.order', ids: ['n1'], to: 'backward' }])[0]).toBe('n1');
  });
  it('brief.set: replace, null, add/remove, budget merge', () => {
    const r = run([{ op: 'brief.set', goal: 'new goal', platform: null, add: { tone: ['bold', 'calm'] }, remove: { avoid: ['stock-photo look'] }, budget: { maxLevel: 3 } }]);
    const br = r.board.brief!;
    expect(br.goal).toBe('new goal');
    expect(br.platform).toBeUndefined();
    expect(br.tone).toEqual(['calm', 'warm', 'bold']);
    expect(br.avoid).toBeUndefined();
    expect(br.budget).toEqual({ cpuMin: 10, maxLevel: 3 });
    expect(r.changed).toEqual(['brief']);
    expect(err([{ op: 'brief.set', add: { goal: ['x'] } }]).code).toBe('E_ARG');
    expect(err([{ op: 'brief.set', tone: 'calm' }]).code).toBe('E_SCHEMA');
  });
  it('rounds: open, options (status proposed at 2), update an option, decide, set', () => {
    const r = run([
      { op: 'round.open', goal: 'pick the look' },
      { op: 'round.option', round: 'r2', option: { title: 'Warm', tradeoffs: 'safe' } },
      { op: 'round.option', round: 'r2', option: { title: 'Bold', shapes: ['s1'] } },
      { op: 'round.option', round: 'r2', option: { id: 'r2b', tradeoffs: 'loud; risky' } },
    ]);
    const r2 = r.board.rounds![1]!;
    expect(r2).toMatchObject({ id: 'r2', fidelity: 1, status: 'proposed' });
    expect(r2.options!.map((o) => o.id)).toEqual(['r2a', 'r2b']);
    expect(r2.options![1]).toMatchObject({ title: 'Bold', tradeoffs: 'loud; risky' });
    const d = run([{ op: 'round.decide', round: 'r2', chosen: 'r2b', why: 'energy' }], r.board).board.rounds![1]!;
    expect(d).toMatchObject({ status: 'decided', chosen: 'r2b', why: 'energy' });
    expect(err([{ op: 'round.decide', round: 'r2', chosen: 'Bold' }], r.board).fix).toContain('chosen=r2b');
    expect(err([{ op: 'round.option', round: 'r1', option: { title: 'x' } }]).code).toBe('E_ROUND_CLOSED');
    expect(err([{ op: 'round.option', round: 'r3', option: { title: 'x' } }]).code).toBe('E_REF');
    expect(err([{ op: 'round.option', round: 'r1', option: { tradeoffs: 'x' } }], run([{ op: 'round.set', round: 'r1', props: { status: 'open' } }]).board).code).toBe('E_MISSING');
    const s = run([{ op: 'round.set', round: 'r1', props: { status: 'dropped', notes: 'n' } }]).board.rounds![0]!;
    expect(s).toMatchObject({ status: 'dropped', notes: 'n' });
    expect(s.chosen).toBeUndefined();
    expect(err([{ op: 'round.set', round: 'r1', props: { colour: 1 } }]).fix).toContain('status');
  });
  it('pins and say', () => {
    const r = run([{ op: 'pin.add', target: 's1', u: 0.1, v: 0.9, text: 'too dark' }, { op: 'pin.resolve', id: 'p1', reply: 'title is 96 px now' }, { op: 'say', text: 'done' }]);
    expect(shape(r.board, 'p2')).toMatchObject({ type: 'pin', target: 's1', u: 0.1, v: 0.9, by: 'ai' });
    expect(shape(r.board, 'p1')).toMatchObject({ status: 'resolved', reply: 'title is 96 px now' });
    expect(r.board.log!.at(-1)).toEqual({ id: 'm2', by: 'ai', text: 'done', at: '2026-10-09T12:00:00Z' });
    expect(err([{ op: 'pin.resolve', id: 'n1' }]).message).toContain('not a pin');
    expect(err([{ op: 'pin.add', target: 'a1', text: 'x' }]).code).toBe('E_ARG');
    const human = applyOps(base(), [{ op: 'say', text: 'hi' }], { by: 'human' });
    expect(human.board.log!.at(-1)!.by).toBe('human');
  });
  it('still.add: autoplace right of the last still, time checked against the project', () => {
    const r = run([{ op: 'still.add', t: '2s' }, { op: 'still.add', t: 90, fidelity: 'half' }, { op: 'still.add', t: '1s', x: 5, y: 7 }]);
    expect(shape(r.board, 's2')).toMatchObject({ x: 1300, y: 60, t: '2s' });
    expect(shape(r.board, 's3')).toMatchObject({ x: 1600, y: 60, fidelity: 'half' });
    expect(shape(r.board, 's4')).toMatchObject({ x: 5, y: 7 });
    expect(err([{ op: 'still.add', t: '9s' }]).code).toBe('E_TIME_RANGE');
    expect(err([{ op: 'still.add', t: '1s', comp: 'mian' }]).fix).toContain('"main"');
    expect(err([{ op: 'still.add', t: 'soon' }]).code).toBe('E_SCHEMA');
    expect(run([{ op: 'still.add', t: '99s' }], base(), null as never).created).toEqual(['s2']); // no project: any time
  });
  it('storyboard.make: cuts by default, every N, grid in a new frame', () => {
    const r = run([{ op: 'storyboard.make' }]);
    const f = shape(r.board, 'f1');
    expect(f).toMatchObject({ type: 'frame', label: 'Storyboard' });
    const stills = r.board.shapes!.filter((s) => s.parent === 'f1');
    expect(stills.map((s) => (s as { t: string }).t)).toEqual(['0.5s', '2.5s', '4.5s']); // half a second into each cut: entrances have played
    expect(stills[1]!.x - stills[0]!.x).toBe(300);
    const e = run([{ op: 'storyboard.make', every: '1s', frame: 'Every second', fidelity: 'thumb' }]);
    const st = e.board.shapes!.filter((s) => s.type === 'still' && s.parent);
    expect(st.length).toBe(6);
    expect(st[5]!.y).toBeGreaterThan(st[0]!.y); // 5 per row
    expect(st[5]!.x).toBe(st[0]!.x);
    expect(err([{ op: 'storyboard.make' }], base(), null as never).code).toBe('E_NO_PROJECT');
    expect(err([{ op: 'storyboard.make', every: 1 }]).code).toBe('E_TOO_MANY');
  });
  it('spend.add', () => {
    const r = run([{ op: 'spend.add', level: 2, what: 'sheet', ms: 2400.4, round: 'r1' }]);
    expect(r.board.spend!.at(-1)).toEqual({ id: 'c2', level: 2, what: 'sheet', ms: 2400, round: 'r1' });
    expect(err([{ op: 'spend.add', level: 7, what: 'x', ms: 1 }]).code).toBe('E_SCHEMA');
    expect(err([{ op: 'spend.add', level: 1, what: 'x', ms: 1, round: 'r5' }]).code).toBe('E_REF');
  });
});
