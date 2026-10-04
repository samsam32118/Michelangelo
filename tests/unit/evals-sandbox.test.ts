// The eval runner and sandbox: arguments, transcript metrics, summaries, a dry run end to end, and the
// repository lock that must be restored on SIGINT and after a crash.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  it('parses options and refuses unsandboxed agent runs', () => {
    const o = run.parseArgs(['--set', 'heldout', '--tasks', 'a,b', '--parallel', '3', '--label', 'm1', '--timeout-scale', '1.5', '--dry-run', '--no-sandbox']);
    expect(o).toMatchObject({ set: 'heldout', tasks: ['a', 'b'], parallel: 3, label: 'm1', timeoutScale: 1.5, dryRun: true, sandbox: false, model: 'claude-opus-5-5', maxTurns: 200 });
    expect(() => run.parseArgs(['--no-sandbox'])).toThrow(/dry runs only/);
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
  const runner = (label: string, claude: string, extra: string[] = []) => spawnSync(process.execPath, [join(EVALS, 'run.mjs'), '--tasks', 'gif-export', '--claude', claude, '--no-template', '--no-credentials', '--no-history',
    '--label', label, '--results-dir', join(tmp, 'res'), '--private-dir', join(tmp, 'priv'), ...extra], { encoding: 'utf8', timeout: 180_000, env: { ...process.env, MGL_EVAL_LOCK_STATE: join(tmp, 'runner-lock.json') } });

  it('runs as the eval user without access to the repository, captures the transcript, grades and restores the lock', () => {
    const r = runner('fake-ok', fake);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(statSync(repo).mode & 0o777).not.toBe(0o700);
    const s = JSON.parse(readFileSync(join(tmp, 'res/fake-ok/main/summary.json'), 'utf8'));
    const t = s.results[0];
    expect(t.pass, JSON.stringify(t.checks)).toBe(true);
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
    expect(s.results[0]).toMatchObject({ timedOut: true, pass: false });
    expect(s.results[0].wallSec).toBeLessThan(30);
  }, 180_000);
});
