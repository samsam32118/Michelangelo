import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { boardKv } from '../../src/cli/board.js';
import { tempProject } from './board-model-fixtures.js';

async function cli(args: string[]): Promise<{ code: number; out: string; err: string; json: any; lines: string[] }> {
  let out = '', err = '';
  const o = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as never);
  const e = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err += s; return true; }) as never);
  let code: number;
  try { code = await main(args); } finally { o.mockRestore(); e.mockRestore(); }
  let json: unknown;
  if (args.includes('--json')) try { json = JSON.parse(out); } catch { /* not JSON */ }
  return { code, out, err, json, lines: out.split('\n').filter(Boolean) };
}

afterEach(() => vi.restoreAllMocks());

describe('mgl board', () => {
  it('show creates the board next to the project and prints the brief gaps and next steps', async () => {
    const { dir, project } = tempProject();
    const r = await cli(['board', 'show', project]);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(dir, 'video.board.json'))).toBe(true);
    expect(readFileSync(path.join(dir, 'video.board.json'), 'utf8')).toBe('{"michelangeloBoard": 1, "project": "video.mgl.json"}\n');
    expect(r.lines[0]).toMatch(/^board .*video\.board\.json \(new\) · 0 shapes · project video\.mgl\.json \(main 1080x1920 30fps 6\.0 s, 3 clips\)/);
    expect(r.out).toContain('brief: (empty)');
    expect(r.out).toContain('  missing: goal, audience, success');
    expect(r.out).toContain('next:\n  ask: brief lacks goal, audience, success');
    expect(r.lines.length).toBeLessThanOrEqual(40);
    const j = await cli(['board', 'show', project, '--json']);
    expect(j.json).toMatchObject({ ok: true, missing: ['goal', 'audience', 'success'], board: { michelangeloBoard: 1 }, outline: { main: 'main' } });
  });
  it('edit: k=v ops, JSON ops, batches, dry runs, undo/redo; show reflects them', async () => {
    const { dir, project } = tempProject();
    const board = path.join(dir, 'video.board.json');
    let r = await cli(['board', 'edit', project, 'brief.set', 'goal=Teach the trick', 'audience=students', 'success=viewer can do it', 'budget.cpuMin=5', 'tone=calm']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('applied 1 op (brief.set)');
    expect(r.out).toContain('~ brief: {"goal": "Teach the trick", "audience": "students", "tone": ["calm"], "success": ["viewer can do it"], "budget": {"cpuMin": 5}}');
    r = await cli(['board', 'edit', project, 'storyboard.make', 'every=2s']);
    expect(r.out).toMatch(/L\d+ \+ \{"id": "f1", "type": "frame"/);
    expect(r.out).toContain('"t": "4.5s"'); // samples offset from 0: entrances have played
    r = await cli(['board', 'edit', project, 'round.open', 'pick the opening', 'fidelity=1']);
    r = await cli(['board', 'edit', project, '{"op": "round.option", "round": "r1", "option": {"title": "Cold open", "tradeoffs": "fast hook; less context", "shapes": ["s1"]}}']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    writeFileSync(path.join(dir, 'ops.jsonl'), '{"op": "round.option", "round": "r1", "option": {"title": "Slow build"}}\n{"op": "pin.add", "target": "s2", "text": "too busy"}\n');
    r = await cli(['board', 'edit', project, '--batch', path.join(dir, 'ops.jsonl'), '--by', 'human']);
    expect(r.out).toContain('applied 2 ops (round.option, pin.add)');
    expect(readFileSync(board, 'utf8')).toContain('{"id": "p1", "type": "pin", "target": "s2", "text": "too busy", "by": "human"}');
    r = await cli(['board', 'edit', project, 'round.option', 'r1', 'id=r1b', 'tradeoffs=calm; slower']);
    expect(r.code).toBe(0);
    const show = await cli(['board', 'show', project]);
    expect(show.out).toContain('round r1 "pick the opening" · level 1 (frames) · proposed');
    expect(show.out).toContain('r1a "Cold open": tradeoffs: fast hook; less context');
    expect(show.out).toContain('pins: 1 open');
    expect(show.out).toContain('p1 on s2 @ 2.5s [clips: t2]: "too busy" (human)');
    expect(show.out).toMatch(/next:\n {2}do: pin p1/);
    expect(show.out).toContain('wait: round r1');
    const before = readFileSync(board, 'utf8');
    r = await cli(['board', 'edit', project, 'say', 'hello', '--dry-run']);
    expect(r.out).toContain('dry run: nothing written');
    expect(readFileSync(board, 'utf8')).toBe(before);
    r = await cli(['board', 'edit', project, 'undo']);
    expect(r.out).toContain('undid: round.option r1');
    r = await cli(['board', 'edit', project, 'redo']);
    expect(r.out).toContain('redid: round.option r1');
    expect(readFileSync(board, 'utf8')).toBe(before);
    r = await cli(['board', 'edit', project, 'history', '--json']);
    expect(r.json.undo.length).toBe(6);
  });
  it('edit errors: unknown op, bad field, exit 1 with a fix', async () => {
    const { project } = tempProject();
    let r = await cli(['board', 'edit', project, 'shape.ad', 'note']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('error E_UNKNOWN_OP: "shape.ad" is not a board op.');
    expect(r.err).toContain('did you mean "shape.add"?');
    r = await cli(['board', 'edit', project, 'shape.add', 'note', 'txt=hi']);
    expect(r.err).toContain('did you mean "text"?');
    r = await cli(['board', 'edit', project, 'round.decide', 'r9', 'chosen=r9a', '--json']);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, error: { code: 'E_REF' } });
    r = await cli(['board', 'shwo', project]);
    expect(r.err).toContain('did you mean "mgl board show"?');
  });
  it('say works without a server; view and focus need one', async () => {
    const { dir, project } = tempProject();
    let r = await cli(['board', 'say', project, 'Two', 'options', 'are', 'up']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\+ \{"id": "m1", "by": "ai", "text": "Two options are up", "at": "/);
    r = await cli(['board', 'say', project, 'warmer please', '--by', 'human']);
    expect(readFileSync(path.join(dir, 'video.board.json'), 'utf8')).toContain('"by": "human", "text": "warmer please"');
    const show = await cli(['board', 'show', project]);
    expect(show.out).toContain('do: the person said "warmer please" (m2): answer it');
    r = await cli(['board', 'view', project]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('fix: start one: mgl board serve <file> (in the background)');
    r = await cli(['board', 'focus', project, 's1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('E_NO_SERVER');
  });
  it('k=v parsing', () => {
    expect(boardKv('shape.add', ['note', 'text=123', 'x=10', 'tags=a,b'])).toEqual({ op: 'shape.add', shape: { type: 'note', text: '123', x: 10, tags: ['a', 'b'] } });
    expect(boardKv('shape.set', ['n1', 'color=null', 'from=[1,2]'])).toEqual({ op: 'shape.set', id: 'n1', props: { color: null, from: [1, 2] } });
    expect(boardKv('shape.move', ['n1,n2', 'dx=5', 'dy=-3'])).toEqual({ op: 'shape.move', ids: ['n1', 'n2'], dx: 5, dy: -3 });
    expect(boardKv('brief.set', ['add.tone=bold', 'success=a, b'])).toEqual({ op: 'brief.set', add: { tone: ['bold'] }, success: ['a, b'] });
    expect(boardKv('still.add', ['75'])).toEqual({ op: 'still.add', t: 75 });
    expect(boardKv('round.option', ['r1', 'title=A'])).toEqual({ op: 'round.option', round: 'r1', option: { title: 'A' } });
    expect(() => boardKv('say', ['a', 'b'])).toThrow(/only one bare word/);
  });
});
