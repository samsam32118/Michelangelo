import { join } from 'node:path';
import { readFileSync, existsSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as L from '../_lib/index.mjs';
import { QUOTES, SPANS } from './setup.mjs';

const W = 1080, H = 1350;
const norm = (s) => String(s).toLowerCase().replace(/[“”‘’"'`«»—–-]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const strings = (v, acc = []) => { if (typeof v === 'string') acc.push(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, acc); return acc; };
const isQuoteCard = (c) => (c.tags ?? []).some((t) => /quote-card/i.test(String(t))) || /quote-card/i.test(String(c.gen?.type ?? ''));

function mglBin(dir) {
  for (const f of [process.env.MGL_EVAL_MGL, join(dir, 'node_modules/.bin/mgl'), join(dir, 'node_modules/michelangelo/dist/cli/main.js')]) if (f && existsSync(f)) return f;
  return null;
}

/** Template instances: groups of quote-card clips covering [from, to] (comp frames), with every string inside. */
function instances(pj) {
  const fps = L.compFps(L.tables(pj, 'comps')[0]);
  const qc = L.tables(pj, 'clips').filter(isQuoteCard).map((c) => {
    const s = L.clipSpan(pj, c);
    // a nested comp's own clips belong to the instance too
    const inner = c.comp !== undefined ? L.tables(pj, 'clips').filter((k) => L.tables(pj, 'tracks').some((t) => t.id === k.track && t.comp === c.comp)) : [];
    return { at: s.at, end: s.end, text: [c, ...inner].flatMap((x) => strings(x)), fps };
  });
  return SPANS.map(([a, b]) => {
    const g = qc.filter((c) => c.at >= a - 1 && c.end <= b + 1);
    return g.length ? { at: Math.min(...g.map((c) => c.at)), end: Math.max(...g.map((c) => c.end)), text: g.flatMap((c) => c.text) } : null;
  });
}

function accents(img) {
  const g = L.colorMask(img, '#22c55e', 8), r = L.colorMask(img, '#ef4444', 8);
  return { gRun: L.longestVerticalRun(g, img.width), rRun: L.longestVerticalRun(r, img.width), gN: L.maskCount(g, img.width), rN: L.maskCount(r, img.width) };
}

export async function grade(dir) {
  const g = L.grader();
  const quotes = L.readSetup(dir).info.quotes ?? QUOTES;
  const pdir = join(dir, 'plugins/quote-card');
  const mgl = mglBin(dir);

  await g.checkAsync('[lib] plugins/quote-card: manifest api ^1 with kind template; `mgl plugin test plugins/quote-card` exits 0', async () => {
    let m;
    try { m = JSON.parse(readFileSync(join(pdir, 'package.json'), 'utf8')); } catch { return { pass: false, detail: 'plugins/quote-card/package.json missing or not JSON' }; }
    const api = String(m?.michelangelo?.api ?? '').trim(), kinds = [].concat(m?.michelangelo?.kinds ?? []);
    const manifest = /^(\^|~|>=\s*)?1(\.\d+){0,2}$/.test(api) && kinds.includes('template');
    if (!mgl) return { pass: false, detail: `manifest ${manifest ? 'ok' : `bad (api "${api}", kinds ${kinds})`}; mgl not found to run plugin test` };
    const r = await L.runAgentCode(process.execPath, [mgl, 'plugin', 'test', 'plugins/quote-card'], { cwd: dir, timeoutMs: 300_000 });
    return { pass: manifest && r.code === 0 && !r.timedOut, detail: `manifest ${manifest ? 'ok' : `bad (api "${api}", kinds ${kinds})`}; plugin test exit ${r.code}${r.timedOut ? ' (timed out)' : ''}${r.code ? `: ${(r.stdout.toString() + r.stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 200)}` : ''}` };
  });

  const pj = L.readProject(join(dir, 'reel.mgl.json'));
  const inst = pj && !L.validateRaw(pj).length ? instances(pj) : [null, null];
  g.check('[lib] reel.mgl.json names the plugin and has quote-card entities at frames 30-150 and 180-300 with the quotes.json text', (() => {
    if (!pj || L.validateRaw(pj).length) return false;
    const named = Object.keys(pj.project?.plugins ?? {}).some((k) => /(^|\/)quote-card$/.test(k));
    return named && inst.every((it, i) => it && Math.abs(it.at - SPANS[i][0]) <= 1 && Math.abs(it.end - SPANS[i][1]) <= 1
      && it.text.some((s) => norm(s) === norm(quotes[i].quote)) && it.text.some((s) => norm(s).includes(norm(quotes[i].author))));
  })(), pj ? (L.validateRaw(pj)[0] ?? `plugins ${Object.keys(pj.project?.plugins ?? {}).join(',') || 'none'}; instances ${inst.map((it) => (it ? `${it.at}-${it.end}` : 'none')).join(', ')}`) : 'missing or not JSON');

  const [q1, q2] = await Promise.all(['out/q1.png', 'out/q2.png'].map(async (f) => { const p = await L.probe(join(dir, f)); return p?.video?.width === W && p.video.height === H ? L.imageRGB(join(dir, f)) : null; }));
  const [a1, a2] = [q1, q2].map((q) => (q ? accents(q) : null));
  g.check('out/q1.png and out/q2.png: 1080x1350, not one colour; q1 has a >= 80 px vertical #22c55e run and no #ef4444, q2 the opposite',
    q1 && q2 && [q1, q2].every((q) => L.colourSpread(q).std > 5) && a1.gRun >= 80 && a1.rN < 30 && a2.rRun >= 80 && a2.gN < 30,
    [a1, a2].map((a, i) => (a ? `q${i + 1}: green run ${a.gRun} (${a.gN} px), red run ${a.rRun} (${a.rN} px)` : `q${i + 1}: missing or not 1080x1350`)).join('; '));

  await g.checkAsync('text glyphs in the card region of both stills; glyph regions differ between q1 and q2', async () => {
    if (!q1 || !q2) return { pass: false, detail: 'stills missing' };
    const [b1, b2] = await Promise.all([3, 8].map((t) => L.frameAt(join(dir, 'media/bg.mp4'), t + 0.02)));
    const card = (q, b) => {
      const m = L.diffMask(q, b, 60), bl = L.blobs(m, W, { minArea: 2000 });
      if (!bl.length) return null;
      const box = [Math.min(...bl.map((x) => x.x0)), Math.min(...bl.map((x) => x.y0)), Math.max(...bl.map((x) => x.x1)) + 1, Math.max(...bl.map((x) => x.y1)) + 1];
      return { m, box, area: bl.reduce((s, x) => s + x.area, 0), edges: L.edgeDensity(q, box, 100) };
    };
    const c1 = card(q1, b1), c2 = card(q2, b2);
    if (!c1 || !c2) return { pass: false, detail: 'no card found (stills equal the background)' };
    let diff = 0, both = 0;
    const L1 = L.luma(q1), L2 = L.luma(q2);
    for (let i = 0; i < c1.m.length; i++) if (c1.m[i] && c2.m[i]) { both++; if (Math.abs(L1[i] - L2[i]) > 60) diff++; }
    const ok = [c1, c2].every((c) => c.area >= 0.03 * W * H && c.edges >= 0.01) && both > 0 && diff / both >= 0.02;
    return { pass: ok, detail: `card areas ${c1.area}/${c2.area} px, edge density ${L.round(c1.edges, 3)}/${L.round(c2.edges, 3)}; q1 vs q2 differ on ${L.round(both ? diff / both : 0, 3)} of the card` };
  });

  await g.checkAsync('[lib] nothing of the cards before 1 s: no accent colour at 0.5 s', async () => {
    if (!pj || L.validateRaw(pj).length) return { pass: false, detail: 'project missing or invalid' };
    const at15 = L.tables(pj, 'clips').filter((c) => { const s = L.clipSpan(pj, c); return !s.audioTrack && s.at <= 15 && s.end > 15; });
    const leaks = at15.filter((c) => isQuoteCard(c) || strings(c).some((s) => /22c55e|ef4444/i.test(s)));
    let px = 'not rendered';
    if (mgl && !leaks.length) {
      const tmp = mkdtempSync(join(tmpdir(), 'mglh-qc-'));
      try {
        chmodSync(tmp, 0o777);
        const still = join(tmp, 'still.png');
        const r = await L.runAgentCode(process.execPath, [mgl, 'render', 'reel.mgl.json', still, '--still', '0.5s'], { cwd: dir, timeoutMs: 300_000 });
        const img = r.code === 0 ? await L.imageRGB(still) : null;
        if (img) { const a = accents(img); px = `${a.gN + a.rN} accent px`; if (a.gN + a.rN >= 30) return { pass: false, detail: `still at 0.5 s has ${px}` }; } else px = `still render failed (exit ${r.code}); judged from the project`;
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    }
    return { pass: !leaks.length, detail: leaks.length ? `active at 0.5 s: ${leaks.map((c) => c.id).join(', ')}` : `no card entity active at 0.5 s; ${px}` };
  });
  return g.result();
}
