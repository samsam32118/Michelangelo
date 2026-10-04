import { join } from 'node:path';
import { grader, probe, frameAt, resize, crop, round, assertNotEmpty, findProjectUsing } from '../../lib/index.mjs';

/** Pixels that are the PiP: far from the screen, and not just a darkened screen pixel (the shadow). */
function pipMask(img, scr) {
  const W = img.width, H = img.height, m = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < W * H; p++, i += 4) {
    const o = [img.data[i], img.data[i + 1], img.data[i + 2]], s = [scr.data[i], scr.data[i + 1], scr.data[i + 2]];
    if (Math.max(...o.map((v, c) => Math.abs(v - s[c]))) <= 50) continue;
    const ratios = s.map((v, c) => (v > 25 ? o[c] / v : null)).filter((r) => r !== null);
    const shadow = o.every((v, c) => v <= s[c] + 12) && ratios.length && Math.max(...ratios) - Math.min(...ratios) < 0.2;
    if (!shadow) m[p] = 1;
  }
  return m;
}

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/pip.mp4');
  const p = await probe(out);
  let box = null, img, scr, m;
  if (p) {
    [img, scr] = await Promise.all([frameAt(out, 2, { width: 1920, height: 1080 }), frameAt(join(dir, 'screen.mp4'), 2, { width: 1920, height: 1080 })]);
    if (img && scr) {
      m = pipMask(img, scr);
      const cols = new Uint32Array(1920), rows = new Uint32Array(1080);
      for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) if (m[y * 1920 + x]) { cols[x]++; rows[y]++; }
      const span = (arr, min) => { let a = -1, b = -1; arr.forEach((v, i) => { if (v >= min) { if (a < 0) a = i; b = i; } }); return a < 0 ? null : [a, b]; };
      const cx = span(cols, Math.max(...cols) * 0.3), cy = span(rows, Math.max(...rows) * 0.3);
      if (cx && cy) box = [cx[0], cy[0], cx[1] - cx[0] + 1, cy[1] - cy[0] + 1];
    }
  }
  await g.checkAsync('at 2 s: the bottom-right region shows smptebars, the rest testsrc2', async () => {
    if (!p) return { pass: false, detail: 'out/pip.mp4 missing' };
    if (!box) return { pass: false, detail: 'no PiP found' };
    const ne = await assertNotEmpty(out);
    const inBR = box[0] > 960 && box[1] > 540 && box[0] + box[2] > 1700 && box[1] + box[3] > 900;
    const inset = [box[0] + box[2] * 0.1, box[1] + box[3] * 0.1, box[2] * 0.8, box[3] * 0.8].map(Math.round);
    const cam = await frameAt(join(dir, 'cam.mp4'), 2, { width: 1920, height: 1080 });
    const region = crop(img, inset), ref = crop(resize(cam, box[2], box[3]), [box[2] * 0.1, box[3] * 0.1, box[2] * 0.8, box[3] * 0.8].map(Math.round));
    let e = 0;
    for (let i = 0; i < Math.min(region.data.length, ref.data.length); i += 4) e += (Math.abs(region.data[i] - ref.data[i]) + Math.abs(region.data[i + 1] - ref.data[i + 1]) + Math.abs(region.data[i + 2] - ref.data[i + 2])) / 3;
    e /= Math.max(1, region.data.length / 4);
    // outside the PiP (and its shadow margin) the frame is the screen
    let diff = 0, n = 0;
    for (let y = 0; y < 1080; y += 4) for (let x = 0; x < 1920; x += 4) {
      if (x > box[0] - 80 && y > box[1] - 80) continue;
      const i = (y * 1920 + x) * 4; n++;
      if (Math.max(Math.abs(img.data[i] - scr.data[i]), Math.abs(img.data[i + 1] - scr.data[i + 1]), Math.abs(img.data[i + 2] - scr.data[i + 2])) > 40) diff++;
    }
    return { pass: inBR && e < 40 && diff / n < 0.02 && ne.pass, detail: `box ${box.join(',')}, PiP error vs smptebars ${round(e, 1)}, rest changed ${round(diff / n, 4)}` };
  });
  g.check('PiP box width 480 +-20 px', !!box && Math.abs(box[2] - 480) <= 20, box ? `width ${box[2]}` : 'no PiP');
  g.check('corners of the PiP box show the background (rounded)', !!box && (() => {
    const c = [[box[0] + 1, box[1] + 1], [box[0] + box[2] - 2, box[1] + 1], [box[0] + 1, box[1] + box[3] - 2], [box[0] + box[2] - 2, box[1] + box[3] - 2]];
    const mid = [[box[0] + box[2] / 2, box[1] + 2], [box[0] + 2, box[1] + box[3] / 2]].map(([x, y]) => m[Math.round(y) * 1920 + Math.round(x)]);
    return c.filter(([x, y]) => !m[y * 1920 + x]).length >= 3 && mid.every(Boolean);
  })(), box ? 'corner pixels checked' : 'no PiP');
  // made with the library: the edit is in a valid project that uses the task's inputs (not only in an ffmpeg output)
  const proj = findProjectUsing(dir, { inputs: ['screen.mp4', 'cam.mp4'], size: [1920, 1080], pred: (pp) => {
    const srcOf = new Map((pp.assets ?? []).map((a) => [a.id, String(a.src ?? '')]));
    const cam = (pp.clips ?? []).find((c) => srcOf.get(c.asset)?.endsWith('cam.mp4'));
    return (!!cam && ['scale', 'x', 'y', 'anchor', 'crop'].some((k) => cam[k] !== undefined)) || 'the cam clip is not scaled or placed';
  } });
  g.check('a 1920x1080 project uses screen.mp4 and cam.mp4, with the cam clip scaled and placed', !!proj.p, proj.p ? proj.f : proj.why);
  return g.result();
}
