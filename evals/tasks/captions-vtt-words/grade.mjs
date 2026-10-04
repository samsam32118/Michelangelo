import { join } from 'node:path';
import { grader, probe, frameAt, readSetup, outputs, readProject, projectCues, normText, colorClusters, hex, round, assertNotEmpty } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const tol = 1 / 30 + 0.002;
  const files = ['clip.mgl.json', ...outputs(dir, /\.mgl\.json$/).filter((f) => f !== 'clip.mgl.json')];
  let detail = 'no project with the VTT cues';
  const ok = files.some((f) => {
    const p = readProject(join(dir, f));
    if (!p) return false;
    const cues = projectCues(p);
    const good = cues.length === info.cues.length && info.cues.every((c, i) => {
      const q = cues[i];
      return q && normText(q.text) === normText(c.text) && Math.abs(q.start - c.start) <= tol && q.words?.length === c.words.length && q.words.every((w, j) => Math.abs(w - c.words[j]) <= tol);
    });
    detail = `${f}: ${cues.length} cues, word times ${cues.map((q) => (q.words ? q.words.length : 0)).join('/')}`;
    return good;
  });
  g.check('cues carry word timings matching the VTT within 1 frame (texts unchanged)', ok, detail);

  await g.checkAsync('out/still.png 1080x1920; the caption at 4.2 s shows 2 dominant text colours (highlighted word)', async () => {
    const f = join(dir, 'out/still.png');
    const pi = await probe(f);
    if (!pi) return { pass: false, detail: 'out/still.png missing' };
    if (pi.width !== 1080 || pi.height !== 1920) return { pass: false, detail: `${pi.width}x${pi.height}` };
    const img = await frameAt(f, 0);
    const bg = hex(info.bg);
    const isText = (r, g2, b) => Math.max(Math.abs(r - bg[0]), Math.abs(g2 - bg[1]), Math.abs(b - bg[2])) > 60 && Math.max(r, g2, b) > 110;
    const cl = colorClusters(img, { step: 2, radius: 60, minShare: 0.06, pred: isText });
    const ne = await assertNotEmpty(f, { still: true });
    return { pass: cl.length >= 2 && ne.pass, detail: `clusters ${cl.map((c) => `rgb(${c.color}) ${round(c.share, 2)}`).join(', ') || 'none'}` };
  });
  return g.result();
}
