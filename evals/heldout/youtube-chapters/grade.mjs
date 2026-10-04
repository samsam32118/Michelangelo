import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as L from '../_lib/index.mjs';
import { CHAPTERS } from './setup.mjs';

const W = 960, H = 540;

/** Text pixels on a darkened frame: residual after removing the best uniform darkening of the source. */
function glyphs(out, src, band) {
  const lo = L.luma(out), ls = L.luma(src);
  let num = 0, den = 0;
  for (let i = 0; i < lo.length; i++) { num += lo[i] * ls[i]; den += ls[i] * ls[i]; }
  const a = den ? num / den : 1;
  let n = 0, tot = 0;
  for (let y = band[1]; y < band[3]; y++) for (let x = band[0]; x < band[2]; x++) { const i = y * W + x; if (Math.abs(lo[i] - a * ls[i]) > 50) n++; tot++; }
  return n / tot;
}

export async function grade(dir) {
  const g = L.grader();
  const chapters = L.readSetup(dir).info.chapters ?? CHAPTERS;
  const pad = (n) => String(n).padStart(2, '0');
  g.check('out/chapters.txt: exactly 5 lines "MM:SS Title" matching chapters.csv in order, first 00:00', (() => {
    let lines;
    try { lines = readFileSync(join(dir, 'out/chapters.txt'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean); } catch { return false; }
    return lines.length === 5 && lines.every((l, i) => /^\d{2}:\d{2} .+$/.test(l) && l === `${pad(Math.floor(chapters[i][0] / 60))}:${pad(chapters[i][0] % 60)} ${chapters[i][1]}`);
  })(), (() => { try { return readFileSync(join(dir, 'out/chapters.txt'), 'utf8').trim().split(/\r?\n/).join(' | ').slice(0, 300); } catch { return 'missing'; } })());

  const pj = L.readProject(join(dir, 'lesson.mgl.json'));
  g.check('lesson.mgl.json: 5 markers on comp main at the chapter frames (+/- 1); project still valid with the lesson clip', (() => {
    if (!pj || L.validateRaw(pj).length) return false;
    const fps = L.compFps(L.tables(pj, 'comps').find((c) => c.id === 'main'));
    const ms = L.tables(pj, 'markers').filter((m) => m.comp === 'main').map((m) => L.toFrames(m.at, fps)).sort((a, b) => a - b);
    const want = chapters.map(([t]) => t * 30);
    const lesson = L.tables(pj, 'clips').some((c) => L.assetsNamed(pj, 'lesson.mp4').some((a) => a.id === c.asset) && !c.hidden);
    return fps === 30 && ms.length === 5 && ms.every((f, i) => Math.abs(f - want[i]) <= 1) && lesson;
  })(), pj ? (L.validateRaw(pj)[0] ?? `markers ${L.tables(pj, 'markers').map((m) => `${m.comp}@${m.at}`).join(', ')}`) : 'missing or not JSON');

  const out = join(dir, 'out/lesson.mp4'), src = join(dir, 'lesson.mp4');
  const p = await L.probe(out);
  await g.checkAsync('out/lesson.mp4: 1920x1080, 60 s +/- 0.2, not black, not static, audio not silent', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const ne = await L.notEmpty(out, { audio: true });
    return { pass: p.video?.width === 1920 && p.video.height === 1080 && Math.abs(p.duration - 60) <= 0.2 && ne.pass, detail: `${p.video?.width}x${p.video?.height} ${L.round(p.duration, 2)} s; ${ne.detail}` };
  });

  await g.checkAsync('title cards: darker with centred text at chapter + 1 s; frame matches the source at chapter + 4 s', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const res = await Promise.all(chapters.map(async ([t]) => {
      const [o1, s1, o4, s4] = await Promise.all([L.frameAt(out, t + 1.02, { width: W, height: H }), L.frameAt(src, t + 1.02, { width: W, height: H }), L.frameAt(out, t + 4.02, { width: W, height: H }), L.frameAt(src, t + 4.02, { width: W, height: H })]);
      if (!o1 || !s1 || !o4 || !s4) return { ok: false, d: `${t}s: no frame` };
      const ratio = L.meanStd(L.luma(o1)).mean / L.meanStd(L.luma(s1)).mean;
      const gl = glyphs(o1, s1, [0, Math.round(H * 0.3), W, Math.round(H * 0.7)]);
      const s = L.ssim(o4, s4);
      return { ok: ratio < 0.75 && gl >= 0.003 && s >= 0.9, d: `${t}s: luma x${L.round(ratio, 2)} glyphs ${L.round(gl, 4)} ssim+4s ${L.round(s, 3)}` };
    }));
    return { pass: res.every((r) => r.ok), detail: res.map((r) => r.d).join('; ') };
  });
  return g.result();
}
