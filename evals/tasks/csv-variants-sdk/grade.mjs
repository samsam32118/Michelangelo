import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { grader, readSetup, probe, frameAt, meanColor, deltaE, hex, mask, findFiles, round, assertNotEmpty, readProject, validateRaw, textClips } from '../../lib/index.mjs';

export async function grade(dir) {
  const g = grader();
  const { info } = readSetup(dir);
  const rows = info.products;
  const files = rows.map(([id]) => join(dir, 'out', `${id}.png`));
  const probes = await Promise.all(files.map((f) => probe(f)));
  g.check('10 PNGs out/<id>.png at the comp size (1080x1080)', probes.every((p) => p && p.width === 1080 && p.height === 1080),
    `${probes.filter((p) => p && p.width === 1080 && p.height === 1080).length}/10 present at 1080x1080`);
  const imgs = await Promise.all(files.map((f, i) => (probes[i] ? frameAt(f, 0) : undefined)));
  const des = imgs.map((img, i) => (img ? deltaE(meanColor(img, [8, 8, 60, 60]), hex(rows[i][3])) : 99));
  g.check('background colour of each matches its CSV colour (delta E < 5)', des.every((d) => d < 5), `delta E ${des.map((d) => round(d, 1)).join(' ')}`);
  // the variants come from the library: a script that imports it, or 10 variant projects (one per row) that carry
  // the row's name and price; plus (below) per-row differences in the rendered name and price
  const scripts = findFiles(dir, /\.(m?js|m?ts|cjs)$/).filter((f) => !f.startsWith('plugins/') && /from\s*['"]michelangelo['"]|import\(\s*['"]michelangelo['"]\s*\)|require\(\s*['"]michelangelo['"]\s*\)/.test(readFileSync(join(dir, f), 'utf8')));
  const variants = findFiles(dir, /\.mgl\.json$/).filter((f) => f !== 'promo.mgl.json').map((f) => ({ f, p: readProject(join(dir, f)) })).filter((x) => x.p && !validateRaw(x.p).length);
  const texts = (p) => textClips(p).map((c) => c.text);
  const perRow = rows.map(([, name, price]) => variants.find((v) => texts(v.p).some((t) => t.includes(name)) && texts(v.p).some((t) => t.includes(price))));
  const projectsOk = perRow.every(Boolean) && new Set(perRow.map((v) => v.f)).size === rows.length;
  g.check('made with the library: a script importing michelangelo, or 10 valid variant projects each with its name and price', scripts.length > 0 || projectsOk,
    `scripts: ${scripts.join(', ') || 'none'}; variant projects with name and price: ${perRow.filter(Boolean).length}/10`);
  if (variants.length >= rows.length) {
    // when the variants were saved as projects, their prices must be the CSV's
    const missing = rows.filter((r, i) => !perRow[i]).map((r) => r[0]);
    g.check('variant projects carry each product\'s price and name', !missing.length, missing.length ? `no project with the name and price of ${missing.join(', ')}` : '10/10');
  }
  await g.checkAsync('name glyph region differs between variants (and has text)', async () => {
    if (!imgs.every(Boolean)) return { pass: false, detail: 'missing PNGs' };
    const masks = imgs.map((img, i) => { const bg = hex(rows[i][3]); return mask(img, (r, gg, b) => Math.max(Math.abs(r - bg[0]), Math.abs(gg - bg[1]), Math.abs(b - bg[2])) > 80, info.nameBand); });
    const counts = masks.map((m) => m.reduce((a, v) => a + v, 0));
    let minX = 1;
    for (let i = 0; i < masks.length; i++) for (let j = i + 1; j < masks.length; j++) {
      let x = 0, u = 0;
      for (let k = 0; k < masks[i].length; k++) { if (masks[i][k] || masks[j][k]) u++; if (masks[i][k] !== masks[j][k]) x++; }
      minX = Math.min(minX, u ? x / u : 0);
    }
    const ne = await assertNotEmpty(files[0], { still: true });
    return { pass: counts.every((c) => c > 400) && minX > 0.15 && ne.pass, detail: `text px ${Math.min(...counts)}..${Math.max(...counts)}, min pairwise XOR/union ${round(minX, 3)}` };
  });
  await g.checkAsync('price region has text in each variant and differs between rows with different prices', async () => {
    if (!imgs.every(Boolean)) return { pass: false, detail: 'missing PNGs' };
    const band = info.priceBand ?? [0, 560, 1080, 220];
    const masks = imgs.map((img, i) => { const bg = hex(rows[i][3]); return mask(img, (r, gg, b) => Math.max(Math.abs(r - bg[0]), Math.abs(gg - bg[1]), Math.abs(b - bg[2])) > 80, band); });
    const counts = masks.map((m) => m.reduce((a, v) => a + v, 0));
    let minX = 1;
    for (let i = 0; i < masks.length; i++) for (let j = i + 1; j < masks.length; j++) {
      if (rows[i][2] === rows[j][2]) continue;
      let x = 0, u = 0;
      for (let k = 0; k < masks[i].length; k++) { if (masks[i][k] || masks[j][k]) u++; if (masks[i][k] !== masks[j][k]) x++; }
      minX = Math.min(minX, u ? x / u : 0);
    }
    return { pass: counts.every((c) => c > 200) && minX > 0.05, detail: `price px ${Math.min(...counts)}..${Math.max(...counts)}, min pairwise XOR/union ${round(minX, 3)}` };
  });
  return g.result();
}
