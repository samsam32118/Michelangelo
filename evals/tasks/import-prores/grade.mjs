import { join } from 'node:path';
import { grader, probe, frameAt, ssim, round, assertNotEmpty, findProjectUsing, compRate, mainComp } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/edit.mp4');
  const p = await probe(out, { countFrames: true });
  await g.checkAsync('out/edit.mp4 1920x1080 30 fps, 6.0 s +-1 frame (cut-centred transition: lengths add up)', async () => {
    if (!p) return { pass: false, detail: 'out/edit.mp4 missing' };
    const ne = await assertNotEmpty(out);
    const frames = p.frames ?? Math.round(p.duration * 30);
    return { pass: p.width === 1920 && p.height === 1080 && Math.abs(p.fps - 30) < 0.01 && Math.abs(frames - 180) <= 1 && ne.pass, detail: `${p.width}x${p.height} ${round(p.fps, 3)} fps ${frames} frames; ${ne.detail}` };
  });
  await g.checkAsync('frame at 1 s matches testsrc, at 5.5 s matches smptebars (SSIM > 0.6)', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const a = await ssim(out, join(dir, 'master.mov'), { ta: 1, tb: 1, width: 480, height: 270 });
    const b = await ssim(out, join(dir, 'film24.mp4'), { ta: 5.5, tb: 2.5, width: 480, height: 270 });
    return { pass: a > 0.6 && b > 0.6, detail: `testsrc ${round(a, 3)}, smptebars ${round(b, 3)}` };
  });
  await g.checkAsync('crossfade: the frame at the cut (3.0 s) is a blend of both sources', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const W = 480, H = 270;
    const [o, a, b] = await Promise.all([frameAt(out, 3.0, { width: W, height: H }), frameAt(join(dir, 'master.mov'), 3.0, { width: W, height: H }), frameAt(join(dir, 'film24.mp4'), 1.0, { width: W, height: H })]);
    if (!o || !a || !b) return { pass: false, detail: 'no frame' };
    let n = 0, between = 0;
    for (let i = 0; i < o.data.length; i += 4) {
      const ch = [0, 1, 2].filter((c) => Math.abs(a.data[i + c] - b.data[i + c]) > 100);
      if (!ch.length) continue;
      n++;
      if (ch.every((c) => { const lo = Math.min(a.data[i + c], b.data[i + c]), hi = Math.max(a.data[i + c], b.data[i + c]), v = o.data[i + c]; return v > lo + 20 && v < hi - 20; })) between++;
    }
    return { pass: n > 1000 && between / n > 0.5, detail: `share ${round(between / Math.max(1, n), 3)} of ${n} contrasting pixels lie between both sources` };
  });
  // made with the library: the edit is in a valid project that uses the task's inputs (not only in an ffmpeg output)
  const proj = findProjectUsing(dir, { inputs: ['master.mov', 'film24.mp4'], size: [1920, 1080], pred: (pp) => {
    if (Math.abs(compRate(mainComp(pp)) - 30) > 0.01) return 'main comp is not 30 fps';
    return (pp.clips ?? []).some((c) => c.transition || (Array.isArray(c.fade) && c.fade.some((x) => x && x !== '0'))) || 'no transition or fade';
  } });
  g.check('[lib] a 1920x1080 30 fps project uses master.mov and film24.mp4 with a transition', !!proj.p, proj.p ? proj.f : proj.why);
  return g.result();
}
