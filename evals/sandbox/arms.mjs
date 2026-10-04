// The two arms of the north-star eval (DESIGN §17.2), the library-only check rule and the cost model (§17.1).
//   with:    the packed Michelangelo library, its skill and docs (the default; results in <label>/<set>)
//   without: no Michelangelo; Node 22 with @napi-rs/canvas, ffmpeg/ffprobe and Python 3 (results in <label>/<set>-without)

export const ARMS = ['with', 'without'];
export const DEFAULT_MACHINE_RATE = 0.10; // $ per hour of wall clock (4 vCPU container)
/** A high-quality deliverable passes the objective grade with a vision score at least this. */
export const HQ_VISION = 7;
/** Library-only checks (e.g. "a Michelangelo project file renders like the output") start with this. */
export const LIB_PREFIX = '[lib]';
/** The canvas package preinstalled in the "without" template. */
export const CANVAS_PKG = '@napi-rs/canvas@0.1.80';

export const PREAMBLES = {
  with: `You are working in a sandbox: your current directory holds the task's files. The Michelangelo video library is installed here: run its CLI with \`npx mgl\` (start with \`npx mgl docs\`) and import it in Node scripts as 'michelangelo'. Its skill is in .claude/skills/michelangelo/SKILL.md (docs next to it). Use only this installed package and its docs; do not look for its source code elsewhere. Write outputs where the task says (paths are relative to this directory). Nobody will answer questions: decide and finish the task.

Task:
`,
  without: `You are working in a sandbox: your current directory holds the task's files. You have Node 22 (with @napi-rs/canvas installed here), ffmpeg/ffprobe 6.1 (libx264, aac, flite, drawtext, ebur128, loudnorm ...) and Python 3. Use whatever tools you like. Write outputs where the task says. Nobody will answer questions: decide and finish the task.

Task:
`,
};

export function checkArm(arm) {
  if (!ARMS.includes(arm)) throw new Error(`--arm ${arm}: use with or without.`);
  return arm;
}

/** The results subdirectory of a set in an arm: <set> for "with" (as before arms existed), <set>-without otherwise. */
export const armSetDir = (set, arm = 'with') => (arm === 'without' ? `${set}-without` : set);

/** The set name of a results subdirectory (strips the arm suffix): heldout2-without → heldout2. */
export const setOfDir = (name) => String(name ?? '').replace(/-without$/, '');
export const armOfDir = (name) => (/-without$/.test(String(name ?? '')) ? 'without' : 'with');

export const isLibCheck = (c) => typeof c?.name === 'string' && c.name.trimStart().startsWith(LIB_PREFIX);

/**
 * A grade as it counts in an arm. "with": unchanged (library-only checks count as they always did). "without":
 * library-only checks are moved to `skippedChecks` and pass/score are recomputed from the rest (a pass needs
 * every remaining check, and at least one).
 */
export function applyArm(g, arm = 'with') {
  const checks = Array.isArray(g?.checks) ? g.checks : [];
  if (arm !== 'without' || !checks.some(isLibCheck)) return { ...g, checks };
  const kept = checks.filter((c) => !isLibCheck(c)), skipped = checks.filter(isLibCheck);
  const passed = kept.filter((c) => c.pass).length;
  return { ...g, pass: kept.length > 0 && passed === kept.length, score: kept.length ? Math.round((passed / kept.length) * 1e4) / 1e4 : 0, checks: kept, skippedChecks: skipped };
}

const usd = (v) => Math.round(v * 1e4) / 1e4;

/** Cost of one run: model $ (the transcript's total_cost_usd) + machine $ (agent wall clock × rate), summed. */
export function costOf(r, machineRate = DEFAULT_MACHINE_RATE) {
  const modelUsd = Number(r?.metrics?.costUsd) || 0;
  const machineUsd = ((Number(r?.wallSec) || 0) / 3600) * machineRate;
  return { modelUsd: usd(modelUsd), machineUsd: usd(machineUsd), totalUsd: usd(modelUsd + machineUsd), machineRate };
}

/** Is a run a high-quality deliverable (objective pass and vision ≥ 7)? Undefined when it has no vision score. */
export const isHQ = (r) => (typeof r?.vision?.overall === 'number' ? !!r.pass && r.vision.overall >= HQ_VISION : undefined);

/**
 * Aggregate costs of results (each with .cost, or derived from metrics/wallSec at `machineRate`). With `vision`,
 * costPerHQ = total cost ÷ runs that pass with vision ≥ 7 (null when none); without it, costPerHQ is null and
 * costPerPass is the stand-in (the summary says so).
 */
export function costSummary(results, { machineRate = DEFAULT_MACHINE_RATE, vision = false } = {}) {
  const costs = results.map((x) => x.cost ?? costOf(x, machineRate));
  const sum = (k) => costs.reduce((a, c) => a + (c[k] ?? 0), 0);
  const n = results.length, passed = results.filter((x) => x.pass).length;
  const scored = results.filter((x) => typeof x.vision?.overall === 'number');
  const hq = results.filter((x) => isHQ(x)).length;
  const total = sum('totalUsd');
  return {
    machineRate,
    totalModelUsd: usd(sum('modelUsd')), totalMachineUsd: usd(sum('machineUsd')), totalUsd: usd(total),
    meanModelUsd: n ? usd(sum('modelUsd') / n) : 0, meanMachineUsd: n ? usd(sum('machineUsd') / n) : 0, meanTotalUsd: n ? usd(total / n) : 0,
    costPerPass: passed ? usd(total / passed) : null,
    vision: !!vision,
    visionScored: scored.length,
    meanVision: scored.length ? Math.round((scored.reduce((a, x) => a + x.vision.overall, 0) / scored.length) * 100) / 100 : null,
    hqDeliverables: vision ? hq : null,
    costPerHQ: vision && hq ? usd(total / hq) : null,
  };
}
