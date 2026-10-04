import { join } from 'node:path';
import { grader, readSetup, probe, ssim, loudness, rmsWindows, bandpassRmsDb, round, assertNotEmpty, findProjectUsing, span } from '../../lib/index.mjs';

const N = {
  bed: 'music bed throughout: in every 1 s window >= 80 % of 50 ms frames above -50 dBFS',
  sfx: 'a transient sound effect within 3 frames of each cut and of the title (10 ms RMS peak >= 6 dB above the surrounding median)',
  loud: 'mixed for YouTube: -14 +-1 LUFS integrated, true peak <= -1 dBTP',
  voice: 'voice not masked: 300-3400 Hz energy during the voice-over >= 6 dB above the bed alone (5.5-8.5 s, 14.6-18.1 s)',
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : -Infinity; };

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const out = join(dir, 'out/final.mp4'), edit = join(dir, 'edit.mp4');
  const p = await probe(out);
  await g.checkAsync('out/final.mp4: 1280x720 H.264 + AAC, 20 s +-0.2, the same picture as edit.mp4 (SSIM > 0.8 at 2, 6, 11, 17 s), sound not silent', async () => {
    if (!p) return { pass: false, detail: 'out/final.mp4 missing' };
    const ne = await assertNotEmpty(out, { audio: true });
    const ss = await Promise.all([2, 6, 11, 17].map((t) => ssim(out, edit, { ta: t, tb: t, width: 480, height: 270 })));
    return { pass: p.displayWidth === 1280 && p.displayHeight === 720 && p.video?.codec === 'h264' && p.audio?.codec === 'aac' && Math.abs(p.duration - 20) <= 0.2 && ss.every((s) => s > 0.8) && ne.pass,
      detail: `${p.displayWidth}x${p.displayHeight} ${p.video?.codec}/${p.audio?.codec} ${round(p.duration, 2)} s; SSIM ${ss.map((s) => round(s, 3)).join('/')}; ${ne.detail}` };
  });
  if (!p?.audio) {
    for (const n of [N.bed, N.sfx, N.loud, N.voice])
      g.check(n, false, p ? 'no audio stream' : 'out/final.mp4 missing');
  } else {
    const env = await rmsWindows(out, { win: 0.05 });
    const gaps = [];
    for (let s = 0; s < Math.min(19, Math.floor(env.length / 20)); s++) {
      const w = env.slice(s * 20, s * 20 + 20);
      if (w.filter((d) => d > -50).length / w.length < 0.8) gaps.push(`${s}-${s + 1} s`);
    }
    g.check(N.bed, env.length >= 380 && !gaps.length, `quiet windows: ${gaps.join(', ') || 'none'}`);
    const fine = (await rmsWindows(out, { win: 0.01 })).map((d) => Math.max(-90, d));
    const at = (t) => Math.round(t * 100);
    const hits = [info.title.start, ...info.cuts].map((c) => {
      const base = median([...fine.slice(at(c - 1), at(c - 0.2)), ...fine.slice(at(c + 0.25), at(c + 1))]);
      const peak = Math.max(...fine.slice(at(c - 0.1), at(c + 0.1) + 1));
      return { c, rise: peak - base };
    });
    g.check(N.sfx, hits.every((h) => h.rise >= 6),
      hits.map((h) => `${h.c} s: +${round(h.rise, 1)} dB`).join(', '));
    const l = await loudness(out);
    g.check(N.loud, Math.abs(l.integrated + 14) <= 1 && l.truePeak <= -1, `${l.integrated} LUFS, ${l.truePeak} dBTP`);
    const v = info.vo;
    const [voice, bedA, bedB] = await Promise.all([bandpassRmsDb(out, 300, 3400, { start: v.start + 0.1, duration: Math.max(0.3, v.end - v.start - 0.2) }), bandpassRmsDb(out, 300, 3400, { start: 5.5, duration: 3 }), bandpassRmsDb(out, 300, 3400, { start: 14.6, duration: 3.5 })]);
    const bed = Math.max(bedA, bedB);
    g.check(N.voice, voice - bed >= 6 && voice > -45,
      `voice band ${round(voice, 1)} dB, bed ${round(bed, 1)} dB`);
  }
  // with the library: the music and the effects are in the project
  const shots = [1, 2, 3, 4].map((i) => `media/shot${i}.mp4`);
  const proj = findProjectUsing(dir, { inputs: shots, pred: (pp) => {
    const audioTracks = new Set((pp.tracks ?? []).filter((t) => t.audio).map((t) => t.id));
    const srcOf = new Map((pp.assets ?? []).map((a) => [a.id, String(a.src ?? '')]));
    const sounds = (pp.clips ?? []).filter((c) => audioTracks.has(c.track) && !srcOf.get(c.asset)?.endsWith('vo.wav')).map((c) => ({ c, s: span(pp, c) }));
    if (!sounds.some(({ s }) => s.end - s.start >= 18)) return 'no music clip of >= 18 s on an audio track';
    const missing = [info.title.start, ...info.cuts].filter((t) => !sounds.some(({ s }) => s.end - s.start <= 3 && s.start <= t + 0.1 && s.start >= t - 1 && s.end >= t - 0.1));
    return !missing.length || `no short effect clip at ${missing.join(', ')} s`;
  } });
  g.check('[lib] the project (the edit\'s shots) has a music clip of >= 18 s and a short effect clip at each cut and at the title', !!proj.p, proj.p ? proj.f : proj.why);
  return g.result();
}
