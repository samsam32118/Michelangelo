import { join } from 'node:path';
import { grader, readProject, validateRaw, outputs, probe, frameAt, round, assertNotEmpty } from '../../lib/index.mjs';

const screen = (a, b) => 255 - ((255 - a) * (255 - b)) / 255;

export async function grade(dir) {
  const g = grader();
  const p = readProject(join(dir, 'layers.mgl.json'));
  const clip = (id) => (p?.clips ?? []).find((c) => c.id === id);
  const top = clip('top'), leak = clip('leak');
  const ell = (top?.masks ?? []).find((m) => m.shape === 'ellipse' && (m.feather ?? 0) > 0 && !m.invert);
  const centred = ell && (() => {
    if (!ell.box) return true;
    const [x, y, w, h] = ell.box;
    const clipSpace = ell.space === 'clip' || [x, y, w, h].every((v) => v <= 1);
    const [cx, cy] = clipSpace ? [(x + w / 2) * 1280, (y + h / 2) * 720] : [x + w / 2, y + h / 2];
    return Math.abs(cx - 640) < 130 && Math.abs(cy - 360) < 72;
  })();
  g.check('[lib] top clip has a centred ellipse mask with feather > 0 (not hidden, opacity unchanged)', !!ell && !!centred && !top.hidden && top.opacity === undefined && !!p && !validateRaw(p).length,
    top ? `masks ${JSON.stringify(top.masks ?? null)}` : 'top clip missing');
  g.check('[lib] light leak clip blend = screen', leak?.blend === 'screen' && !leak.hidden && (leak.opacity === undefined || leak.opacity >= 0.5), leak ? `blend ${leak.blend}, opacity ${leak.opacity}` : 'leak clip missing');
  await g.checkAsync('still: centre = smptebars screen leak, corners = testsrc2 screen leak, nothing darker than the base', async () => {
    const W = 320, H = 180;
    const [base, bars, lk] = await Promise.all(['base', 'bars', 'leak'].map((n) => frameAt(join(dir, `media/${n}.mp4`), 2, { width: W, height: H })));
    const regions = { centre: [W * 0.42, H * 0.42, W * 0.16, H * 0.16], tl: [0, 0, W * 0.1, H * 0.1], tr: [W * 0.9, 0, W * 0.1, H * 0.1], bl: [0, H * 0.9, W * 0.1, H * 0.1], br: [W * 0.9, H * 0.9, W * 0.1, H * 0.1] };
    const notes = [];
    for (const f of outputs(dir, /\.png$/).slice(0, 8)) {
      const pi = await probe(join(dir, f));
      if (!pi || Math.abs(pi.width / pi.height - 16 / 9) > 0.02) continue;
      const img = await frameAt(join(dir, f), 0, { width: W, height: H });
      const err = {};
      let darker = 0, n = 0;
      for (const [k, [x0, y0, w, h]] of Object.entries(regions)) {
        const under = k === 'centre' ? bars : base;
        let s = 0, c = 0;
        for (let y = Math.round(y0); y < Math.round(y0 + h); y++) for (let x = Math.round(x0); x < Math.round(x0 + w); x++) {
          const i = (y * W + x) * 4;
          for (let ch = 0; ch < 3; ch++) {
            s += Math.abs(img.data[i + ch] - screen(under.data[i + ch], lk.data[i + ch])); c++;
            if (k !== 'centre') { n++; if (img.data[i + ch] < under.data[i + ch] - 25) darker++; }
          }
        }
        err[k] = s / c;
      }
      const ok = Object.values(err).every((e) => e < 30) && darker / n < 0.02 && (await assertNotEmpty(join(dir, f), { still: true })).pass;
      notes.push(`${f}: error ${Object.entries(err).map(([k, e]) => `${k} ${round(e, 1)}`).join(' ')}, darker ${round(darker / n, 3)}`);
      if (ok) return { pass: true, detail: notes.at(-1) };
    }
    return { pass: false, detail: notes.join('; ') || 'no 16:9 PNG still' };
  });
  return g.result();
}
