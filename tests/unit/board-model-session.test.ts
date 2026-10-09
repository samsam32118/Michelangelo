import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BoardSession, projectOutline, clipsAt } from '../../src/board/model/index.js';
import { SAMPLE, tempProject } from './board-model-fixtures.js';

function boardFile(text = SAMPLE) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mgl-board-'));
  const f = path.join(dir, 'video.board.json');
  writeFileSync(f, text);
  return f;
}

describe('BoardSession', () => {
  it('applies, persists, undoes and redoes across sessions', async () => {
    const f = boardFile();
    const s = await BoardSession.open(f);
    expect(s.version).toBe(1);
    const r = await s.apply([{ op: 'say', text: 'one' }], 'ai');
    expect(r).toMatchObject({ created: ['m2'], version: 2 });
    await s.apply([{ op: 'shape.add', shape: { type: 'note', text: 'two' } }], 'human');
    expect(readFileSync(f, 'utf8')).toContain('"text": "two", "by": "human"');
    expect(existsSync(path.join(path.dirname(f), '.mgl', 'board-history.jsonl'))).toBe(true);
    const other = await BoardSession.open(f);
    expect(other.historyStatus().undo).toEqual(['shape.add note "two"', 'say one']);
    const u = await other.undo();
    expect(u.summary).toEqual(['undid: shape.add note "two"']);
    expect(u.changed).toEqual(['n2']);
    expect(readFileSync(f, 'utf8')).not.toContain('"two"');
    await other.undo();
    expect(readFileSync(f, 'utf8')).toBe(SAMPLE);
    await expect(other.undo()).rejects.toMatchObject({ code: 'E_HISTORY_EMPTY' });
    const rd = await other.redo(2);
    expect(rd.summary.length).toBe(2);
    expect(readFileSync(f, 'utf8')).toContain('"two"');
  });
  it('spend rows are a ledger: not an undo step, and kept by undo / redo', async () => {
    const f = boardFile();
    const s = await BoardSession.open(f);
    await s.apply([{ op: 'shape.add', shape: { type: 'note', text: 'mine' } }], 'human');
    await s.apply([{ op: 'spend.add', level: 1, what: 'still 1s', ms: 40 }], 'ai');
    expect(s.historyStatus().undo[0]).toBe('shape.add note "mine"');
    const u = await s.undo();
    expect(u.summary).toEqual(['undid: shape.add note "mine"']);
    const text = readFileSync(f, 'utf8');
    expect(text).not.toContain('"mine"');
    expect(text).toContain('"what": "still 1s"');
    await s.redo();
    expect(readFileSync(f, 'utf8')).toContain('"mine"');
    expect(readFileSync(f, 'utf8')).toContain('"what": "still 1s"');
  });
  it('a new edit clears redo; dry runs write nothing', async () => {
    const f = boardFile();
    const s = await BoardSession.open(f);
    await s.apply([{ op: 'say', text: 'a' }], 'ai');
    await s.undo();
    await s.apply([{ op: 'say', text: 'b' }], 'ai');
    await expect(s.redo()).rejects.toMatchObject({ code: 'E_HISTORY_EMPTY' });
    const d = await s.apply([{ op: 'say', text: 'c' }], 'ai', null, { dryRun: true });
    expect(d.dryRun).toBe(true);
    expect(readFileSync(f, 'utf8')).not.toContain('"c"');
  });
  it('refuses to undo over a hand edit, and adopts hand edits on the next apply', async () => {
    const f = boardFile();
    const s = await BoardSession.open(f);
    await s.apply([{ op: 'say', text: 'a' }], 'ai');
    writeFileSync(f, readFileSync(f, 'utf8').replace('"Brief"', '"Brief!"'));
    expect(await s.reload()).toBe(true);
    expect(await s.reload()).toBe(false);
    await expect(s.undo()).rejects.toMatchObject({ code: 'E_HISTORY_STALE', message: expect.stringContaining('changed on disk') });
    writeFileSync(f, readFileSync(f, 'utf8').replace('"Brief!"', '"Brief?"'));
    await s.apply([{ op: 'say', text: 'b' }], 'ai');
    expect(readFileSync(f, 'utf8')).toContain('"Brief?"');
  });
  it('creates a missing board on first apply', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mgl-board-'));
    const f = path.join(dir, 'new.board.json');
    const s = await BoardSession.open(f);
    expect(s.board).toEqual({ michelangeloBoard: 1 });
    await s.apply([{ op: 'say', text: 'hi' }], 'ai', null, { now: '2026-10-09T00:00:00Z' });
    expect(readFileSync(f, 'utf8')).toBe('{"michelangeloBoard": 1,\n"log": [\n{"id": "m1", "by": "ai", "text": "hi", "at": "2026-10-09T00:00:00Z"}\n]\n}\n');
    await s.undo();
    expect(readFileSync(f, 'utf8')).toBe('{"michelangeloBoard": 1}\n');
  });
});

describe('project outline', () => {
  it('reads comps, tracks, clips and finds the visible clips at a frame', async () => {
    const { project } = tempProject();
    const o = await projectOutline(project);
    expect(o.main).toBe('main');
    expect(o.comps[0]).toMatchObject({ id: 'main', size: [1080, 1920], fps: 30, length: 180 });
    expect(o.clips.map((c) => c.id)).toEqual(['t1', 't2', 't3']);
    expect(o.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(clipsAt(o, 'main', 75)).toEqual(['t2']);
    expect(clipsAt(o, 'main', 500)).toEqual([]);
  });
});
