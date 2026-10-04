import { join } from 'node:path';
import {
  grader, assertNotEmpty, frameAt, round, mediaFacts, regionSsim, namedProject, inputsUnchanged, toneLevels, lumaStats, maskStats, mad, shrink, crop,
} from '../_lib/h.mjs';
import { CLIPS, LOGO } from './setup.mjs';

const NOLOGO = [0, 300, 1280, 420];

/** Mean luma (0..1) of a frame outside the top-right logo corner. */
function lumaNoLogo(img) {
  const a = lumaStats(img, [0, 0, 960, 720]).mean, b = lumaStats(img, [960, 320, 320, 400]).mean;
  return (a * 960 * 720 + b * 320 * 400) / (960 * 720 + 320 * 400);
}

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/bug.mp4');
  const facts = await mediaFacts(out, { w: 1280, h: 720, dur: 12, durTol: 0.25, audio: true });
  const ne = facts.ok ? await assertNotEmpty(out, { audio: true }) : { pass: false, detail: '' };
  g.check('out/bug.mp4: 1280x720 with audio, 12 s, not empty', facts.ok && ne.pass, `${facts.detail}; ${ne.detail}`);
  const src = facts.ok ? await Promise.all(CLIPS.map((c) => frameAt(join(dir, c.f), 2, { width: 1280, height: 720 }))) : [];
  const mids = facts.ok ? await Promise.all([2, 6, 10].map((t) => frameAt(out, t, { width: 1280, height: 720 }))) : [];

  await g.checkAsync('segments show clips 01, 02, 03 in order', async () => {
    if (!facts.ok || mids.some((m) => !m) || src.some((s) => !s)) return { pass: false, detail: 'no frames' };
    let pass = true; const notes = [];
    for (let k = 0; k < 3; k++) {
      const s = src.map((sf) => mad(shrink(crop(mids[k], NOLOGO), 320, 105), shrink(crop(sf, NOLOGO), 320, 105)));
      const others = s.filter((_, j) => j !== k);
      if (!(s[k] <= 20 && Math.min(...others) >= s[k] * 2 + 10)) pass = false;
      notes.push(`${[2, 6, 10][k]}s: MAD ${s.map((v) => round(v, 1)).join('/')}`);
    }
    return { pass, detail: notes.join('; ') };
  });

  await g.checkAsync('short dips to black at 4 s and 8 s', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const notes = []; let pass = true;
    for (const cut of [4, 8]) {
      const ts = Array.from({ length: 9 }, (_, i) => cut - 0.2 + i * 0.05);
      const ls = (await Promise.all(ts.map((t) => frameAt(out, t, { width: 320, height: 180 })))).map((f) => (f ? lumaNoLogo(f) : 1));
      const side = (await Promise.all([cut - 0.6, cut + 0.6].map((t) => frameAt(out, t, { width: 320, height: 180 })))).map((f) => (f ? lumaNoLogo(f) : 0));
      const min = Math.min(...ls);
      if (!(min < 0.05 && side.every((l) => l > 0.2))) pass = false;
      notes.push(`cut ${cut}s: min luma ${round(min, 3)}, at +-0.6 s ${side.map((l) => round(l, 2)).join('/')}`);
    }
    return { pass, detail: notes.join('; ') };
  });

  await g.checkAsync('logo disc top-right, original size, 60% opacity, whole video', async () => {
    if (!facts.ok || src.some((s) => !s)) return { pass: false, detail: 'no output' };
    const notes = []; let pass = true;
    for (const [t, k, st] of [[1, 0, 1], [6, 1, 2], [11, 2, 3]]) {
      const [o, s] = await Promise.all([frameAt(out, t, { width: 1280, height: 720 }), frameAt(join(dir, CLIPS[k].f), st, { width: 1280, height: 720 })]);
      if (!o || !s) { pass = false; notes.push(`${t}s: no frame`); continue; }
      const m = new Uint8Array(1280 * 720), alphas = [];
      for (let y = 0; y < 360; y++) for (let x = 800; x < 1280; x++) {
        const i = (y * 1280 + x) * 4;
        const d = [0, 1, 2].map((c) => o.data[i + c] - s.data[i + c]);
        if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) > 45) m[y * 1280 + x] = 1;
      }
      const st2 = maskStats(m, 1280, 720, { minPerLine: 25 });
      const bb = st2.bbox;
      if (bb) {
        const cx = bb[0] + bb[2] / 2, cy = bb[1] + bb[3] / 2;
        for (let y = Math.round(cy - 45); y < cy + 45; y += 2) for (let x = Math.round(cx - 45); x < cx + 45; x += 2) {
          const i = (y * 1280 + x) * 4;
          const Y = (d, j) => 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2];
          const den = Y(LOGO, 0) - Y(s.data, i);
          if (Math.abs(den) > 40) alphas.push((Y(o.data, i) - Y(s.data, i)) / den);
        }
      }
      alphas.sort((a, b) => a - b);
      const alpha = alphas.length ? alphas[alphas.length >> 1] : NaN;
      const good = !!bb && Math.abs(bb[2] - 180) <= 20 && Math.abs(bb[3] - 180) <= 20 && 1280 - (bb[0] + bb[2]) >= 10 && 1280 - (bb[0] + bb[2]) <= 60 && bb[1] >= 10 && bb[1] <= 60 && Math.abs(alpha - 0.6) <= 0.1;
      if (!good) pass = false;
      notes.push(`${t}s: bbox ${bb ? bb.join(',') : 'none'}, alpha ${round(alpha, 2)}`);
    }
    return { pass, detail: notes.join('; ') };
  });

  await g.checkAsync("each segment plays its own clip's tone", async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const notes = []; let pass = true;
    for (let k = 0; k < 3; k++) {
      const lv = await toneLevels(out, CLIPS.map((c) => c.hz), { start: k * 4 + 0.6, duration: 2.8 });
      const me = lv[CLIPS[k].hz], others = CLIPS.filter((_, j) => j !== k).map((c) => lv[c.hz]);
      if (!(me > -50 && me >= Math.max(...others) + 20)) pass = false;
      notes.push(`seg ${k + 1}: ${CLIPS.map((c) => round(lv[c.hz], 1)).join('/')} dB`);
    }
    return { pass, detail: notes.join('; ') };
  });

  const pr = namedProject(dir, 'bug.mgl.json', { inputs: [...CLIPS.map((c) => c.f), 'logo.png'], size: [1280, 720] });
  const inp = await inputsUnchanged(dir, [...CLIPS.map((c) => c.f), 'logo.png']);
  g.check('bug.mgl.json valid, 1280x720, uses the clips and logo.png; inputs unchanged', pr.ok && inp.ok, `${pr.detail}; ${inp.detail}`);
  return g.result();
}
