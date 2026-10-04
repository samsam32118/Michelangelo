// Summaries of a results dir (summary.json + summary.md) and the HISTORY.md row.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
const k = (n) => (n >= 1e6 ? `${r(n / 1e6, 2)}M` : n >= 1e3 ? `${r(n / 1e3, 1)}k` : String(n ?? 0));

/** results: [{task, pass, score, checks?, metrics, wallSec, timedOut, error?}] */
export function summarise(results, meta) {
  const ok = results.filter((x) => x.pass);
  const sumObj = (key) => results.reduce((acc, x) => { for (const [c, n] of Object.entries(x.metrics?.[key] ?? {})) acc[c] = (acc[c] ?? 0) + n; return acc; }, {});
  const top = (o, n = 8) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  const tokens = (x) => (x.metrics?.inputTokens ?? 0) + (x.metrics?.outputTokens ?? 0) + (x.metrics?.cacheReadTokens ?? 0) + (x.metrics?.cacheCreationTokens ?? 0);
  return {
    ...meta,
    tasks: results.length,
    passed: ok.length,
    successRate: r(results.length ? ok.length / results.length : 0, 4),
    meanScore: r(mean(results.map((x) => x.score ?? 0)), 4),
    meanTurns: r(mean(results.map((x) => x.metrics?.turns ?? 0)), 1),
    meanTokens: Math.round(mean(results.map(tokens))),
    totalTokens: results.reduce((a, x) => a + tokens(x), 0),
    totalOutputTokens: results.reduce((a, x) => a + (x.metrics?.outputTokens ?? 0), 0),
    totalCostUsd: r(results.reduce((a, x) => a + (x.metrics?.costUsd ?? 0), 0), 2),
    meanWallSec: r(mean(results.map((x) => x.wallSec ?? 0)), 1),
    timeouts: results.filter((x) => x.timedOut).length,
    bashTimeouts: results.reduce((a, x) => a + (x.metrics?.bashTimeouts ?? 0), 0),
    failedEdits: results.reduce((a, x) => a + (x.metrics?.failedEdits ?? 0), 0),
    violations: results.reduce((a, x) => a + (x.metrics?.violations?.length ?? 0), 0),
    topErrors: top(sumObj('errorCodes')),
    topVerbs: top(sumObj('verbs')),
    results,
  };
}

/** Markdown summary. With `hideChecks` (held-out set) no check names or details are written. */
export function summaryMarkdown(s, { hideChecks = false } = {}) {
  const lines = [
    `# Eval ${s.label} · ${s.set}`, '',
    `${s.date} · model ${s.model} · ${s.dryRun ? 'DRY RUN (no agent) · ' : ''}package ${s.packageVersion ?? '?'}`, '',
    `**${s.passed}/${s.tasks} passed (${r(s.successRate * 100, 1)} %)**, mean score ${s.meanScore}, mean turns ${s.meanTurns}, mean tokens ${k(s.meanTokens)} (total ${k(s.totalTokens)}, cost $${s.totalCostUsd}), mean wall ${s.meanWallSec} s, agent timeouts ${s.timeouts}, shell timeouts ${s.bashTimeouts}, failed edits ${s.failedEdits}, violations ${s.violations}.`, '',
    '| task | pass | score | turns | tokens | time s | shell timeouts | failed edits | errors | verbs |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...s.results.map((x) => {
      const m = x.metrics ?? {};
      const tok = (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.cacheReadTokens ?? 0) + (m.cacheCreationTokens ?? 0);
      return `| ${x.task} | ${x.pass ? 'yes' : x.timedOut ? 'timeout' : 'no'} | ${r(x.score ?? 0, 2)} | ${m.turns ?? 0} | ${k(tok)} | ${r(x.wallSec ?? 0, 0)} | ${m.bashTimeouts ?? 0} | ${m.failedEdits ?? 0} | ${Object.entries(m.errorCodes ?? {}).map(([c, n]) => `${c}×${n}`).join(' ')} | ${Object.entries(m.verbs ?? {}).map(([c, n]) => `${c}×${n}`).join(' ')} |`;
    }),
    '',
    `Most common errors: ${s.topErrors.map(([c, n]) => `${c} (${n})`).join(', ') || 'none'}`,
    `CLI verbs used: ${s.topVerbs.map(([c, n]) => `${c} (${n})`).join(', ') || 'none'}`,
  ];
  if (!hideChecks) {
    lines.push('', '## Failed checks', '');
    for (const x of s.results) for (const c of (x.checks ?? []).filter((c) => !c.pass)) lines.push(`- **${x.task}**: ${c.name} (${c.detail})`);
    const viol = s.results.filter((x) => x.metrics?.violations?.length);
    if (viol.length) { lines.push('', '## Sandbox violations', ''); for (const x of viol) for (const v of x.metrics.violations.slice(0, 10)) lines.push(`- ${x.task}: \`${v.replace(/`/g, "'")}\``); }
  }
  return lines.join('\n') + '\n';
}

export function writeSummary(dir, s, opts) {
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(opts?.hideChecks ? { ...s, results: s.results.map(({ checks, error, ...x }) => ({ ...x, checks: (checks ?? []).length, harnessError: !!error })) } : s, null, 1));
  writeFileSync(join(dir, 'summary.md'), summaryMarkdown(s, opts));
}

const HEADER = `# Eval history

Main and held-out sets are reported separately. One row per run (\`node evals/run.mjs\`); details in \`evals/results/<label>/<set>/summary.md\`.

| date | label | set | model | tasks | passed | success | mean score | mean turns | mean tokens | mean wall s | shell timeouts | failed edits | violations | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
`;

export function appendHistory(file, s, note = '') {
  if (!existsSync(file) || !readFileSync(file, 'utf8').includes('| date | label |')) writeFileSync(file, HEADER);
  appendFileSync(file, `| ${s.date.slice(0, 10)} | ${s.label} | ${s.set} | ${s.model} | ${s.tasks} | ${s.passed} | ${r(s.successRate * 100, 1)} % | ${s.meanScore} | ${s.meanTurns} | ${k(s.meanTokens)} | ${s.meanWallSec} | ${s.bashTimeouts} | ${s.failedEdits} | ${s.violations} | ${[s.dryRun ? 'dry run' : '', note].filter(Boolean).join('; ')} |\n`);
}
