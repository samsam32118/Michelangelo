import { join } from 'node:path';
import { grader, outputs, readProject, validateRaw, mainComp, clipsInComp, isKeyframes, toFrames, probe, allFrames, mask, dilate, components, frameDiff, crop, resize, round, assertNotEmpty } from '../../lib/index.mjs';

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

const W = 640, H = 360, FPS = 6, DIL = 3;

/** The most common colour of the frame border (the main comp's background), quantised to 8 levels per channel. */
function borderColor(img) {
  const counts = new Map();
  const add = (x, y) => { const i = (y * W + x) * 4; const k = (img.data[i] >> 5) * 64 + (img.data[i + 1] >> 5) * 8 + (img.data[i + 2] >> 5); const e = counts.get(k) ?? { n: 0, r: 0, g: 0, b: 0 }; e.n++; e.r += img.data[i]; e.g += img.data[i + 1]; e.b += img.data[i + 2]; counts.set(k, e); };
  for (let x = 0; x < W; x += 2) { add(x, 0); add(x, H - 1); }
  for (let y = 0; y < H; y += 2) { add(0, y); add(W - 1, y); }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return [best.r / best.n, best.g / best.n, best.b / best.n];
}

/**
 * Badge sightings in the output, from the pixels alone (no project needed): per sampled frame (6 fps), the
 * roughly square blobs that differ from the background. Returns [{i, t, size, cx, cy, bbox}].
 */
async function sightings(out) {
  const frames = await allFrames(out, { width: W, height: H, fps: FPS });
  const res = [];
  frames.forEach((img, i) => {
    const bg = borderColor(img);
    const m = dilate(mask(img, (r, g, b) => Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2])) > 50), W, H, DIL);
    for (const c of components(m, W, H, 120)) {
      const [x, y, w, h] = c.bbox;
      const bw = w - 2 * DIL, bh = h - 2 * DIL;
      if (bw < 8 || bh < 8 || bw / bh < 0.75 || bw / bh > 1.33 || c.area / (w * h) < 0.5) continue;
      if (x <= 0 || y <= 0 || x + w >= W || y + h >= H) continue; // cut by the frame edge
      res.push({ i, t: i / FPS, size: Math.max(bw, bh), cx: c.centroid[0], cy: c.centroid[1], bbox: [x + DIL, y + DIL, bw, bh] });
    }
  });
  return { frames, res };
}

/** Sizes held for >= 3 samples (within 5 %): the distinct scales the badge is shown at. */
function heldSizes(res) {
  const sizes = res.map((r) => r.size).sort((a, b) => a - b);
  const clusters = [];
  for (const s of sizes) {
    const c = clusters[clusters.length - 1];
    if (c && s / c[0] <= 1.05) c.push(s); else clusters.push([s]);
  }
  const held = clusters.filter((c) => c.length >= 3).map((c) => c[Math.floor(c.length / 2)]);
  const distinct = [];
  for (const s of held) if (!distinct.length || s / distinct[distinct.length - 1] > 1.1) distinct.push(s);
  return { held, distinct };
}

export async function grade(dir) {
  const g = grader();
  const b = findBadge(dir);
  const rotates = b && (clipsInComp(b.p, b.comp.id).some((c) => isKeyframes(c.rotate)) || b.uses.some((c) => isKeyframes(c.rotate)));
  g.check('[lib] a 1080x1080 5 s badge comp used by 3 comp clips in a 1920x1080 main (different sizes and start times), with a rotation',
    !!b && b.comp.size[0] === 1080 && b.comp.size[1] === 1080 && b.main.size[0] === 1920 && b.main.size[1] === 1080 && new Set(b.uses.map((c) => toFrames(c.at, 30))).size >= 3 && new Set(b.uses.map((c) => round(scaleOf(c), 2))).size >= 3 && !!rotates,
    b ? `${b.f}: comp "${b.comp.id}" ${b.comp.size.join('x')}, ${b.uses.length} uses at ${b.uses.map((c) => c.at).join(',')} scale ${b.uses.map(scaleOf).join(',')}` : 'no comp used 3 times in main');

  // From the output alone, each instance where it is visible (the instances need not overlap in time).
  const out = join(dir, 'out/badges.mp4');
  const info = await probe(out);
  const s = info?.video ? await sightings(out) : { frames: [], res: [] };
  await g.checkAsync('out/badges.mp4 1920x1080: the badge is shown at 3 different scales (each held for >= 0.5 s somewhere in the video)', async () => {
    if (!info) return { pass: false, detail: 'out/badges.mp4 missing' };
    const ne = await assertNotEmpty(out);
    const { held, distinct } = heldSizes(s.res);
    return { pass: info.displayWidth === 1920 && info.displayHeight === 1080 && distinct.length >= 3 && ne.pass,
      detail: `${info.displayWidth}x${info.displayHeight}; ${s.res.length} badge sightings in ${s.frames.length} frames; held sizes ${held.map((x) => round(x, 0)).join(',') || 'none'} px at ${W} px wide; distinct ${distinct.length}; ${ne.detail}` };
  });
  await g.checkAsync('within one instance (same place and size 0.5 s later) the badge content rotates', async () => {
    if (!info) return { pass: false, detail: 'out/badges.mp4 missing' };
    let best = 0, pairs = 0;
    for (const a of s.res) {
      if (a.size < 24) continue;
      const c = s.res.find((x) => x.i === a.i + FPS / 2 && Math.abs(x.size / a.size - 1) < 0.25 && Math.hypot(x.cx - a.cx, x.cy - a.cy) < 0.25 * a.size);
      if (!c) continue;
      pairs++;
      const n = Math.min(a.size, 96);
      const A = resize(crop(s.frames[a.i], a.bbox), n, n), C = resize(crop(s.frames[c.i], c.bbox), n, n);
      best = Math.max(best, frameDiff(A, C, { thresh: 50 }).changed);
    }
    return { pass: best > 0.04, detail: `${pairs} same-instance pairs 0.5 s apart; max changed share ${round(best, 3)} (need > 0.04)` };
  });
  return g.result();
}
