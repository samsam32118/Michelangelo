import { editText, replaceWith } from '../_lib/mutate.mjs';

export const mutants = [
  { name: 'both stills the same', apply: (d) => replaceWith(d, 'out/q1.png', 'out/q2.png') },
  { name: 'quote text altered in the project', apply: (d) => editText(d, 'reel.mgl.json', (s) => s.replace('remarkable', 'notable')) },
  { name: 'first card starts at 0', apply: (d) => editText(d, 'reel.mgl.json', (s) => s.replace(/"at": 30,/g, '"at": 0,').replace(/"len": 120,/g, '"len": 150,')) },
  { name: 'plugin not named in the project', apply: (d) => editText(d, 'reel.mgl.json', (s) => s.replace(/"plugins": \{[^}]*\}/, '"plugins": {}')) },
];
