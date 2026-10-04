import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as L from '../_lib/index.mjs';
import { centre } from './setup.mjs';

const TIMES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5];

/** Ground-truth box centre shown at output time t: source frame floor(t * 30 + eps). */
function gt(dir, t) {
  const n = Math.floor(t * 30 + 1e-6);
  try { const r = JSON.parse(readFileSync(join(dir, '.golden/track.json'), 'utf8'))[n]; if (r) return [r[1], r[2]]; } catch { /* fall back */ }
  return centre(n / 30);
}

/** Near-white, low-saturation pixels (the label's pill). */
function whiteMask(img) {
  const n = img.width * img.height, m = new Uint8Array(n), d = img.data;
  for (let i = 0; i < n; i++) { const r = d[3 * i], g = d[3 * i + 1], b = d[3 * i + 2]; m[i] = r >= 215 && g >= 215 && b >= 215 && Math.max(r, g, b) - Math.min(r, g, b) <= 40 ? 1 : 0; }
  return m;
}

export async function grade(dir) {
  const g = L.grader();
  const out = join(dir, 'out/tracked.mp4');
  const p = await L.probe(out);
  await g.checkAsync('out/tracked.mp4: 1920x1080, 8 s +/- 0.1, not black, not static', async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const ne = await L.notEmpty(out);
    return { pass: p.video?.width === 1920 && p.video.height === 1080 && Math.abs(p.duration - 8) <= 0.1 && ne.pass, detail: `${p.video?.width}x${p.video?.height} ${L.round(p.duration, 2)} s; ${ne.detail}` };
  });
  // Seek half a frame early: ffmpeg returns the first frame at or after the seek time.
  const fps = p?.video?.fps || 30;
  const shown = TIMES.map((t) => Math.round(t * fps) / fps);
  const frames = p?.video?.width === 1920 && p.video.height === 1080 ? await Promise.all(shown.map((t) => L.frameAt(out, t - 0.5 / fps))) : TIMES.map(() => null);
  const samples = frames.map((f, k) => {
    const [cx, cy] = gt(dir, shown[k]);
    if (!f) return { cx, cy, box: null, pill: null };
    const box = L.blobs(L.colorMask(f, '#ff7a00', 10), 1920, { minArea: 500 })[0] ?? null;
    const pill = L.blobs(whiteMask(f), 1920, { minArea: 1500 }).find((b) => Math.abs(b.cx - cx) <= 60 && cy - b.cy >= 40 && cy - b.cy <= 200) ?? null;
    return { cx, cy, box, pill };
  });
  g.check('orange box still visible: #ff7a00 blob >= 10,000 px at the ground-truth position at 8 times',
    samples.every((s) => s.box && s.box.area >= 10000 && Math.hypot(s.box.cx - s.cx, s.box.cy - s.cy) <= 40),
    samples.map((s, k) => `${TIMES[k]}s ${s.box ? `${s.box.area}px@${Math.round(s.box.cx)},${Math.round(s.box.cy)}` : 'none'}`).join('; '));
  g.check('label follows: a near-white pill >= 1,500 px within 60 px horizontally and 40-200 px above the box at 8 times', samples.every((s) => s.pill),
    samples.map((s, k) => `${TIMES[k]}s ${s.pill ? `${s.pill.area}px dx ${Math.round(s.pill.cx - s.cx)} dy ${Math.round(s.cy - s.pill.cy)}` : 'none'}`).join('; '));
  const pts = samples.filter((s) => s.pill).map((s) => [s.pill.cx, s.pill.cy]);
  let span = 0;
  for (const a of pts) for (const b of pts) span = Math.max(span, Math.hypot(a[0] - b[0], a[1] - b[1]));
  g.check('label is not static: pill centre moves > 400 px across the samples', span > 400, `max pill displacement ${Math.round(span)} px over ${pts.length} samples`);
  return g.result();
}
