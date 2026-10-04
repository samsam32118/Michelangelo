import { join } from 'node:path';
import { grader, probe, allFrames, readCounter, round, assertNotEmpty, findProjectUsing, isKeyframes } from '../../lib/index.mjs';

/** Expected: source 0..29 at 1x, source 30..89 at 2x (30 frames), source 90 held 30 frames, then 1x from 90/91. */
function analyse(v) {
  const n = v.length;
  const bad = v.filter((x) => x < 0).length;
  if (n < 100 || bad > 3) return { ok: false, why: `${n} frames, ${bad} unreadable` };
  // the freeze: longest run of a constant value
  let best = { start: 0, len: 0 };
  for (let i = 0; i < n;) { let j = i; while (j + 1 < n && v[j + 1] === v[i]) j++; if (j - i + 1 > best.len) best = { start: i, len: j - i + 1 }; i = j + 1; }
  const held = v[best.start];
  const freezeOk = best.len >= 29 && best.len <= 32 && Math.abs(held - 90) <= 2 && Math.abs(best.start - 60) <= 2;
  const steps = (a, b) => { const d = []; for (let i = a + 1; i < b; i++) d.push(v[i] - v[i - 1]); return d; };
  const share = (d, s) => (d.length ? d.filter((x) => x === s).length / d.length : 0);
  const s1 = steps(0, Math.min(29, best.start - 31)), s2 = steps(best.start - 28, best.start - 1), s3 = steps(best.start + best.len + 1, n);
  const startOk = Math.abs(v[0]) <= 1;
  const ok = freezeOk && startOk && share(s1, 1) >= 0.85 && share(s2, 2) >= 0.8 && share(s3, 1) >= 0.9 && s3.length >= 20 && Math.abs(v[best.start + best.len] - held) <= 2;
  return { ok, why: `start ${v[0]}; 1x ${round(share(s1, 1), 2)}; 2x ${round(share(s2, 2), 2)}; hold ${held} x${best.len} at frame ${best.start}; then 1x ${round(share(s3, 1), 2)} over ${s3.length}; last ${v[n - 1]}`, last: v[n - 1], freezeEnd: best.start + best.len };
}

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/run.mp4');
  const p = await probe(out, { countFrames: true });
  let a;
  await g.checkAsync('decoded counter values follow 1x, then 2x steps, then constant for 30 frames, then 1x', async () => {
    if (!p) return { pass: false, detail: 'out/run.mp4 missing' };
    const frames = await allFrames(out, { width: 192, height: 108 });
    a = analyse(frames.map((f) => readCounter(f)));
    const ne = await assertNotEmpty(out);
    return { pass: a.ok && ne.pass, detail: `${a.why}; ${ne.detail}` };
  });
  g.check('duration consistent (frame count matches the edit: 90 + the 1x tail to the end of the original range)', !!p && !!a?.ok && Math.abs((p.frames ?? 0) - (a.freezeEnd + (a.last - 90))) <= 2 && a.last >= 230 && Math.abs(p.duration - p.frames / 30) < 0.1,
    p ? `${p.frames} frames, ${round(p.duration, 2)} s; last source frame ${a?.last}` : 'missing');
  // made with the library: the edit is in a valid project that uses the task's inputs (not only in an ffmpeg output)
  const proj = findProjectUsing(dir, { inputs: ['media/counter.mp4'], pred: (pp) => {
    const cs = (pp.clips ?? []).filter((c) => c.asset !== undefined && (pp.assets ?? []).find((a) => a.id === c.asset)?.src?.endsWith('counter.mp4'));
    const fast = cs.some((c) => Number(c.speed) === 2), held = cs.some((c) => Number(c.speed) === 0);
    return (fast && held) || cs.some((c) => isKeyframes(c.remap)) || 'no 2x clip and held (speed 0) clip, nor a remap';
  } });
  g.check('the project has the edit: a 2x clip and a freeze (speed 0) or a time remap on the counter', !!proj.p, proj.p ? proj.f : proj.why);
  return g.result();
}
