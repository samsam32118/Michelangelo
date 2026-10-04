import { join } from 'node:path';
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, renameSync, mkdirSync } from 'node:fs';
import * as L from '../_lib/index.mjs';
import { HIGHLIGHTS, XF, SOURCES, secs } from './setup.mjs';

const W = 480, H = 270, LABEL = [0, H / 2, W / 2, H]; // lower-left quadrant (label area)
const FREQS = Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.hz]));
const IMPORT_RE = /from\s*['"]michelangelo(\/[^'"]*)?['"]|import\(\s*['"]michelangelo['"]\s*\)|require\(\s*['"]michelangelo['"]\s*\)/;

/** Moments laid out with overlapping crossfades: start, duration, source in-point (s). */
export function layout(hl, xf = XF) {
  let t = 0;
  return hl.map((h, k) => { const d = secs(h.out) - secs(h.in), m = { k, src: h.source, inS: secs(h.in), d, start: t }; t += d - xf; return m; });
}
const total = (hl, xf = XF) => hl.reduce((s, h) => s + secs(h.out) - secs(h.in), 0) - xf * (hl.length - 1);

/** Label pixels in the lower-left quadrant: changed vs the matched source frame (m), and new edges there (e: glyphs). */
function labelMask(o, s) {
  const eo = L.edgeMask(o, 100), es = L.edgeMask(s, 100);
  const m = new Uint8Array((W / 2) * (H / 2)), e = new Uint8Array(m.length);
  for (let y = H / 2; y < H; y++) for (let x = 0; x < W / 2; x++) {
    const i = y * W + x, j = (y - H / 2) * (W / 2) + x;
    const d = Math.max(Math.abs(o.data[3 * i] - s.data[3 * i]), Math.abs(o.data[3 * i + 1] - s.data[3 * i + 1]), Math.abs(o.data[3 * i + 2] - s.data[3 * i + 2]));
    m[j] = d > 60 ? 1 : 0;
    e[j] = eo[i] && !es[i] ? 1 : 0;
  }
  return { m, e };
}

/** Visual media clips of a raw project (assets under clips/ on visual tracks). */
function mediaClips(pj) {
  const audioTracks = new Set(L.tables(pj, 'tracks').filter((t) => t.audio).map((t) => t.id));
  const assets = new Map(L.tables(pj, 'assets').map((a) => [a.id, a.src]));
  return L.tables(pj, 'clips').filter((c) => c.asset !== undefined && !audioTracks.has(c.track) && /(^|\/)clips\/[a-d]\.mp4$/.test(String(assets.get(c.asset) ?? '').replace(/\\/g, '/')));
}

export async function grade(dir) {
  const g = L.grader();
  const hl = L.readSetup(dir).info.highlights ?? HIGHLIGHTS;
  const ms = layout(hl), dur = total(hl);
  const out = join(dir, 'out/reel.mp4');
  const p = await L.probe(out);
  const results = {};

  // 2. format, duration, not empty
  results.render = await (async () => {
    if (!p) return { pass: false, detail: 'missing' };
    const ne = await L.notEmpty(out, { audio: true });
    const ok = p.video?.width === 1920 && p.video.height === 1080 && Math.abs(p.duration - dur) <= 2 / 30 + 0.02 && ne.pass;
    return { pass: ok, detail: `${p.video?.width}x${p.video?.height} ${L.round(p.duration, 3)} s (want ${dur}); ${ne.detail}` };
  })();

  // 3 + 5. midpoint matches its source (best offset within +/- 0.25 s), crossfades blend, label in the lower left
  const mids = await Promise.all(ms.map(async (m) => {
    const t = m.start + m.d / 2;
    const [o, seq] = await Promise.all([L.frameAt(out, t, { width: W, height: H }), L.frameSeq(join(dir, m.src), { t0: Math.max(0, m.inS + m.d / 2 - 0.25), dur: 0.5, width: W, height: H, gray: false })]);
    if (!o || !seq.length) return { ok: false, d: `#${m.k + 1}: no frame` };
    let best = -1, ref = null;
    for (const s of seq) { const v = L.ssim(o, s, W, H, { exclude: LABEL }); if (v > best) { best = v; ref = s; } }
    const lm = labelMask(o, ref);
    const dens = lm.m.reduce((a, v) => a + v, 0) / lm.m.length;
    return { ok: best >= 0.8, best, lm, dens, d: `#${m.k + 1} ssim ${L.round(best, 3)}` };
  }));
  const fades = await Promise.all(ms.slice(1).map(async (b, j) => {
    const a = ms[j];
    const tries = await Promise.all([0.15, 0.25, 0.35].map(async (dt) => {
      const t = b.start + dt;
      const [o, fa, fb] = await Promise.all([L.frameAt(out, t, { width: W, height: H }), L.frameAt(join(dir, a.src), a.inS + (t - a.start), { width: W, height: H }), L.frameAt(join(dir, b.src), b.inS + dt, { width: W, height: H })]);
      if (!o || !fa || !fb) return null;
      return [L.ssim(o, fa, W, H, { exclude: LABEL }), L.ssim(o, fb, W, H, { exclude: LABEL })];
    }));
    const ok = tries.some((s) => s && s.every((v) => v >= 0.3 && v <= 0.95));
    return { ok, d: `x${j + 1} ${tries.map((s) => (s ? s.map((v) => L.round(v, 2)).join('/') : '-')).join(' ')}` };
  }));
  results.match = { pass: !!p && mids.every((m) => m.ok) && fades.every((f) => f.ok), detail: [...mids.map((m) => m.d), ...fades.map((f) => f.d)].join('; ') };

  // 4. dominant tone at each midpoint
  results.audio = await (async () => {
    const x = p ? await L.pcm(out) : null;
    if (!x) return { pass: false, detail: 'no audio' };
    const res = ms.map((m) => {
      const t = m.start + m.d / 2, lv = Object.fromEntries(Object.values(FREQS).map((f) => [f, L.toneDb(x, 48000, f, t - 0.3, t + 0.3)]));
      const want = FREQS[m.src], others = Object.entries(lv).filter(([f]) => Number(f) !== want).map(([, v]) => v);
      return { ok: lv[want] >= Math.max(...others) + 6, d: `#${m.k + 1} ${want} Hz ${L.round(lv[want] - Math.max(...others), 1)} dB over others` };
    });
    return { pass: res.every((r) => r.ok), detail: res.map((r) => r.d).join('; ') };
  })();

  // glyph edges that are new against the source: consecutive labels must differ (XOR / union >= 0.2)
  const xors = mids.slice(1).map((m, j) => {
    const a = mids[j].lm?.e, b = m.lm?.e;
    if (!a || !b) return 0;
    let x = 0, u = 0;
    for (let i = 0; i < a.length; i++) { x += a[i] ^ b[i]; u += a[i] | b[i]; }
    return u ? x / u : 0;
  });
  results.labels = { pass: !!p && mids.every((m) => m.dens >= 0.004) && xors.every((v) => v >= 0.2), detail: `label px ${mids.map((m) => L.round(m.dens ?? 0, 4)).join('/')}; consecutive label difference ${xors.map((v) => L.round(v, 2)).join('/')}` };

  // 6. project
  const pj = L.readProject(join(dir, 'reel.mgl.json'));
  const errs = pj ? L.validateRaw(pj) : ['missing or not JSON'];
  results.project = { pass: !errs.length && mediaClips(pj).length === 5, detail: errs[0] ?? `${mediaClips(pj).length} media clips` };

  // 1. the script exists, imports michelangelo, and re-runs on a shorter list (run last; originals restored)
  results.script = await rerun(dir, hl);

  g.check('make-reel.mjs re-runs on highlights.json minus one entry and gives a reel one moment shorter', results.script.rerun, results.script.detail);
  g.check('[lib] make-reel.mjs imports michelangelo and its re-run writes reel.mgl.json with one media clip fewer', results.script.pass, results.script.detail);
  g.check('out/reel.mp4: 1920x1080, duration = sum of moments - 4 x 0.5 s (+/- 2 frames), not black, not static, audio not silent', results.render.pass, results.render.detail);
  g.check('each midpoint matches its source at in + offset (SSIM >= 0.8 outside the label); crossfades are blends', results.match.pass, results.match.detail);
  g.check('dominant audio tone at each midpoint matches its source', results.audio.pass, results.audio.detail);
  g.check('lower-left label at each midpoint; label differs between consecutive moments', results.labels.pass, results.labels.detail);
  g.check('[lib] reel.mgl.json validates with 5 media clips', results.project.pass, results.project.detail);
  return g.result();
}

async function rerun(dir, hl) {
  const script = join(dir, 'make-reel.mjs');
  if (!existsSync(script)) return { pass: false, rerun: false, detail: 'make-reel.mjs missing' };
  const imports = IMPORT_RE.test(readFileSync(script, 'utf8'));
  const keep = ['highlights.json', 'reel.mgl.json', 'out/reel.mp4'], bak = join(dir, '.grade-backup');
  rmSync(bak, { recursive: true, force: true });
  mkdirSync(join(bak, 'out'), { recursive: true });
  for (const f of keep) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(bak, f));
  try {
    const short = hl.filter((_, i) => i !== 2);
    writeFileSync(join(dir, 'highlights.json'), `${JSON.stringify(short, null, 2)}\n`);
    for (const f of keep.slice(1)) rmSync(join(dir, f), { force: true });
    const r = await L.runAgentCode(process.execPath, ['make-reel.mjs'], { cwd: dir, timeoutMs: 600_000 });
    const p = await L.probe(join(dir, 'out/reel.mp4'));
    const pj = L.readProject(join(dir, 'reel.mgl.json'));
    const want = total(short), n = pj ? mediaClips(pj).length : 0;
    const rerunOk = r.code === 0 && !r.timedOut && !!p && Math.abs(p.duration - want) <= 2 / 30 + 0.02;
    return { pass: imports && rerunOk && n === 4, rerun: rerunOk, detail: `${imports ? '' : 'does not import michelangelo; '}exit ${r.code}${r.timedOut ? ' (timed out)' : ''}; reel ${p ? L.round(p.duration, 3) : 'missing'} s (want ${want}); ${n} media clips${r.code ? `; ${r.stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}` : ''}` };
  } finally {
    for (const f of keep) { rmSync(join(dir, f), { force: true }); if (existsSync(join(bak, f))) renameSync(join(bak, f), join(dir, f)); }
    rmSync(bak, { recursive: true, force: true });
  }
}
