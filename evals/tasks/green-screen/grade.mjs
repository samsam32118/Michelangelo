import { join } from 'node:path';
import { grader, readSetup, outputs, probe, frameAt, round, assertNotEmpty, findProjectUsing } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const D = info.disc, cx = D.x0 + D.vx * 1, cy = D.y;
  const city = await frameAt(join(dir, 'city.mp4'), 1, { width: 1280, height: 720 });
  const evals = [];
  for (const f of outputs(dir, /\.png$/).slice(0, 8)) {
    const pi = await probe(join(dir, f));
    if (!pi || Math.abs(pi.width / pi.height - 16 / 9) > 0.02 || !(await assertNotEmpty(join(dir, f), { still: true })).pass) continue;
    const img = await frameAt(join(dir, f), 0, { width: 1280, height: 720 });
    let green = 0, discN = 0, discOk = 0, bgN = 0, bgErr = 0;
    for (let y = 0; y < 720; y += 2) for (let x = 0; x < 1280; x += 2) {
      const i = (y * 1280 + x) * 4, r = img.data[i], gg = img.data[i + 1], b = img.data[i + 2];
      if (gg > r + 60 && gg > b + 60) green++;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < D.r * 0.7) { discN++; if (r > 180 && gg < 90 && b > 180) discOk++; }
      else if (dist > D.r * 1.3) { bgN++; bgErr += (Math.abs(r - city.data[i]) + Math.abs(gg - city.data[i + 1]) + Math.abs(b - city.data[i + 2])) / 3; }
    }
    evals.push({ f, green, disc: discOk / discN, bg: bgErr / bgN });
  }
  const best = evals.sort((a, b) => a.green - b.green || b.disc - a.disc)[0];
  g.check('still: no pixel with dominant green (g > r+60 and g > b+60)', !!best && best.green === 0, best ? `${best.f}: ${best.green} green pixels (sampled)` : 'no 16:9 PNG still');
  g.check('the disc region is magenta; the former green region matches city.mp4', !!best && best.disc > 0.95 && best.bg < 25, best ? `disc magenta ${round(best.disc, 3)}, background error vs city ${round(best.bg, 1)}` : 'no still');
  // made with the library: the edit is in a valid project that uses the task's inputs (not only in an ffmpeg output)
  const proj = findProjectUsing(dir, { inputs: ['presenter.mp4', 'city.mp4'], pred: (pp) => {
    const srcOf = new Map((pp.assets ?? []).map((a) => [a.id, String(a.src ?? '')]));
    const pr = (pp.clips ?? []).filter((c) => srcOf.get(c.asset)?.endsWith('presenter.mp4'));
    return pr.some((c) => Array.isArray(c.fx) && c.fx.some((x) => /key/i.test(String(x?.type ?? '')))) || 'the presenter clip has no keying fx';
  } });
  g.check('[lib] a project uses presenter.mp4 and city.mp4 and keys the presenter (a chroma-key fx)', !!proj.p, proj.p ? proj.f : proj.why);
  return g.result();
}
