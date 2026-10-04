import { join } from 'node:path';
import { grader, readSetup, readProject, validateRaw, toFrames, trackGaps, renderProject, toneLevels, round, outputs, probe, assertNotEmpty } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const p = readProject(join(dir, 'dialog.mgl.json'));
  const clip = (id) => (p?.clips ?? []).find((c) => c.id === id);
  const a = clip('a'), b = clip('b');
  g.check('[lib] picture cut frame unchanged (a ends and b starts at frame 120)', !!a && !!b && toFrames(a.at, 30) === 0 && toFrames(a.len, 30) === info.cut && toFrames(b.at, 30) === info.cut && toFrames(b.len, 30) === 120 && toFrames(b.in ?? 0, 30) === 60 && !a.hidden && !b.hidden,
    a && b ? `a ${a.at}+${a.len}, b ${b.at}+${b.len} in ${b.in}` : 'clips a/b missing');
  await g.checkAsync('[lib] 440 Hz for 1 s after the picture cut in a rendered wav, then 660 Hz', async () => {
    if (!p) return { pass: false, detail: 'dialog.mgl.json missing' };
    let file;
    const r = await renderProject(dir, 'dialog.mgl.json', 'wav');
    if (r.file) file = r.file;
    else {
      const own = outputs(dir, /\.(wav|mp4|m4a|mp3)$/).filter((f) => !f.startsWith('media/'));
      for (const f of own) if ((await probe(join(dir, f)))?.audio) { file = join(dir, f); break; }
      if (!file) return { pass: false, detail: r.error };
    }
    const lv = async (s) => { const l = await toneLevels(file, [440, 660], { start: s, duration: 0.5 }); return l[440] - l[660]; };
    const [before, under, after, late] = await Promise.all([lv(2), lv(4.2), lv(5.3), lv(7)]);
    const ne = await assertNotEmpty(file, { video: false, audio: true });
    return { pass: before > 10 && under > 10 && after < -10 && late < -10 && ne.pass, detail: `440 minus 660 dB: 2 s ${round(before, 1)}, 4.2 s ${round(under, 1)}, 5.3 s ${round(after, 1)}, 7 s ${round(late, 1)}` };
  });
  g.check('[lib] no gap or overlap problems (file valid; V1 and the audio track contiguous)', !!p && !validateRaw(p).length && (p.tracks ?? []).every((t) => trackGaps(p, t.id).length === 0),
    p ? (validateRaw(p)[0] ?? ((p.tracks ?? []).map((t) => trackGaps(p, t.id).map((x) => `${t.id} gap ${x.gap} after ${x.after}`).join(',')).filter(Boolean).join('; ') || 'ok')) : 'missing');
  return g.result();
}
