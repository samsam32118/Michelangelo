import { join } from 'node:path';
import { grader, assertNotEmpty, probe, loudness, frameAt, glyphDensity, readSetup, outputs, readProject, validateRaw, projectCues, textClips, span, mainComp, compOfClip, round } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const out = join(dir, 'out/short.mp4');
  const p0 = await probe(out);
  g.check('out/short.mp4: 1080x1920, H.264 + AAC, duration within 0.5 s of vo.wav',
    p0 && p0.displayWidth === 1080 && p0.displayHeight === 1920 && p0.video?.codec === 'h264' && p0.audio?.codec === 'aac' && Math.abs(p0.duration - info.voDuration) <= 0.5,
    p0 ? `${p0.displayWidth}x${p0.displayHeight} ${p0.video?.codec}/${p0.audio?.codec} ${round(p0.duration)} s (vo ${round(info.voDuration)} s)` : 'missing');
  await g.checkAsync('not black, not static, audio not silent, integrated loudness -20..-10 LUFS', async () => {
    if (!p0) return { pass: false, detail: 'missing' };
    const ne = await assertNotEmpty(out, { audio: true });
    const l = await loudness(out);
    return { pass: ne.pass && l.integrated >= -20 && l.integrated <= -10, detail: `${ne.detail}; ${l.integrated} LUFS` };
  });
  await g.checkAsync('text present at 0.5 s and 7 s (glyph pixel density above the bg-only reference)', async () => {
    if (!p0) return { pass: false, detail: 'missing' };
    const res = [];
    for (const t of [0.5, 7]) {
      const [img, ref] = await Promise.all([frameAt(out, t, { width: 540, height: 960 }), frameAt(join(dir, `.golden/bg_${t}.png`), 0, { width: 540, height: 960 })]);
      res.push(img && ref ? glyphDensity(img, { ref, reach: 3 }) : 0);
    }
    return { pass: res.every((d) => d > 0.003), detail: `excess density ${res.map((d) => round(d, 4)).join(', ')} (need > 0.003)` };
  });
  g.check(...projectCheck(dir, info));
  return g.result();
}

function projectCheck(dir, info) {
  const name = '[lib] project valid; >= 1 cue per script line; a text clip starts at 0 with len <= 2.5 s';
  const files = outputs(dir, /\.mgl\.json$/);
  const notes = [];
  for (const f of files) {
    const p = readProject(join(dir, f));
    if (!p) { notes.push(`${f}: not JSON`); continue; }
    const errs = validateRaw(p);
    if (errs.length) { notes.push(`${f}: ${errs[0]}`); continue; }
    const main = mainComp(p);
    if (main?.size?.[0] !== 1080 || main?.size?.[1] !== 1920) { notes.push(`${f}: main comp is not 1080x1920`); continue; }
    const cues = projectCues(p);
    const words = (s) => s.toLowerCase().match(/[a-z]+/g) ?? [];
    const cueWords = new Set(cues.flatMap((c) => words(c.text)));
    const scriptWords = info.lines.flatMap(words);
    const covered = scriptWords.filter((w) => cueWords.has(w)).length / scriptWords.length;
    const title = textClips(p).find((c) => compOfClip(p, c)?.id === main.id && span(p, c).at === 0 && span(p, c).end <= 2.5 + 1e-6);
    const ok = cues.length >= info.lines.length && covered >= 0.8 && !!title;
    notes.push(`${f}: ${cues.length} cues, ${Math.round(covered * 100)}% of script words, title ${title ? `"${title.text}"` : 'missing'}`);
    if (ok) return [name, true, notes.at(-1)];
  }
  return [name, false, notes.join('; ') || 'no .mgl.json project'];
}
