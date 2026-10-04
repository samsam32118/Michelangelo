import { join } from 'node:path';
import * as F from '../../lib/fixtures.mjs';

export const PRODUCTS = [
  ['p01', 'Aurora Lamp', '49.00', '#1f4e79'], ['p02', 'Basalt Mug', '12.50', '#7a1f1f'], ['p03', 'Cedar Board', '34.90', '#2e5e2e'],
  ['p04', 'Dune Throw', '59.00', '#8a6d1f'], ['p05', 'Ember Candle', '18.00', '#6b2d6b'], ['p06', 'Fjord Bottle', '24.00', '#1f6b6b'],
  ['p07', 'Granite Bowl', '29.50', '#4a4a4a'], ['p08', 'Harbor Tote', '39.00', '#24345e'], ['p09', 'Iris Vase', '44.00', '#5e2440'], ['p10', 'Juniper Soap', '8.90', '#3d5e24'],
];

export async function setup(dir) {
  F.writeText(join(dir, 'products.csv'), ['id,name,price,colour', ...PRODUCTS.map((r) => r.join(','))].join('\n') + '\n');
  F.writeProject(join(dir, 'promo.mgl.json'), {
    project: { name: 'Product promo' },
    comps: [{ id: 'main', size: [1080, 1080], fps: 30, length: 90 }],
    tracks: [{ id: 'BG', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'T2', comp: 'main' }],
    clips: [
      { id: 'bg', track: 'BG', at: 0, len: 90, color: '#333333' },
      { id: 'name', track: 'T1', at: 0, len: 90, text: 'Product name', style: { base: 'title', size: 110 }, y: 420 },
      { id: 'price', track: 'T2', at: 0, len: 90, text: '$0.00', style: { base: 'subtitle', size: 90 }, y: 660 },
    ],
  });
  return F.finish(dir, { products: PRODUCTS, nameBand: [0, 300, 1080, 240] });
}
