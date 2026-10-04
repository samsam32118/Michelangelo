#!/usr/bin/env node
// The eval runner (DESIGN §11.4, §16 #1). Usage:
//   node evals/run.mjs [--set main|heldout] [--tasks a,b] [--parallel 2] [--model claude-opus-5-5] [--label m1]
//                      [--timeout-scale 1] [--max-turns 200] [--dry-run] [--no-sandbox] [--no-build] [--pass-env A,B]
//                      [--no-history] [--note text] [--restore] [--claude <cmd>] [--no-template] [--no-credentials]
// --dry-run: no agent; setup + grade on the untouched sandboxes (must all fail), to test the harness.
// --no-sandbox (dry runs only): temp dirs as the current user, no eval user, no repository lock.
// --restore: put back the repository mode after a crashed run, then exit.
// --claude / --no-template / --no-credentials are for testing the harness with a stand-in agent (no package build).
import { spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './lib/util.mjs';
import * as S from './sandbox/sandbox.mjs';
import { readTranscript, metricsFrom } from './sandbox/metrics.mjs';
import { summarise, writeSummary, appendHistory } from './sandbox/summary.mjs';

const EVALS = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(EVALS, '..');

export function parseArgs(argv) {
  const o = { set: 'main', tasks: null, parallel: 2, model: 'claude-opus-5-5', label: null, timeoutScale: 1, maxTurns: 200, dryRun: false, sandbox: true, build: true, passEnv: [], history: true, note: '', restore: false,
    privateDir: process.env.MGL_EVAL_PRIVATE_DIR || '/root/mgl-eval-private', resultsDir: join(EVALS, 'results'), claude: 'claude', template: true, credentials: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value. fix: e.g. ${a} 2`); return v; };
    switch (a) {
      case '--set': o.set = next(); break;
      case '--tasks': o.tasks = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--parallel': o.parallel = Math.max(1, Number(next())); break;
      case '--model': o.model = next(); break;
      case '--label': o.label = next(); break;
      case '--timeout-scale': o.timeoutScale = Number(next()); break;
      case '--max-turns': o.maxTurns = Number(next()); break;
      case '--dry-run': o.dryRun = true; break;
      case '--no-sandbox': o.sandbox = false; break;
      case '--no-build': o.build = false; break;
      case '--pass-env': o.passEnv = next().split(',').filter(Boolean); break;
      case '--no-history': o.history = false; break;
      case '--note': o.note = next(); break;
      case '--restore': o.restore = true; break;
      case '--private-dir': o.privateDir = next(); break;
      case '--results-dir': o.resultsDir = resolve(next()); break;
      case '--claude': o.claude = next(); break;
      case '--no-template': o.template = false; break;
      case '--no-credentials': o.credentials = false; break;
      default: throw new Error(`unknown option ${a}. fix: see the usage at the top of evals/run.mjs.`);
    }
  }
  if (!['main', 'heldout'].includes(o.set)) throw new Error(`--set ${o.set}: use main or heldout.`);
  if (!o.sandbox && !o.dryRun) throw new Error('--no-sandbox is for dry runs only: real agent runs must be sandboxed. fix: add --dry-run or drop --no-sandbox.');
  o.label ??= `${new Date().toISOString().slice(0, 10)}-${o.dryRun ? 'dry' : 'run'}`;
  if (!/^[A-Za-z0-9._-]+$/.test(o.label)) throw new Error(`--label "${o.label}": use letters, digits, ".", "_" and "-".`);
  return o;
}

const PREAMBLE = `You are working in a sandbox: your current directory holds the task's files. The Michelangelo video library is installed here: run its CLI with \`npx mgl\` (start with \`npx mgl docs\`) and import it in Node scripts as 'michelangelo'. Its skill is in .claude/skills/michelangelo/SKILL.md (docs next to it). Use only this installed package and its docs; do not look for its source code elsewhere. Write outputs where the task says (paths are relative to this directory). Nobody will answer questions: decide and finish the task.

Task:
`;

/** Processes of the eval user whose working directory is inside dir. */
function killProcsIn(dir) {
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if ((cwd === dir || cwd.startsWith(dir + '/')) && statSync(`/proc/${pid}`).uid !== 0) process.kill(Number(pid), 'SIGKILL');
    } catch { /* gone or not ours */ }
  }
}

const children = new Set();
function runAgent({ dir, prompt, env, model, maxTurns, timeoutMs, transcript, stderrFile, sandbox, claude = 'claude' }) {
  return new Promise((done) => {
    const claudeArgs = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model, '--permission-mode', 'bypassPermissions', '--max-turns', String(maxTurns)];
    const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    const [cmd, args] = sandbox ? ['runuser', ['-u', S.USER, '--', 'env', '-i', ...envArgs, claude, ...claudeArgs]] : [claude, claudeArgs];
    const out = createWriteStream(transcript), err = createWriteStream(stderrFile);
    const t0 = Date.now();
    const p = spawn(cmd, args, { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: sandbox ? { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } : { ...process.env, ...env } });
    children.add(p);
    p.stdout.pipe(out); p.stderr.pipe(err);
    let timedOut = false;
    const kill = (sig) => { try { process.kill(-p.pid, sig); } catch { /* exited */ } };
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 10_000); }, timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer); children.delete(p);
      if (sandbox) killProcsIn(dir);
      out.end(); err.end();
      done({ code, timedOut, wallSec: (Date.now() - t0) / 1000 });
    });
    p.on('error', (e) => { err.write(String(e)); });
  });
}
const killChildren = () => { for (const p of children) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } } };

async function gradeIn(gradePath, dir, env, timeoutMs = 900_000) {
  const r = await run(process.execPath, [join(EVALS, 'sandbox/grade-child.mjs'), gradePath, dir], { timeoutMs, env: { ...process.env, ...env } });
  const line = r.stdout.toString().split('\n').reverse().find((l) => l.startsWith('MGL_GRADE '));
  if (line) return JSON.parse(line.slice(10));
  return { pass: false, score: 0, checks: [{ name: 'grader ran', pass: false, detail: `grader ${r.timedOut ? 'timed out' : `exited ${r.code}`}: ${r.stderr.slice(-800)}` }] };
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; res[i] = await fn(items[i], i); } }));
  return res;
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const log = (...a) => console.log(`[eval ${new Date().toISOString().slice(11, 19)}]`, ...a);
  const stale = S.isRoot() ? S.restoreRepo() : null;
  if (stale) { log(`restored ${stale.path} to mode ${stale.mode.toString(8)} (left by an interrupted run at ${stale.at})`); await S.killUserProcs(); }
  if (o.restore) { if (!stale) log('nothing to restore'); return { restored: stale }; }

  const setRoot = join(EVALS, o.set === 'main' ? 'tasks' : 'heldout');
  const hidden = o.set === 'heldout';
  const all = readdirSync(setRoot).filter((d) => existsSync(join(setRoot, d, 'task.md'))).sort();
  const tasks = o.tasks ? o.tasks.filter((t) => { if (!all.includes(t)) throw new Error(`unknown task "${t}" in the ${o.set} set. fix: one of ${hidden ? '(see evals/heldout)' : all.join(', ')}.`); return true; }) : all;
  const outRoot = join(o.resultsDir, o.label, o.set);
  const privRoot = hidden ? join(o.privateDir, o.label) : outRoot;
  mkdirSync(outRoot, { recursive: true });
  mkdirSync(privRoot, { recursive: true });
  log(`${o.set}: ${tasks.length} task(s), label ${o.label}, ${o.dryRun ? 'DRY RUN' : `model ${o.model}`}, parallel ${o.parallel}${o.sandbox ? `, sandbox user ${S.USER}` : ', no sandbox'}`);

  let template = null, agentEnv = {};
  if (o.sandbox) {
    const u = await S.ensureUser();
    log(`user ${S.USER} uid ${u.uid}${u.created ? ' (created)' : ''}`);
  }
  if (!o.dryRun && o.template) {
    const tgz = await S.packRepo(REPO, join(tmpdir(), 'mgl-eval-pack'), { build: o.build, log });
    template = await S.buildTemplate(tgz, { log });
    log(`template ${S.TEMPLATE}: michelangelo ${template.version} (${template.offline ? 'offline install' : 'online install'}), skill ${template.skill ? 'copied' : 'MISSING'}`);
  }
  if (!o.dryRun) agentEnv = o.sandbox ? (await S.prepareHome({ passEnv: o.passEnv, credentials: o.credentials, log })).env : {};
  const gradeEnv = { MGL_EVAL_RUN_AS: o.sandbox ? S.USER : '', ...(existsSync(S.templateCli()) ? { MGL_EVAL_MGL: S.templateCli() } : {}) };
  const unlock = o.sandbox ? S.lockRepo(REPO) : () => {};
  const onSignal = () => { killChildren(); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  let results;
  try {
    if (o.sandbox) log(`repository locked (mode 0700) for the run`);
    results = await pool(tasks, o.parallel, async (task) => {
      const tdir = join(setRoot, task);
      const meta = JSON.parse(readFileSync(join(tdir, 'meta.json'), 'utf8'));
      const resDir = join(outRoot, task), privDir = join(privRoot, task);
      rmSync(resDir, { recursive: true, force: true }); mkdirSync(resDir, { recursive: true }); mkdirSync(privDir, { recursive: true });
      const dir = o.sandbox ? join(S.HOME, 'runs', o.label, o.set, task) : mkdtempSync(join(tmpdir(), `mgl-eval-${task}-`));
      rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
      const r = { task, pass: false, score: 0, checks: [], metrics: {}, wallSec: 0, timedOut: false, dir, timeoutMin: meta.timeout_min, expectsWeak: !!meta.expects_weak };
      try {
        if (!o.dryRun && o.template) S.populateFromTemplate(dir);
        const { setup } = await import(join(tdir, 'setup.mjs'));
        await setup(dir);
        copyFileSync(join(tdir, 'task.md'), join(dir, 'task.md'));
        S.stash(dir, join(privDir, 'stash'));
        if (o.sandbox) await S.chownTree(dir);
        if (!o.dryRun) {
          const prompt = PREAMBLE + readFileSync(join(tdir, 'task.md'), 'utf8');
          const a = await runAgent({ dir, prompt, env: agentEnv, model: o.model, maxTurns: o.maxTurns, timeoutMs: (meta.timeout_min ?? 15) * 60_000 * o.timeoutScale,
            transcript: join(privDir, 'transcript.jsonl'), stderrFile: join(privDir, 'agent.stderr.log'), sandbox: o.sandbox, claude: o.claude });
          Object.assign(r, { timedOut: a.timedOut, wallSec: a.wallSec, exitCode: a.code });
          r.metrics = metricsFrom(readTranscript(join(privDir, 'transcript.jsonl')), { runDir: dir, forbidden: [REPO, '/root'] });
        }
        S.unstash(dir, join(privDir, 'stash'));
        const g = await gradeIn(join(tdir, 'grade.mjs'), dir, gradeEnv);
        Object.assign(r, { pass: g.pass, score: g.score, checks: g.checks });
      } catch (e) {
        r.error = String(e?.stack ?? e).slice(0, 2000);
        r.checks.push({ name: 'harness', pass: false, detail: r.error });
      }
      writeFileSync(join(privDir, 'result.json'), JSON.stringify(r, null, 1));
      if (hidden) writeFileSync(join(resDir, 'result.json'), JSON.stringify({ task, pass: r.pass, score: r.score, wallSec: r.wallSec, timedOut: r.timedOut, metrics: { ...r.metrics, violations: r.metrics.violations?.length ?? 0 } }, null, 1));
      log(`${task}: ${r.pass ? 'PASS' : 'fail'} score ${r.score}${o.dryRun ? '' : ` turns ${r.metrics.turns ?? 0} ${Math.round(r.wallSec)} s${r.timedOut ? ' TIMEOUT' : ''}`}${r.error ? ' (harness error)' : ''}`);
      return r;
    });
  } finally {
    unlock();
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    if (o.sandbox && !o.dryRun) await S.killUserProcs();
    if (o.sandbox) log('repository unlocked');
  }
  const s = summarise(results, {
    label: o.label, set: o.set, model: o.dryRun ? 'none' : o.model, date: new Date().toISOString(), dryRun: o.dryRun, sandbox: o.sandbox, packageVersion: template?.version, timeoutScale: o.timeoutScale,
  });
  writeSummary(outRoot, s, { hideChecks: hidden });
  if (hidden) writeSummary(privRoot, s);
  if (o.history) appendHistory(join(EVALS, 'HISTORY.md'), s, o.note);
  log(`${s.passed}/${s.tasks} passed; summary: ${join(outRoot, 'summary.md')}`);
  return s;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0), (e) => { console.error(`error: ${e?.message ?? e}`); process.exit(1); });
}
