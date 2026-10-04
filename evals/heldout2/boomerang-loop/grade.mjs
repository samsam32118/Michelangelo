import { join } from 'node:path';
import { grader, assertNotEmpty, round, mediaFacts, namedProject, inputsUnchanged, allFrames, readCounter } from '../_lib/h.mjs';

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/boomerang.mp4');
  const facts = await mediaFacts(out, { w: 1080, h: 1080, dur: 9, durTol: 0.2 });
  const fpsOk = facts.ok && Math.abs((facts.info.fps ?? 0) - 30) <= 0.5;
  const ne = facts.ok ? await assertNotEmpty(out) : { pass: false, detail: '' };
  g.check('out/boomerang.mp4: 1080x1080, 30 fps, 9 s, not empty', facts.ok && fpsOk && ne.pass, `${facts.detail}, ${round(facts.info?.fps, 2)} fps; ${ne.detail}`);
  const vals = facts.ok ? (await allFrames(out, { width: 360, height: 360 })).map((f) => readCounter(f)) : [];
  const good = vals.filter((v) => v >= 0);
  const inRange = good.every((v) => v >= 28 && v <= 76);
  g.check('frames decode to source frames 28-76', vals.length > 200 && good.length >= 0.95 * vals.length && inRange,
    `${good.length}/${vals.length} decoded, range ${good.length ? Math.min(...good) : '-'}-${good.length ? Math.max(...good) : '-'}`);
  // monotone runs (ignoring repeats)
  const runs = [];
  for (let i = 1; i < good.length; i++) {
    const d = Math.sign(good[i] - good[i - 1]);
    if (!d) continue;
    const last = runs[runs.length - 1];
    if (last && last.dir === d) last.end = good[i]; else runs.push({ dir: d, start: good[i - 1], end: good[i] });
  }
  const shape = runs.length === 6 && runs.every((r, i) => (i % 2 === 0 ? r.dir > 0 && r.start <= 33 && r.end >= 71 : r.dir < 0 && r.start >= 71 && r.end <= 33));
  g.check('6 monotone runs: up/down x3, each spanning the whole range', shape, runs.slice(0, 12).map((r) => `${r.dir > 0 ? 'up' : 'down'} ${r.start}->${r.end}`).join(', ') + (runs.length > 12 ? ` ... (${runs.length} runs)` : ''));
  const steps = good.slice(1).map((v, i) => Math.abs(v - good[i])).filter((d) => d > 0).sort((a, b) => a - b);
  const med = steps.length ? steps[steps.length >> 1] : NaN;
  g.check('normal speed (median step <= 1.5 frames)', steps.length > 100 && med <= 1.5, `median step ${med}, ${steps.length} steps`);
  const pr = namedProject(dir, 'boomerang.mgl.json', { inputs: ['jump.mp4'], size: [1080, 1080] });
  const inp = await inputsUnchanged(dir, ['jump.mp4']);
  g.check('input unchanged', inp.ok, inp.detail);
  g.check('[lib] boomerang.mgl.json valid, 1080x1080, uses jump.mp4', pr.ok, pr.detail);
  return g.result();
}
