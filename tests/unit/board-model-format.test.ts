import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatBoard, parseBoardText, loadBoard, saveBoard, resolveBoardPath } from '../../src/board/model/index.js';
import { MglError } from '../../src/core/errors.js';
import { SAMPLE } from './board-model-fixtures.js';

const err = (fn: () => unknown): MglError => { try { fn(); } catch (e) { return e as MglError; } throw new Error('no error'); };

describe('board format', () => {
  it('round-trips byte-stable, one entity per line', () => {
    const f = formatBoard(parseBoardText(SAMPLE));
    expect(f).toBe(SAMPLE);
    expect(formatBoard(parseBoardText(f))).toBe(f);
    expect(f.split('\n').filter((l) => l.startsWith('{"id": ')).length).toBe(8);
  });
  it('omits defaults and orders keys id first', () => {
    const b = parseBoardText('{"michelangeloBoard": 1, "shapes": [{"text": "hi", "rot": 0, "locked": false, "tags": [], "type": "note", "y": 2, "id": "n1", "x": 1},\n{"type": "pin", "id": "p1", "target": "n1", "u": 0.5, "v": 0.5, "status": "open", "text": "x"},\n{"id": "s1", "type": "still", "x": 0, "y": 0, "t": 30, "fidelity": "thumb"}]}');
    const f = formatBoard(b);
    expect(f).toContain('{"id": "n1", "type": "note", "x": 1, "y": 2, "text": "hi"}');
    expect(f).toContain('{"id": "p1", "type": "pin", "target": "n1", "text": "x"}');
    expect(f).toContain('{"id": "s1", "type": "still", "x": 0, "y": 0, "t": 30}');
  });
  it('writes a bare board on one line', () => {
    expect(formatBoard({ michelangeloBoard: 1 })).toBe('{"michelangeloBoard": 1}\n');
    expect(formatBoard({ michelangeloBoard: 1, project: 'v.mgl.json', brief: {} })).toBe('{"michelangeloBoard": 1, "project": "v.mgl.json"}\n');
  });
});

describe('board validation', () => {
  it('unknown keys: line + did-you-mean', () => {
    const e = err(() => parseBoardText(SAMPLE.replace('"label": "Brief"', '"lable": "Brief"')));
    expect(e.code).toBe('E_UNKNOWN_KEY');
    expect(e.line).toBe(4);
    expect(e.fix).toContain('"label"');
  });
  it('unknown shape type and bad enum values', () => {
    expect(err(() => parseBoardText(SAMPLE.replace('"type": "still"', '"type": "stil"'))).fix).toContain('"still"');
    const e = err(() => parseBoardText(SAMPLE.replace('"color": "yellow"', '"color": "yelow"')));
    expect(e.code).toBe('E_SCHEMA');
    expect(e.fix).toContain('"yellow"');
    expect(e.line).toBe(5);
  });
  it('bad times, versions, JSON syntax', () => {
    expect(err(() => parseBoardText(SAMPLE.replace('"t": "0s"', '"t": "soon"'))).message).toContain('not a time');
    expect(err(() => parseBoardText(SAMPLE.replace('"michelangeloBoard": 1', '"michelangeloBoard": 2'))).code).toBe('E_VERSION');
    const j = err(() => parseBoardText(SAMPLE.replace('"label": "Brief"}', '"label": "Brief"')));
    expect(j.code).toBe('E_JSON');
  });
  it('references: parents, arrows, pins, chosen options, duplicates', () => {
    expect(err(() => parseBoardText(SAMPLE.replace('"parent": "f-brief"', '"parent": "f-brif"'))).fix).toContain('"f-brief"');
    expect(err(() => parseBoardText(SAMPLE.replace('"parent": "f-brief"', '"parent": "s1"'))).message).toContain('not a frame');
    expect(err(() => parseBoardText(SAMPLE.replace('"to": "s1"', '"to": "s9"'))).code).toBe('E_REF');
    expect(err(() => parseBoardText(SAMPLE.replace('"target": "s1"', '"target": "zz"'))).code).toBe('E_REF');
    expect(err(() => parseBoardText(SAMPLE.replace('"chosen": "r1a"', '"chosen": "r1b"'))).fix).toContain('r1a');
    expect(err(() => parseBoardText(SAMPLE.replace('"id": "n1"', '"id": "s1"'))).code).toBe('E_DUPLICATE_ID');
  });
});

describe('board files', () => {
  it('resolves project → board and loads a missing board lazily without writing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mgl-board-'));
    const proj = path.join(dir, 'video.mgl.json');
    writeFileSync(proj, '{}');
    const r = resolveBoardPath(proj);
    expect(r.boardPath).toBe(path.join(dir, 'video.board.json'));
    expect(r.projectPath).toBe(proj);
    const b = await loadBoard(r.boardPath);
    expect(b).toEqual({ michelangeloBoard: 1, project: 'video.mgl.json' });
    expect(existsSync(r.boardPath)).toBe(false);
    await saveBoard(r.boardPath, parseBoardText(SAMPLE));
    expect(readFileSync(r.boardPath, 'utf8')).toBe(SAMPLE);
    expect(resolveBoardPath(r.boardPath).projectPath).toBe(proj);
  });
  it('load errors name the file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mgl-board-'));
    const f = path.join(dir, 'x.board.json');
    writeFileSync(f, '{"michelangeloBoard": 1, "shapez": []}');
    await expect(loadBoard(f)).rejects.toMatchObject({ code: 'E_UNKNOWN_KEY', message: expect.stringContaining('x.board.json') });
  });
});
