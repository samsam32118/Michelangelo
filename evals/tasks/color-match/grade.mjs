import { join } from 'node:path';
import { grader, readProject, validateRaw, outputs, probe, frameAt, meanColor, round, assertNotEmpty } from '../../lib/index.mjs';

/** Luma correlation at 64x36: tells the unmirrored shot A from the mirrored shot B regardless of colour. */
function corr(a, b) {
  const l = (img) => { const v = []; for (let i = 0; i < img.data.length; i += 4) v.push(0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]); return v; };
  const x = l(a), y = l(b), mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { n += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return n / Math.sqrt(dx * dy || 1);
}

export async function grade(dir) {
  const g = grader();
  const S = { width: 64, height: 36 };
  const [ga, gb] = await Promise.all([frameAt(join(dir, '.golden/a.png'), 0, S), frameAt(join(dir, '.golden/b_neutral.png'), 0, S)]);
  const stills = [];
  for (const f of outputs(dir, /\.png$/).slice(0, 10)) {
    const pi = await probe(join(dir, f));
    if (!pi || Math.abs(pi.width / pi.height - 16 / 9) > 0.02 || !(await assertNotEmpty(join(dir, f), { still: true })).pass) continue;
    const small = await frameAt(join(dir, f), 0, S), full = await frameAt(join(dir, f), 0, { width: 320, height: 180 });
    const [ca, cb] = [corr(small, ga), corr(small, gb)];
    const [r, , b] = meanColor(full);
    stills.push({ f, shot: ca > cb ? 'A' : 'B', rb: r / Math.max(1, b), c: Math.max(ca, cb) });
  }
  const A = stills.find((s) => s.shot === 'A' && s.c > 0.6), B = stills.find((s) => s.shot === 'B' && s.c > 0.6);
  g.check('mean R/B ratio of the B still within 5 % of the A still', !!A && !!B && Math.abs(B.rb / A.rb - 1) <= 0.05,
    stills.map((s) => `${s.f}: shot ${s.shot} R/B ${round(s.rb, 3)}`).join('; ') || 'no 16:9 PNG stills');
  const p = readProject(join(dir, 'match.mgl.json'));
  const b = (p?.clips ?? []).find((c) => c.asset === 'shot-b');
  const a = (p?.clips ?? []).find((c) => c.id === 'a');
  g.check('B not just replaced by A (B source still referenced, visible; A untouched)', !!p && !validateRaw(p).length && !!b && !b.hidden && (b.opacity === undefined || b.opacity === 1) && p.assets.some((x) => x.id === 'shot-b' && x.src === 'media/b.mp4') && a?.asset === 'shot-a' && !a.fx,
    b ? `B clip "${b.id}" fx ${JSON.stringify(b.fx ?? [])}` : 'no clip uses shot B');
  return g.result();
}
