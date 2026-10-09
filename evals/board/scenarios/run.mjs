#!/usr/bin/env node
// A scripted person on the board. Starts `mgl board serve` in the background, seeds the person's first message,
// then polls GET /api/state and releases the scenario's human ops through POST /api/ops when their conditions hold.
// The agent under test works on the same project (CLI, HTTP or page) while this runs.
//
//   node evals/board/scenarios/run.mjs <scenario-dir> --dir <work dir> [--out <dir>] [--project video.mgl.json]
//        [--mgl "node --import tsx /abs/src/cli/main.ts"] [--poll 700]
//
// The work dir gets `script.txt` (the person's rough script) at once; the server starts as soon as the project
// file exists (the agent makes it with `mgl new shorts --script script.txt -o video.mgl.json`).
// Writes <out>/person.jsonl (each release), <out>/timeline.json (what was true when: brief complete, decisions,
// spend rows, pins, log; the grader reads it for ordering) and stops at the scenario's `done` condition or timeout.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const scenarioDir = resolve(args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? '');
if (!existsSync(join(scenarioDir, 'scenario.json'))) { console.error('usage: run.mjs <scenario-dir> --dir <work dir> [--out dir]'); process.exit(1); }
const sc = JSON.parse(readFileSync(join(scenarioDir, 'scenario.json'), 'utf8'));
const work = resolve(flag('dir', ''));
if (!flag('dir')) { console.error('--dir <work dir> is required'); process.exit(1); }
const out = resolve(flag('out', join(work, '.person')));
const projectName = flag('project', 'video.mgl.json');
const mgl = (flag('mgl', `node --import ${pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href} ${join(repo, 'src/cli/main.ts')}`)).split(' ');
const pollMs = Number(flag('poll', 700));
mkdirSync(work, { recursive: true }); mkdirSync(out, { recursive: true });
const t0 = Date.now();
const sec = () => Math.round((Date.now() - t0) / 100) / 10;
const log = (o) => { const line = { at: sec(), ...o }; appendFileSync(join(out, 'person.jsonl'), JSON.stringify(line) + '\n'); console.log(JSON.stringify(line)); };
writeFileSync(join(out, 'person.jsonl'), '');
if (sc.script && !existsSync(join(work, 'script.txt'))) writeFileSync(join(work, 'script.txt'), sc.script + '\n');
const project = join(work, projectName);
log({ event: 'waiting', for: project });
while (!existsSync(project)) { if (sec() > (sc.timeoutSec ?? 3600)) { log({ event: 'timeout', waiting: project }); process.exit(1); } await sleep(500); }

// the server, in the background; its JSON line carries the url
const srv = spawn(mgl[0], [...mgl.slice(1), 'board', 'serve', project, '--port', '0', '--json'], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
let buf = '', url;
srv.stdout.on('data', (d) => { buf += d; const m = /"url"\s*:\s*"([^"]+)"/.exec(buf); if (m) url = m[1]; });
srv.stderr.on('data', (d) => appendFileSync(join(out, 'server.log'), d));
const stop = (code) => { try { srv.kill('SIGINT'); } catch {} writeTimeline(); setTimeout(() => process.exit(code), 400); };
process.on('SIGINT', () => stop(130)); process.on('SIGTERM', () => stop(143));
for (let i = 0; !url; i++) { if (i > 200 || srv.exitCode !== null) { log({ event: 'server-failed', out: buf.slice(0, 400) }); process.exit(2); } await sleep(100); }
log({ event: 'server', url });

const api = async (path, body) => {
  const r = await fetch(url + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json();
};
const send = async (ops, why) => {
  const r = await api('/api/ops', { ops, by: 'human' });
  log({ event: 'release', why, ops, ok: r.ok, error: r.ok ? undefined : r.error, created: r.created });
  return r;
};

// ---- conditions and templates over a state -------------------------------------------------------------------
const decidedByUs = new Set();
const stillsOf = (b) => (b.shapes ?? []).filter((s) => s.type === 'still');
const proposed = (b) => [...(b.rounds ?? [])].reverse().find((r) => r.status === 'proposed' && (r.options ?? []).length >= 2 && !decidedByUs.has(r.id));
function holds(when, b, ctx) {
  for (const [k, v] of Object.entries(when)) {
    const ok = {
      briefQuestions: () => ((b.brief?.questions ?? []).length > 0) === v,
      roundProposed: () => !!proposed(b) === v,
      stills: () => stillsOf(b).length >= v,
      decided: () => (b.rounds ?? []).filter((r) => r.status === 'decided').length >= v,
      pinsResolved: () => { const p = (b.shapes ?? []).filter((s) => s.type === 'pin' && s.by === 'human'); return (p.length > 0 && p.every((s) => s.status === 'resolved')) === v; },
      spendLevel: () => (b.spend ?? []).some((s) => s.level >= v),
      afterAiSay: () => ((b.log ?? []).at(-1)?.by === 'ai') === v,
    }[k];
    if (!ok) throw new Error(`unknown condition ${k}`);
    if (!ok()) return false;
  }
  return true;
}
function fill(ops, b) {
  const r = proposed(b);
  const sub = (s) => s.replace(/\{\{(\w+)(?::(\d+))?\}\}/g, (m, name, n) => {
    const i = Number(n ?? 1) - 1;
    const v = { round: r?.id, option: r?.options?.[i]?.id, optionTitle: r?.options?.[i]?.title, still: stillsOf(b)[i]?.id }[name];
    if (v === undefined) throw new Error(`template ${m} has no value`);
    return v;
  });
  const walk = (x) => (typeof x === 'string' ? sub(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)])) : x);
  return { ops: walk(ops), round: r?.id };
}

// ---- the timeline: first time each fact was seen --------------------------------------------------------------
const tl = { scenario: sc.id, url, started: new Date(t0).toISOString(), briefComplete: null, rounds: {}, spend: {}, pins: {}, log: {}, released: [], polls: 0 };
const writeTimeline = () => writeFileSync(join(out, 'timeline.json'), JSON.stringify(tl, null, 1));
function observe(b, version) {
  const snap = { at: sec(), version, spendRows: (b.spend ?? []).length, maxLevel: Math.max(-1, ...(b.spend ?? []).map((s) => s.level)) };
  const br = b.brief ?? {};
  if (!tl.briefComplete && br.goal && br.audience && (br.success ?? []).length) tl.briefComplete = snap;
  for (const r of b.rounds ?? []) {
    const e = (tl.rounds[r.id] ??= { seen: snap, fidelity: r.fidelity });
    if (r.status === 'proposed' && !e.proposed) e.proposed = snap;
    if (r.status === 'decided' && !e.decided) e.decided = { ...snap, chosen: r.chosen, why: r.why };
  }
  for (const s of b.spend ?? []) tl.spend[s.id] ??= { ...snap, level: s.level, ms: s.ms, what: s.what };
  for (const p of (b.shapes ?? []).filter((s) => s.type === 'pin')) {
    const e = (tl.pins[p.id] ??= { seen: snap, by: p.by });
    if (p.status === 'resolved' && !e.resolved) e.resolved = snap;
  }
  for (const m of b.log ?? []) tl.log[m.id] ??= { at: snap.at, by: m.by };
}

// ---- the loop --------------------------------------------------------------------------------------------------
const pending = [...(sc.steps ?? [])];
let lastStepAt = sec(), errors = 0;
if (sc.seed?.length) await send(sc.seed, 'seed');
while (true) {
  if (sec() > (sc.timeoutSec ?? 3600)) { log({ event: 'timeout' }); break; }
  if (srv.exitCode !== null) { log({ event: 'server-exited', code: srv.exitCode }); break; }
  let st;
  try { st = await api('/api/state'); errors = 0; } catch (e) { if (++errors > 20) { log({ event: 'state-failed', error: String(e) }); break; } await sleep(pollMs); continue; }
  const b = st.board; tl.polls++;
  observe(b, st.version);
  if (sc.done && holds(sc.done, b)) { log({ event: 'done' }); writeTimeline(); await sleep(1500); break; }
  // ordered steps: any pending step whose condition holds fires once (or after orAfterSec since the last release)
  let fired = false;
  for (const step of [...pending]) {
    const byTime = step.orAfterSec && sec() - lastStepAt > step.orAfterSec;
    if (!holds(step.when, b) && !byTime) continue;
    let f;
    try { f = fill(step.do, b); } catch (e) { continue; }
    const r = await send(f.ops, `step ${step.id}${holds(step.when, b) ? '' : ' (timeout)'}`);
    if (f.round && r.ok) decidedByUs.add(f.round);
    tl.released.push({ step: step.id, at: sec(), byTimeout: !holds(step.when, b), ok: r.ok });
    pending.splice(pending.indexOf(step), 1); lastStepAt = sec(); fired = true;
    break;
  }
  // repeating rules, once no pending step waits on the same thing
  if (!fired) for (const rule of sc.rules ?? []) {
    if (pending.some((s) => Object.keys(s.when).some((k) => k in rule.when))) continue;
    if (!holds(rule.when, b)) continue;
    let f;
    try { f = fill(rule.do, b); } catch { continue; }
    const r = await send(f.ops, `rule ${rule.id}`);
    if (f.round) decidedByUs.add(f.round);
    tl.released.push({ rule: rule.id, at: sec(), round: f.round, ok: r.ok });
    break;
  }
  writeTimeline();
  await sleep(pollMs);
}
log({ event: 'stopped', pendingSteps: pending.map((s) => s.id) });
stop(0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
