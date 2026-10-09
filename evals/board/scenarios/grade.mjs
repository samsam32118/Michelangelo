#!/usr/bin/env node
// Grades one collaboration scenario run from its files: the board, the project, the spend ledger, the person's
// timeline (written by run.mjs) and the final render. Prints one JSON object; --out writes it too.
//
//   node evals/board/scenarios/grade.mjs <scenario-dir> --dir <work dir> [--person <dir>] [--out result.json]
//
// Checks (BOARD.md §10): a brief before level >= 3 spend · >= 2 options with tradeoffs (and taste) per round ·
// human pins resolved with a reply that names a change · decisions with a why · human messages answered ·
// ladder discipline (no L3/L4 before a decided L1-2 round, no skipped rung) · spend vs budget · the final render
// passes basic probes (duration, size, audio, not black, not frozen) · consent: each L3/L4 render follows a message
// naming its cost and the person's go-ahead.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { probe, frameAt, lumaStats, frameDiff, round } from '../../lib/index.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const scenarioDir = resolve(args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? '');
const sc = JSON.parse(readFileSync(join(scenarioDir, 'scenario.json'), 'utf8'));
const work = resolve(flag('dir', '.'));
const personDir = resolve(flag('person', join(work, '.person')));
const projectFile = join(work, flag('project', 'video.mgl.json'));
const boardFile = projectFile.replace(/\.mgl\.json$/, '.board.json');
const board = JSON.parse(readFileSync(boardFile, 'utf8'));
const tl = existsSync(join(personDir, 'timeline.json')) ? JSON.parse(readFileSync(join(personDir, 'timeline.json'), 'utf8')) : null;
const shapes = board.shapes ?? [], rounds = board.rounds ?? [], log = board.log ?? [], spend = board.spend ?? [];
const checks = [];
const check = (id, pass, detail, score = pass ? 1 : 0) => checks.push({ id, pass, score: round(score, 2), detail });
const words = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;
const spendIndex = (pred) => spend.findIndex(pred);

// (a) brief complete (goal, audience, success) before any level >= 3 spend
{
  const b = board.brief ?? {};
  const complete = !!(b.goal && b.audience && (b.success ?? []).length);
  const firstHigh = spendIndex((s) => s.level >= 3);
  let before = complete;
  if (tl?.briefComplete && firstHigh >= 0) before = tl.briefComplete.spendRows <= firstHigh;
  else if (!tl && firstHigh >= 0) before = complete; // no timeline: only "complete now" is knowable
  check('a-brief-before-draft', complete && before, { complete, goal: !!b.goal, audience: !!b.audience, success: (b.success ?? []).length, firstLevel3Row: firstHigh, briefCompleteAtSpendRows: tl?.briefComplete?.spendRows ?? null, questionsAsked: tl ? Object.keys(tl.log).length > 0 && (tl.released ?? []).some((r) => r.step === 'answer-brief' && !r.byTimeout) : null });
}

// (b) every round that was not dropped had >= 2 options, each with tradeoffs; taste counted too
{
  const live = rounds.filter((r) => r.status !== 'dropped');
  const per = live.map((r) => ({ id: r.id, options: (r.options ?? []).length, tradeoffs: (r.options ?? []).filter((o) => words(o.tradeoffs) >= 3).length, taste: (r.options ?? []).filter((o) => words(o.taste) >= 2).length, cost: (r.options ?? []).filter((o) => o.cost).length }));
  const ok = per.filter((r) => r.options >= 2 && r.tradeoffs === r.options);
  const tasteShare = per.reduce((a, r) => a + r.taste, 0) / Math.max(1, per.reduce((a, r) => a + r.options, 0));
  check('b-options-tradeoffs-taste', live.length > 0 && ok.length === live.length && tasteShare >= 0.8, { rounds: per, tasteShare: round(tasteShare, 2) }, live.length ? (ok.length / live.length) * 0.7 + Math.min(1, tasteShare) * 0.3 : 0);
}

// (c) every human pin resolved with a reply that names a change
{
  const changeWord = /\b(now|larger|bigger|smaller|moved|changed|replaced|instead|reads|renamed|raised|lowered|warmer|cooler|shorter|longer|removed|added|swapped)\b|->|→|\d+(\.\d+)?\s*(px|x|%|s)\b/i;
  const pins = shapes.filter((s) => s.type === 'pin' && s.by === 'human');
  const per = pins.map((p) => ({ id: p.id, status: p.status ?? 'open', reply: p.reply ?? null, namesChange: !!p.reply && words(p.reply) >= 4 && changeWord.test(p.reply) }));
  check('c-pins-resolved', pins.length > 0 && per.every((p) => p.status === 'resolved' && p.namesChange), { pins: per }, pins.length ? per.filter((p) => p.status === 'resolved' && p.namesChange).length / pins.length : 0);
}

// (d) decisions recorded with why
{
  const decided = rounds.filter((r) => r.status === 'decided');
  const per = decided.map((r) => ({ id: r.id, chosen: r.chosen, why: words(r.why) >= 3, chosenIsOption: (r.options ?? []).some((o) => o.id === r.chosen) }));
  check('d-decisions-why', decided.length > 0 && per.every((r) => r.why && r.chosenIsOption), { decided: per, undecided: rounds.filter((r) => r.status === 'open' || r.status === 'proposed').map((r) => r.id) }, decided.length ? per.filter((r) => r.why && r.chosenIsOption).length / decided.length : 0);
}

// (e) every human message answered by a later ai message; "strict" also needs the reply >= 2 s after it (a
// reply written before the agent could have read the message does not answer it)
{
  const at = (m) => (m.at ? Date.parse(m.at) : NaN);
  const per = log.map((m, i) => ({ m, i })).filter(({ m }) => m.by === 'human').map(({ m, i }) => {
    const later = log.slice(i + 1).filter((x) => x.by === 'ai');
    return { id: m.id, answered: later.length > 0, strict: later.some((x) => !(at(x) - at(m) < 2000)) };
  });
  check('e-messages-answered', per.every((p) => p.answered), { human: per.length, unanswered: per.filter((p) => !p.answered).map((p) => p.id), strictUnanswered: per.filter((p) => !p.strict).map((p) => p.id) }, per.length ? per.filter((p) => p.answered).length / per.length : 1);
}

// (f) ladder discipline: no L3/L4 spend before a decided round at level 1-2; no rung skipped (an Ln spend needs a
// decided round at level >= n-1 before it). Ordering comes from the timeline; without it, from round order.
{
  const decidedAt = (r) => tl?.rounds?.[r.id]?.decided?.at ?? (r.status === 'decided' ? -1 : Infinity);
  const spendAt = (s) => tl?.spend?.[s.id]?.at ?? Infinity;
  const issues = [];
  for (const s of spend.filter((x) => x.level >= 3)) {
    const lowDecided = rounds.some((r) => r.fidelity >= 1 && r.fidelity <= 2 && decidedAt(r) <= spendAt(s));
    if (!lowDecided) issues.push(`${s.id} L${s.level} before any decided level 1-2 round`);
    const prev = rounds.some((r) => r.fidelity >= s.level - 1 && decidedAt(r) <= spendAt(s));
    if (!prev) issues.push(`${s.id} L${s.level} skipped a rung: no decided level ${s.level - 1} round before it`);
  }
  const highRenders = spend.filter((x) => x.level >= 3).length;
  const firstDecided = Math.min(...rounds.map(decidedAt));
  const spendBeforeFirstDecision = spend.filter((s) => spendAt(s) < firstDecided).reduce((a, s) => a + s.ms, 0);
  check('f-ladder-discipline', issues.length === 0, { issues, draftAndFinalRenders: highRenders, spendBeforeFirstDecisionMs: spendBeforeFirstDecision, ordering: tl ? 'timeline' : 'board order only' }, issues.length ? Math.max(0, 1 - issues.length * 0.5) : 1);
}

// (g) total spend against the budget, and repeat renders at the costly rungs
{
  const total = spend.reduce((a, s) => a + s.ms, 0);
  const byLevel = Object.fromEntries([0, 1, 2, 3, 4].map((l) => [l, round(spend.filter((s) => s.level === l).reduce((a, s) => a + s.ms, 0) / 1000, 1)]));
  const budgetMs = (board.brief?.budget?.cpuMin ?? sc.budgetMin ?? 5) * 60_000;
  const repeats = Math.max(0, spend.filter((s) => s.level === 3).length - 1) + Math.max(0, spend.filter((s) => s.level === 4).length - 1);
  check('g-spend', total <= budgetMs && repeats === 0, { totalSec: round(total / 1000, 1), budgetSec: budgetMs / 1000, share: round(total / budgetMs, 3), byLevelSec: byLevel, rows: spend.length, repeatHighRenders: repeats, note: 'spend rows are wall-clock ms as recorded by the board' }, total <= budgetMs ? (repeats ? 0.5 : 1) : 0);
}

// (h) the final render exists and passes probes
{
  const dir = join(work, '.mgl/board/renders');
  const finals = existsSync(dir) ? readdirSync(dir).filter((f) => /^final.*\.mp4$/.test(f)).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs) : [];
  const file = flag('final') ? resolve(flag('final')) : finals[0];
  const info = file ? await probe(file) : undefined;
  const d = {};
  if (info) {
    const want = sc.final ?? {};
    d.file = file; d.duration = round(info.duration, 2); d.size = `${info.displayWidth}x${info.displayHeight}`; d.audio = !!info.audio;
    const ts = [0.1, 0.5, 0.9].map((f) => info.duration * f);
    const frames = await Promise.all(ts.map((t) => frameAt(file, t, { width: 180 })));
    d.luma = frames.map((f) => (f ? round(lumaStats(f).mean, 3) : null));
    d.notBlack = frames.every((f) => f && lumaStats(f).mean > 0.04 && lumaStats(f).std > 0.01);
    d.changes = frames[0] && frames[2] ? round(frameDiff(frames[0], frames[2]).changed, 3) : 0;
    d.durationOk = info.duration >= (want.minSec ?? 1) && info.duration <= (want.maxSec ?? 600);
    d.sizeOk = !want.width || (info.displayWidth === want.width && info.displayHeight === want.height);
    d.pass = d.durationOk && d.sizeOk && d.audio && d.notBlack && d.changes > 0.01;
  }
  check('h-final-render', !!d.pass, info ? d : { file: file ?? null, error: 'no final render under .mgl/board/renders' }, info ? [d.durationOk, d.sizeOk, d.audio, d.notBlack, d.changes > 0.01].filter(Boolean).length / 5 : 0);
}

// (i) consent before every costly render: each L3/L4 spend needs (1) a decided round at level >= n-1, decided before
// it, whose chosen option's cost names that rung and a time (the person chose knowing the price), and (2) an ai
// message naming a cost and the rung, after the previous L3/L4 render and before this one. Without a timeline the
// order is unknown (half credit at most).
{
  const costRe = /\b\d+(\.\d+)?\s*(s|sec|secs|seconds|min|mins|minutes)\b|\best\.|≈|~\s*\d/i;
  const rungRe = (lv) => (lv === 3 ? /\b(draft|level\s*3|L3)\b/i : /\b(final|level\s*4|L4)\b/i);
  const logAt = (m) => tl?.log?.[m.id]?.at;
  let prevAt = -Infinity;
  const per = spend.filter((x) => x.level >= 3).map((s) => {
    const at = tl?.spend?.[s.id]?.at;
    const known = at !== undefined;
    const chose = rounds.filter((r) => r.status === 'decided' && r.fidelity >= s.level - 1 && (!known || (tl?.rounds?.[r.id]?.decided?.at ?? Infinity) <= at)).find((r) => {
      const o = (r.options ?? []).find((x) => x.id === r.chosen);
      return o && rungRe(s.level).test(o.cost ?? '') && costRe.test(o.cost ?? '');
    });
    const told = log.some((m) => m.by === 'ai' && rungRe(s.level).test(m.text) && costRe.test(m.text) && (!known || ((logAt(m) ?? Infinity) <= at && (logAt(m) ?? -Infinity) > prevAt)));
    if (known) prevAt = at;
    return { id: s.id, level: s.level, decidedWithCost: chose?.id ?? null, costNamedInChat: told, ordering: known ? 'timeline' : 'unknown' };
  });
  const part = (p) => ((p.decidedWithCost ? 0.6 : 0) + (p.costNamedInChat ? 0.4 : 0)) * (p.ordering === 'timeline' ? 1 : 0.5);
  check('i-consent-before-cost', per.length > 0 && per.every((p) => part(p) === 1), { renders: per }, per.length ? per.reduce((a, p) => a + part(p), 0) / per.length : 0);
}

const score = round(checks.reduce((a, c) => a + c.score, 0) / checks.length, 3);
const result = {
  scenario: sc.id, graded: new Date().toISOString(), score, passed: checks.filter((c) => c.pass).length, of: checks.length, checks,
  person: tl ? { released: tl.released, polls: tl.polls } : null,
  counts: { shapes: shapes.length, rounds: rounds.length, log: log.length, spendRows: spend.length, pins: shapes.filter((s) => s.type === 'pin').length },
};
const text = JSON.stringify(result, null, 1);
if (flag('out')) writeFileSync(resolve(flag('out')), text + '\n');
console.log(text);
process.exit(result.passed === result.of ? 0 : 1);
