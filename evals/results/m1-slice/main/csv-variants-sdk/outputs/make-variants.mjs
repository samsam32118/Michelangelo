import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { open } from 'michelangelo';

const [header, ...rows] = readFileSync('products.csv', 'utf8').trim().split(/\r?\n/);
const cols = header.split(',');
const products = rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v.trim()])));

mkdirSync('variants', { recursive: true });
mkdirSync('out', { recursive: true });
for (const prod of products) {
  const file = `variants/${prod.id}.mgl.json`;
  copyFileSync('promo.mgl.json', file);
  const p = await open(file);
  await p.edit([
    { op: 'project.set', name: `Product promo – ${prod.name}` },
    { op: 'clip.set', id: 'bg', color: prod.colour },
    { op: 'clip.set', id: 'name', text: prod.name },
    { op: 'clip.set', id: 'price', text: `$${Number(prod.price).toFixed(2)}` },
  ]);
  await p.render(`out/${prod.id}.png`, { still: '1s' });
  console.log(`${prod.id}: ${prod.name} ${prod.price} ${prod.colour} -> out/${prod.id}.png`);
}
