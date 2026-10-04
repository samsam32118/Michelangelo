#!/usr/bin/env node
// Re-summarise a results dir:
//   node evals/report.mjs evals/results/<label>/<set> [--history] [--transcripts <dir>] [--baseline] [--collect]
// Reads each <task>/result.json (and recomputes metrics from <task>/transcript.jsonl when present, with the current
// violation rules), then rewrites summary.json + summary.md. Pass/fail stay as graded at run time (a violation
// failure recorded by the runner is kept; old results are not re-judged).
//   --history     append a HISTORY.md row
//   --baseline    (main set) grade untouched sandboxes for tasks whose result has no baselineScore, store it
//   --collect     copy the outputs of run dirs that still exist into <task>/outputs, then delete those run dirs
//                 and the grader-only <task>/stash copies
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readTranscript, metricsFrom } from './sandbox/metrics.mjs';
import { summarise, writeSummary, appendHistory } from './sandbox/summary.mjs';
import { FORBIDDEN, gradeIn, keepOutputs } from './run.mjs';

const EVALS = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(EVALS, '..');

/** The agent HOME of an audit run, when the results do not record it: the /tmp/mgl-eval-home-* the transcripts use most. */
export function inferHome(transcriptFiles) {
  const n = new Map();
  for (const f of transcriptFiles) {
    if (!existsSync(f)) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/\/tmp\/mgl-eval-home-[A-Za-z0-9]+/g)) n.set(m[0], (n.get(m[0]) ?? 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Grade a freshly set-up, untouched sandbox of a main-set task; returns its score. */
export async function baselineScore(task, { env = {} } = {}) {
  const tdir = join(EVALS, 'tasks', task);
  const dir = mkdtempSync(join(tmpdir(), `mgl-eval-base-${task}-`));
  try {
    await (await import(pathToFileURL(join(tdir, 'setup.mjs')).href)).setup(dir);
    const g = await gradeIn(join(tdir, 'grade.mjs'), dir, env);
    return g.score ?? 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function report(dir, { history = false, transcripts, baseline = false, collect = false, parallel = 3 } = {}) {
  dir = resolve(dir);
  if (!existsSync(dir)) throw new Error(`${dir} does not exist. fix: pass evals/results/<label>/<set>.`);
  const prev = existsSync(join(dir, 'summary.json')) ? JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) : {};
  const set = prev.set ?? dir.split('/').pop();
  const tasks = readdirSync(dir).filter((t) => existsSync(join(dir, t, 'result.json'))).sort();
  if (!tasks.length) throw new Error(`no <task>/result.json under ${dir}.`);
  const tr = (t) => join(transcripts ?? dir, t, 'transcript.jsonl');
  const home = prev.agentHome ?? (prev.sandbox ? undefined : inferHome(tasks.map(tr)));
  const results = tasks.map((t) => {
    const r = JSON.parse(readFileSync(join(dir, t, 'result.json'), 'utf8'));
    if (existsSync(tr(t))) r.metrics = metricsFrom(readTranscript(tr(t)), { runDir: r.dir ?? '', home: r.agentHome ?? home ?? '/home/mgleval', forbidden: FORBIDDEN, fatal: [REPO, EVALS] });
    for (const k of ['violations', 'fatalViolations']) if (typeof r.metrics?.[k] === 'number') r.metrics[k] = Array(r.metrics[k]).fill('(hidden)');
    return r;
  });
  if (collect) {
    for (const r of results) {
      const td = join(dir, r.task);
      if (r.dir && existsSync(r.dir) && !r.dir.startsWith(REPO)) {
        r.outputs = keepOutputs(r.dir, join(td, 'outputs')).length;
        rmSync(r.dir, { recursive: true, force: true });
        r.dirRemoved = true;
      }
      rmSync(join(td, 'stash'), { recursive: true, force: true });
    }
  }
  if (baseline) {
    if (set !== 'main') throw new Error('--baseline works on the main set only (the held-out tasks are not read here).');
    const dist = join(REPO, 'dist/cli/main.js');
    const env = process.env.MGL_EVAL_MGL ? {} : existsSync(dist) ? { MGL_EVAL_MGL: dist } : {};
    const todo = results.filter((r) => typeof r.baselineScore !== 'number' && existsSync(join(EVALS, 'tasks', r.task, 'setup.mjs')));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(parallel, todo.length) }, async () => {
      while (next < todo.length) { const r = todo[next++]; r.baselineScore = await baselineScore(r.task, { env }); }
    }));
  }
  if (collect || baseline) {
    for (const r of results) {
      // store the run-time fields (not the recomputed metrics) back
      const file = join(dir, r.task, 'result.json');
      const orig = JSON.parse(readFileSync(file, 'utf8'));
      for (const k of ['baselineScore', 'outputs', 'dirRemoved']) if (r[k] !== undefined) orig[k] = r[k];
      writeFileSync(file, JSON.stringify(orig, null, 1));
    }
  }
  const s = summarise(results, { label: prev.label ?? dir.split('/').at(-2), set, model: prev.model ?? '?', date: prev.date ?? new Date().toISOString(), dryRun: !!prev.dryRun, sandbox: prev.sandbox,
    isolation: prev.isolation ?? (prev.sandbox ? 'user' : 'audit'), packageVersion: prev.packageVersion, timeoutScale: prev.timeoutScale, ...(home ? { agentHome: home } : {}), resummarisedAt: new Date().toISOString() });
  writeSummary(dir, s, { hideChecks: set === 'heldout' });
  if (history) appendHistory(join(EVALS, 'HISTORY.md'), s, 're-summarised');
  return s;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ti = args.indexOf('--transcripts');
  const dir = args.find((a, i) => !a.startsWith('--') && !(ti >= 0 && i === ti + 1));
  report(dir ?? '', { history: args.includes('--history'), transcripts: ti >= 0 ? args[ti + 1] : undefined, baseline: args.includes('--baseline'), collect: args.includes('--collect') }).then((s) => {
    console.log(`${s.passed}/${s.tasks} passed (${Math.round(s.successRate * 1000) / 10} %), mean score ${s.meanScore}${s.meanBaselineScore !== undefined ? `, baseline ${s.meanBaselineScore}, delta ${s.meanDeltaScore}` : ''}, permission denials ${s.permissionDenials}, violations ${s.violations} (${s.fatalViolations} fatal); wrote ${join(resolve(dir), 'summary.md')}`);
  }, (e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
