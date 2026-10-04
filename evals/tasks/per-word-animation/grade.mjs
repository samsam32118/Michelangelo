import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { grader, outputs, findFiles, readProject, validateRaw, textClips, mainComp, probe, frameAt, renderStill, round, assertNotEmpty } from '../../lib/index.mjs';

const WORDS = ['make', 'every', 'second', 'count'];
/** Columns (at 270 px wide) containing pixels that differ from the corner (background) colour. */
function glyphColumns(img) {
  const bg = [img.data[0], img.data[1], img.data[2]];
  let cols = 0;
  for (let x = 0; x < img.width; x++) {
    for (let y = 0; y < img.height; y++) {
      const i = (y * img.width + x) * 4;
      if (Math.max(Math.abs(img.data[i] - bg[0]), Math.abs(img.data[i + 1] - bg[1]), Math.abs(img.data[i + 2] - bg[2])) > 60) { cols++; break; }
    }
  }
  return cols;
}

function findProject(dir) {
  for (const f of outputs(dir, /\.mgl\.json$/)) {
    const p = readProject(join(dir, f));
    if (!p || validateRaw(p).length) continue;
    const main = mainComp(p);
    if (main?.size?.[0] !== 1080 || main?.size?.[1] !== 1920) continue;
    const texts = textClips(p);
    const byWord = texts.find((c) => /make every second count/i.test(c.text) && c.animate?.by === 'word' && c.animate?.in);
    const words = WORDS.every((w) => texts.some((c) => c.text.trim().toLowerCase() === w && (c.animate?.in || Array.isArray(c.scale) || Array.isArray(c.opacity))));
    if (byWord || words) return { f, p };
  }
  return undefined;
}

export async function grade(dir) {
  const g = grader();
  const found = findProject(dir);
  g.check('1080x1920 project with a per-word text animation (animate by word) or per-word clips', !!found, found ? found.f : 'no matching project');
  await g.checkAsync('still at 0.6 s (out/w.png) shows fewer glyph columns than the project rendered at 2.5 s', async () => {
    const w = join(dir, 'out/w.png');
    if (!existsSync(w) || !found) return { pass: false, detail: !found ? 'no project' : 'out/w.png missing' };
    const pi = await probe(w);
    const r = await renderStill(dir, found.f, 2.5);
    if (r.error) return { pass: false, detail: r.error };
    const [a, b] = await Promise.all([frameAt(w, 0, { width: 270, height: 480 }), frameAt(r.file, 0, { width: 270, height: 480 })]);
    const ca = glyphColumns(a), cb = glyphColumns(b);
    const ne = await assertNotEmpty(r.file, { still: true });
    return { pass: pi.width === 1080 && pi.height === 1920 && ca < cb * 0.85 && cb > 30 && ne.pass, detail: `glyph columns ${ca} at 0.6 s vs ${cb} at 2.5 s` };
  });
  await g.checkAsync('look contact sheet exists (.mgl/**/sheet.png), long edge <= 1568', async () => {
    const sheets = findFiles(dir, /^sheet\.png$/, { includeMgl: true }).filter((f) => f.startsWith('.mgl/'));
    if (!sheets.length) return { pass: false, detail: 'no .mgl/**/sheet.png' };
    const pi = await probe(join(dir, sheets[0]));
    return { pass: !!pi && Math.max(pi.width, pi.height) <= 1568 && Math.max(pi.width, pi.height) >= 300, detail: `${sheets[0]} ${pi?.width}x${pi?.height}` };
  });
  void round;
  return g.result();
}
