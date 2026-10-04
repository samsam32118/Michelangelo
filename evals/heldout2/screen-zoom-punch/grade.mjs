import { join } from 'node:path';
import {
  grader, assertNotEmpty, frameAt, round, mediaFacts, regionSsim, namedProject, inputsUnchanged, envelopeMatch, shrink, crop, mad, isKeyframes, clipsUsing,
} from '../_lib/h.mjs';

const W = 240, H = 135;
/** The source frame (half-res image) as it looks zoomed by s with the view centre a fraction u of the way to (1440, 270). */
function view(half, s, u) {
  const cx = (960 + 480 * u) / 2, cy = (540 - 270 * u) / 2, w = 960 / s, h = 540 / s;
  const x0 = Math.max(0, Math.min(960 - w, cx - w / 2)), y0 = Math.max(0, Math.min(540 - h, cy - h / 2));
  return shrink(crop(half, [Math.round(x0), Math.round(y0), Math.round(w), Math.round(h)]), W, H);
}
const GRID = [];
for (let s = 1; s <= 2.001; s += 0.1) for (const u of [0, 0.25, 0.5, 0.75, 1]) GRID.push([round(s, 1), u]);

/** Best (s, u) for the output frame at t: {s, u, err, full, zoom} (errors = mean abs grey difference). */
async function bestView(out, src, t) {
  const [o, sf] = await Promise.all([frameAt(out, t, { width: 960, height: 540 }), frameAt(src, t, { width: 960, height: 540 })]);
  if (!o || !sf) return null;
  const os = shrink(o, W, H);
  let best = null;
  for (const [s, u] of GRID) { const e = mad(os, view(sf, s, u)); if (!best || e < best.err) best = { s, u, err: e }; }
  best.full = mad(os, view(sf, 1, 0)); best.zoom = mad(os, view(sf, 2, 1));
  return best;
}

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/zoom.mp4'), src = join(dir, 'screencast.mp4');
  const facts = await mediaFacts(out, { w: 1920, h: 1080, dur: 9, durTol: 0.15, audio: true });
  const ne = facts.ok ? await assertNotEmpty(out, { audio: true }) : { pass: false, detail: '' };
  g.check('out/zoom.mp4: 1920x1080 with audio, 9 s, not empty', facts.ok && ne.pass, `${facts.detail}; ${ne.detail}`);

  await g.checkAsync('full frame at 1.5 s and 7.5 s', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const notes = []; let pass = true;
    for (const t of [1.5, 7.5]) {
      const [o, s] = await Promise.all([frameAt(out, t), frameAt(src, t)]);
      const ss = o && s ? await regionSsim(o, [0, 0, 1920, 1080], s, [0, 0, 1920, 1080], 960) : 0;
      const b = await bestView(out, src, t);
      if (!(ss >= 0.85 && b && b.s === 1 && b.err <= 8)) pass = false;
      notes.push(`${t}s SSIM ${round(ss, 3)}, best zoom ${b?.s}x err ${round(b?.err, 1)}`);
    }
    return { pass, detail: notes.join('; ') };
  });

  await g.checkAsync('2x on the top-right quarter at 4.0 / 4.75 / 5.5 s', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const notes = []; let pass = true;
    for (const t of [4, 4.75, 5.5]) {
      const [o, s] = await Promise.all([frameAt(out, t), frameAt(src, t)]);
      const sz = o && s ? await regionSsim(o, [0, 0, 1920, 1080], s, [960, 0, 960, 540], 960) : 0;
      const sf = o && s ? await regionSsim(o, [0, 0, 1920, 1080], s, [0, 0, 1920, 1080], 960) : 0;
      const b = await bestView(out, src, t);
      if (!(sz >= 0.8 && sz >= sf + 0.04 && b && b.zoom <= 10 && b.full >= 2 * b.zoom + 5)) pass = false;
      notes.push(`${t}s SSIM quarter ${round(sz, 3)} / full ${round(sf, 3)}, err quarter ${round(b?.zoom, 1)} / full ${round(b?.full, 1)}`);
    }
    return { pass, detail: notes.join('; ') };
  });

  await g.checkAsync('smooth zoom in and out (intermediate zooms)', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const notes = []; let pass = true;
    for (const [a, name] of [[2.9, 'in'], [5.9, 'out']]) {
      const mids = [];
      for (let i = 0; i <= 10; i++) {
        const t = round(a + i * 0.1, 2), b = await bestView(out, src, t);
        if (b && b.s >= 1.1 && b.s <= 1.9 && b.err <= 12 && b.err < Math.min(b.full, b.zoom) - 2) mids.push(`${t}s:${b.s}x`);
      }
      if (mids.length < 2) pass = false;
      notes.push(`zoom ${name}: ${mids.join(' ') || 'no intermediate frames'}`);
    }
    return { pass, detail: notes.join('; ') };
  });

  await g.checkAsync('audio unchanged', async () => {
    if (!facts.ok) return { pass: false, detail: 'no output' };
    const c = await envelopeMatch(out, src);
    return { pass: c >= 0.9, detail: `envelope corr ${round(c, 3)}` };
  });
  const pr = namedProject(dir, 'zoom.mgl.json', { inputs: ['screencast.mp4'], size: [1920, 1080], pred: (p) => (p.clips ?? []).some((c) => ['scale', 'x', 'y', 'anchor'].some((k) => isKeyframes(c[k]))) || 'no clip with keyframed scale/x/y/anchor' });
  const inp = await inputsUnchanged(dir, ['screencast.mp4']);
  g.check('zoom.mgl.json valid, uses screencast.mp4, keyframed zoom; input unchanged', pr.ok && inp.ok, `${pr.detail}; ${inp.detail}`);
  return g.result();
}
