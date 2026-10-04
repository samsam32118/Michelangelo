import { join } from 'node:path';
import { grader, readProject, readManifest, apiIsV1, runPluginTests, probe, frameAt, meanColor, mask, toFrames, round, assertNotEmpty } from '../../lib/index.mjs';

const isRed = (r, g, b) => r > 180 && g < 70 && b < 70;
const isBlue = (r, g, b) => b > 180 && r < 70 && g < 70;
const share = (img, pred) => { const m = mask(img, pred); let n = 0; for (const v of m) n += v; return n / m.length; };

export async function grade(dir) {
  const g = grader();
  const pdir = join(dir, 'plugins/iris');
  await g.checkAsync('[lib] plugin test passes (plugins/iris, manifest api ^1)', async () => {
    const m = readManifest(pdir);
    if (!m) return { pass: false, detail: 'plugins/iris/package.json missing' };
    const t = await runPluginTests(pdir);
    return { pass: apiIsV1(m) && t.pass, detail: `api ${m.michelangelo?.api}; tests ${t.detail}` };
  });
  const p = readProject(join(dir, 'two.mgl.json'));
  const clip = (id) => (p?.clips ?? []).find((c) => c.id === id);
  const tr = clip('blue')?.transition?.in ?? clip('red')?.transition?.out;
  g.check('[lib] two.mgl.json uses the iris transition between the clips, 1 s long; clips unchanged', !!p?.project?.plugins && 'iris' in p.project.plugins && tr?.type === 'iris' && toFrames(tr.len, 30) === 30
    && clip('red')?.at === 0 && toFrames(clip('red')?.len, 30) === 90 && toFrames(clip('blue')?.at, 30) === 90, p ? `transition ${JSON.stringify(tr ?? null)}` : 'two.mgl.json missing');
  const out = join(dir, 'out/iris.mp4');
  const info = await probe(out);
  const at = async (t) => frameAt(out, t, { width: 320, height: 180 });
  await g.checkAsync('at the transition midpoint (3.0 s): centre pixel blue, corner pixel red', async () => {
    if (!info) return { pass: false, detail: 'out/iris.mp4 missing' };
    const img = await at(3.0);
    const c = meanColor(img, [150, 80, 20, 20]), k = meanColor(img, [2, 2, 12, 12]);
    return { pass: isBlue(...c) && isRed(...k), detail: `centre rgb(${c.map(Math.round)}), corner rgb(${k.map(Math.round)})` };
  });
  await g.checkAsync('before (2.0 s): all red; after (4.0 s): all blue; duration 6 s', async () => {
    if (!info) return { pass: false, detail: 'missing' };
    const [a, b] = await Promise.all([at(2.0), at(4.0)]);
    const r = share(a, isRed), bl = share(b, isBlue);
    const ne = await assertNotEmpty(out);
    return { pass: r > 0.98 && bl > 0.98 && Math.abs(info.duration - 6) < 0.1 && ne.pass, detail: `red ${round(r, 3)}, blue ${round(bl, 3)}, ${round(info.duration, 2)} s` };
  });
  return g.result();
}
