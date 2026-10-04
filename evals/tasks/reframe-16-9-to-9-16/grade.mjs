import { join } from 'node:path';
import { grader, readSetup, readProject, validateRaw, mainComp, sha256, probe, frameAt, mask, maskStats, components, assertNotEmpty, round, textClips } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const { hashes } = readSetup(dir);
  const tall = readProject(join(dir, 'tall.mgl.json'));
  const main = tall && mainComp(tall);
  const wideSame = sha256(join(dir, 'wide.mgl.json')) === hashes['wide.mgl.json'];
  g.check('tall.mgl.json comp 1080x1920 (valid, keeps the title); wide.mgl.json unchanged',
    !!main && main.size[0] === 1080 && main.size[1] === 1920 && !validateRaw(tall).length && textClips(tall).some((c) => /orbit/i.test(c.text)) && wideSame,
    `${main ? main.size.join('x') : 'tall.mgl.json missing'}${tall ? `; ${validateRaw(tall)[0] ?? 'valid'}` : ''}; wide ${wideSame ? 'unchanged' : 'MODIFIED'}`);

  const out = join(dir, 'out/tall.mp4');
  const info = await probe(out);
  await g.checkAsync('out/tall.mp4 1080x1920; the white circle is fully inside the frame in 5 sampled frames', async () => {
    if (!info) return { pass: false, detail: 'out/tall.mp4 missing' };
    if (info.displayWidth !== 1080 || info.displayHeight !== 1920) return { pass: false, detail: `${info.displayWidth}x${info.displayHeight}` };
    const ne = await assertNotEmpty(out);
    const notes = [];
    let ok = ne.pass;
    for (const t of [0.5, 1.5, 2.8, 4.2, 5.6]) {
      const img = await frameAt(out, Math.min(t, info.duration - 0.1), { width: 540, height: 960 });
      const comps = img ? components(mask(img, (r, gg, b) => r > 200 && gg > 200 && b > 200), 540, 960, 30) : [];
      const c = comps[0];
      const good = c && c.area >= Math.PI * 20 * 20 * 0.8 && c.bbox[2] / c.bbox[3] > 0.75 && c.bbox[2] / c.bbox[3] < 1.33 && c.area / (c.bbox[2] * c.bbox[3]) > 0.6
        && c.bbox[0] > 0 && c.bbox[1] > 0 && c.bbox[0] + c.bbox[2] < 540 && c.bbox[1] + c.bbox[3] < 960;
      notes.push(c ? `${t}s blob ${c.area}px @${c.bbox.join(',')}` : `${t}s none`);
      if (!good) ok = false;
    }
    return { pass: ok, detail: `${notes.join('; ')}; ${ne.detail}` };
  });
  await g.checkAsync('title fully inside the 9:16 Shorts safe zone', async () => {
    if (!info) return { pass: false, detail: 'out/tall.mp4 missing' };
    const img = await frameAt(out, 1.5, { width: 540, height: 960 });
    if (!img) return { pass: false, detail: 'no frame' };
    const s = maskStats(mask(img, (r, gg, b) => r > 200 && gg > 150 && b < 90), 540, 960, { minPerLine: 2 });
    const safe = [540 * 0.05, 960 * 0.08, 540 * 0.83, 960 * 0.72];
    const b = s.bbox;
    const inside = b && b[0] >= safe[0] - 1 && b[1] >= safe[1] - 1 && b[0] + b[2] <= safe[0] + safe[2] + 1 && b[1] + b[3] <= safe[1] + safe[3] + 1;
    return { pass: s.count > 150 && !!inside, detail: `title px ${s.count}, box ${b?.map((v) => round(v, 0)).join(',')}, safe ${safe.map((v) => round(v, 0)).join(',')}` };
  });
  return g.result();
}
