#!/usr/bin/env node
// With vs without (DESIGN §17.2): compare the two arms of one set.
//   node evals/compare.mjs <with results dir> <without results dir> [--out <file>] [--history <file>] [--no-history] [--note text]
// e.g. node evals/compare.mjs evals/results/n1/main evals/results/n1/main-without
// Writes <label dir>/compare-<set>.md (next to the "with" dir) with per-task pass/score/vision/cost/turns/wall for
// both arms and the aggregate ratios, and appends a row to evals/HISTORY.md under "## With vs without".
// Held-out sets: the public summaries name tasks by alias only, and so does this comparison.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costOf, costSummary, isHQ, DEFAULT_MACHINE_RATE, HQ_VISION, setOfDir, armOfDir } from './sandbox/arms.mjs';
import { isAlias, isHiddenSet } from './sandbox/alias.mjs';

const EVALS = dirname(fileURLToPath(import.meta.url));
const r = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Load one arm's results dir: its summary.json (or the <task>/result.json files) → {meta, results}. */
export function loadArm(dir) {
  dir = resolve(dir);
  if (!existsSync(dir)) throw new Error(`${dir} does not exist. fix: pass evals/results/<label>/<set> and evals/results/<label>/<set>-without.`);
  const name = dir.split('/').pop();
  let meta = {}, results;
  if (existsSync(join(dir, 'summary.json'))) {
    const s = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    ({ results, ...meta } = s);
  }
  const set = meta.set ?? setOfDir(name);
  if (!Array.isArray(results)) {
    const hidden = isHiddenSet(set);
    results = readdirSync(dir).filter((t) => existsSync(join(dir, t, 'result.json')) && (!hidden || isAlias(t))).sort()
      .map((t) => ({ ...JSON.parse(readFileSync(join(dir, t, 'result.json'), 'utf8')), ...(hidden ? { task: t } : {}) }));
  }
  if (!results.length) throw new Error(`no results in ${dir}.`);
  return { dir, meta: { ...meta, set, arm: meta.arm ?? armOfDir(name), label: meta.label ?? dir.split('/').at(-2) }, results };
}

/** Aggregates of one arm (recomputed from the results, so old summaries without cost fields work too). */
export function aggregate({ meta, results }) {
  const machineRate = meta.machineRate ?? DEFAULT_MACHINE_RATE;
  const vision = meta.vision ?? results.some((x) => typeof x.vision?.overall === 'number');
  for (const x of results) x.cost ??= costOf(x, machineRate);
  const c = costSummary(results, { machineRate, vision });
  const n = results.length, passed = results.filter((x) => x.pass).length;
  return { ...c, tasks: n, passed, successRate: n ? passed / n : 0, meanScore: mean(results.map((x) => x.score ?? 0)), meanTurns: mean(results.map((x) => x.metrics?.turns ?? 0)),
    meanWallSec: mean(results.map((x) => x.wallSec ?? 0)) };
}

const ratio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null);
const fx = (v) => (v === null || v === undefined ? 'n/a' : `${r(v, 2)}x`);
const money = (v) => (v === null || v === undefined ? 'n/a' : `$${r(v, 3)}`);
const num = (v, d = 2) => (v === null || v === undefined ? 'n/a' : String(r(v, d)));

/** Compare two loaded arms → {markdown, row, set, label, agg}. */
export function compareArms(withArm, withoutArm) {
  if (withArm.meta.set !== withoutArm.meta.set) throw new Error(`the two dirs hold different sets (${withArm.meta.set} vs ${withoutArm.meta.set}). fix: compare one set's two arms.`);
  if (withArm.meta.arm !== 'with' || withoutArm.meta.arm !== 'without')
    throw new Error(`pass the "with" dir first and the "without" dir second (got arms ${withArm.meta.arm} and ${withoutArm.meta.arm}).`);
  const set = withArm.meta.set;
  const label = withArm.meta.label === withoutArm.meta.label ? withArm.meta.label : `${withArm.meta.label} vs ${withoutArm.meta.label}`;
  // aggregates over the tasks both arms ran (library-only tasks are not run in "without"), so the ratios compare like with like
  const inBoth = (other) => (x) => other.results.some((y) => y.task === x.task);
  const commonWith = withArm.results.filter(inBoth(withoutArm)), commonWithout = withoutArm.results.filter(inBoth(withArm));
  if (!commonWith.length) throw new Error('the two arms ran no task in common. fix: run the same tasks in both arms.');
  const onlyOne = [...withArm.results.filter((x) => !inBoth(withoutArm)(x)), ...withoutArm.results.filter((x) => !inBoth(withArm)(x))].map((x) => x.task);
  const A = aggregate({ ...withArm, results: commonWith }), B = aggregate({ ...withoutArm, results: commonWithout });
  // the headline: cost per high-quality deliverable when both arms were vision-scored, else cost per pass
  const hq = A.vision && B.vision;
  const head = hq ? 'cost per high-quality deliverable' : 'cost per pass (vision off in at least one arm, so cost per pass stands in for cost per high-quality deliverable)';
  const ha = hq ? A.costPerHQ : A.costPerPass, hb = hq ? B.costPerHQ : B.costPerPass;
  const byTask = (arm) => new Map(arm.results.map((x) => [x.task, x]));
  const ma = byTask(withArm), mb = byTask(withoutArm);
  const tasks = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  const cell = (x, f) => (x ? f(x) : '-');
  const pass = (x) => (x.pass ? 'yes' : x.violationFail ? 'violation' : x.timedOut ? 'timeout' : 'no');
  const vis = (x) => (typeof x.vision?.overall === 'number' ? `${x.vision.overall}${isHQ(x) ? '*' : ''}` : '');
  const lines = [
    `# With vs without · ${label} · ${set}`, '',
    `with: \`${withArm.dir}\` (model ${withArm.meta.model ?? '?'}, package ${withArm.meta.packageVersion ?? '?'})  `,
    `without: \`${withoutArm.dir}\` (model ${withoutArm.meta.model ?? '?'})`, '',
    `**${head}: with ${money(ha)}, without ${money(hb)}, ratio with/without ${fx(ratio(ha, hb))}** (lower is better).`, '',
    '| measure | with | without | with / without |', '|---|---|---|---|',
    `| ${hq ? 'cost per HQ deliverable' : 'cost per pass'} | ${money(ha)} | ${money(hb)} | ${fx(ratio(ha, hb))} |`,
    ...(hq ? [`| HQ deliverables (pass and vision >= ${HQ_VISION}) | ${A.hqDeliverables}/${A.tasks} | ${B.hqDeliverables}/${B.tasks} | ${fx(ratio(A.hqDeliverables, B.hqDeliverables))} |`] : []),
    `| success rate | ${num(A.successRate * 100, 1)} % (${A.passed}/${A.tasks}) | ${num(B.successRate * 100, 1)} % (${B.passed}/${B.tasks}) | ${fx(ratio(A.successRate, B.successRate))} |`,
    `| mean score | ${num(A.meanScore, 3)} | ${num(B.meanScore, 3)} | ${fx(ratio(A.meanScore, B.meanScore))} |`,
    `| mean vision | ${num(A.meanVision)} | ${num(B.meanVision)} | ${fx(ratio(A.meanVision, B.meanVision))} |`,
    `| mean cost per run | ${money(A.meanTotalUsd)} | ${money(B.meanTotalUsd)} | ${fx(ratio(A.meanTotalUsd, B.meanTotalUsd))} |`,
    `| mean model cost | ${money(A.meanModelUsd)} | ${money(B.meanModelUsd)} | ${fx(ratio(A.meanModelUsd, B.meanModelUsd))} |`,
    `| mean machine cost | ${money(A.meanMachineUsd)} | ${money(B.meanMachineUsd)} | ${fx(ratio(A.meanMachineUsd, B.meanMachineUsd))} |`,
    `| mean wall s | ${num(A.meanWallSec, 1)} | ${num(B.meanWallSec, 1)} | ${fx(ratio(A.meanWallSec, B.meanWallSec))} |`,
    `| mean turns | ${num(A.meanTurns, 1)} | ${num(B.meanTurns, 1)} | ${fx(ratio(A.meanTurns, B.meanTurns))} |`,
    '',
    `Aggregates cover the ${A.tasks} task(s) run in both arms${onlyOne.length ? `; not counted (run in one arm only, e.g. library-only tasks): ${[...new Set(onlyOne)].sort().join(', ')}` : ''}.`,
    `Machine rate: with $${A.machineRate}/h, without $${B.machineRate}/h. Judge cost is not included. "-" = task not run in that arm; * = high-quality deliverable.`, '',
    '| task | pass (w / wo) | score (w / wo) | vision (w / wo) | cost $ (w / wo) | turns (w / wo) | wall s (w / wo) |',
    '|---|---|---|---|---|---|---|',
    ...tasks.map((t) => {
      const a = ma.get(t), b = mb.get(t);
      const pair = (f) => `${cell(a, f)} / ${cell(b, f)}`;
      return `| ${t} | ${pair(pass)} | ${pair((x) => r(x.score ?? 0, 2))} | ${pair(vis)} | ${pair((x) => r(x.cost.totalUsd, 3))} | ${pair((x) => x.metrics?.turns ?? 0)} | ${pair((x) => r(x.wallSec ?? 0, 0))} |`;
    }),
    '',
  ];
  const date = (withArm.meta.date ?? new Date().toISOString()).slice(0, 10);
  const row = { date, label, set, hq, with: { passed: A.passed, tasks: A.tasks, perHQ: ha, vision: A.meanVision, wall: A.meanWallSec, meanUsd: A.meanTotalUsd }, without: { passed: B.passed, tasks: B.tasks, perHQ: hb, vision: B.meanVision, wall: B.meanWallSec, meanUsd: B.meanTotalUsd }, ratio: ratio(ha, hb) };
  return { markdown: lines.join('\n'), row, set, label, agg: { with: A, without: B } };
}

export const HISTORY_SECTION = '## With vs without';
const HISTORY_TABLE = `${HISTORY_SECTION}

One row per comparison (\`node evals/compare.mjs\`); details in \`evals/results/<label>/compare-<set>.md\`. $/HQ is the cost per
high-quality deliverable (pass and vision >= ${HQ_VISION}); rows marked "per pass" had vision scoring off.

| date | label | set | with passed | without passed | with $/HQ | without $/HQ | ratio | with vision | without vision | with $/run | without $/run | with wall s | without wall s | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
`;

/** Append a row to the "## With vs without" table of HISTORY.md (the section is created at the end when missing). */
export function appendCompareHistory(file, row, note = '') {
  const line = `| ${row.date} | ${row.label} | ${row.set} | ${row.with.passed}/${row.with.tasks} | ${row.without.passed}/${row.without.tasks} | ${money(row.with.perHQ)} | ${money(row.without.perHQ)} | ${fx(row.ratio)} | ${num(row.with.vision)} | ${num(row.without.vision)} | ${money(row.with.meanUsd)} | ${money(row.without.meanUsd)} | ${num(row.with.wall, 1)} | ${num(row.without.wall, 1)} | ${[row.hq ? '' : 'per pass (vision off)', note].filter(Boolean).join('; ')} |`;
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '# Eval history\n';
  const at = text.indexOf(`\n${HISTORY_SECTION}\n`);
  if (at < 0) {
    text = text.replace(/\n*$/, '\n\n') + HISTORY_TABLE + line + '\n';
  } else {
    // insert after the last table row of the section
    const lines = text.split('\n');
    const h = lines.findIndex((l) => l === HISTORY_SECTION);
    let i = h + 1;
    while (i < lines.length && !lines[i].startsWith('|') && !lines[i].startsWith('## ')) i++;
    if (i >= lines.length || lines[i].startsWith('## ')) lines.splice(i, 0, ...HISTORY_TABLE.split('\n').filter((l) => l.startsWith('|')), line, '');
    else { while (i < lines.length && lines[i].startsWith('|')) i++; lines.splice(i, 0, line); }
    text = lines.join('\n');
  }
  writeFileSync(file, text);
}

export function compare(withDir, withoutDir, { out, history = join(EVALS, 'HISTORY.md'), note = '' } = {}) {
  const res = compareArms(loadArm(withDir), loadArm(withoutDir));
  const file = out ?? join(dirname(resolve(withDir)), `compare-${res.set}.md`);
  writeFileSync(file, res.markdown);
  if (history) appendCompareHistory(history, res.row, note);
  return { ...res, file };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), pos = [], o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') o.out = resolve(args[++i]);
    else if (a === '--history') o.history = resolve(args[++i]);
    else if (a === '--no-history') o.history = null;
    else if (a === '--note') o.note = args[++i];
    else if (a.startsWith('--')) { console.error(`error: unknown option ${a}`); process.exit(1); }
    else pos.push(a);
  }
  if (pos.length !== 2) { console.error('usage: node evals/compare.mjs <with dir> <without dir> [--out file] [--history file | --no-history] [--note text]'); process.exit(1); }
  try {
    const c = compare(pos[0], pos[1], o);
    console.log(`${c.set}: ${c.row.hq ? 'cost per HQ deliverable' : 'cost per pass'} with ${money(c.row.with.perHQ)}, without ${money(c.row.without.perHQ)} (ratio ${fx(c.row.ratio)}); wrote ${c.file}`);
  } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
}
