import { join } from 'node:path';
import { grader, outputs, readProject, validateRaw, mainComp, clipsInComp, absoluteSpans, isKeyframes, toFrames, probe, frameAt, mask, dilate, components, frameDiff, crop, round, assertNotEmpty } from '../../lib/index.mjs';

function findBadge(dir) {
  for (const f of outputs(dir, /\.mgl\.json$/)) {
    const p = readProject(join(dir, f));
    if (!p || validateRaw(p).length) continue;
    const main = mainComp(p);
    for (const comp of p.comps) {
      if (comp.id === main.id) continue;
      const uses = clipsInComp(p, main.id).filter((c) => c.comp === comp.id);
      if (uses.length >= 3) return { f, p, main, comp, uses };
    }
  }
  return undefined;
}
const scaleOf = (c) => { const s = isKeyframes(c.scale) ? c.scale[c.scale.length - 1][1] : c.scale ?? 1; return Array.isArray(s) ? s[0] : s; };

export async function grade(dir) {
  const g = grader();
  const b = findBadge(dir);
  const rotates = b && (clipsInComp(b.p, b.comp.id).some((c) => isKeyframes(c.rotate)) || b.uses.some((c) => isKeyframes(c.rotate)));
  g.check('a 1080x1080 5 s badge comp used by 3 comp clips in a 1920x1080 main (different sizes and start times), with a rotation',
    !!b && b.comp.size[0] === 1080 && b.comp.size[1] === 1080 && b.main.size[0] === 1920 && b.main.size[1] === 1080 && new Set(b.uses.map((c) => toFrames(c.at, 30))).size >= 3 && new Set(b.uses.map((c) => round(scaleOf(c), 2))).size >= 3 && !!rotates,
    b ? `${b.f}: comp "${b.comp.id}" ${b.comp.size.join('x')}, ${b.uses.length} uses at ${b.uses.map((c) => c.at).join(',')} scale ${b.uses.map(scaleOf).join(',')}` : 'no comp used 3 times in main');
  const out = join(dir, 'out/badges.mp4');
  const info = await probe(out);
  let t0;
  if (b) {
    const spans = b.uses.map((c) => absoluteSpans(b.p, c)[0]).filter(Boolean);
    const start = Math.max(...spans.map((s) => s.start)), end = Math.min(...spans.map((s) => s.end));
    if (end - start > 0.6) t0 = start + Math.min(0.5, (end - start - 0.5) / 2);
  }
  let blobs = [];
  await g.checkAsync('frames: the badge is visible at 3 different scales at a time when all three overlap', async () => {
    if (!info) return { pass: false, detail: 'out/badges.mp4 missing' };
    if (t0 === undefined) return { pass: false, detail: 'the three badge clips never overlap in time' };
    const img = await frameAt(out, t0, { width: 480, height: 270 });
    const bg = [img.data[0], img.data[1], img.data[2]];
    blobs = components(dilate(mask(img, (r, gg, bl) => Math.max(Math.abs(r - bg[0]), Math.abs(gg - bg[1]), Math.abs(bl - bg[2])) > 50), 480, 270, 6), 480, 270, 150);
    const sizes = blobs.slice(0, 3).map((c) => Math.max(c.bbox[2], c.bbox[3])).sort((x, y) => x - y);
    const distinct = sizes.length === 3 && sizes[1] / sizes[0] > 1.1 && sizes[2] / sizes[1] > 1.1;
    const ne = await assertNotEmpty(out);
    return { pass: distinct && ne.pass, detail: `at ${round(t0, 2)} s: ${blobs.length} blobs, sizes ${sizes.join(',')}; ${ne.detail}` };
  });
  await g.checkAsync('rotation differs between two frames 0.5 s apart', async () => {
    if (!info || t0 === undefined || !blobs.length) return { pass: false, detail: 'no badge frame' };
    const [a, c] = await Promise.all([frameAt(out, t0, { width: 480, height: 270 }), frameAt(out, t0 + 0.5, { width: 480, height: 270 })]);
    const d = frameDiff(crop(a, blobs[0].bbox), crop(c, blobs[0].bbox), { thresh: 50 });
    return { pass: d.changed > 0.02, detail: `${round(d.changed, 3)} of the largest badge's pixels changed` };
  });
  return g.result();
}
