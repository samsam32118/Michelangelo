import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { grader, readProject, readManifest, apiIsV1, runPluginTests, probe, frameAt, channelLevels, assertNotEmpty } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const pdir = join(dir, 'plugins/posterize');
  await g.checkAsync('[lib] plugins/posterize exists with manifest api ^1 and passing tests', async () => {
    const m = readManifest(pdir);
    if (!m) return { pass: false, detail: 'plugins/posterize/package.json missing' };
    if (!apiIsV1(m)) return { pass: false, detail: `michelangelo.api = ${JSON.stringify(m.michelangelo?.api)}` };
    const t = await runPluginTests(pdir);
    return { pass: t.pass, detail: `api ${m.michelangelo.api}; tests ${t.detail}` };
  });
  const p = readProject(join(dir, 'demo.mgl.json'));
  const fx = (p?.clips ?? []).find((c) => c.id === 'shot')?.fx ?? [];
  g.check('[lib] demo.mgl.json names the plugin and the clip has fx posterize levels=3',
    !!p?.project?.plugins && 'posterize' in p.project.plugins && fx.some((f) => f.type === 'posterize' && f.levels === 3 && f.enabled !== false),
    p ? `plugins ${JSON.stringify(p.project?.plugins ?? {})}, fx ${JSON.stringify(fx)}` : 'demo.mgl.json missing');
  await g.checkAsync('out/poster.png: each channel has <= 3 distinct value clusters in the clip area (and is not flat)', async () => {
    const f = join(dir, 'out/poster.png');
    if (!existsSync(f)) return { pass: false, detail: 'out/poster.png missing' };
    const pi = await probe(f);
    const img = await frameAt(f, 0);
    const lv = channelLevels(img, { box: [0, 0, img.width, img.height] });
    const ne = await assertNotEmpty(f, { still: true });
    return { pass: pi.width === 1280 && pi.height === 720 && lv.every((n) => n <= 3) && lv.some((n) => n >= 2) && ne.pass, detail: `${pi.width}x${pi.height}, levels per channel ${lv.join('/')}` };
  });
  return g.result();
}
