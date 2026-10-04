#!/usr/bin/env node
// The eval runner (DESIGN §11.4, §16 #1). Usage:
//   node evals/run.mjs [--set main|heldout] [--tasks a,b] [--parallel 2] [--model claude-opus-5-5] [--label m1]
//                      [--timeout-scale 1] [--max-turns 200] [--dry-run] [--no-sandbox] [--no-build] [--pass-env A,B]
//                      [--no-history] [--note text] [--restore] [--claude <cmd>] [--no-template] [--no-credentials]
//                      [--keep-dirs] [--no-baseline] [--private-dir <dir>] [--results-dir <dir>] [--sets-dir <dir>]
//                      [--arm with|without] [--machine-rate 0.10] [--vision] [--judge-model <model>]
// --arm (DESIGN §17.2): "with" (default) installs the packed library and its skill; "without" installs no Michelangelo
//   (a template with @napi-rs/canvas only; ffmpeg, Node and Python as always) and its results go to
//   <results>/<label>/<set>-without. Checks named "[lib] ..." are library-only: not counted in "without"; tasks with
//   meta.json `library_only: true` (no deliverable checks) are not run in "without".
// --machine-rate: $ per hour of agent wall clock for the machine cost (default 0.10). --vision: after grading, judge
//   the deliverable(s) with evals/vision (contact sheets + sound summary, `claude -p` with Read only, run once;
//   the --claude command is used for it too); the judge's cost is recorded apart from the run's cost.
// --private-dir: held-out transcripts, results and the alias key (default $MGL_EVAL_PRIVATE_DIR or /root/mgl-eval-private);
//   a held-out set's private results go to <private-dir>/<label>/<set>. --sets-dir: where the task sets live (tests).
// --dry-run: no agent; setup + grade on the untouched sandboxes (must all fail), to test the harness.
// --no-sandbox (dry runs only): temp dirs as the current user, no eval user, no repository lock.
// --restore: put back the repository mode after a crashed run, then exit.
// --claude / --no-template / --no-credentials are for testing the harness with a stand-in agent (no package build).
// --keep-dirs: keep each run dir after grading (by default it is deleted; the outputs the report needs are copied
//   to <results>/<task>/outputs). --no-baseline: skip grading the untouched sandbox (the baseline score).
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './lib/util.mjs';
import * as S from './sandbox/sandbox.mjs';
import { readTranscript, metricsFrom, applyViolationPolicy } from './sandbox/metrics.mjs';
import { summarise, writeSummary, appendHistory, publicResult } from './sandbox/summary.mjs';
import { aliasOf, loadAliasKey, isHiddenSet } from './sandbox/alias.mjs';
import { PREAMBLES, applyArm, armSetDir, checkArm, costOf, DEFAULT_MACHINE_RATE } from './sandbox/arms.mjs';
import { visionScore } from './vision/vision.mjs';

export { aliasOf };

const EVALS = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(EVALS, '..');
/** Paths whose access is a violation; the repository and evals/ (and other sandboxes) are fatal. */
export const FORBIDDEN = [REPO, '/root', '/home/user', '/home/claude', '/tmp/claude-0/-home-user', EVALS];
export const DEFAULT_PRIVATE_DIR = process.env.MGL_EVAL_PRIVATE_DIR || '/root/mgl-eval-private';
/**
 * Paths whose access fails the run: the repository, evals/, the private results dir (held-out transcripts and the
 * grader-only stash of every task) and the results dir. Other sandboxes are fatal in metricsFrom itself.
 */
export const fatalPaths = ({ privateDir = DEFAULT_PRIVATE_DIR, resultsDir, setsDir } = {}) => [...new Set([REPO, EVALS, privateDir, resultsDir, setsDir].filter(Boolean).map((p) => resolve(p)))];

export function parseArgs(argv) {
  const o = { set: 'main', tasks: null, parallel: 2, model: 'claude-opus-5-5', label: null, timeoutScale: 1, maxTurns: 200, dryRun: false, sandbox: true, build: true, passEnv: [], history: true, note: '', restore: false,
    privateDir: DEFAULT_PRIVATE_DIR, resultsDir: join(EVALS, 'results'), setsDir: EVALS, claude: 'claude', template: true, credentials: true, keepDirs: false, baseline: true,
    arm: 'with', machineRate: DEFAULT_MACHINE_RATE, vision: false, judgeModel: null };
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
      case '--private-dir': o.privateDir = resolve(next()); break;
      case '--results-dir': o.resultsDir = resolve(next()); break;
      case '--sets-dir': o.setsDir = resolve(next()); break;
      case '--claude': o.claude = next(); break;
      case '--no-template': o.template = false; break;
      case '--no-credentials': o.credentials = false; break;
      case '--keep-dirs': o.keepDirs = true; break;
      case '--no-baseline': o.baseline = false; break;
      case '--arm': o.arm = checkArm(next()); break;
      case '--machine-rate': o.machineRate = Number(next()); if (!(o.machineRate >= 0)) throw new Error('--machine-rate: a number of $ per hour, e.g. 0.10.'); break;
      case '--vision': o.vision = true; break;
      case '--judge-model': o.judgeModel = next(); break;
      default: throw new Error(`unknown option ${a}. fix: see the usage at the top of evals/run.mjs.`);
    }
  }
  if (!/^(main|heldout\d*)$/.test(o.set)) throw new Error(`--set ${o.set}: use main or heldout (heldout2, ... for later held-out sets).`);
  // --no-sandbox with real agents = "audit" isolation: the agent runs as the current user in a fresh directory with a
  // fresh HOME; it is not prevented from reading the repository, but every access outside its run dir is recorded
  // as a violation from the transcript and reported (DESIGN.md §16 #1 records why).
  o.judgeModel ??= o.model;
  o.label ??= `${new Date().toISOString().slice(0, 10)}-${o.dryRun ? 'dry' : 'run'}`;
  if (!/^[A-Za-z0-9._-]+$/.test(o.label)) throw new Error(`--label "${o.label}": use letters, digits, ".", "_" and "-".`);
  return o;
}

/** Is a task library-only (meta.json `library_only: true`: no deliverable checks, so not run in the "without" arm)? */
export function isLibraryOnly(taskDir) {
  try { return JSON.parse(readFileSync(join(taskDir, 'meta.json'), 'utf8')).library_only === true; } catch { return false; }
}

/** The prompt preamble of an arm (the task text follows it). */
export const preambleFor = (arm = 'with') => PREAMBLES[arm];

/**
 * Kill every process whose working directory is inside dir (the agent's leftovers, e.g. a `mgl render --detach`
 * worker, which runs in its own process group and survives the group kill), and the pids recorded in
 * .mgl/<project>/render.json. Never this process or its ancestors. Returns the pids signalled.
 */
export function killProcsIn(dir) {
  const killed = [];
  const spare = new Set([process.pid, process.ppid]);
  const kill = (pid) => { if (!pid || spare.has(pid)) return; try { process.kill(pid, 'SIGKILL'); killed.push(pid); } catch { /* gone or not ours */ } };
  let procs = [];
  try { procs = readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch { /* no procfs */ }
  for (const pid of procs) {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === dir || cwd.startsWith(dir + '/')) kill(Number(pid));
    } catch { /* gone or not ours */ }
  }
  try {
    for (const p of readdirSync(join(dir, '.mgl'))) {
      try {
        const st = JSON.parse(readFileSync(join(dir, '.mgl', p, 'render.json'), 'utf8'));
        const pid = Number(st.pid);
        // only a render worker: its command line runs node (never signal an unrelated reused pid)
        if (Number.isInteger(pid) && pid > 1 && /node|mgl|michelangelo/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) kill(pid);
      } catch { /* no state or not running */ }
    }
  } catch { /* no .mgl */ }
  return killed;
}

/** Wait until no process has its cwd in dir (or timeoutMs passes). */
async function settleProcs(dir, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && killProcsIn(dir).length) await new Promise((r) => setTimeout(r, 200));
}

/** Outputs kept for the report (small, agent-made files: out/, projects, scripts, plugins), copied before the run dir is deleted. */
export function keepOutputs(dir, dest, { maxFile = 25 * 1024 * 1024, maxTotal = 150 * 1024 * 1024 } = {}) {
  let total = 0;
  const kept = [];
  const SKIP = new Set(['node_modules', '.claude', '.cache', '.npm', '.golden', '.git', 'media']);
  const walk = (rel, depth) => {
    if (depth > 5) return;
    let entries = [];
    try { entries = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !(depth === 0 && e.name === '.mgl')) walk(r, depth + 1); continue; }
      if (!e.isFile()) continue;
      const keep = r.startsWith('out/') || /\.(mgl\.json|m?js|m?ts|cjs|json|srt|vtt|md|txt|csv)$/.test(e.name);
      if (!keep || ['package-lock.json', 'package.json', 'task.md', '.setup.json'].includes(r)) continue;
      const size = lstatSync(join(dir, r)).size;
      if (size > maxFile || total + size > maxTotal) continue;
      mkdirSync(dirname(join(dest, r)), { recursive: true });
      copyFileSync(join(dir, r), join(dest, r));
      total += size; kept.push(r);
    }
  };
  rmSync(dest, { recursive: true, force: true });
  walk('', 0);
  return kept;
}

/** Copy a fresh run dir for the baseline grade (node_modules linked, not copied). */
function copyForBaseline(dir) {
  const b = mkdtempSync(join(tmpdir(), 'mgl-eval-base-'));
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules') symlinkSync(join(dir, n), join(b, n));
    else cpSync(join(dir, n), join(b, n), { recursive: true, verbatimSymlinks: true });
  }
  return b;
}

/**
 * What an eval agent may use: file tools, and the shell for the library, Node, ffmpeg and plain file commands.
 * No command that runs another command line given as its arguments (env, xargs, find -exec, sh/bash -c, nohup,
 * timeout, sudo ...): such a wrapper would let any command through without a permission prompt. `find` is left out
 * for that reason (the Glob tool covers it). node/python3/npx run code by design; the sandbox user and the
 * transcript audit are the barrier there.
 */
export const COMMAND_RUNNERS = ['env', 'xargs', 'find', 'sh', 'bash', 'zsh', 'dash', 'nohup', 'timeout', 'sudo', 'su', 'runuser', 'exec', 'eval', 'command', 'nice', 'stdbuf', 'setsid', 'watch', 'parallel', 'script', 'time', 'busybox', 'chroot', 'unshare', 'nsenter'];
export const AGENT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite',
  ...['npx', 'mgl', 'node', 'npm', 'ffmpeg', 'ffprobe', 'ls', 'cat', 'head', 'tail', 'wc', 'mkdir', 'cp', 'mv', 'grep', 'echo', 'pwd', 'sort', 'diff', 'file', 'stat', 'du', 'python3',
    'cd', 'sed', 'awk', 'cut', 'tr', 'uniq', 'tee', 'touch', 'printf', 'test', 'which', 'sleep', 'basename', 'dirname', 'cmp', 'sha256sum', 'md5sum', 'jq', 'rm', 'ln', 'date', 'seq'].map((c) => `Bash(${c}:*)`)];

const children = new Set();
function runAgent({ dir, prompt, env, model, maxTurns, timeoutMs, transcript, stderrFile, sandbox, claude = 'claude' }) {
  return new Promise((done) => {
    const claudeArgs = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model, '--max-turns', String(maxTurns),
      // default permission mode with an allowlist (no bypass): anything else is denied in -p mode and counted
      '--allowedTools', ...AGENT_TOOLS, '--disallowedTools', 'WebFetch', 'WebSearch'];
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
      killProcsIn(dir); // always: detached renders leave the process group (audit mode too)
      out.end(); err.end();
      done({ code, timedOut, wallSec: (Date.now() - t0) / 1000 });
    });
    p.on('error', (e) => { err.write(String(e)); });
  });
}
const killChildren = () => { for (const p of children) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } } };

export async function gradeIn(gradePath, dir, env, timeoutMs = 900_000) {
  // the grader's temp files (renders, frames) go to a dir removed afterwards
  const tmp = mkdtempSync(join(tmpdir(), 'mgl-eval-grade-'));
  let r;
  try { r = await run(process.execPath, [join(EVALS, 'sandbox/grade-child.mjs'), gradePath, dir], { timeoutMs, env: { ...process.env, ...env, TMPDIR: tmp } }); } finally { rmSync(tmp, { recursive: true, force: true }); }
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

  const setRoot = join(o.setsDir, o.set === 'main' ? 'tasks' : o.set);
  const hidden = isHiddenSet(o.set);
  // held-out aliases are keyed by a secret in the private dir (DESIGN §16.1): a guessed id cannot be confirmed
  const aliasKey = hidden ? loadAliasKey(o.privateDir) : null;
  const fatal = fatalPaths(o);
  const all = readdirSync(setRoot).filter((d) => existsSync(join(setRoot, d, 'task.md'))).sort();
  const asked = o.tasks ? o.tasks.filter((t) => { if (!all.includes(t)) throw new Error(`unknown task "${t}" in the ${o.set} set. fix: one of ${hidden ? '(see evals/heldout)' : all.join(', ')}.`); return true; }) : all;
  // meta.library_only tasks (the deliverable is the project file itself) have no deliverable checks: not run in "without"
  const excluded = o.arm === 'without' ? asked.filter((t) => isLibraryOnly(join(setRoot, t))) : [];
  const tasks = asked.filter((t) => !excluded.includes(t));
  const setDir = armSetDir(o.set, o.arm);
  const outRoot = join(o.resultsDir, o.label, setDir);
  const privRoot = hidden ? join(o.privateDir, o.label, setDir) : outRoot;
  mkdirSync(outRoot, { recursive: true });
  mkdirSync(privRoot, { recursive: true });
  if (excluded.length) log(`arm without: ${excluded.length} library-only task(s) not run${hidden ? '' : ` (${excluded.join(', ')})`}`);
  log(`${o.set}: ${tasks.length} task(s), label ${o.label}, ${o.dryRun ? 'DRY RUN' : `model ${o.model}`}, parallel ${o.parallel}, arm ${o.arm}${o.vision ? ', vision on' : ''}${o.sandbox ? `, sandbox user ${S.USER}` : ', no sandbox'}`);

  let template = null, agentEnv = {};
  if (o.sandbox) {
    const u = await S.ensureUser();
    log(`user ${S.USER} uid ${u.uid}${u.created ? ' (created)' : ''}`);
  }
  if (!o.dryRun && o.template && o.arm === 'without') {
    template = await S.buildBareTemplate({ log });
    log(`template ${S.TEMPLATE_WITHOUT}: no Michelangelo; ${template.canvas} (${template.offline ? 'offline install' : 'online install'}), no skill`);
  } else if (!o.dryRun && o.template) {
    const tgz = await S.packRepo(REPO, join(tmpdir(), 'mgl-eval-pack'), { build: o.build, log });
    template = await S.buildTemplate(tgz, { log });
    log(`template ${S.TEMPLATE}: michelangelo ${template.version} (${template.offline ? 'offline install' : 'online install'}), skill ${template.skill ? 'copied' : 'MISSING'}`);
  }
  if (!o.dryRun) agentEnv = o.sandbox ? (await S.prepareHome({ passEnv: o.passEnv, credentials: o.credentials, seedCache: o.arm === 'with', log })).env
    : { HOME: mkdtempSync(join(tmpdir(), 'mgl-eval-home-')), DISABLE_AUTOUPDATER: '1' };
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
      // held-out task ids never appear in public output (dirs, logs, summaries): stable anonymous aliases instead
      const shown = hidden ? aliasOf(task, aliasKey) : task;
      const resDir = join(outRoot, shown), privDir = join(privRoot, task);
      rmSync(resDir, { recursive: true, force: true }); mkdirSync(resDir, { recursive: true }); mkdirSync(privDir, { recursive: true });
      const dir = o.sandbox ? join(S.HOME, 'runs', o.label, setDir, task) : mkdtempSync(join(tmpdir(), `mgl-eval-${task}-`));
      rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
      const r = { task, arm: o.arm, pass: false, score: 0, checks: [], metrics: {}, wallSec: 0, timedOut: false, dir, timeoutMin: meta.timeout_min, expectsWeak: !!meta.expects_weak };
      if (!o.dryRun) r.agentHome = agentEnv.HOME;
      try {
        if (!o.dryRun && o.template) S.populateFromTemplate(dir, S.templateFor(o.arm));
        const { setup } = await import(join(tdir, 'setup.mjs'));
        await setup(dir);
        copyFileSync(join(tdir, 'task.md'), join(dir, 'task.md'));
        if (o.baseline && !o.dryRun) {
          // the baseline: what the untouched sandbox already scores (graded on a copy, so grading leaves no trace)
          const b = copyForBaseline(dir);
          if (o.sandbox) await S.chownTree(b);
          try { r.baselineScore = applyArm(await gradeIn(join(tdir, 'grade.mjs'), b, gradeEnv), o.arm).score ?? 0; } finally { rmSync(b, { recursive: true, force: true }); }
        }
        S.stash(dir, join(privDir, 'stash'));
        if (o.sandbox) await S.chownTree(dir);
        if (!o.dryRun) {
          const prompt = preambleFor(o.arm) + readFileSync(join(tdir, 'task.md'), 'utf8');
          const a = await runAgent({ dir, prompt, env: agentEnv, model: o.model, maxTurns: o.maxTurns, timeoutMs: (meta.timeout_min ?? 15) * 60_000 * o.timeoutScale,
            transcript: join(privDir, 'transcript.jsonl'), stderrFile: join(privDir, 'agent.stderr.log'), sandbox: o.sandbox, claude: o.claude });
          Object.assign(r, { timedOut: a.timedOut, wallSec: a.wallSec, exitCode: a.code });
          r.metrics = metricsFrom(readTranscript(join(privDir, 'transcript.jsonl')), { runDir: dir, home: agentEnv.HOME, forbidden: FORBIDDEN, fatal });
          await settleProcs(dir); // nothing of the agent's may still write outputs while grading
        }
        S.unstash(dir, join(privDir, 'stash'));
        const g = applyArm(await gradeIn(join(tdir, 'grade.mjs'), dir, gradeEnv), o.arm);
        Object.assign(r, { pass: g.pass, score: g.score, checks: g.checks });
        if (g.skippedChecks) r.skippedChecks = g.skippedChecks; // library-only checks, not counted in this arm
        r.cost = costOf(r, o.machineRate);
        if (o.vision) {
          r.vision = await visionScore({ dir, taskMd: readFileSync(join(tdir, 'task.md'), 'utf8'), meta, result: g, claude: o.claude, model: o.judgeModel, keepDir: join(privDir, 'vision') });
        }
        if (o.dryRun && !o.baseline) delete r.baselineScore;
        else if (o.dryRun) r.baselineScore = g.score; // a dry run grades the untouched sandbox itself
        applyViolationPolicy(r);
      } catch (e) {
        r.error = String(e?.stack ?? e).slice(0, 2000);
        r.checks.push({ name: 'harness', pass: false, detail: r.error });
      }
      // keep what the report needs (outside /tmp), then remove the run dir and the grader-only stash
      try {
        if (existsSync(dir)) { await settleProcs(dir); r.outputs = keepOutputs(dir, join(privDir, 'outputs')).length; }
        if (!o.keepDirs) { rmSync(dir, { recursive: true, force: true }); r.dirRemoved = true; }
        rmSync(join(privDir, 'stash'), { recursive: true, force: true });
      } catch (e) { r.cleanupError = String(e?.message ?? e).slice(0, 300); }
      writeFileSync(join(privDir, 'result.json'), JSON.stringify(r, null, 1));
      if (hidden) {
        // the public copy names the task only by its alias (counts only, no check names, paths or reasons)
        writeFileSync(join(resDir, 'result.json'), JSON.stringify({ ...publicResult(r), task: shown }, null, 1));
      }
      const vis = r.vision ? (typeof r.vision.overall === 'number' ? ` vision ${r.vision.overall}` : r.vision.error ? ' vision error' : ' no vision') : '';
      log(`${shown}: ${r.pass ? 'PASS' : 'fail'} score ${r.score}${vis}${o.dryRun ? '' : ` $${r.cost?.totalUsd ?? 0} turns ${r.metrics.turns ?? 0} ${Math.round(r.wallSec)} s${r.timedOut ? ' TIMEOUT' : ''}`}${r.error ? ' (harness error)' : ''}${r.violationFail ? ' (failed: sandbox violation)' : ''}`);
      return r;
    });
  } finally {
    unlock();
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    if (!o.sandbox && agentEnv.HOME?.startsWith(join(tmpdir(), 'mgl-eval-home-'))) rmSync(agentEnv.HOME, { recursive: true, force: true });
    if (o.sandbox && !o.dryRun) await S.killUserProcs();
    if (o.sandbox) log('repository unlocked');
  }
  const pubResults = hidden ? results.map((r) => ({ ...r, task: aliasOf(r.task, aliasKey) })) : results;
  const meta = {
    label: o.label, set: o.set, model: o.dryRun ? 'none' : o.model, date: new Date().toISOString(), dryRun: o.dryRun, sandbox: o.sandbox, isolation: o.sandbox ? 'user' : 'audit', packageVersion: template?.version, timeoutScale: o.timeoutScale, agentHome: agentEnv.HOME,
    arm: o.arm, machineRate: o.machineRate, ...(excluded.length ? { libraryOnlyExcluded: hidden ? excluded.length : excluded } : {}), vision: o.vision, ...(o.vision ? { judgeModel: o.judgeModel } : {}),
  };
  const s = summarise(pubResults, meta);
  writeSummary(outRoot, s, { hideChecks: hidden });
  if (hidden) writeSummary(privRoot, summarise(results, meta));
  if (o.history) appendHistory(join(EVALS, 'HISTORY.md'), s, o.note);
  log(`${s.passed}/${s.tasks} passed; summary: ${join(outRoot, 'summary.md')}`);
  return s;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0), (e) => { console.error(`error: ${e?.message ?? e}`); process.exit(1); });
}
