// Builds one promo variant per row of products.csv from promo.mgl.json and renders a PNG still at 1 s.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open } from 'michelangelo';

const [header, ...lines] = readFileSync('products.csv', 'utf8').trim().split(/\r?\n/);
const cols = header.split(',');
const products = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v.trim()])));

mkdirSync('variants', { recursive: true });
mkdirSync('out', { recursive: true });

for (const { id, name, price, colour } of products) {
  const p = await open('promo.mgl.json');
  await p.edit([
    { op: 'text.set', id: 'name', text: name },
    { op: 'text.set', id: 'price', text: `$${Number(price).toFixed(2)}` },
    { op: 'clip.set', id: 'bg', color: colour },
  ], { save: false });
  const file = `variants/${id}.mgl.json`;
  writeFileSync(file, p.text());

  const v = await open(file);
  const report = await v.check();
  const r = await v.render(`out/${id}.png`, { still: '1s' });
  console.log(`${id}: ${name} $${price} ${colour} -> ${r.out} ${r.width}x${r.height} (check: ${report.errors} errors, ${report.findings.length} findings)`);
}
