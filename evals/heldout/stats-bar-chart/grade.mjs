import { join } from 'node:path';
import * as L from '../_lib/index.mjs';
import { ROWS } from './setup.mjs';

/** Bar of one colour: largest blob, height = median column run over its central half. */
function bar(img, hex) {
  const m = L.colorMask(img, hex, 8), b = L.blobs(m, img.width, { minArea: 150 })[0];
  if (!b) return { h: 0 };
  const runs = [];
  const w = b.x1 - b.x0 + 1;
  for (let x = b.x0 + Math.floor(w / 4); x <= b.x1 - Math.floor(w / 4); x++) { let n = 0; for (let y = b.y0; y <= b.y1; y++) n += m[y * img.width + x]; runs.push(n); }
  runs.sort((a, c) => a - c);
  return { h: runs[Math.floor(runs.length / 2)] ?? 0, cx: b.cx, x0: b.x0, x1: b.x1, bottom: b.y1, area: b.area };
}

export async function grade(dir) {
  const g = L.grader();
  const rows = L.readSetup(dir).info.rows ?? ROWS;
  const out = join(dir, 'out/chart.mp4');
  const p = await L.probe(out);
  const ok1080 = p?.video?.width === 1920 && p.video.height === 1080;
  await g.checkAsync('out/chart.mp4: 1920x1080, 6 s +/- 0.1, not black, not static', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const ne = await L.notEmpty(out);
    return { pass: ok1080 && Math.abs(p.duration - 6) <= 0.1 && ne.pass, detail: `${p.video?.width}x${p.video?.height} ${L.round(p.duration, 2)} s; ${ne.detail}` };
  });
  const at = async (t) => (ok1080 ? L.frameAt(out, t) : null);
  const f5 = await at(5);
  const fin = f5 ? rows.map((r) => bar(f5, r[2])) : rows.map(() => ({ h: 0 }));
  const hmax = Math.max(...fin.map((b) => b.h));
  const prop = fin.map((b, i) => ({ r: hmax ? b.h / hmax : 0, want: rows[i][1] / 60 }));
  g.check('at 5 s each bar height is proportional to its value (within 5 %)', hmax >= 100 && prop.every((q) => Math.abs(q.r - q.want) <= 0.05 * q.want + 3 / hmax),
    fin.map((b, i) => `${rows[i][0]} ${b.h}px (${L.round(prop[i].r, 3)} vs ${L.round(prop[i].want, 3)})`).join('; '));

  const corners = f5 ? [[5, 5], [1895, 5], [5, 1055], [1895, 1055]].map(([x, y]) => L.deltaE(L.lab(...L.avgRGB(f5, [x, y, x + 20, y + 20])), L.lab(255, 255, 255))) : [];
  g.check('bars left to right in CSV order; background corners white (delta E < 3)', fin.every((b, i) => b.h > 0 && (!i || b.cx > fin[i - 1].cx)) && corners.length === 4 && corners.every((d) => d < 3),
    `x ${fin.map((b) => (b.cx ? Math.round(b.cx) : '-')).join(', ')}; corner dE ${corners.map((d) => L.round(d, 1)).join('/')}`);

  await g.checkAsync('growth animated and staggered: < 10 % at 0.1 s; first bar leads the last by >= 50 % at some time in 0.5-3 s; hold 4.5 s ~ 5.8 s (SSIM >= 0.98)', async () => {
    if (!f5 || !(hmax > 0)) return { pass: false, detail: 'no final bars' };
    const rel = async (t) => { const f = await at(t); return f ? rows.map((r, i) => (fin[i].h ? bar(f, r[2]).h / fin[i].h : 0)) : null; };
    const r01 = await rel(0.1);
    const ts = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3];
    const lead = await Promise.all(ts.map(async (t) => { const r = await rel(t); return r ? r[0] - r[r.length - 1] : -1; }));
    const [a, b] = await Promise.all([4.5, 5.8].map((t) => (ok1080 ? L.frameAt(out, t, { width: 480, height: 270 }) : null)));
    const hold = L.ssim(a, b);
    const ok = r01 && r01.every((v) => v < 0.1) && Math.max(...lead) >= 0.5 && hold >= 0.98;
    return { pass: ok, detail: `0.1 s ${r01?.map((v) => L.round(v, 2)).join('/')}; best lead ${L.round(Math.max(...lead), 2)} at ${ts[lead.indexOf(Math.max(...lead))]} s; hold SSIM ${L.round(hold, 3)}` };
  });

  const glyph = (() => {
    if (!f5 || fin.some((b) => !b.h)) return null;
    const base = fin.map((b) => b.bottom).sort((x, y) => x - y)[2];
    const white = L.lab(255, 255, 255); // any ink counts (labels may be dark or in the bar colour)
    return fin.map((b) => {
      const w = b.x1 - b.x0, region = [Math.max(0, Math.round(b.x0 - w / 4)), base + 6, Math.min(1920, Math.round(b.x1 + w / 4)), Math.min(1080, base + 170)];
      let n = 0, tot = 0;
      for (let y = region[1]; y < region[3]; y++) for (let x = region[0]; x < region[2]; x++) {
        const i = 3 * (y * 1920 + x), c = L.lab(f5.data[i], f5.data[i + 1], f5.data[i + 2]);
        if (L.deltaE(c, white) > 30) n++;
        tot++;
      }
      return { n, frac: tot ? n / tot : 0 };
    });
  })();
  g.check('glyph pixels below the baseline under each bar at 5 s', glyph && glyph.every((q) => q.n >= 40 && q.frac <= 0.6), glyph ? glyph.map((q) => `${q.n}px`).join(', ') : 'no bars');
  return g.result();
}
