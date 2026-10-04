#!/usr/bin/env node
// Re-summarise a results dir: node evals/report.mjs evals/results/<label>/<set> [--history] [--transcripts <dir>]
// Reads each <task>/result.json (and recomputes metrics from <task>/transcript.jsonl when present), then rewrites
// summary.json + summary.md. --history appends a HISTORY.md row.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript, metricsFrom } from './sandbox/metrics.mjs';
import { summarise, writeSummary, appendHistory } from './sandbox/summary.mjs';

const EVALS = dirname(fileURLToPath(import.meta.url));

export function report(dir, { history = false, transcripts } = {}) {
  dir = resolve(dir);
  if (!existsSync(dir)) throw new Error(`${dir} does not exist. fix: pass evals/results/<label>/<set>.`);
  const prev = existsSync(join(dir, 'summary.json')) ? JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) : {};
  const set = prev.set ?? dir.split('/').pop();
  const results = readdirSync(dir).filter((t) => existsSync(join(dir, t, 'result.json'))).sort().map((t) => {
    const r = JSON.parse(readFileSync(join(dir, t, 'result.json'), 'utf8'));
    const tr = join(transcripts ?? dir, t, 'transcript.jsonl');
    if (existsSync(tr)) r.metrics = metricsFrom(readTranscript(tr), { runDir: r.dir ?? '', forbidden: [resolve(EVALS, '..'), '/root'] });
    if (typeof r.metrics?.violations === 'number') r.metrics.violations = Array(r.metrics.violations).fill('(hidden)');
    return r;
  });
  if (!results.length) throw new Error(`no <task>/result.json under ${dir}.`);
  const s = summarise(results, { label: prev.label ?? dir.split('/').at(-2), set, model: prev.model ?? '?', date: prev.date ?? new Date().toISOString(), dryRun: !!prev.dryRun, sandbox: prev.sandbox, packageVersion: prev.packageVersion });
  writeSummary(dir, s, { hideChecks: set === 'heldout' });
  if (history) appendHistory(join(EVALS, 'HISTORY.md'), s, 're-summarised');
  return s;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const ti = args.indexOf('--transcripts');
  try {
    const s = report(dir ?? '', { history: args.includes('--history'), transcripts: ti >= 0 ? args[ti + 1] : undefined });
    console.log(`${s.passed}/${s.tasks} passed (${Math.round(s.successRate * 1000) / 10} %), mean score ${s.meanScore}; wrote ${join(resolve(dir), 'summary.md')}`);
  } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
}
