import { join } from 'node:path';
import {
  grader, assertNotEmpty, frameAt, resize, round, mediaFacts, regionSsim, saturation, namedProject, inputsUnchanged,
  envelopeMatch, toneLevels, textClips,
} from '../_lib/h.mjs';

const T = [2, 4, 6];
/** The source as it would appear in a 960x1080 half: cover (centre crop), stretched, or letterboxed. */
function half(src, mode) {
  if (mode === 'cover') {
    const out = new Uint8Array(960 * 1080 * 4);
    for (let y = 0; y < 1080; y++) out.set(src.data.subarray((y * 1920 + 480) * 4, (y * 1920 + 1440) * 4), y * 960 * 4);
    return { width: 960, height: 1080, data: out };
  }
  if (mode === 'stretch') return resize(src, 960, 1080);
  const small = resize(src, 960, 540), out = new Uint8Array(960 * 1080 * 4);
  out.set(small.data, 270 * 960 * 4);
  return { width: 960, height: 1080, data: out };
}

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/split.mp4'), before = join(dir, 'before.mp4'), after = join(dir, 'after.mp4');
  const facts = await mediaFacts(out, { w: 1920, h: 1080, dur: 8, durTol: 0.25, audio: true });
  const ne = facts.ok ? await assertNotEmpty(out, { audio: true }) : { pass: false, detail: '' };
  g.check('out/split.mp4: 1920x1080 with audio, 8 s, not empty', facts.ok && ne.pass, `${facts.detail}; ${ne.detail}`);

  const frames = facts.ok ? await Promise.all(T.map(async (t) => ({ t, o: await frameAt(out, t), b: await frameAt(before, t), a: await frameAt(after, t) }))) : [];
  const ok = frames.length === 3 && frames.every((f) => f.o && f.b && f.a);
  const sideCheck = async (side) => {
    if (!ok) return { pass: false, detail: 'no frames' };
    const notes = [];
    let pass = true;
    for (const f of frames) {
      const src = side === 'left' ? f.b : f.a;
      const oBox = side === 'left' ? [0, 260, 930, 820] : [990, 260, 930, 820];
      const hBox = side === 'left' ? [0, 260, 930, 820] : [30, 260, 930, 820];
      const s = {};
      for (const m of ['cover', 'stretch', 'letterbox']) s[m] = await regionSsim(f.o, oBox, half(src, m), hBox, 480);
      const sat = saturation(f.o, oBox);
      const good = s.cover >= 0.7 && s.cover > Math.max(s.stretch, s.letterbox) + 0.05 && (side === 'left' ? sat < 18 : sat > 60);
      if (!good) pass = false;
      notes.push(`${f.t}s cover ${round(s.cover, 2)} stretch ${round(s.stretch, 2)} lbox ${round(s.letterbox, 2)} sat ${round(sat, 0)}`);
    }
    return { pass, detail: notes.join('; ') };
  };
  await g.checkAsync('left half = centre crop of before.mp4 (grey)', () => sideCheck('left'));
  await g.checkAsync('right half = centre crop of after.mp4 (saturated)', () => sideCheck('right'));

  g.check('white divider 3-14 px wide around x = 960', ok && frames.every((f) => {
    const cols = [];
    for (let x = 930; x < 990; x++) {
      let w = 0, n = 0;
      for (let y = 300; y < 1060; y += 8) { const i = (y * 1920 + x) * 4; n++; if (Math.min(f.o.data[i], f.o.data[i + 1], f.o.data[i + 2]) > 205) w++; }
      if (w / n >= 0.9) cols.push(x);
    }
    f.cols = cols;
    return cols.length >= 3 && cols.length <= 14 && cols[0] >= 940 && cols[cols.length - 1] <= 980 && cols[cols.length - 1] - cols[0] < 16;
  }), ok ? frames.map((f) => `${f.t}s white cols ${f.cols?.length ? `${f.cols[0]}-${f.cols[f.cols.length - 1]} (${f.cols.length})` : 'none'}`).join('; ') : 'no frames');

  // labels: in the top band of each half, some (not most) pixels differ from what the source alone would show
  const labelShare = (f, side) => {
    const src = half(side === 'left' ? f.b : f.a, 'cover');
    const x0 = side === 'left' ? 40 : 1000, hx0 = side === 'left' ? 40 : 40;
    let n = 0, d = 0;
    for (let y = 10; y < 260; y += 2) for (let x = 0; x < 880; x += 2) {
      const i = (y * 1920 + x0 + x) * 4, j = (y * 960 + hx0 + x) * 4; n++;
      if (Math.max(Math.abs(f.o.data[i] - src.data[j]), Math.abs(f.o.data[i + 1] - src.data[j + 1]), Math.abs(f.o.data[i + 2] - src.data[j + 2])) > 60) d++;
    }
    return d / n;
  };
  const projR = namedProject(dir, 'split.mgl.json', { inputs: ['before.mp4', 'after.mp4'], size: [1920, 1080] });
  const texts = projR.p ? textClips(projR.p).map((c) => c.text.trim().toUpperCase()) : [];
  const shares = ok ? frames.map((f) => [labelShare(f, 'left'), labelShare(f, 'right')]) : [];
  g.check('labels drawn in the top band of both halves; BEFORE and AFTER text clips', ok && shares.every((s) => s.every((v) => v > 0.004 && v < 0.6)) && texts.includes('BEFORE') && texts.includes('AFTER'),
    `label pixel shares ${shares.map((s) => s.map((v) => round(v, 3)).join('/')).join(', ')}; text clips: ${texts.join(', ') || 'none'}`);

  await g.checkAsync("audio is after.mp4's speech only", async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const corr = await envelopeMatch(out, after);
    const [lo, lb] = await Promise.all([toneLevels(out, [440]), toneLevels(before, [440])]);
    return { pass: corr >= 0.8 && lo[440] <= lb[440] - 20, detail: `envelope corr ${round(corr, 3)}, 440 Hz ${round(lo[440], 1)} dB (before.mp4 ${round(lb[440], 1)} dB)` };
  });
  const inp = await inputsUnchanged(dir, ['before.mp4', 'after.mp4']);
  g.check('split.mgl.json valid, 1920x1080, uses both clips; inputs unchanged', projR.ok && inp.ok, `${projR.detail}; ${inp.detail}`);
  return g.result();
}
