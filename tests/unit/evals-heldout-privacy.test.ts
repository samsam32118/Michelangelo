// @vitest-environment node
// Held-out privacy (review 3): public results and summaries name held-out tasks only by a keyed alias, report.mjs
// keeps it so for every held-out set, private results go per set, the agent allowlist has no command runners,
// and the transcript audit follows cd (also across calls and inside sh -c) and relative operands, with reads of
// the private dir (grader stash), other sandboxes, the repository and evals/ fatal.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EVALS = resolve(__dirname, '../../evals');
const REPO = resolve(EVALS, '..');
const load = (p: string): Promise<any> => import(pathToFileURL(join(EVALS, p)).href);
const tmp = mkdtempSync(join(tmpdir(), 'mgl-evals-ho-'));
let run: any, metrics: any, alias: any, rep: any;
beforeAll(async () => { [run, metrics, alias, rep] = await Promise.all([load('run.mjs'), load('sandbox/metrics.mjs'), load('sandbox/alias.mjs'), load('report.mjs')]); });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const textUnder = (d: string) => walk(d).map((f) => readFileSync(f, 'utf8')).join('\n');

describe('held-out aliases', () => {
  it('are keyed by a secret in the private dir (not a plain hash of the id)', () => {
    const priv = join(tmp, 'keypriv');
    const k = alias.loadAliasKey(priv);
    expect(statSync(join(priv, 'alias-key')).mode & 0o777).toBe(0o600);
    expect(alias.loadAliasKey(priv)).toBe(k);
    const a = alias.aliasOf('secret-alpha', k);
    expect(alias.isAlias(a)).toBe(true);
    expect(a).not.toBe('h-' + createHash('sha256').update('secret-alpha').digest('hex').slice(0, 6));
    expect(alias.aliasOf('secret-alpha', 'another-key-another-key-another-key')).not.toBe(a);
    expect(alias.isHiddenSet('heldout')).toBe(true);
    expect(alias.isHiddenSet('heldout3')).toBe(true);
    expect(alias.isHiddenSet('main')).toBe(false);
  });
});

describe('a held-out dry run (fake heldout3 set)', () => {
  const sets = join(tmp, 'sets'), res = join(tmp, 'res'), priv = join(tmp, 'priv');
  const ids = ['secret-alpha', 'secret-beta'];
  beforeAll(() => {
    for (const id of ids) {
      const d = join(sets, 'heldout3', id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'task.md'), `Do ${id}.\n`);
      writeFileSync(join(d, 'meta.json'), JSON.stringify({ id, timeout_min: 1 }));
      writeFileSync(join(d, 'setup.mjs'), `import { writeFileSync } from 'node:fs';\nexport async function setup(dir) { writeFileSync(dir + '/in.txt', '${id}'); }\n`);
      writeFileSync(join(d, 'grade.mjs'), `export async function grade(dir) { return { pass: false, score: 0, checks: [{ name: 'check of ${id}', pass: false, detail: 'detail ${id}' }] }; }\n`);
    }
  });
  const runIt = (label: string) => spawnSync(process.execPath, [join(EVALS, 'run.mjs'), '--set', 'heldout3', '--dry-run', '--no-sandbox', '--no-history', '--label', label,
    '--sets-dir', sets, '--results-dir', res, '--private-dir', priv], { encoding: 'utf8', timeout: 120_000 });

  it('public result.json, summary and log carry only aliases; private results go to <private>/<label>/<set>', async () => {
    const r = runIt('ho1');
    expect(r.status, r.stderr + r.stdout).toBe(0);
    for (const id of ids) expect(r.stdout + r.stderr).not.toContain(id);
    const pub = join(res, 'ho1/heldout3');
    const text = textUnder(pub);
    for (const id of ids) expect(text).not.toContain(id);
    const dirs = readdirSync(pub).filter((d) => !d.startsWith('summary'));
    expect(dirs).toHaveLength(2);
    for (const d of dirs) {
      expect(alias.isAlias(d)).toBe(true);
      expect(JSON.parse(readFileSync(join(pub, d, 'result.json'), 'utf8')).task).toBe(d);
    }
    const key = alias.loadAliasKey(priv);
    expect(dirs.sort()).toEqual(ids.map((id) => alias.aliasOf(id, key)).sort());
    for (const id of ids) expect(JSON.parse(readFileSync(join(priv, 'ho1/heldout3', id, 'result.json'), 'utf8')).task).toBe(id);
    expect(JSON.parse(readFileSync(join(priv, 'ho1/heldout3/summary.json'), 'utf8')).set).toBe('heldout3');

    // report.mjs on the public dir: no real ids, no crash on count-only checks
    const rr = spawnSync(process.execPath, [join(EVALS, 'report.mjs'), pub, '--private-dir', priv], { encoding: 'utf8' });
    expect(rr.status, rr.stderr).toBe(0);
    const after = textUnder(pub);
    for (const id of ids) expect(after).not.toContain(id);
    expect(after).not.toMatch(/check of|detail /);

    // the private copy keeps the real ids when re-summarised
    const s = await rep.report(join(priv, 'ho1/heldout3'), { privateDir: priv });
    expect(s.results.map((x: any) => x.task).sort()).toEqual(ids);
  }, 150_000);

  it('report.mjs never writes a real id from an old public result.json back', async () => {
    const pub = join(tmp, 'legacy/l/heldout2');
    mkdirSync(join(pub, 'h-0a1b2c'), { recursive: true });
    writeFileSync(join(pub, 'summary.json'), JSON.stringify({ label: 'l', set: 'heldout2', model: 'm', date: '2026-10-04T00:00:00Z' }));
    writeFileSync(join(pub, 'h-0a1b2c/result.json'), JSON.stringify({ task: 'secret-gamma', pass: false, score: 0, checks: 3, harnessError: false, metrics: { violations: 1, fatalViolations: 0 } }));
    const s = await rep.report(pub, { privateDir: join(tmp, 'priv') });
    expect(s.results[0].task).toBe('h-0a1b2c');
    expect(textUnder(pub)).not.toContain('secret-gamma');
    expect(JSON.parse(readFileSync(join(pub, 'summary.json'), 'utf8')).results[0]).toMatchObject({ task: 'h-0a1b2c', checks: 3, metrics: { violations: 1, fatalViolations: 0 } });
  });

  it('writeSummary refuses a held-out summary with a non-alias task', async () => {
    const summary = await load('sandbox/summary.mjs');
    const s = summary.summarise([{ task: 'secret-delta', pass: false, score: 0, metrics: {} }], { label: 'l', set: 'heldout2', model: 'm', date: '2026-10-04T00:00:00Z' });
    const d = mkdtempSync(join(tmp, 'ws-'));
    expect(() => summary.writeSummary(d, s, { hideChecks: true })).toThrow(/h-<alias>/);
    expect(existsSync(join(d, 'summary.json'))).toBe(false);
  });
});

describe('agent allowlist', () => {
  it('has no command that runs another command line', () => {
    const shell = run.AGENT_TOOLS.filter((t: string) => t.startsWith('Bash(')).map((t: string) => t.slice(5, -3));
    for (const c of ['env', 'xargs', 'find', 'sh', 'bash', 'nohup', 'timeout', 'sudo', 'exec', 'eval']) expect(shell).not.toContain(c);
    expect(shell.filter((c: string) => run.COMMAND_RUNNERS.includes(c))).toEqual([]);
    expect(shell).toContain('mgl');
  });
});

describe('transcript audit: cd, relative operands, fatal private dir and sibling sandboxes', () => {
  const runDir = '/tmp/mgl-eval-foo-abc';
  const priv = '/root/mgl-eval-private';
  let opts: any;
  beforeAll(() => { opts = { runDir, home: '/home/mgleval', forbidden: run.FORBIDDEN, fatal: run.fatalPaths({ privateDir: priv }) }; });
  const ev = (cmds: (string | [string, any])[]) => [{ type: 'assistant', message: { id: 'm', content: cmds.map((c, i) => (typeof c === 'string'
    ? { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: c } } : { type: 'tool_use', id: `t${i}`, name: c[0], input: c[1] })) } }];
  const fatalOf = (cmd: string) => metrics.metricsFrom(ev([cmd]), opts).fatalViolations.length;

  it('makes the review commands fatal', () => {
    expect(run.fatalPaths({ privateDir: priv })).toEqual(expect.arrayContaining([REPO, EVALS, priv]));
    for (const cmd of [
      `cd ./../.. && cd ${REPO.slice(1).split('/').slice(0, -1).join('/')} && cat ${REPO.split('/').pop()}/evals/tasks/x/grade.mjs`,
      'cd ./../.. && cd root && rm -rf mgl-eval-private/m4/x/stash',
      `env sh -c 'cd ./../.. && cd ${REPO.slice(1).split('/').slice(0, -1).join('/')} && cat ${REPO.split('/').pop()}/evals/heldout2/x/grade.mjs'`,
      'echo x | xargs sh -c "cd ./../.. && cd root && cat mgl-eval-private/a/b/stash/.golden/ref.json"',
      `cat ${priv}/m4/some-task/stash/.golden/ref.json`,
      'cd ..; cat mgl-eval-other-task-XYZ/.golden/a',
      `node -e "console.log(require('fs').readFileSync('${REPO}/evals/tasks/x/grade.mjs','utf8'))"`,
    ]) expect(fatalOf(cmd), cmd).toBe(1);
    expect(metrics.metricsFrom(ev([['Read', { file_path: `${priv}/m4/t/stash/.golden/ref.json` }]]), opts).fatalViolations).toHaveLength(1);
  });

  it('carries the shell cwd across Bash calls until Claude Code resets it', () => {
    const m = metrics.metricsFrom(ev(['cd ..', 'cat mgl-eval-other-XYZ/.golden/a']), opts);
    expect(m.fatalViolations).toEqual(['Bash: cat mgl-eval-other-XYZ/.golden/a']);
    expect(m.violations).toHaveLength(2);
    const reset = [
      { type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'cd ..' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: `Shell cwd was reset to ${runDir}` }] } },
      { type: 'assistant', message: { id: 'b', content: [{ type: 'tool_use', id: 'c2', name: 'Bash', input: { command: 'cat mgl-eval-other-XYZ/.golden/a' } }] } },
    ];
    const r = metrics.metricsFrom(reset, opts);
    expect(r.violations).toEqual(['Bash: cd ..']);
    expect(r.fatalViolations).toEqual([]);
  });

  it('flags rm/mv/cp/ln operands outside the run dir, relative to the cwd', () => {
    const v = (cmd: string) => metrics.metricsFrom(ev([cmd]), opts).violations.length;
    expect(v('cd /tmp && rm -rf foo')).toBe(1);
    expect(v('cp out/a.txt /tmp/b.txt')).toBe(1);
    expect(v('mv /tmp/x.mp4 out/x.mp4')).toBe(1);
    expect(v('cd sub && rm -rf ../out/old && ln -s a.mp4 b.mp4')).toBe(0);
    expect(v('cp /usr/share/fonts/x.ttf fonts/ && rm -f out/a.png 2>/dev/null')).toBe(0);
    expect(v('cd ~ && rm -rf .cache/x')).toBe(1);
  });

  it('still leaves ordinary work alone', () => {
    const m = metrics.metricsFrom(ev([
      'npx mgl render p.mgl.json out/a.mp4 && ls out && cat task.md | head -5',
      "grep -n 'speed' docs/x.md; sed -n '1,5p' a.txt > out/b.txt; awk '{print $1}' list.txt | sort | uniq",
      'mkdir -p out/frames && ffmpeg -y -i media/a.mp4 -vf fps=1 out/frames/%03d.png && node make.mjs --out out/v.mp4',
    ]), opts);
    expect(m.violations).toEqual([]);
  });
});
