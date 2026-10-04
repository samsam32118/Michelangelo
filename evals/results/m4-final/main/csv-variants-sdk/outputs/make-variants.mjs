import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { open } from 'michelangelo';

const [header, ...lines] = readFileSync('products.csv', 'utf8').trim().split(/\r?\n/);
const cols = header.split(',');
const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v.trim()])));

mkdirSync('out', { recursive: true });
mkdirSync('variants', { recursive: true });
for (const r of rows) {
  const p = await open('promo.mgl.json');
  await p.edit([
    { op: 'text.set', id: 'name', text: r.name },
    { op: 'text.set', id: 'price', text: `$${Number(r.price).toFixed(2)}` },
    { op: 'clip.set', id: 'bg', color: r.colour },
  ], { save: false });
  writeFileSync(`variants/${r.id}.mgl.json`, p.text());
  const res = await p.render(`out/${r.id}.png`, { still: '1s' });
  console.log(`${r.id}: ${res.out} ${res.width}x${res.height}`);
}
