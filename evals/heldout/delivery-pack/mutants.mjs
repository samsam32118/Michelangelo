import { black, frozen, silent, editText, swap } from '../_lib/mutate.mjs';
import { ff } from '../_lib/proc.mjs';

export const mutants = [
  { name: 'webm black', apply: (d) => black(d, 'out/web.webm') },
  { name: 'mov frozen', apply: (d) => frozen(d, 'out/master.mov') },
  { name: 'mov silent', apply: (d) => silent(d, 'out/master.mov') },
  { name: 'thumbnail from 1 s', apply: (d) => swap(d, 'out/thumb.jpg', (_s, dst) => ff(['-ss', '1', '-i', `${d}/out/master.mov`, '-frames:v', '1', '-vf', 'scale=1280:720', dst])) },
  { name: 'project reformatted', apply: (d) => editText(d, 'spot.mgl.json', (s) => s.replace('"name": "Spot"', '"name": "Spot "')) },
];
