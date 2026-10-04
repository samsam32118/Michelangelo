import { join } from 'node:path';
import { grader, readSetup, readProject, renderStill, frameAt, mask, maskStats, projectCues, resolveStyle, isKeyframes, round, validateRaw, assertNotEmpty } from '../../lib/index.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const p = readProject(join(dir, 'promo.mgl.json'));
  const orig = { x: info.logo.x, y: info.logo.y };
  const clip = (id) => p?.clips?.find((c) => c.id === id);

  await g.checkAsync('[lib] frame at cue c5: caption glyphs and the logo both present and disjoint', async () => {
    if (!p || validateRaw(p).length) return { pass: false, detail: p ? validateRaw(p)[0] : 'promo.mgl.json missing' };
    const r = await renderStill(dir, 'promo.mgl.json', info.t);
    if (r.error) return { pass: false, detail: r.error };
    const img = await frameAt(r.file, 0);
    const L = info.logo, half = L.size / 2;
    const lb = [L.x - half, L.y - half, L.size, L.size];
    const orange = maskStats(mask(img, (R, G, B) => R > 200 && G > 80 && G < 170 && B < 70, lb), img.width, img.height);
    const inLogo = (x, y, pad) => x >= lb[0] - pad && x < lb[0] + lb[2] + pad && y >= lb[1] - pad && y < lb[1] + lb[3] + pad;
    const caption = maskStats(mask(img, (R, G, B, x, y) => !inLogo(x, y, 0) && ((R > 215 && G > 215 && B > 215) || (R < 45 && G < 45 && B < 45))), img.width, img.height, { minPerLine: 3 });
    const white = maskStats(mask(img, (R, G, B) => R > 215 && G > 215 && B > 215), img.width, img.height).count;
    const bb = caption.bbox;
    const overlap = bb && bb[0] < lb[0] + lb[2] + 4 && bb[0] + bb[2] > lb[0] - 4 && bb[1] < lb[1] + lb[3] + 4 && bb[1] + bb[3] > lb[1] - 4;
    const logoShare = orange.count / (L.size * L.size);
    const ne = await assertNotEmpty(r.file, { still: true });
    return { pass: logoShare >= 0.95 && white > 1500 && !overlap && ne.pass, detail: `logo ${round(logoShare, 3)} visible, caption white px ${white}, caption box ${bb?.join(',')}, logo box ${lb.join(',')}` };
  });
  g.check('[lib] logo clip x, y, scale, opacity, hidden, blend unchanged', (() => {
    const l = clip('logo');
    return !!l && l.x === orig.x && l.y === orig.y && l.fit === 'none' && ['scale', 'opacity', 'hidden', 'blend', 'anchor', 'parent', 'masks', 'crop'].every((k) => l[k] === undefined)
      && l.track === 'LOGO' && !p.tracks.find((t) => t.id === 'LOGO')?.hidden && p.tracks.findIndex((t) => t.id === 'LOGO') > p.tracks.findIndex((t) => t.id === (p.clips.find((c) => c.captions)?.track ?? 'CAP'));
  })(), JSON.stringify(clip('logo') ?? null));
  g.check('[lib] caption clip and style: size not smaller, not hidden, opacity unchanged, scale not < 1', (() => {
    const caps = (p?.clips ?? []).filter((c) => c.captions);
    if (caps.length !== 1) return false;
    const c = caps[0], st = resolveStyle(p, c);
    const size = st.size ?? 64;
    const scales = c.scale === undefined ? [1] : isKeyframes(c.scale) ? c.scale.map((k) => k[1]) : [c.scale];
    const minScale = Math.min(...scales.flat());
    const track = p.tracks.find((t) => t.id === c.track);
    return size >= 64 && !c.hidden && c.opacity === undefined && minScale >= 1 && !track?.hidden && !c.masks && (st.maxLines ?? 3) >= 3;
  })(), (() => { const c = (p?.clips ?? []).find((x) => x.captions); return c ? `size ${resolveStyle(p, c).size}, scale ${JSON.stringify(c.scale)}, opacity ${c.opacity}` : 'no captions clip'; })());
  g.check('[lib] cue count, texts and timings unchanged', (() => {
    if (!p) return false;
    const cues = projectCues(p);
    return cues.length === info.cues.length && info.cues.every(([id, at, len, text], i) => cues[i].text === text && Math.abs(cues[i].start - at / 30) < 1e-6 && Math.abs(cues[i].end - (at + len) / 30) < 1e-6 && same(cues[i].id, id));
  })(), p ? `${(p.cues ?? []).length} cues` : 'missing');
  return g.result();
}
