/** Regressions from review round 1: render --dry-run and budget gates, show (messages, the person's edits), undo by party, help. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { main } from '../../src/cli/main.js';
import { tempProject } from './board-model-fixtures.js';

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = '';
  const o = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as never);
  const e = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { err += s; return true; }) as never);
  let code: number;
  try { code = await main(args); } finally { o.mockRestore(); e.mockRestore(); }
  return { code, out, err };
}
afterEach(() => vi.restoreAllMocks());

describe('mgl board (round 1 fixes)', () => {
  it('render --dry-run prints the estimate against the budget and spends nothing', async () => {
    const { dir, project } = tempProject();
    await cli(['board', 'edit', project, 'brief.set', 'goal=g', 'audience=a', 'success=s', 'budget.cpuMin=5']);
    const r = await cli(['board', 'render', project, '--level', '3', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/dry run: level 3 \(draft\) est\. /);
    expect(r.out).toContain('of the 5 render min budget');
    expect(r.out).toContain('nothing rendered, no spend recorded');
    expect(readFileSync(path.join(dir, 'video.board.json'), 'utf8')).not.toContain('"spend"');
  }, 60000);
  it('render refuses a level above budget.maxLevel or an estimate over the budget left, unless --force', async () => {
    const { project } = tempProject();
    await cli(['board', 'edit', project, 'brief.set', 'goal=g', 'audience=a', 'success=s', 'budget.maxLevel=1', 'budget.cpuMin=0.0001']);
    let r = await cli(['board', 'render', project, '--level', '3']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('error E_BUDGET: level 3 (draft) is above the brief\'s budget.maxLevel 1');
    await cli(['board', 'edit', project, 'brief.set', 'budget.maxLevel=4']);
    r = await cli(['board', 'render', project, '--level', '3']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/E_BUDGET: the draft render is estimated at .* over the/);
  }, 60000);
  it("show lists every unanswered message of the person and what they changed; undo leaves the person's edit", async () => {
    const { project } = tempProject();
    await cli(['board', 'edit', project, 'say', 'two options are up']);
    await cli(['board', 'edit', project, 'say', 'here is my full brief: calm, warm, 30 s, for students', '--by', 'human']);
    await cli(['board', 'edit', project, 'shape.add', 'note', 'text=person: try a sunrise open', '--by', 'human']);
    await cli(['board', 'edit', project, 'say', 'please keep the music quiet', '--by', 'human']);
    const show = await cli(['board', 'show', project]);
    expect(show.out).toContain('person said (unanswered, 2):');
    expect(show.out).toContain('here is my full brief: calm, warm, 30 s, for students');
    expect(show.out).toContain('please keep the music quiet');
    expect(show.out).toContain('person changed since your last op (1):');
    expect(show.out).toContain('shape.add note "person: try a sunrise open"');
    const u = await cli(['board', 'edit', project, 'undo']);
    expect(u.code).toBe(1);
    expect(u.err).toContain('error E_UNDO_OTHER: the step to undo was made by the person');
    const h = await cli(['board', 'edit', project, 'history']);
    expect(h.out).toContain('1. person: say please keep the music quiet');
    expect(h.out).toContain('agent: say two options are up');
    const ans = await cli(['board', 'edit', project, 'say', 'noted both', 're=m2,m3']);
    expect(ans.code).toBe(0);
    expect((await cli(['board', 'show', project])).out).not.toContain('unanswered');
    expect((await cli(['board', 'edit', project, 'undo'])).out).toContain('undid: say noted both');
    expect((await cli(['board', 'edit', project, 'undo', '--force'])).out).toContain('undid: say please keep the music quiet');
  });
  it('history says how many steps it left out', async () => {
    const { project } = tempProject();
    for (let i = 0; i < 14; i++) await cli(['board', 'edit', project, 'say', `line ${i}`]);
    expect((await cli(['board', 'edit', project, 'history'])).out).toContain('… 2 more (--json)');
  });
  it('help <sub> prints that subcommand; a board error prints once', async () => {
    const r = await cli(['board', 'help', 'render']);
    expect(r.out).toContain('--dry-run');
    expect(r.out).toContain('--ids');
    const { dir, project } = tempProject();
    writeFileSync(path.join(dir, 'video.board.json'), '{"michelangeloBoard": 1,\n"shapes": [\n{"id": "n1", "type": "note", "x": 0, "y": 0},\n{"id": "n1", "type": "note", "x": 0, "y": 0}\n]\n}\n');
    const e = await cli(['board', 'show', project]);
    expect(e.code).toBe(1);
    expect(e.err.match(/is used twice/g)?.length).toBe(1);
  });
  it('an absolute project path in the board file works', async () => {
    const { dir, project } = tempProject();
    writeFileSync(path.join(dir, 'video.board.json'), `{"michelangeloBoard": 1, "project": ${JSON.stringify(project)}}\n`);
    const r = await cli(['board', 'show', project]);
    expect(r.out).toMatch(/project .*video\.mgl\.json \(main 1080x1920/);
    expect((await cli(['board', 'edit', project, 'storyboard.make', 'every=2s'])).code).toBe(0);
  });
});
