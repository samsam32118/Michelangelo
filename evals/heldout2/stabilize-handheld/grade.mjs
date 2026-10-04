import { join } from 'node:path';
import { grader, assertNotEmpty, round, mediaFacts, namedProject, inputsUnchanged, allFrames, centroid } from '../_lib/h.mjs';
import { MARKERS } from './setup.mjs';

const S = 4; // analysis at 480x270
const isMag = (r, g, b) => r > 190 && b > 190 && g < 90;
const isCyan = (r, g, b) => g > 190 && b > 190 && r < 90;
const isBall = (r, g, b) => r > 200 && g > 170 && b < 90;

async function track(file) {
  const fr = await allFrames(file, { width: 480, height: 270 });
  return fr.map((f) => {
    const m = centroid(f, isMag), c = centroid(f, isCyan), b = centroid(f, isBall);
    let black = 0, n = 0;
    for (let y = 0; y < 270; y++) for (let x = 0; x < 480; x++) {
      if (x >= 15 && x < 465 && y >= 8 && y < 262) continue;
      const i = (y * 480 + x) * 4; n++;
      if (f.data[i] < 20 && f.data[i + 1] < 20 && f.data[i + 2] < 20) black++;
    }
    const pt = (r) => (r.count >= 20 ? r.centroid.map((v) => v * S) : null);
    return { m: pt(m), c: pt(c), b: b.count >= 15 ? b.centroid.map((v) => v * S) : null, black: black / n };
  });
}
const jitter = (tr) => {
  const d = [];
  for (let i = 1; i < tr.length; i++) if (tr[i].m && tr[i - 1].m) d.push(Math.hypot(tr[i].m[0] - tr[i - 1].m[0], tr[i].m[1] - tr[i - 1].m[1]));
  return d.length ? d.reduce((a, b) => a + b, 0) / d.length : NaN;
};

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/stable.mp4');
  const facts = await mediaFacts(out, { w: 1920, h: 1080, dur: 8, durTol: 0.15 });
  const ne = facts.ok ? await assertNotEmpty(out, { staticThresh: 0.2 }) : { pass: false, detail: '' };
  g.check('out/stable.mp4: 1920x1080, 8 s, not empty', facts.ok && ne.pass, `${facts.detail}; ${ne.detail}`);
  const tr = facts.ok ? await track(out) : [];
  const src = facts.ok ? await track(join(dir, 'handheld.mp4')) : [];
  const vis = tr.length ? tr.filter((f) => f.m && f.c).length / tr.length : 0;
  g.check('both markers visible in >= 95% of frames', tr.length > 200 && vis >= 0.95, `${tr.length} frames, visible ${round(vis * 100, 1)}%`);
  const jo = jitter(tr), js = jitter(src);
  g.check('shake removed (marker movement <= 35% of the source)', tr.length > 200 && jo <= 0.35 * js, `mean frame-to-frame movement ${round(jo, 2)} px vs source ${round(js, 2)} px`);
  const bx = (a, b) => { const xs = tr.slice(a, b).filter((f) => f.b).map((f) => f.b[0]); return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : NaN; };
  const travel = tr.length > 30 ? bx(tr.length - 15, tr.length) - bx(0, 15) : NaN;
  g.check('the ball still travels >= 800 px', travel >= 800, `ball travel ${round(travel, 0)} px`);
  const world = Math.hypot(MARKERS.cyan[0] - MARKERS.magenta[0], MARKERS.cyan[1] - MARKERS.magenta[1]);
  const sp = tr.filter((f) => f.m && f.c).map((f) => Math.hypot(f.c[0] - f.m[0], f.c[1] - f.m[1]) / world).sort((a, b) => a - b);
  const zoom = sp.length ? sp[sp.length >> 1] : NaN;
  const blackFrames = tr.filter((f) => f.black > 0.01).length;
  g.check('zoom 0.95-1.3x and no black edges', zoom >= 0.95 && zoom <= 1.3 && tr.length > 0 && blackFrames === 0, `zoom ${round(zoom, 3)}x, frames with black edges ${blackFrames}`);
  const pr = namedProject(dir, 'stable.mgl.json', { inputs: ['handheld.mp4'], size: [1920, 1080] });
  const inp = await inputsUnchanged(dir, ['handheld.mp4']);
  g.check('input unchanged', inp.ok, inp.detail);
  g.check('[lib] stable.mgl.json valid, 1920x1080, uses handheld.mp4', pr.ok, pr.detail);
  return g.result();
}
