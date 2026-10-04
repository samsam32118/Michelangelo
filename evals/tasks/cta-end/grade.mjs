import { join } from 'node:path';
import { grader, readProject, validateRaw, textClipsMatching, groupOf, motionOf, outputs, probe, frameAt, mask, maskStats, round, assertNotEmpty } from '../../lib/index.mjs';

const BOUNCY = /back|bounce|elastic/i;

export async function grade(dir) {
  const g = grader();
  const p = readProject(join(dir, 'vlog.mgl.json'));
  const ctas = p ? textClipsMatching(p, /subscribe/i).filter(({ spans }) => spans.some((s) => Math.abs(s.start - 12) <= 0.04 && Math.abs(s.end - 15) <= 0.04)) : [];
  g.check('[lib] a CTA clip ("Subscribe") spans 12-15 s; project valid', ctas.length > 0 && !validateRaw(p).length,
    p ? `${textClipsMatching(p, /subscribe/i).map(({ clip, spans }) => `"${clip.text}" ${spans.map((s) => `${round(s.start, 2)}-${round(s.end, 2)}`).join(',')}`).join('; ') || 'no Subscribe clip'}; ${validateRaw(p)[0] ?? 'valid'}` : 'vlog.mgl.json missing');

  const draft = outputs(dir, /\.mp4$/).find((f) => !f.startsWith('media/'));
  const file = draft && join(dir, draft);
  const info = file && (await probe(file));
  await g.checkAsync('its rendered box at 13.5 s is inside the Shorts safe zone', async () => {
    if (!info) return { pass: false, detail: 'no rendered mp4' };
    const W = info.displayWidth, H = info.displayHeight;
    const [img, ref] = await Promise.all([frameAt(file, 13.5), frameAt(join(dir, 'media/vlog.mp4'), 13.5, { width: W, height: H })]);
    if (!img || !ref) return { pass: false, detail: 'no frame' };
    const m = mask(img, (r, gg, b, x, y) => { const i = (y * W + x) * 4; return Math.max(Math.abs(r - ref.data[i]), Math.abs(gg - ref.data[i + 1]), Math.abs(b - ref.data[i + 2])) > 70; });
    const s = maskStats(m, W, H, { minPerLine: Math.max(3, Math.round(W / 200)) });
    const safe = [W * 0.05, H * 0.08, W * 0.83, H * 0.72];
    const b = s.bbox;
    const inside = b && b[0] >= safe[0] - 2 && b[1] >= safe[1] - 2 && b[0] + b[2] <= safe[0] + safe[2] + 2 && b[1] + b[3] <= safe[1] + safe[3] + 2;
    return { pass: s.fraction > 0.003 && !!inside, detail: `CTA px ${round(s.fraction, 4)} of frame, box ${b?.join(',')}, safe ${safe.map(Math.round).join(',')} (${W}x${H})` };
  });
  g.check('[lib] scale or animate keyframes with a back/bounce/elastic easing, or a pop/bounce preset', ctas.some(({ clip }) => groupOf(p, clip).some((c) => { const m = motionOf(c); return m.easings.some((e) => BOUNCY.test(String(e))) || m.presets.some((x) => /pop|bounce|drop|elastic|back/i.test(x)); })),
    ctas.map(({ clip }) => JSON.stringify(motionOf(clip))).join('; ') || 'no CTA');
  // the CTA's timing from the output: overlay pixels (vs the plain vlog) only in the last 3 seconds
  await g.checkAsync('draft: an overlay (the CTA) is present at 12.4 s and 14.8 s and absent at 6 s and 11.6 s', async () => {
    if (!info) return { pass: false, detail: 'no rendered mp4' };
    const W = 270, H = 480;
    const frac = async (t) => {
      const [img, ref] = await Promise.all([frameAt(file, Math.min(t, info.duration - 0.05), { width: W, height: H }), frameAt(join(dir, 'media/vlog.mp4'), t, { width: W, height: H })]);
      if (!img || !ref) return 0;
      const m = mask(img, (r, gg, b, x, y) => { const i = (y * W + x) * 4; return Math.max(Math.abs(r - ref.data[i]), Math.abs(gg - ref.data[i + 1]), Math.abs(b - ref.data[i + 2])) > 70; });
      return maskStats(m, W, H, { minPerLine: 2 }).fraction;
    };
    const [a, b, c, d] = await Promise.all([6, 11.6, 12.4, 14.8].map(frac));
    return { pass: a < 0.001 && b < 0.001 && c > 0.003 && d > 0.003, detail: `overlay share at 6 s ${round(a, 4)}, 11.6 s ${round(b, 4)}, 12.4 s ${round(c, 4)}, 14.8 s ${round(d, 4)}` };
  });
  await g.checkAsync('draft mp4 rendered, 15 s', async () => {
    if (!info) return { pass: false, detail: 'no rendered mp4' };
    const ne = await assertNotEmpty(file);
    return { pass: Math.abs(info.duration - 15) <= 0.2 && ne.pass, detail: `${draft}: ${round(info.duration, 2)} s; ${ne.detail}` };
  });
  return g.result();
}
