import { join } from 'node:path';
import * as L from '../_lib/index.mjs';

const R = 48000;

export async function grade(dir) {
  const g = L.grader();
  const { hashes } = L.readSetup(dir);
  const out = join(dir, 'out/clean.wav'), inp = join(dir, 'voice_hum.wav'), refF = join(dir, '.golden/voice_ref.wav');
  const p = await L.probe(out);
  const [Lo, Li, Lr] = await Promise.all([L.loudness(out), L.loudness(inp), L.loudness(refF)]);
  g.check('out/clean.wav: 15 s +/- 0.1, not silent, integrated loudness -16 +/- 1 LUFS', p?.audio && Math.abs(p.duration - 15) <= 0.1 && Lo !== null && Math.abs(Lo + 16) <= 1,
    p ? `${p.audio?.codec ?? 'no audio'} ${L.round(p.duration, 2)} s, ${L.round(Lo, 2)} LUFS` : 'missing');

  const [xo, xi, xr] = await Promise.all([L.pcm(out), L.pcm(inp), L.pcm(refF)]);
  const ready = xo && xi && xr && Number.isFinite(Lo) && Number.isFinite(Li) && Number.isFinite(Lr) && Lo > -70;
  // The input is voice_ref + hum, so its speech sits at the reference's loudness: match out to that (gR = 0).
  const gO = ready ? Lr - Lo : 0, gR = 0;
  const hum = [];
  if (ready) for (const f of [60, 120, 180]) for (const [w, t0, t1] of [['lead-in', 0.2, 0.5], ['speech', 1, 14.5]]) {
    const i = L.toneDb(xi, R, f, t0, t1), o = L.toneDb(xo, R, f, t0, t1) + gO, r = L.toneDb(xr, R, f, t0, t1) + gR;
    // Reduction is capped by the voice's own energy at f: matching the clean reference counts as removed.
    hum.push({ f, w, red: i - o, ok: o <= i - 25 || (w === 'speech' && o <= r + 3) });
  }
  g.check('hum reduced: 60/120/180 Hz >= 25 dB below the input (lead-in and speech), loudness-matched', ready && hum.every((h) => h.ok),
    ready ? hum.map((h) => `${h.f}Hz ${h.w} -${L.round(h.red, 1)}dB${h.ok ? '' : '!'}`).join(', ') : 'no output audio');

  await g.checkAsync('voice kept: 300-3400 Hz energy within 3 dB of voice_ref.wav (sub-bands within 6 dB); envelope correlation >= 0.9', async () => {
    if (!ready) return { pass: false, detail: 'no output audio' };
    const so = L.spectrum(xo, R), sr = L.spectrum(xr, R), k = Lr - Lo; // out matched to the reference's loudness
    const band = (s, a, b, gain) => L.bandDb(s, a, b) + gain;
    const d = band(so, 300, 3400, k) - band(sr, 300, 3400, 0);
    const subs = [[300, 800], [800, 1600], [1600, 3400]].map(([a, b]) => band(so, a, b, k) - band(sr, a, b, 0));
    const env = L.envelopeLag(xo, xr, R, 0.1, 0.01);
    return { pass: Math.abs(d) <= 3 && subs.every((s) => Math.abs(s) <= 6) && env.r >= 0.9, detail: `band ${L.round(d, 2)} dB (sub-bands ${subs.map((s) => L.round(s, 1)).join('/')}); envelope r=${L.round(env.r, 3)} lag ${L.round(env.lag * 1000, 0)} ms` };
  });

  let unchanged = false;
  try { unchanged = L.sha256(inp) === hashes['voice_hum.wav']; } catch { /* missing */ }
  g.check('voice_hum.wav unchanged (the input is not overwritten)', unchanged, unchanged ? 'matches the setup hash' : 'changed or missing');

  const pj = L.readProject(join(dir, 'clean.mgl.json'));
  g.check('[lib] clean.mgl.json validates and its audio clip(s) reference voice_hum.wav (unchanged), not a processed copy', (() => {
    if (!pj || L.validateRaw(pj).length) return false;
    const humIds = new Set(L.assetsNamed(pj, 'voice_hum.wav').map((a) => a.id));
    const audioExt = /\.(wav|mp3|aac|m4a|flac|ogg|opus)$/i;
    const assets = new Map(L.tables(pj, 'assets').map((a) => [a.id, a]));
    const clips = L.tables(pj, 'clips').filter((c) => c.asset !== undefined && !c.muted);
    const usesHum = clips.some((c) => humIds.has(c.asset));
    const others = clips.filter((c) => !humIds.has(c.asset) && audioExt.test(assets.get(c.asset)?.src ?? ''));
    return usesHum && !others.length && unchanged;
  })(), pj ? (L.validateRaw(pj)[0] ?? `assets ${L.tables(pj, 'assets').map((a) => a.src).join(', ')}`) : 'missing or not JSON');
  return g.result();
}
