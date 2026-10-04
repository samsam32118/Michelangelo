// The eval runner and sandbox: arguments, transcript metrics, summaries, a dry run end to end, and the
// repository lock that must be restored on SIGINT and after a crash.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EVALS = resolve(__dirname, '../../evals');
const load = (p: string): Promise<any> => import(pathToFileURL(join(EVALS, p)).href);
const tmp = mkdtempSync(join(tmpdir(), 'mgl-evals-sb-'));
let run: any, metrics: any, summary: any, sandbox: any;
beforeAll(async () => { [run, metrics, summary] = await Promise.all([load('run.mjs'), load('sandbox/metrics.mjs'), load('sandbox/summary.mjs')]); });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const isRoot = process.getuid?.() === 0;

describe('runner arguments', () => {
  it('parses options; --no-sandbox runs agents with audit isolation', () => {
    const o = run.parseArgs(['--set', 'heldout', '--tasks', 'a,b', '--parallel', '3', '--label', 'm1', '--timeout-scale', '1.5', '--dry-run', '--no-sandbox']);
    expect(o).toMatchObject({ set: 'heldout', tasks: ['a', 'b'], parallel: 3, label: 'm1', timeoutScale: 1.5, dryRun: true, sandbox: false, model: 'claude-opus-5-5', maxTurns: 200 });
    expect(run.parseArgs(['--no-sandbox'])).toMatchObject({ sandbox: false, dryRun: false });
    expect(() => run.parseArgs(['--set', 'x'])).toThrow(/main or heldout/);
    expect(() => run.parseArgs(['--bogus'])).toThrow(/unknown option/);
  });
});

describe('transcript metrics', () => {
  it('counts turns, tokens, shell timeouts, failed edits, error codes, verbs and violations', () => {
    const ev = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npx mgl show p.mgl.json && mgl render p.mgl.json out/a.mp4' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'error E_REF line 3: ... \nCommand timed out after 2m 0s' }] } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/home/mgleval/runs/x/t/p.mgl.json' } }, { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/home/user/Michelangelo/src/core/load.ts' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: '<tool_use_error>String to replace not found in file.</tool_use_error>' }, { type: 'tool_result', tool_use_id: 't3', content: 'x' }] } },
      { type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.5, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } },
    ];
    const m = metrics.metricsFrom(ev, { runDir: '/home/mgleval/runs/x/t', forbidden: ['/home/user/Michelangelo'] });
    expect(m).toMatchObject({ turns: 2, inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, costUsd: 0.5, bashTimeouts: 1, failedEdits: 1, errorCodes: { E_REF: 1 }, verbs: { show: 1, render: 1 } });
    expect(m.violations).toEqual(['Read: /home/user/Michelangelo/src/core/load.ts']);
  });
});

describe('violations (review finding 43) and the violation policy', () => {
  const runDir = '/tmp/mgl-eval-cta-end-abc';
  const ev = (calls: [string, any][]) => [{ type: 'assistant', message: { id: 'm', content: calls.map(([name, input], i) => ({ type: 'tool_use', id: `t${i}`, name, input })) } }];
  const opts = { runDir, home: '/home/mgleval', forbidden: ['/home/user', '/root'], fatal: ['/home/user/Michelangelo'] };

  it('resolves relative paths, Glob/Grep patterns and shell traversal against the run dir', () => {
    const m = metrics.metricsFrom(ev([
      ['Read', { file_path: '../../home/user/Michelangelo/evals/tasks/cta-end/grade.mjs' }],
      ['Glob', { pattern: '/home/user/Michelangelo/evals/**/grade.mjs' }],
      ['Grep', { pattern: 'x', path: '../../home/user' }],
      ['Grep', { pattern: 'grade', glob: '../../**/*.mjs' }],
      ['Bash', { command: 'cd ~ && cd ../user/Michelangelo/evals/heldout && cat */grade.mjs' }],
      ['Bash', { command: 'find / -name grade.mjs | xargs cat' }],
      ['Bash', { command: 'cd .. && ls' }],
      ['Read', { file_path: '/tmp/mgl-eval-gif-export-xyz/out/clip.gif' }],
      ['Read', { file_path: '/home/mgleval/runs/l/main/pip/out/pip.mp4' }],
      ['Read', { file_path: '/tmp/claude-0/-tmp-mgl-eval-pip-zzz/s/scratchpad/x' }],
    ]), opts);
    expect(m.violations).toHaveLength(10);
    expect(m.fatalViolations).toHaveLength(6);
    expect(m.fatalViolations.join('\n')).toMatch(/grade\.mjs \(\/home\/user\/Michelangelo\/evals/);
    expect(m.fatalViolations.join('\n')).toMatch(/cd ~ && cd \.\.\/user/);
    expect(m.violations).toContain('Bash: find / -name grade.mjs | xargs cat');
    expect(m.fatalViolations).not.toContain('Bash: find / -name grade.mjs | xargs cat');
  });

  it('does not flag the run dir, its own scratchpad, HOME tool dirs, system paths or non-path words', () => {
    const m = metrics.metricsFrom(ev([
      ['Read', { file_path: `${runDir}/task.md` }], ['Read', { file_path: 'out/a.png' }], ['Glob', { pattern: '**/*.mgl.json' }], ['Grep', { pattern: '/abs/regex/', path: 'src' }],
      ['Read', { file_path: '/tmp/claude-0/-tmp-mgl-eval-cta-end-abc/sess/scratchpad/x.png' }], ['Read', { file_path: '/home/mgleval/.claude/skills/michelangelo/SKILL.md' }],
      ['Bash', { command: "npx mgl render p.mgl.json out/a.mp4 2>/dev/null && ffmpeg -i a.mp4 -vf scale=480:-1 out.gif; sed -n '/## speed/,$p' x.md; cd sub && ls ./x; ls /usr/bin/ffmpeg" }],
      ['Bash', { command: "cat > plugins/p/src/index.ts <<'EOF'\n// a comment\nimport x from '/home/user/Michelangelo/src/x';\nEOF\nnode -e 1 | sed \"s/^/$f /\"" }],
    ]), opts);
    expect(m.violations).toEqual([]);
  });

  it('a fatal violation fails the run and keeps the graded verdict', () => {
    const r = { task: 't', pass: true, score: 1, metrics: { violations: ['Read: /home/user/Michelangelo/x', 'Read: /root/y'], fatalViolations: ['Read: /home/user/Michelangelo/x'] } };
    metrics.applyViolationPolicy(r);
    expect(r).toMatchObject({ pass: false, score: 0, gradedPass: true, gradedScore: 1, violationFail: true });
    expect((r as any).failReason).toMatch(/sandbox violation: 1 access/);
    const ok = { task: 't', pass: true, score: 1, metrics: { violations: ['Read: /root/y'], fatalViolations: [] } };
    expect(metrics.applyViolationPolicy(ok)).toMatchObject({ pass: true, score: 1 });
  });
});

describe('permission denials (review finding 49)', () => {
  it('counts denials separately; a denied Write is not a failed edit', () => {
    const ev = [
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/etc/x' } }, { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'rm out/a.png' } }, { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'p.mgl.json' } }] } },
      { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'w1', is_error: true, content: 'Claude requested permissions to write to /etc/x, but you haven\'t granted it yet.' },
        { type: 'tool_result', tool_use_id: 'b1', is_error: true, content: "rm in '/tmp/x/out/a.png' needs approval." },
        { type: 'tool_result', tool_use_id: 'e1', is_error: true, content: '<tool_use_error>String to replace not found in file.</tool_use_error>' }] } },
      { type: 'result', subtype: 'success', num_turns: 1, permission_denials: [{ tool_name: 'Write', tool_use_id: 'w1', tool_input: {} }, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: {} }] },
    ];
    const m = metrics.metricsFrom(ev, { runDir: '/tmp/x' });
    expect(m.permissionDenials).toBe(2);
    expect(m.failedEdits).toBe(1);
    const s = summary.summarise([{ task: 'a', pass: true, score: 1, metrics: m }], { label: 'l', set: 'main', model: 'm', date: '2026-10-04T00:00:00Z' });
    expect(s.permissionDenials).toBe(2);
    expect(summary.summaryMarkdown(s)).toMatch(/permission denials 2/);
  });
});

describe('baseline and delta scores (review finding 50)', () => {
  it('reports the untouched-sandbox score and the gain over it', () => {
    const s = summary.summarise([{ task: 'a', pass: true, score: 1, baselineScore: 0.75, metrics: {} }, { task: 'b', pass: false, score: 0.5, baselineScore: 0.25, metrics: {} }], { label: 'l', set: 'main', model: 'm', date: '2026-10-04T00:00:00Z' });
    expect(s).toMatchObject({ meanScore: 0.75, meanBaselineScore: 0.5, meanDeltaScore: 0.25, baselineTasks: 2 });
    expect(s.results[0].deltaScore).toBe(0.25);
    expect(summary.summaryMarkdown(s)).toMatch(/baseline 0\.5 on untouched sandboxes, delta 0\.25/);
  });
});

describe('held-out summary.json (review finding 51)', () => {
  it('holds no violation strings, failure reasons, run dirs or HOME', () => {
    const d = mkdtempSync(join(tmp, 'ho-'));
    const res = [{ task: 'secret-task', pass: false, score: 0, gradedPass: true, gradedScore: 1, violationFail: true, failReason: 'sandbox violation: 1 access(es) (first: Read: /home/user/Michelangelo/evals/heldout/x/grade.mjs)',
      dir: '/tmp/mgl-eval-secret-task-abc', agentHome: '/tmp/mgl-eval-home-q', checks: [{ name: 'hidden', pass: false, detail: 'y' }],
      metrics: { violations: ['Read: /home/user/Michelangelo/evals/heldout/x/grade.mjs', 'Bash: cat /root/z'], fatalViolations: ['Read: /home/user/Michelangelo/evals/heldout/x/grade.mjs'] } }];
    const s = summary.summarise(res, { label: 'l', set: 'heldout', model: 'm', date: '2026-10-04T00:00:00Z', agentHome: '/tmp/mgl-eval-home-q' });
    summary.writeSummary(d, s, { hideChecks: true });
    const text = readFileSync(join(d, 'summary.json'), 'utf8') + readFileSync(join(d, 'summary.md'), 'utf8');
    expect(text).not.toMatch(/Michelangelo|\/root|mgl-eval-|hidden|grade\.mjs/);
    const j = JSON.parse(readFileSync(join(d, 'summary.json'), 'utf8'));
    expect(j.results[0]).toMatchObject({ task: 'secret-task', violationFail: true, checks: 1, metrics: { violations: 2, fatalViolations: 1 } });
  });
});

describe('run-dir processes and outputs (review finding 47, cleanup)', () => {
  it('kills processes whose cwd is in the run dir, also when detached', async () => {
    const d = mkdtempSync(join(tmp, 'procs-'));
    const p = spawn('sleep', ['60'], { cwd: d, detached: true, stdio: 'ignore' });
    p.unref();
    await new Promise((r) => setTimeout(r, 200));
    const exited = new Promise((r) => p.on('exit', r));
    expect(run.killProcsIn(d)).toContain(p.pid);
    await exited;
    expect(run.killProcsIn(d)).toEqual([]);
  });

  it('keeps outputs, projects and scripts, not node_modules, media or grader files', () => {
    const d = mkdtempSync(join(tmp, 'keep-'));
    for (const f of ['out/a.mp4', 'p.mgl.json', 'make.mjs', 'node_modules/x/index.js', 'media/b.mp4', '.golden/g.png', 'task.md', '.mgl/p/look/sheet.png']) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), 'x'); }
    const kept = run.keepOutputs(d, join(d + '-kept'));
    expect(kept.sort()).toEqual(['make.mjs', 'out/a.mp4', 'p.mgl.json']);
  });
});

describe('report', () => {
  it('re-summarises with recomputed metrics, keeps pass/fail as graded, infers the audit HOME, adds baselines', async () => {
    const rep = await load('report.mjs');
    const d = join(tmp, 'rep/l1/main');
    mkdirSync(join(d, 'fix-broken-file'), { recursive: true });
    writeFileSync(join(d, 'summary.json'), JSON.stringify({ label: 'l1', set: 'main', model: 'm', date: '2026-10-04T00:00:00Z', sandbox: false }));
    writeFileSync(join(d, 'fix-broken-file/result.json'), JSON.stringify({ task: 'fix-broken-file', pass: true, score: 1, dir: '/tmp/mgl-eval-fix-broken-file-q', metrics: {}, checks: [] }));
    writeFileSync(join(d, 'fix-broken-file/transcript.jsonl'), [
      { type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/tmp/mgl-eval-home-Q1/.claude/skills/michelangelo/SKILL.md' } }, { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: join(EVALS, 'tasks/fix-broken-file/grade.mjs') } }] } },
      { type: 'result', subtype: 'success', num_turns: 1, permission_denials: [{ tool_use_id: 'zz' }] },
    ].map((e) => JSON.stringify(e)).join('\n'));
    const s = await rep.report(d, { baseline: true });
    const x = s.results[0];
    expect(x.pass).toBe(true); // graded then; not re-judged
    expect(x.metrics.fatalViolations).toHaveLength(1);
    expect(x.metrics.violations).toHaveLength(1); // the inferred HOME's skill is fine
    expect(x.metrics.permissionDenials).toBe(1);
    expect(typeof x.baselineScore).toBe('number');
    expect(x.baselineScore).toBeLessThan(1);
    expect(JSON.parse(readFileSync(join(d, 'fix-broken-file/result.json'), 'utf8')).baselineScore).toBe(x.baselineScore);
    expect(s.meanDeltaScore).toBe(Math.round((1 - x.baselineScore) * 1e4) / 1e4);
  }, 60_000);
});

describe('summaries', () => {
  it('writes success rate and aggregates; the held-out markdown has no check names', () => {
    const res = [{ task: 'a', pass: true, score: 1, checks: [{ name: 'secret check', pass: true, detail: '' }], metrics: { turns: 4, inputTokens: 10, outputTokens: 10, errorCodes: { E_REF: 2 } }, wallSec: 10 },
      { task: 'b', pass: false, score: 0.5, checks: [{ name: 'hidden thing', pass: false, detail: 'x' }], metrics: { turns: 6, errorCodes: { E_REF: 1, E_SCHEMA: 1 } }, wallSec: 30 }];
    const s = summary.summarise(res, { label: 'l', set: 'heldout', model: 'm', date: '2026-10-04T00:00:00Z' });
    expect(s).toMatchObject({ tasks: 2, passed: 1, successRate: 0.5, meanScore: 0.75, meanTurns: 5, meanWallSec: 20 });
    expect(s.topErrors[0]).toEqual(['E_REF', 3]);
    const md = summary.summaryMarkdown(s, { hideChecks: true });
    expect(md).not.toMatch(/secret check|hidden thing/);
    expect(summary.summaryMarkdown(s)).toMatch(/hidden thing/);
    const h = join(tmp, 'HISTORY.md');
    summary.appendHistory(h, s); summary.appendHistory(h, s, 'again');
    expect(readFileSync(h, 'utf8').split('\n').filter((l) => l.startsWith('| 2026-10-04')).length).toBe(2);
  });
});

describe('dry run end to end (no agent, no sandbox)', () => {
  it('sets up and grades tasks; untouched sandboxes all fail; report re-summarises', () => {
    const out = join(tmp, 'results');
    const r = spawnSync(process.execPath, [join(EVALS, 'run.mjs'), '--dry-run', '--no-sandbox', '--no-history', '--label', 't1', '--tasks', 'fix-broken-file,edit-200-clips', '--results-dir', out], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const s = JSON.parse(readFileSync(join(out, 't1/main/summary.json'), 'utf8'));
    expect(s).toMatchObject({ tasks: 2, passed: 0, dryRun: true });
    for (const x of s.results) {
      expect(existsSync(x.dir), x.dir).toBe(false); // run dirs are removed after grading
      expect(x.baselineScore).toBe(x.score);
      expect(existsSync(join(out, 't1/main', x.task, 'outputs'))).toBe(true);
      expect(existsSync(join(out, 't1/main', x.task, 'stash'))).toBe(false);
    }
    expect(readdirSync(join(out, 't1/main/fix-broken-file/outputs'))).toContain('broken.mgl.json');
    expect(readFileSync(join(out, 't1/main/summary.md'), 'utf8')).toMatch(/0\/2 passed/);
    const rep = spawnSync(process.execPath, [join(EVALS, 'report.mjs'), join(out, 't1/main')], { encoding: 'utf8' });
    expect(rep.status, rep.stderr).toBe(0);
    expect(rep.stdout).toMatch(/0\/2 passed/);
  }, 150_000);
});

describe.skipIf(!isRoot)('repository lock (root only)', () => {
  const state = join(tmp, 'lock-state.json');
  const env = { ...process.env, MGL_EVAL_LOCK_STATE: state };
  const child = (target: string) => spawn(process.execPath, ['--input-type=module', '-e',
    `const S = await import(${JSON.stringify(pathToFileURL(join(EVALS, 'sandbox/sandbox.mjs')).href)}); S.lockRepo(${JSON.stringify(target)}); console.log('locked'); setInterval(() => {}, 1000);`], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const waitLocked = (p: any) => new Promise<void>((res) => p.stdout.on('data', (d: Buffer) => { if (String(d).includes('locked')) res(); }));
  const mode = (f: string) => statSync(f).mode & 0o777;

  it('restores the mode on SIGINT', async () => {
    const target = mkdtempSync('/var/tmp/mgl-lock-test-');
    chmodSync(target, 0o755);
    const p = child(target);
    await waitLocked(p);
    expect(mode(target)).toBe(0o700);
    p.kill('SIGINT');
    await new Promise((r) => p.on('close', r));
    expect(mode(target)).toBe(0o755);
    expect(existsSync(state)).toBe(false);
    rmSync(target, { recursive: true, force: true });
  }, 30_000);

  it('after a crash (SIGKILL) the next start restores it', async () => {
    const target = mkdtempSync('/var/tmp/mgl-lock-test-');
    chmodSync(target, 0o751);
    const p = child(target);
    await waitLocked(p);
    p.kill('SIGKILL');
    await new Promise((r) => p.on('close', r));
    expect(mode(target)).toBe(0o700);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const S = await import(${JSON.stringify(pathToFileURL(join(EVALS, 'sandbox/sandbox.mjs')).href)}); console.log(JSON.stringify(S.restoreRepo()));`], { env, encoding: 'utf8' });
    expect(JSON.parse(r.stdout).path).toBe(target);
    expect(mode(target)).toBe(0o751);
    rmSync(target, { recursive: true, force: true });
  }, 30_000);

  it('a locked directory is unreadable to the eval user (when it exists)', async () => {
    sandbox = await load('sandbox/sandbox.mjs');
    if (spawnSync('id', ['-u', sandbox.USER]).status !== 0) return;
    const target = mkdtempSync('/var/tmp/mgl-lock-test-');
    chmodSync(target, 0o755);
    writeFileSync(join(target, 'secret.txt'), 'x');
    chmodSync(join(target, 'secret.txt'), 0o644);
    const read = () => spawnSync('runuser', ['-u', sandbox.USER, '--', 'cat', join(target, 'secret.txt')]).status;
    expect(read()).toBe(0);
    process.env.MGL_EVAL_LOCK_STATE = state;
    const unlock = sandbox.lockRepo(target);
    try { expect(read()).not.toBe(0); } finally { unlock(); delete process.env.MGL_EVAL_LOCK_STATE; }
    expect(read()).toBe(0);
    mkdirSync(join(target, 'x'));
    rmSync(target, { recursive: true, force: true });
  }, 30_000);
});

describe.skipIf(!isRoot)('a stand-in agent through the real sandbox (root only)', () => {
  const fakeDir = mkdtempSync('/var/tmp/mgl-fake-agent-');
  const repo = resolve(EVALS, '..');
  chmodSync(fakeDir, 0o755);
  const fake = join(fakeDir, 'claude-ok.sh'), slow = join(fakeDir, 'claude-slow.sh');
  writeFileSync(fake, `#!/bin/bash
echo '{"type":"system","subtype":"init"}'
echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npx mgl render demo.mgl.json out/clip.gif"}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"error E_RENDER: x. Command timed out after 2m 0s"}]}}'
ls ${repo} >/dev/null 2>&1 && touch REPO_READABLE
[ "$HOME" = "/home/mgleval" ] || touch WRONG_HOME
mkdir -p out && ffmpeg -loglevel error -ss 3 -t 3 -i media/bg.mp4 -vf "fps=15,scale=480:-1,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 out/clip.gif
echo '{"type":"result","subtype":"success","num_turns":1,"total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":4}}'
`);
  writeFileSync(slow, '#!/bin/bash\nsleep 60\n');
  chmodSync(fake, 0o755); chmodSync(slow, 0o755);
  afterAll(() => { for (const d of [fakeDir, '/home/mgleval/runs/fake-ok', '/home/mgleval/runs/fake-slow']) rmSync(d, { recursive: true, force: true }); });
  const runner = (label: string, claude: string, extra: string[] = []) => spawnSync(process.execPath, [join(EVALS, 'run.mjs'), '--tasks', 'gif-export', '--claude', claude, '--no-template', '--no-credentials', '--no-history', '--no-baseline',
    '--label', label, '--results-dir', join(tmp, 'res'), '--private-dir', join(tmp, 'priv'), ...extra], { encoding: 'utf8', timeout: 180_000, env: { ...process.env, MGL_EVAL_LOCK_STATE: join(tmp, 'runner-lock.json') } });

  it('runs as the eval user without access to the repository, captures the transcript, grades and restores the lock', () => {
    const r = runner('fake-ok', fake, ['--keep-dirs']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(statSync(repo).mode & 0o777).not.toBe(0o700);
    const s = JSON.parse(readFileSync(join(tmp, 'res/fake-ok/main/summary.json'), 'utf8'));
    const t = s.results[0];
    // the GIF itself is right; the label check needs the project rendered (plain ffmpeg ignores it)
    expect(t.checks[0].pass, JSON.stringify(t.checks)).toBe(true);
    expect(t.metrics).toMatchObject({ turns: 1, bashTimeouts: 1, errorCodes: { E_RENDER: 1 }, verbs: { render: 1 } });
    expect(existsSync(join(t.dir, 'REPO_READABLE'))).toBe(false);
    expect(existsSync(join(t.dir, 'WRONG_HOME'))).toBe(false);
    expect(statSync(join(t.dir, 'out/clip.gif')).uid).not.toBe(0);
    expect(existsSync(join(tmp, 'res/fake-ok/main/gif-export/transcript.jsonl'))).toBe(true);
    expect(existsSync(join(t.dir, '.setup.json'))).toBe(true);
  }, 180_000);

  it('kills an agent at the wall-clock limit and still grades', () => {
    const r = runner('fake-slow', slow, ['--timeout-scale', '0.002']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const s = JSON.parse(readFileSync(join(tmp, 'res/fake-slow/main/summary.json'), 'utf8'));
    expect(s.results[0]).toMatchObject({ timedOut: true, pass: false, dirRemoved: true });
    expect(s.results[0].wallSec).toBeLessThan(30);
    expect(existsSync(s.results[0].dir)).toBe(false);
  }, 180_000);
});
