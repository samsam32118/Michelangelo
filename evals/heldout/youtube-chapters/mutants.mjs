import { black, frozen, silent, editText, refilter } from '../_lib/mutate.mjs';

const R = 'out/lesson.mp4';
export const mutants = [
  { name: 'black', apply: (d) => black(d, R) },
  { name: 'frozen', apply: (d) => frozen(d, R) },
  { name: 'silent', apply: (d) => silent(d, R) },
  { name: 'cards never end (dark throughout)', apply: (d) => refilter(d, R, { vf: 'drawbox=t=fill:c=black@0.6' }) },
  { name: 'chapter times in seconds-only format', apply: (d) => editText(d, 'out/chapters.txt', (s) => s.replace(/^00:/gm, '0:')) },
  { name: 'markers off by a second', apply: (d) => editText(d, 'lesson.mgl.json', (s) => s.replace(/"at": 360/, '"at": 390')) },
];
