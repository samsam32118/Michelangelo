import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { grader, readProject, validateRaw, textClipsMatching, groupOf, isAnimated, frameAt, diffFraction, round, assertNotEmpty } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const p = readProject(join(dir, 'talk.mgl.json'));
  const found = p ? textClipsMatching(p, /Ada Park/i) : [];
  const inSpan = found.filter(({ spans }) => spans.length && spans.every((s) => s.start >= 2 - 0.034 && s.start <= 2.6 && s.end >= 6.4 && s.end <= 7 + 0.034));
  g.check('a template-derived or hand-built text clip with the name spans 2-7 s (project valid)', inSpan.length > 0 && found.length === inSpan.length && !validateRaw(p).length && /neuroscientist/i.test((p.clips ?? []).filter((c) => typeof c.text === 'string').map((c) => c.text).join(' ')),
    p ? `${found.map(({ clip, spans }) => `"${clip.text}" ${spans.map((s) => `${round(s.start, 2)}-${round(s.end, 2)}`).join(',')}`).join('; ') || 'no clip with the name'}; ${validateRaw(p)[0] ?? 'valid'}` : 'talk.mgl.json missing');
  await g.checkAsync('out/l3.png has text pixels in the lower-left third; out/before.png matches the plain video there', async () => {
    const l3 = join(dir, 'out/l3.png'), before = join(dir, 'out/before.png');
    if (!existsSync(l3) || !existsSync(before)) return { pass: false, detail: 'out/l3.png or out/before.png missing' };
    const W = 960, H = 540, region = [0, H * 2 / 3, W / 3, H / 3];
    const [a, b, ra, rb] = await Promise.all([frameAt(l3, 0, { width: W, height: H }), frameAt(before, 0, { width: W, height: H }), frameAt(join(dir, 'media/talk.mp4'), 4, { width: W, height: H }), frameAt(join(dir, 'media/talk.mp4'), 1, { width: W, height: H })]);
    if (!a || !b) return { pass: false, detail: 'unreadable PNG' };
    const da = diffFraction(a, ra, { box: region }), db = diffFraction(b, rb, { box: region });
    const ne = await assertNotEmpty(l3, { still: true });
    return { pass: da > 0.01 && db < 0.005 && ne.pass, detail: `changed in lower-left third: l3 ${round(da, 4)}, before ${round(db, 4)}` };
  });
  g.check('animated: opacity/position keyframes or an animate preset on the clip (or its template group)', inSpan.some(({ clip }) => groupOf(p, clip).some(isAnimated)),
    inSpan.map(({ clip }) => JSON.stringify({ animate: clip.animate, opacity: clip.opacity, x: clip.x })).join('; ') || 'no clip');
  return g.result();
}
