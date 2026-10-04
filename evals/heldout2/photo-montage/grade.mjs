import { join } from 'node:path';
import {
  grader, assertNotEmpty, frameAt, round, mediaFacts, namedProject, inputsUnchanged, toneLevels, meanColor, mask, components, rmsWindows,
} from '../_lib/h.mjs';
import { COLORS } from './setup.mjs';

const REGION = [200, 100, 1520, 300];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const nearest = (c) => COLORS.map((k, i) => [dist(k, c), i]).sort((a, b) => a[0] - b[0])[0][1];

/** Distance between the two marker squares (largest near-white blobs in the middle band). */
function markerDistance(img) {
  const m = mask(img, (r, g, b) => r > 200 && g > 200 && b > 200, [0, 240, 1920, 600]);
  const cs = components(m, img.width, img.height, 300).slice(0, 2);
  if (cs.length < 2) return NaN;
  return Math.hypot(cs[0].centroid[0] - cs[1].centroid[0], cs[0].centroid[1] - cs[1].centroid[1]);
}

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/montage.mp4');
  const facts = await mediaFacts(out, { w: 1920, h: 1080, dur: 20, durTol: 0.3, audio: true });
  const ne = facts.ok ? await assertNotEmpty(out, { audio: true }) : { pass: false, detail: '' };
  g.check('out/montage.mp4: 1920x1080 with audio, 20 s, not empty', facts.ok && ne.pass, `${facts.detail}; ${ne.detail}`);

  await g.checkAsync('photos 1-5 in order at 2/6/10/14/18 s', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const ids = [];
    for (const t of [2, 6, 10, 14, 18]) { const f = await frameAt(out, t); const c = f ? meanColor(f, REGION) : [0, 0, 0]; ids.push(f && dist(c, COLORS[nearest(c)]) < 40 ? nearest(c) + 1 : 0); }
    return { pass: ids.join() === '1,2,3,4,5', detail: `photos seen: ${ids.join(', ')}` };
  });

  await g.checkAsync('every photo pushes in (>= 4% between its transitions)', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const notes = []; let pass = true;
    for (let k = 0; k < 5; k++) {
      const [a, b] = await Promise.all([frameAt(out, 4 * k + 0.6), frameAt(out, 4 * k + 3.4)]);
      const da = a ? markerDistance(a) : NaN, db = b ? markerDistance(b) : NaN;
      const ratio = db / da;
      if (!(ratio >= 1.04 && da > 300)) pass = false;
      notes.push(`photo ${k + 1}: ${round(da, 0)} -> ${round(db, 0)} px (x${round(ratio, 3)})`);
    }
    return { pass, detail: notes.join('; ') };
  });

  await g.checkAsync('crossfades at 4/8/12/16 s', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const notes = []; let pass = true;
    for (let k = 1; k <= 4; k++) {
      const A = COLORS[k - 1], B = COLORS[k], AB = B.map((v, i) => v - A[i]), L2 = AB.reduce((s, v) => s + v * v, 0);
      let found = null;
      for (let i = 0; i <= 8 && !found; i++) {
        const t = 4 * k - 0.4 + i * 0.1;
        const f = await frameAt(out, t, { width: 480, height: 270 });
        if (!f) continue;
        const c = meanColor(f, [50, 25, 380, 75]);
        const u = c.reduce((s, v, j) => s + (v - A[j]) * AB[j], 0) / L2;
        const perp = dist(c, A.map((v, j) => v + u * AB[j]));
        if (u >= 0.2 && u <= 0.8 && perp < 0.25 * Math.sqrt(L2)) found = { t, u };
      }
      if (!found) pass = false;
      notes.push(`cut ${4 * k}s: ${found ? `blend ${round(found.u, 2)} at ${round(found.t, 1)}s` : 'no blended frame'}`);
    }
    return { pass, detail: notes.join('; ') };
  });

  await g.checkAsync('music under the slideshow, faded out over the last 2 s', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const lv = await toneLevels(out, [220, 277.18, 329.63], { start: 9, duration: 2 });
    const w = await rmsWindows(out, { win: 0.1 });
    const avg = (a, b) => { const s = w.slice(Math.round(a * 10), Math.round(b * 10)).map((d) => 10 ** (d / 10)); return s.length ? 10 * Math.log10(s.reduce((x, y) => x + y, 0) / s.length) : -Infinity; };
    const base = avg(15, 16), pre = avg(17, 17.8), mid = avg(19, 19.5), end = avg(facts.info.duration - 0.4, facts.info.duration);
    const tones = Object.values(lv).every((v) => v > -45);
    return { pass: tones && end <= base - 12 && mid <= base - 3 && pre >= base - 4, detail: `tones ${Object.values(lv).map((v) => round(v, 1)).join('/')} dB; RMS 15-16 s ${round(base, 1)}, 17-17.8 s ${round(pre, 1)}, 19-19.5 s ${round(mid, 1)}, last 0.4 s ${round(end, 1)} dB` };
  });

  const inputs = [1, 2, 3, 4, 5].map((k) => `photos/${k}.jpg`).concat('music.wav');
  const pr = namedProject(dir, 'montage.mgl.json', { inputs, size: [1920, 1080] });
  const inp = await inputsUnchanged(dir, inputs);
  g.check('montage.mgl.json valid, 1920x1080, uses all photos and music.wav; inputs unchanged', pr.ok && inp.ok, `${pr.detail}; ${inp.detail}`);
  return g.result();
}
