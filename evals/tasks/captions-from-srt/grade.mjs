import { join } from 'node:path';
import { grader, assertNotEmpty, probe, frameAt, readSetup, readProject, validateRaw, projectCues, normText, sha256, round, clipsById } from '../../lib/index.mjs';

/** Pixels that changed against the plain video (> 80 in a channel): the captions. Returns per-region fractions and colours. */
function captionPixels(img, ref) {
  const W = img.width, H = img.height, third = Math.floor(H * 2 / 3);
  let bottom = 0, top = 0, white = 0, black = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, d = img.data, r = ref.data;
    if (Math.max(Math.abs(d[i] - r[i]), Math.abs(d[i + 1] - r[i + 1]), Math.abs(d[i + 2] - r[i + 2])) <= 80) continue;
    if (y >= third) bottom++; else top++;
    if (d[i] >= 200 && d[i + 1] >= 200 && d[i + 2] >= 200) white++;
    if (d[i] <= 60 && d[i + 1] <= 60 && d[i + 2] <= 60) black++;
  }
  const n = bottom + top;
  return { bottom: bottom / (W * (H - third)), share: n ? bottom / n : 0, white: n ? white / n : 0, black: n ? black / n : 0 };
}

export async function grade(dir) {
  const g = grader();
  const { info, hashes } = readSetup(dir);
  const p = readProject(join(dir, 'talk.mgl.json'));
  const srt = info.cues;
  g.check('[lib] project has 12 cues; each cue start/end within 1 frame of the SRT; texts unchanged', (() => {
    if (!p) return false;
    const cues = projectCues(p);
    const tol = 1 / 30 + 0.002;
    const bad = srt.map((c, i) => [c, cues[i]]).filter(([c, q]) => !q || Math.abs(q.start - c.start) > tol || Math.abs(q.end - c.end) > tol || normText(q.text) !== normText(c.text));
    return cues.length === 12 && !bad.length && !validateRaw(p).length;
  })(), p ? `${projectCues(p).length} cues; ${validateRaw(p)[0] ?? 'valid'}` : 'talk.mgl.json missing or not JSON');

  const out = join(dir, 'out/draft.mp4');
  const info0 = await probe(out);
  const W = 960, H = 540;
  const mids = [srt[1], srt[6], srt[10]].map((c) => (c.start + c.end) / 2);
  const measure = async (t) => {
    const [img, ref] = await Promise.all([frameAt(out, t, { width: W, height: H }), frameAt(join(dir, 'media/talk.mp4'), t, { width: W, height: H })]);
    return img && ref ? captionPixels(img, ref) : null;
  };
  const at = info0 ? await Promise.all(mids.map(measure)) : [];
  const gap = info0 ? await measure(info.gap) : null;
  g.check('caption text box in the bottom third, white with a black outline', at.length === 3 && at.every((m) => m && m.share >= 0.8 && m.white >= 0.1 && m.black >= 0.05),
  at.map((m) => (m ? `bottom share ${round(m.share, 2)} white ${round(m.white, 2)} black ${round(m.black, 2)}` : 'no frame')).join('; ') || 'no draft');
  await g.checkAsync('out/draft.mp4 30 s +-0.2, glyph pixels in the bottom third at 3 cue midpoints and none at the gap; not empty; talk.mp4 unchanged', async () => {
    if (!info0) return { pass: false, detail: 'out/draft.mp4 missing' };
    const ne = await assertNotEmpty(out);
    const unchanged = sha256(join(dir, 'media/talk.mp4')) === hashes['media/talk.mp4'];
    const ok = Math.abs(info0.duration - 30) <= 0.2 && at.every((m) => m && m.bottom > 0.003) && gap && gap.bottom < 0.0008 && ne.pass && unchanged;
    return { pass: ok, detail: `${round(info0.duration)} s; bottom-third glyphs ${at.map((m) => round(m?.bottom ?? 0, 4)).join('/')}; gap ${round(gap?.bottom ?? 1, 4)}; ${ne.detail}${unchanged ? '' : '; talk.mp4 modified'}` };
  });
  void clipsById;
  return g.result();
}
