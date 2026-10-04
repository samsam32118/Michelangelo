import { join } from 'node:path';
import { grader, probe, frameAt, frameDiff, edgeDensity, lumaStats, ssim, outputs, readProject, textClipsMatching, round, assertNotEmpty } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/intro.mp4');
  const p = await probe(out);
  await g.checkAsync('out/intro.mp4 1920x1080, 12 s +-0.2; a project has the "Kitchen Lab" title', async () => {
    if (!p) return { pass: false, detail: 'out/intro.mp4 missing' };
    const ne = await assertNotEmpty(out);
    const titled = outputs(dir, /\.mgl\.json$/).some((f) => { const pr = readProject(join(dir, f)); return pr && textClipsMatching(pr, /kitchen\s*lab/i).length > 0; });
    return { pass: p.displayWidth === 1920 && p.displayHeight === 1080 && Math.abs(p.duration - 12) <= 0.2 && ne.pass && titled, detail: `${p.displayWidth}x${p.displayHeight} ${round(p.duration, 2)} s; ${ne.detail}; title clip ${titled ? 'found' : 'missing'}` };
  });
  await g.checkAsync('frames at 0.5 s and 2.5 s differ (animated) and contain title glyphs', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const [a, b] = await Promise.all([frameAt(out, 0.5, { width: 640, height: 360 }), frameAt(out, 2.5, { width: 640, height: 360 })]);
    const d = frameDiff(a, b).mean, e = edgeDensity(b), sa = lumaStats(a).std;
    return { pass: d > 1 && e > 0.003 && sa > 0.01, detail: `diff ${round(d, 2)}, edges at 2.5 s ${round(e, 4)}, luma std at 0.5 s ${round(sa, 3)}` };
  });
  await g.checkAsync('frame at 6 s matches cook.mp4 at 2 s (SSIM > 0.8)', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const s = await ssim(out, join(dir, 'cook.mp4'), { ta: 6, tb: 2, width: 640, height: 360 });
    return { pass: s > 0.8, detail: `SSIM ${round(s, 3)}` };
  });
  return g.result();
}
