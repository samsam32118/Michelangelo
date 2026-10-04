import { join } from 'node:path';
import { grader, probe, frameAt, mask, ssim, round, assertNotEmpty, findProjectUsing, textClips, toFrames, compRate, compOfClip } from '../../lib/index.mjs';

const CORNERS = { tl: [0, 0, 0.3, 0.3], tr: [0.7, 0, 0.3, 0.3], bl: [0, 0.7, 0.3, 0.3], br: [0.7, 0.7, 0.3, 0.3] };
const red = (r, g, b) => r > 170 && g < 80 && b < 80;
function redCorner(img) {
  const share = Object.fromEntries(Object.entries(CORNERS).map(([k, b]) => {
    const [x, y, w, h] = [b[0] * img.width, b[1] * img.height, b[2] * img.width, b[3] * img.height].map(Math.round);
    const m = mask(img, red, [x, y, w, h]);
    let n = 0; for (const v of m) n += v;
    return [k, n / (w * h)];
  }));
  return { best: Object.entries(share).sort((a, b) => b[1] - a[1])[0][0], share };
}

export async function grade(dir) {
  const g = grader();
  const out = join(dir, 'out/day1.mp4');
  const golden = join(dir, '.golden/src_2s.png');
  const p = await probe(out, { countFrames: true });
  await g.checkAsync('out/day1.mp4 H.264 1080x1920, 6 s +-1 frame, not empty', async () => {
    if (!p) return { pass: false, detail: 'out/day1.mp4 missing' };
    const ne = await assertNotEmpty(out);
    const frames = p.frames ?? Math.round(p.duration * 30);
    const ok = p.video?.codec === 'h264' && p.displayWidth === 1080 && p.displayHeight === 1920 && Math.abs(frames / (p.fps || 30) - 6) <= 1 / 30 + 0.01 && ne.pass;
    return { pass: ok, detail: `${p.video?.codec} ${p.displayWidth}x${p.displayHeight} ${frames} frames @${round(p.fps, 3)}; ${ne.detail}` };
  });
  await g.checkAsync('rotation honoured: the red marker is in the same corner as in the displayed source', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const [img, ref] = await Promise.all([frameAt(out, 0.5, { width: 270, height: 480 }), frameAt(golden, 0, { width: 270, height: 480 })]);
    if (!img || !ref) return { pass: false, detail: 'no frame' };
    const a = redCorner(img), b = redCorner(ref);
    return { pass: a.best === b.best && a.share[a.best] > 0.3, detail: `output ${a.best} (${round(a.share[a.best], 2)}), source ${b.best}` };
  });
  await g.checkAsync('first frame matches the source at 2 s (SSIM > 0.7 at 540x960)', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const s = await ssim(out, golden, { ta: 0, width: 540, height: 960 });
    return { pass: s > 0.7, detail: `SSIM ${round(s, 3)}` };
  });
  // made with the library: the edit is in a valid project that uses the task's inputs (not only in an ffmpeg output)
  const proj = findProjectUsing(dir, { inputs: ['phone.mov'], size: [1080, 1920], pred: (pp) => {
    const srcOf = new Map((pp.assets ?? []).map((a) => [a.id, String(a.src ?? '')]));
    const ph = (pp.clips ?? []).find((c) => srcOf.get(c.asset)?.endsWith('phone.mov'));
    if (!ph) return 'no clip of phone.mov';
    const rate = compRate(compOfClip(pp, ph));
    const inS = toFrames(ph.in ?? 0, rate) / rate;
    if (Math.abs(inS - 2) > 2 / 30 + 1e-6) return `phone clip starts at source ${round(inS, 2)} s`;
    return textClips(pp).some((c) => /day\s*1/i.test(c.text)) || 'no "Day 1" text clip';
  } });
  g.check('a 1080x1920 project plays phone.mov from 2 s with a "Day 1" text clip', !!proj.p, proj.p ? proj.f : proj.why);
  return g.result();
}
