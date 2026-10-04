import { join } from 'node:path';
import { grader, assertNotEmpty, frameAt, round, mediaFacts, regionSsim, namedProject, inputsUnchanged, envelopeMatch } from '../_lib/h.mjs';

const RED = [255, 59, 48];
const isRed = (d, i) => Math.hypot(d[i] - RED[0], d[i + 1] - RED[1], d[i + 2] - RED[2]) < 75;

/** Bar run on a row: {run (px from x=0), stray (red px beyond run + 40)}. */
function barRow(img, y) {
  let run = 0, gap = 0, end = 0;
  for (let x = 0; x < img.width; x++) {
    if (isRed(img.data, (y * img.width + x) * 4)) { end = x + 1; gap = 0; } else if (++gap > 6) break;
  }
  run = end;
  let stray = 0;
  for (let x = run + 40; x < img.width; x++) if (isRed(img.data, (y * img.width + x) * 4)) stray++;
  return { run, stray };
}

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/progress.mp4'), src = join(dir, 'tutorial.mp4');
  const facts = await mediaFacts(out, { w: 1920, h: 1080, dur: 10, durTol: 0.15, audio: true });
  const ne = facts.ok ? await assertNotEmpty(out, { audio: true }) : { pass: false, detail: '' };
  g.check('out/progress.mp4: 1920x1080 with audio, 10 s, not empty', facts.ok && ne.pass, `${facts.detail}; ${ne.detail}`);

  await g.checkAsync('bar width grows linearly from the left to the full width', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const T = facts.info.duration, notes = []; let pass = true;
    for (const t of [1, 3, 5, 7, 9, 9.9]) {
      const f = await frameAt(out, t);
      const r = f ? barRow(f, 1074) : { run: 0, stray: 0 };
      const frac = r.run / 1920, want = Math.min(1, t / T);
      const good = t === 9.9 ? frac >= 0.95 : Math.abs(frac - want) <= 0.035 && r.stray < 20;
      if (!good) pass = false;
      notes.push(`${t}s ${round(frac * 100, 1)}%${r.stray ? ` stray ${r.stray}` : ''}`);
    }
    return { pass, detail: notes.join(', ') };
  });

  await g.checkAsync('bar 8-18 px tall, on the bottom edge', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const f = await frameAt(out, 5);
    if (!f) return { pass: false, detail: 'no frame' };
    const rows = [];
    for (let y = 1000; y < 1080; y++) if (isRed(f.data, (y * 1920 + 200) * 4)) rows.push(y);
    const contiguous = rows.length && rows[rows.length - 1] - rows[0] + 1 === rows.length;
    return { pass: contiguous && rows.length >= 8 && rows.length <= 18 && rows[rows.length - 1] >= 1076, detail: rows.length ? `rows ${rows[0]}-${rows[rows.length - 1]} (${rows.length})` : 'no bar at x=200' };
  });

  await g.checkAsync('picture above the bar unchanged', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const s = [];
    for (const t of [2, 5, 8]) { const [a, b] = await Promise.all([frameAt(out, t), frameAt(src, t)]); s.push(a && b ? await regionSsim(a, [0, 0, 1920, 1040], b, [0, 0, 1920, 1040], 960) : 0); }
    return { pass: s.every((v) => v >= 0.9), detail: `SSIM ${s.map((v) => round(v, 3)).join('/')}` };
  });

  await g.checkAsync('audio unchanged', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const c = await envelopeMatch(out, src);
    return { pass: c >= 0.9, detail: `envelope corr ${round(c, 3)}` };
  });

  const pr = namedProject(dir, 'progress.mgl.json', { inputs: ['tutorial.mp4'], size: [1920, 1080] });
  const inp = await inputsUnchanged(dir, ['tutorial.mp4']);
  g.check('input unchanged', inp.ok, inp.detail);
  g.check('[lib] progress.mgl.json valid, 1920x1080, uses tutorial.mp4', pr.ok, pr.detail);
  return g.result();
}
