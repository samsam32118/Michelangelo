// @vitest-environment node
// With vs without (DESIGN §17): the --arm option, library-only check exclusion, the cost model, the vision judge
// (contact sheets, sound summary, judge JSON parsing, a stand-in judge via --claude) and compare.mjs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EVALS = resolve(__dirname, '../../evals');
const load = (p: string): Promise<any> => import(pathToFileURL(join(EVALS, p)).href);
const tmp = mkdtempSync(join(tmpdir(), 'mgl-evals-arms-'));
let run: any, arms: any, summary: any, vision: any, cmp: any;
beforeAll(async () => { [run, arms, summary, vision, cmp] = await Promise.all([load('run.mjs'), load('sandbox/arms.mjs'), load('sandbox/summary.mjs'), load('vision/vision.mjs'), load('compare.mjs')]); });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ff = (args: string[]) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };

describe('--arm and the cost options', () => {
  it('parses --arm, --machine-rate, --vision and --judge-model; "with" is the default', () => {
    expect(run.parseArgs([])).toMatchObject({ arm: 'with', machineRate: 0.1, vision: false, judgeModel: 'claude-opus-5-5' });
    expect(run.parseArgs(['--arm', 'without', '--machine-rate', '0.4', '--vision', '--judge-model', 'j'])).toMatchObject({ arm: 'without', machineRate: 0.4, vision: true, judgeModel: 'j' });
    expect(() => run.parseArgs(['--arm', 'both'])).toThrow(/with or without/);
    expect(() => run.parseArgs(['--machine-rate', 'x'])).toThrow(/machine-rate/);
  });

  it('the "without" preamble names no library; results go to <set>-without', () => {
    const w = run.preambleFor('without');
    expect(w).toMatch(/^You are working in a sandbox: your current directory holds the task's files\. You have Node 22 \(with @napi-rs\/canvas installed here\), ffmpeg\/ffprobe 6\.1/);
    expect(w).toMatch(/Use whatever tools you like\. Write outputs where the task says\. Nobody will answer questions: decide and finish the task\./);
    expect(w).not.toMatch(/Michelangelo|mgl|skill/i);
    expect(run.preambleFor('with')).toMatch(/Michelangelo video library is installed here/);
    expect(arms.armSetDir('main', 'with')).toBe('main');
    expect(arms.armSetDir('heldout2', 'without')).toBe('heldout2-without');
    expect(arms.setOfDir('heldout2-without')).toBe('heldout2');
    expect(arms.armOfDir('main-without')).toBe('without');
    expect(arms.CANVAS_PKG).toBe('@napi-rs/canvas@0.1.80');
  });
});

describe('library-only checks', () => {
  const g = { pass: false, score: 0.6667, checks: [{ name: 'out/a.mp4 1080x1920', pass: true, detail: '' }, { name: 'loudness -14 LUFS', pass: true, detail: '' }, { name: '[lib] the project renders like the output', pass: false, detail: 'no project' }] };
  it('count as today in "with"', () => {
    expect(arms.applyArm(g, 'with')).toMatchObject({ pass: false, score: 0.6667 });
    expect(arms.applyArm(g, 'with').skippedChecks).toBeUndefined();
  });
  it('are excluded from pass and score in "without" and kept as skipped', () => {
    const a = arms.applyArm(g, 'without');
    expect(a).toMatchObject({ pass: true, score: 1 });
    expect(a.checks.map((c: any) => c.name)).toEqual(['out/a.mp4 1080x1920', 'loudness -14 LUFS']);
    expect(a.skippedChecks).toHaveLength(1);
    expect(arms.applyArm({ pass: true, score: 1, checks: [{ name: '[lib] x', pass: true }] }, 'without')).toMatchObject({ pass: false, score: 0 });
    expect(arms.applyArm({ pass: false, score: 0.5, checks: [{ name: 'a', pass: true }, { name: 'b', pass: false }] }, 'without')).toMatchObject({ pass: false, score: 0.5 });
  });
});

describe('cost', () => {
  it('model + machine (wall/3600 x rate) per run', () => {
    expect(arms.costOf({ metrics: { costUsd: 1.2 }, wallSec: 1800 }, 0.1)).toEqual({ modelUsd: 1.2, machineUsd: 0.05, totalUsd: 1.25, machineRate: 0.1 });
    expect(arms.costOf({ metrics: {}, wallSec: 3600 }, 0.4)).toMatchObject({ modelUsd: 0, machineUsd: 0.4, totalUsd: 0.4 });
  });

  const res = () => [
    { task: 'a', pass: true, score: 1, wallSec: 3600, metrics: { costUsd: 0.9 }, vision: { overall: 8, criteria: {} } },
    { task: 'b', pass: true, score: 1, wallSec: 0, metrics: { costUsd: 1 }, vision: { overall: 6, criteria: {} } },
    { task: 'c', pass: false, score: 0.5, wallSec: 0, metrics: { costUsd: 1 }, vision: { overall: 9, criteria: {} } },
    { task: 'd', pass: true, score: 1, wallSec: 0, metrics: { costUsd: 1 }, vision: { error: 'x', judge: { costUsd: 0.05 } } },
  ];
  it('summary: mean costs, cost per pass, cost per HQ deliverable (pass and vision >= 7)', () => {
    const s = summary.summarise(res(), { label: 'l', set: 'main', model: 'm', date: '2026-10-04T00:00:00Z', machineRate: 0.1, vision: true, arm: 'without' });
    expect(s).toMatchObject({ arm: 'without', totalUsd: 4, meanTotalUsd: 1, meanModelUsd: 0.975, meanMachineUsd: 0.025, costPerPass: 1.3333, hqDeliverables: 1, costPerHQ: 4, meanVision: 7.67, visionScored: 3, visionErrors: 1, judgeCostUsd: 0.05 });
    const md = summary.summaryMarkdown(s);
    expect(md).toMatch(/cost per high-quality deliverable \$4\*\*/);
    expect(md).toMatch(/Judge cost \(not counted\): \$0\.05/);
    expect(md).toMatch(/arm \*\*without\*\*/);
  });
  it('with vision off, cost per pass stands in and the summary says so', () => {
    const r = res().map(({ vision: _v, ...x }) => x);
    const s = summary.summarise(r, { label: 'l', set: 'main', model: 'm', date: '2026-10-04T00:00:00Z' });
    expect(s).toMatchObject({ vision: false, costPerHQ: null, hqDeliverables: null, costPerPass: 1.3333 });
    expect(summary.summaryMarkdown(s)).toMatch(/Vision scoring was off: cost per pass stands in/);
  });
  it('the public held-out result keeps vision scores but no notes, deliverables or skipped check names', () => {
    const p = summary.publicResult({ task: 'h-abcdef', pass: true, checks: [{ name: 'x' }], skippedChecks: [{ name: '[lib] secret' }], vision: { overall: 7, criteria: { brief: 7 }, notes: 'the secret brief', deliverables: ['out/secret.mp4'], judge: { costUsd: 0.1, turns: 2, model: 'm' } }, metrics: {} });
    expect(JSON.stringify(p)).not.toMatch(/secret/);
    expect(p).toMatchObject({ skippedChecks: 1, vision: { overall: 7, criteria: { brief: 7 }, judge: { costUsd: 0.1 } } });
  });
});

describe('judge JSON parsing', () => {
  it('takes the last JSON object, recomputes overall from the criteria, clamps to 0-10', () => {
    const t = 'I looked at the sheets.\n```json\n{"overall": 9, "criteria": {"brief": 8, "composition": 7, "text": 6, "motion": 7, "polish": 7, "sound": 12}, "notes": "fine"}\n```';
    expect(vision.parseJudgeJson(t)).toEqual({ overall: 8, criteria: { brief: 8, composition: 7, text: 6, motion: 7, polish: 7, sound: 10 }, notes: 'fine', reportedOverall: 9 });
    const bare = 'draft {"overall": 2, "criteria": {"brief": 2}} then final: {"overall": 5, "criteria": {"brief": 5, "composition": 4, "text": 5, "motion": 5, "polish": 5, "sound": "6"}, "notes": "a {brace} in text"}';
    expect(vision.parseJudgeJson(bare)).toMatchObject({ overall: 5, notes: 'a {brace} in text' });
    expect(vision.parseJudgeJson('{"overall": 6, "criteria": {"brief": 6}}')).toMatchObject({ overall: 6, missingCriteria: ['composition', 'text', 'motion', 'polish', 'sound'] });
    expect(() => vision.parseJudgeJson('no json here {not json}')).toThrow(/no judge JSON/);
  });
  it('reads the final text, cost and tokens of a stream-json transcript', () => {
    const out = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }, { type: 'result', result: '{"overall":7,"criteria":{"brief":7}}', total_cost_usd: 0.03, num_turns: 3, usage: { input_tokens: 10, output_tokens: 5 } }].map((e) => JSON.stringify(e)).join('\n');
    expect(vision.judgeTranscript(out)).toMatchObject({ text: '{"overall":7,"criteria":{"brief":7}}', costUsd: 0.03, turns: 3, tokens: { input: 10, output: 5 } });
  });
});

describe('contact sheets, sound summary and deliverables', () => {
  const d = join(tmp, 'media-run');
  beforeAll(() => {
    mkdirSync(join(d, 'out'), { recursive: true });
    mkdirSync(join(d, 'media'), { recursive: true });
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=25:d=3', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-af', 'apad=pad_dur=1', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(d, 'out/final.mp4')]);
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=10:d=1', join(d, 'media/fixture.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', join(d, 'out/thumb.png')]);
  });

  it('makes a 3x3 sheet with the long edge <= 1568', async () => {
    const s = await vision.contactSheet(join(d, 'out/final.mp4'), join(d, 'sheet.png'));
    expect(s.kind).toBe('video');
    expect(s.times).toHaveLength(9);
    const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(d, 'sheet.png')], { encoding: 'utf8' }).stdout.trim().split(',').map(Number);
    expect(Math.max(...p)).toBeLessThanOrEqual(1568);
    expect(p[0]).toBeGreaterThan(1400); // three 512-px tiles across
    const im = await vision.contactSheet(join(d, 'out/thumb.png'), join(d, 'sheet-img.png'));
    expect(im.kind).toBe('image');
  }, 60_000);

  it('summarises loudness, true peak and silences', async () => {
    const t = await vision.soundSummary(join(d, 'out/final.mp4'), 'out/final.mp4');
    expect(t).toMatch(/integrated loudness \(EBU R128\): -?\d/);
    expect(t).toMatch(/true peak: -?\d/);
    expect(t).toMatch(/silences below -50 dB lasting >= 0\.5 s: 2\.\d+-3\.\d+ s/);
    expect(await vision.soundSummary(join(d, 'media/fixture.mp4'))).toMatch(/audio: none/);
  }, 60_000);

  it('picks meta.deliverables, else the newest video under out/', () => {
    expect(vision.pickDeliverables(d, { meta: { deliverables: ['out/thumb.png', 'out/missing.mp4', '../escape.mp4'] } })).toEqual(['out/thumb.png']);
    expect(vision.pickDeliverables(d, {})).toEqual(['out/final.mp4']);
    expect(vision.pickDeliverables(d, { result: { checks: [{ name: 'x', detail: 'read out/thumb.png and media/fixture.mp4' }] } })).toEqual(['out/thumb.png']);
  });
});

describe('end to end with a stand-in agent and judge (--claude, no sandbox)', () => {
  const sets = join(tmp, 'sets'), res = join(tmp, 'res'), hist = join(tmp, 'HISTORY.md');
  const fake = join(tmp, 'fake-claude.sh');
  beforeAll(() => {
    const t = join(sets, 'tasks', 'make-clip');
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 'task.md'), 'Make out/clip.mp4: 2 s, 640x360, with a tone.\n');
    writeFileSync(join(t, 'meta.json'), JSON.stringify({ id: 'make-clip', timeout_min: 2, deliverables: ['out/clip.mp4'] }));
    writeFileSync(join(t, 'setup.mjs'), "import { writeFileSync } from 'node:fs';\nexport async function setup(dir) { writeFileSync(dir + '/notes.txt', 'brief'); }\n");
    writeFileSync(join(t, 'grade.mjs'), "import { existsSync } from 'node:fs';\nexport async function grade(dir) {\n  const ok = existsSync(dir + '/out/clip.mp4');\n  const checks = [{ name: 'out/clip.mp4 exists', pass: ok, detail: '' }, { name: '[lib] a project file renders like the output', pass: false, detail: 'no project' }];\n  return { pass: false, score: ok ? 0.5 : 0, checks };\n}\n");
    // judge mode when rubric.md is in the cwd; agent mode otherwise
    writeFileSync(fake, `#!/bin/bash
if [ -f rubric.md ]; then
  ok=no; [ -f sheet-1.png ] && [ -f sound.txt ] && [ -f task.md ] && ok=yes
  ro=no; [[ "$*" == *"--allowedTools Read --disallowedTools"* ]] && ro=yes
  grep -q "integrated loudness" sound.txt && snd=yes || snd=no
  echo '{"type":"assistant","message":{"id":"j1","content":[{"type":"text","text":"judging"}]}}'
  node -e 'const ans = { overall: 3, criteria: { brief: 8, composition: 8, text: 8, motion: 7, polish: 7, sound: 7 }, notes: process.argv[1] }; console.log(JSON.stringify({ type: "result", subtype: "success", num_turns: 4, total_cost_usd: 0.02, usage: { input_tokens: 7, output_tokens: 3 }, result: "Done.\\n" + JSON.stringify(ans) }))' "files=$ok readonly=$ro sound=$snd"
  exit 0
fi
printf '%s' "$2" > prompt.txt
[ -e node_modules/michelangelo ] && touch HAS_MGL
[ -e .claude/skills ] && touch HAS_SKILL
mkdir -p out && ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=s=640x360:r=25:d=2 -f lavfi -i sine=f=440:d=2 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac out/clip.mp4
echo '{"type":"system","subtype":"init"}'
echo '{"type":"result","subtype":"success","num_turns":5,"total_cost_usd":0.5,"usage":{"input_tokens":3,"output_tokens":4}}'
`);
    chmodSync(fake, 0o755);
  });
  const runner = (arm: string) => spawnSync(process.execPath, [join(EVALS, 'run.mjs'), '--no-sandbox', '--no-template', '--no-credentials', '--no-history', '--no-baseline', '--claude', fake,
    '--arm', arm, '--vision', '--machine-rate', '3600', '--label', 'e2e', '--sets-dir', sets, '--results-dir', res, '--private-dir', join(tmp, 'priv')], { encoding: 'utf8', timeout: 180_000 });

  it('runs both arms: [lib] counts only in "with"; vision judged once with Read only; costs split from the judge', () => {
    const w = runner('with');
    expect(w.status, w.stderr + w.stdout).toBe(0);
    const wo = runner('without');
    expect(wo.status, wo.stderr + wo.stdout).toBe(0);
    const sw = JSON.parse(readFileSync(join(res, 'e2e/main/summary.json'), 'utf8'));
    const so = JSON.parse(readFileSync(join(res, 'e2e/main-without/summary.json'), 'utf8'));
    expect(sw).toMatchObject({ arm: 'with', set: 'main', passed: 0, vision: true });
    expect(so).toMatchObject({ arm: 'without', set: 'main', passed: 1, skippedLibChecks: 1, vision: true, hqDeliverables: 1 });
    const x = so.results[0];
    expect(x).toMatchObject({ arm: 'without', pass: true, score: 1, metrics: { costUsd: 0.5 } });
    expect(x.skippedChecks[0].name).toMatch(/^\[lib\]/);
    // machine rate 3600 $/h = $1 per wall second
    expect(x.cost.machineUsd).toBeCloseTo(x.wallSec, 1);
    expect(x.cost.totalUsd).toBeCloseTo(0.5 + x.cost.machineUsd, 3);
    expect(x.vision).toMatchObject({ overall: 8, reportedOverall: 3, deliverables: ['out/clip.mp4'], notes: 'files=yes readonly=yes sound=yes', judge: { costUsd: 0.02, turns: 4 } });
    expect(so.judgeCostUsd).toBe(0.02);
    expect(so.totalModelUsd).toBe(0.5); // the judge is not in the arm's cost
    expect(so.costPerHQ).toBeCloseTo(x.cost.totalUsd, 3);
    expect(existsSync(join(res, 'e2e/main-without/make-clip/vision/sheet-1.png'))).toBe(true);
    const prompt = readFileSync(join(res, 'e2e/main-without/make-clip/outputs/prompt.txt'), 'utf8');
    expect(prompt).toMatch(/Use whatever tools you like/);
    expect(prompt).toMatch(/Make out\/clip\.mp4/);
    expect(readFileSync(join(res, 'e2e/main/make-clip/outputs/prompt.txt'), 'utf8')).toMatch(/Michelangelo/);
    expect(readFileSync(join(res, 'e2e/main-without/summary.md'), 'utf8')).toMatch(/Library-only checks \(not counted in this arm\)[\s\S]*\[lib\] a project file renders/);

    // compare.mjs: the markdown and the HISTORY section
    const c = spawnSync(process.execPath, [join(EVALS, 'compare.mjs'), join(res, 'e2e/main'), join(res, 'e2e/main-without'), '--history', hist], { encoding: 'utf8' });
    expect(c.status, c.stderr).toBe(0);
    const md = readFileSync(join(res, 'e2e/compare-main.md'), 'utf8');
    expect(md).toMatch(/# With vs without · e2e · main/);
    expect(md).toMatch(/cost per high-quality deliverable: with n\/a, without \$/);
    expect(md).toMatch(/\| make-clip \| no \/ yes \| 0\.5 \/ 1 \| 8 \/ 8\* \|/);
    expect(md).toMatch(/\| success rate \| 0 % \(0\/1\) \| 100 % \(1\/1\) \| 0x \|/);
    const h = readFileSync(hist, 'utf8');
    expect(h).toMatch(/## With vs without\n/);
    expect(h).toMatch(/\| e2e \| main \| 0\/1 \| 1\/1 \| n\/a \| \$/);
    // wrong order is refused
    expect(spawnSync(process.execPath, [join(EVALS, 'compare.mjs'), join(res, 'e2e/main-without'), join(res, 'e2e/main'), '--no-history'], { encoding: 'utf8' }).status).toBe(1);
  }, 240_000);
});

describe('compare history', () => {
  const row = (label: string) => ({ date: '2026-10-04', label, set: 'main', hq: false, with: { passed: 9, tasks: 10, perHQ: 1, vision: null, wall: 50, meanUsd: 0.9 }, without: { passed: 5, tasks: 10, perHQ: 4, vision: null, wall: 200, meanUsd: 2 }, ratio: 0.25 });
  it('creates the section once and appends rows to its table, before a later section', () => {
    const f = join(tmp, 'H2.md');
    writeFileSync(f, '# Eval history\n\n| date | label |\n|---|---|\n| 2026-10-04 | x |\n');
    cmp.appendCompareHistory(f, row('a'));
    writeFileSync(f, readFileSync(f, 'utf8') + '\n## Later\n\ntext\n');
    cmp.appendCompareHistory(f, row('b'), 'second');
    const t = readFileSync(f, 'utf8');
    expect(t.match(/## With vs without/g)).toHaveLength(1);
    const sec = t.slice(t.indexOf('## With vs without'), t.indexOf('## Later'));
    expect(sec).toMatch(/\| a \| main \| 9\/10 \| 5\/10 \| \$1 \| \$4 \| 0\.25x \|[^\n]*per pass \(vision off\) \|\n\| 2026-10-04 \| b \|[^\n]*second \|/);
    expect(t.startsWith('# Eval history\n\n| date | label |\n|---|---|\n| 2026-10-04 | x |\n')).toBe(true);
  });
});
