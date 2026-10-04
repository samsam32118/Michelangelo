import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { open } from 'michelangelo';

mkdirSync('out', { recursive: true });
mkdirSync('variants', { recursive: true });

const rows = readFileSync('products.csv', 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
for (const [id, name, price, colour] of rows) {
  const p = await open('promo.mgl.json');
  await p.edit([
    { op: 'text.set', id: 'name', text: name },
    { op: 'text.set', id: 'price', text: `$${Number(price).toFixed(2)}` },
    { op: 'clip.set', id: 'bg', color: colour },
    { op: 'project.set', name: `Product promo - ${name}` },
  ], { save: false });
  writeFileSync(`variants/${id}.mgl.json`, p.text());
  const v = await open(`variants/${id}.mgl.json`);
  const r = await v.render(resolve('out', `${id}.png`), { still: '1s' });
  console.log(id, r.out, `${r.width}x${r.height}`);
}
