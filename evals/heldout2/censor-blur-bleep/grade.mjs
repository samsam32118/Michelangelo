import { join } from 'node:path';
import {
  grader, assertNotEmpty, frameAt, round, mediaFacts, regionSsim, namedProject, inputsUnchanged, pearson, lumaStats, pcm, bestLag, corrGain, goertzelDb,
} from '../_lib/h.mjs';

const R = [130, 830, 380, 140];

/** Fine detail (luma minus a 9x9 box blur) of a box, as a flat array. */
function highpass(img, [x0, y0, w, h]) {
  const L = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = ((y0 + y) * img.width + x0 + x) * 4; L[y * w + x] = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]; }
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) I[(y + 1) * (w + 1) + x + 1] = L[y * w + x] + I[y * (w + 1) + x + 1] + I[(y + 1) * (w + 1) + x] - I[y * (w + 1) + x];
  const out = [], r = 4;
  for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) {
    const s = I[(y + r + 1) * (w + 1) + x + r + 1] - I[(y - r) * (w + 1) + x + r + 1] - I[(y + r + 1) * (w + 1) + x - r] + I[(y - r) * (w + 1) + x - r];
    out.push(L[y * w + x] - s / 81);
  }
  return out;
}
const SR = 8000;

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/censored.mp4'), src = join(dir, 'street.mp4');
  const facts = await mediaFacts(out, { w: 1920, h: 1080, dur: 8, durTol: 0.15, audio: true });
  const ne = facts.ok ? await assertNotEmpty(out, { audio: true }) : { pass: false, detail: '' };
  g.check('out/censored.mp4: 1920x1080 with audio, 8 s, not empty', facts.ok && ne.pass, `${facts.detail}; ${ne.detail}`);

  await g.checkAsync('name tag obscured for the whole clip (blurred, not blacked out)', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const notes = []; let pass = true;
    for (const t of [0.2, 4, 7.8]) {
      const [o, s] = await Promise.all([frameAt(out, t), frameAt(src, t)]);
      if (!o || !s) { pass = false; notes.push(`${t}s no frame`); continue; }
      const ho = highpass(o, R), hs = highpass(s, R);
      const rms = (a) => Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length);
      const c = pearson(ho, hs), ratio = rms(ho) / rms(hs);
      const lo = lumaStats(o, R).mean, ls = lumaStats(s, R).mean;
      // readable text keeps the source's fine detail: obscured = detail gone, or no longer correlated with the text strokes
      if (!((c < 0.35 || ratio < 0.2) && Math.abs(lo - ls) <= 0.2)) pass = false;
      notes.push(`${t}s detail corr ${round(c, 3)}, detail ratio ${round(ratio, 3)}, luma ${round(lo, 2)} vs ${round(ls, 2)}`);
    }
    return { pass, detail: notes.join('; ') };
  });

  await g.checkAsync('picture outside the tag unchanged', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const vals = [];
    for (const t of [1, 4, 7]) {
      const [o, s] = await Promise.all([frameAt(out, t), frameAt(src, t)]);
      if (!o || !s) { vals.push(0); continue; }
      vals.push(Math.min(await regionSsim(o, [0, 0, 1920, 740], s, [0, 0, 1920, 740], 960), await regionSsim(o, [640, 740, 1280, 340], s, [640, 740, 1280, 340], 640)));
    }
    return { pass: vals.every((v) => v >= 0.9), detail: `SSIM ${vals.map((v) => round(v, 3)).join('/')}` };
  });

  let audio = null;
  if (facts.ok) {
    const [o, s] = await Promise.all([pcm(out, { rate: SR }), pcm(src, { rate: SR })]);
    const b = bestLag(o, s, 800, { from: Math.round(0.5 * SR), len: Math.round(2.4 * SR) });
    audio = { o, s, lag: b.lag };
  }
  await g.checkAsync('3.25-3.75 s: 1 kHz bleep, original word gone', async () => {
    if (!audio) return { pass: false, detail: 'no output' };
    const s0 = Math.round(3.25 * SR), s1 = Math.round(3.75 * SR);
    const cg = corrGain(audio.o, audio.s, audio.lag, s0, s1);
    const tone = goertzelDb(audio.o.subarray(s0 + audio.lag, s1 + audio.lag), 1000, SR);
    return { pass: tone >= -35 && Math.abs(cg.alpha) < 0.25, detail: `1 kHz ${round(tone, 1)} dB, speech gain ${round(cg.alpha, 3)}` };
  });
  await g.checkAsync('speech unchanged elsewhere, no tone', async () => {
    if (!audio) return { pass: false, detail: 'no output' };
    const notes = []; let pass = true;
    for (const [a, b] of [[0.4, 3.0], [4.0, 7.5]]) {
      const cg = corrGain(audio.o, audio.s, audio.lag, Math.round(a * SR), Math.round(b * SR));
      const tone = goertzelDb(audio.o.subarray(Math.round(a * SR), Math.round(b * SR)), 1000, SR);
      if (!(cg.corr >= 0.9 && cg.alpha >= 0.7 && cg.alpha <= 1.4 && tone < -45)) pass = false;
      notes.push(`${a}-${b}s corr ${round(cg.corr, 3)} gain ${round(cg.alpha, 2)} 1kHz ${round(tone, 1)} dB`);
    }
    return { pass, detail: notes.join('; ') };
  });

  const pr = namedProject(dir, 'censored.mgl.json', { inputs: ['street.mp4'], size: [1920, 1080] });
  const inp = await inputsUnchanged(dir, ['street.mp4']);
  g.check('censored.mgl.json valid, 1920x1080, uses street.mp4; input unchanged', pr.ok && inp.ok, `${pr.detail}; ${inp.detail}`);
  return g.result();
}
