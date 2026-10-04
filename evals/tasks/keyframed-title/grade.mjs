import { join } from 'node:path';
import { grader, readSetup, readProject, isKeyframes, toFrames, valueAt, outputs, probe, frameAt, mask, maskStats, hex, round, assertNotEmpty } from '../../lib/index.mjs';

const outEasing = (e) => (typeof e === 'string' ? /^(out|inOut)/.test(e) : Array.isArray(e) && e.length === 4 && e[1] > e[0]);

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const p = readProject(join(dir, 'title.mgl.json'));
  const c = (p?.clips ?? []).find((x) => x.id === 'title');
  const len = c ? toFrames(c.len, 30) : 0;
  g.check('[lib] x keyframes start off-screen-left and end at centre by frame 15 with an out easing', (() => {
    if (!c || !isKeyframes(c.x)) return false;
    const k = c.x.map((kf) => [toFrames(kf[0], 30), kf[1], kf[2]]);
    const centreAt = k.find((kf) => Math.abs(kf[1] - 960) <= 2);
    const firstSeg = k[0][2];
    return k[0][0] <= 0 && k[0][1] <= 0 && !!centreAt && centreAt[0] <= 16 && outEasing(firstSeg) && Math.abs(valueAt(c.x, 45, 0) - 960) <= 2;
  })(), c ? `x ${JSON.stringify(c.x)}` : 'title clip missing');
  g.check('[lib] opacity reaches 0 at the last frame (after holding at 1)', (() => {
    if (!c || !isKeyframes(c.opacity) || c.hidden) return false;
    return valueAt(c.opacity, len - 1, 1) <= 0.1 && valueAt(c.opacity, len - 17, 0) >= 0.95 && valueAt(c.opacity, 45, 0) >= 0.95 && toFrames(c.at, 30) === 0 && len === info.len;
  })(), c ? `opacity ${JSON.stringify(c.opacity)}, len ${len}` : 'missing');
  await g.checkAsync('stills: at 0.25 s the text is left of centre, at 1.5 s centred, on the last frame no text', async () => {
    const pngs = outputs(dir, /\.png$/, { includeMgl: false });
    const bg = hex(info.bg);
    const res = [];
    for (const f of pngs.slice(0, 12)) {
      const pi = await probe(join(dir, f));
      if (!pi || Math.abs(pi.width / pi.height - 16 / 9) > 0.02) continue;
      const img = await frameAt(join(dir, f), 0, { width: 480, height: 270 });
      const s = maskStats(mask(img, (r, gg, b) => Math.max(Math.abs(r - bg[0]), Math.abs(gg - bg[1]), Math.abs(b - bg[2])) > 60), 480, 270);
      res.push({ f, count: s.count, cx: s.centroid ? s.centroid[0] * 4 : null });
    }
    const left = res.find((r) => r.count > 80 && r.cx < 860), centre = res.find((r) => r.count > 300 && Math.abs(r.cx - 960) < 40), empty = res.find((r) => r.count < 20);
    const lit = left && (await assertNotEmpty(join(dir, left.f), { still: true })).pass;
    return { pass: !!(left && centre && empty && lit), detail: res.map((r) => `${r.f}: ${r.count}px cx ${round(r.cx, 0)}`).join('; ') || 'no 16:9 PNG stills' };
  });
  return g.result();
}
