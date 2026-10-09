/** Regressions from review round 1: arrow / pin binding, undo by party, history `by`, absolute project paths, error text. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BoardSession, applyOps, parseBoardText, projectOf } from '../../src/board/model/index.js';
import type { BoardFile, BoardOp } from '../../src/board/shared/types.js';
import { OUTLINE, SAMPLE } from './board-model-fixtures.js';

const run = (ops: unknown[], b: BoardFile = parseBoardText(SAMPLE)) => applyOps(b, ops as BoardOp[], { by: 'ai', outline: OUTLINE });
const err = (ops: unknown[], b?: BoardFile) => { try { run(ops, b); } catch (e) { return e as { code: string; message: string; problems?: { message: string }[] }; } throw new Error('no error'); };
function boardFile(text = SAMPLE) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mgl-board-fix-'));
  const f = path.join(dir, 'video.board.json');
  writeFileSync(f, text);
  return f;
}

describe('arrow ends and pin targets', () => {
  it('refuses an arrow bound to itself, to an arrow or to a pin (no recursion later)', () => {
    expect(err([{ op: 'shape.set', id: 'a1', props: { from: 'a1' } }])).toMatchObject({ code: 'E_ARG' });
    expect(err([{ op: 'shape.add', shape: { type: 'arrow', id: 'a2', from: 'a1', to: [0, 0] } }]).message).toContain('is a arrow');
    expect(err([{ op: 'shape.add', shape: { type: 'arrow', from: 'p1', to: 'n1' } }]).message).toContain('pin');
    // the ops that used to blow the stack still work after a refused bind
    expect(run([{ op: 'shape.add', shape: { type: 'rect', text: 'next' } }]).created).toEqual(['g1']);
  });
  it('lays out new shapes even when a hand edit chained arrows into a loop', () => {
    const loop = SAMPLE.replace('{"id": "a1", "type": "arrow", "from": "n1", "to": "s1", "label": "becomes"}', '{"id": "a1", "type": "arrow", "from": "a2", "to": "s1"},\n{"id": "a2", "type": "arrow", "from": "a1", "to": "n1"}');
    const b = parseBoardText(loop);
    expect(run([{ op: 'shape.add', shape: { type: 'arrow', from: [0, 0], to: [10, 10] } }, { op: 'shape.add', shape: { type: 'ellipse' } }], b).created).toEqual(['a3', 'g1']);
  });
  it('shape.set refuses a pin on itself or on an arrow, as pin.add does', () => {
    expect(err([{ op: 'shape.set', id: 'p1', props: { target: 'p1' } }]).code).toBe('E_ARG');
    expect(err([{ op: 'shape.set', id: 'p1', props: { target: 'a1' } }]).message).toContain('arrow');
    expect(run([{ op: 'shape.set', id: 'p1', props: { target: 'n1' } }]).changed).toEqual(['p1']);
  });
});

describe('undo by party', () => {
  it("an agent's undo refuses the person's step (E_UNDO_OTHER) unless forced; history keeps who did what", async () => {
    const f = boardFile();
    const s = await BoardSession.open(f);
    await s.apply([{ op: 'say', text: 'mine' }], 'ai');
    await s.apply([{ op: 'say', text: 'please keep the music quiet' }], 'human');
    expect(s.historyStatus().undoSteps.map((x) => x.by)).toEqual(['human', 'ai']);
    await expect(s.undo(1, { by: 'ai' })).rejects.toMatchObject({ code: 'E_UNDO_OTHER', message: expect.stringContaining('the person') });
    expect(readFileSync(f, 'utf8')).toContain('keep the music quiet');
    await expect(s.undo(2, { by: 'human' })).rejects.toMatchObject({ code: 'E_UNDO_OTHER' }); // the second step is the agent's
    expect((await s.undo(1, { by: 'human' })).summary).toEqual(['undid: say please keep the music quiet']);
    expect((await s.undo(1, { by: 'ai' })).summary).toEqual(['undid: say mine']);
    await s.redo(2);
    expect((await s.undo(1, { by: 'ai', force: true })).summary[0]).toContain('music');
  });
  it('since(): what the other party did after your latest step, with the text of their shapes', async () => {
    const s = await BoardSession.open(boardFile());
    await s.apply([{ op: 'say', text: 'two options are up' }], 'ai');
    await s.apply([{ op: 'shape.add', shape: { type: 'note', text: 'person: try a sunrise open' } }], 'human');
    expect(s.since('ai')).toMatchObject([{ by: 'human', summary: 'shape.add note "person: try a sunrise open"' }]);
    expect(s.since('human')).toEqual([]);
  });
});

describe('files and errors', () => {
  it('an absolute "project" path stays absolute', () => {
    expect(projectOf('/a/b/v.board.json', { michelangeloBoard: 1, project: '/abs/dir/v.mgl.json' })).toBe('/abs/dir/v.mgl.json');
    expect(projectOf('/a/b/v.board.json', { michelangeloBoard: 1, project: 'v.mgl.json' })).toBe('/a/b/v.mgl.json');
  });
  it('the top message and its problem are prefixed together (the CLI prints the problem once)', async () => {
    const f = boardFile(SAMPLE.replace('"id": "s1"', '"id": "n1"'));
    const e = await BoardSession.open(f).catch((x) => x);
    expect(e.code).toBe('E_DUPLICATE_ID');
    expect(e.problems.filter((p: { message: string }) => p.message === e.message).length).toBe(1);
    const op = err([{ op: 'say', text: 'a' }, { op: 'shape.add', shape: { type: 'note', id: 'x', parent: 'nope' } }]);
    expect(op.message).toMatch(/^op 2 of 2: /);
  });
});
