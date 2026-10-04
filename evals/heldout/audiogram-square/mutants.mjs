import { black, frozen, silent, refilter } from '../_lib/mutate.mjs';

const R = 'out/audiogram.mp4';
export const mutants = [
  { name: 'black', apply: (d) => black(d, R) },
  { name: 'frozen', apply: (d) => frozen(d, R) },
  { name: 'silent', apply: (d) => silent(d, R) },
  { name: 'visualiser covered', apply: (d) => refilter(d, R, { vf: 'drawbox=x=0:y=300:w=1080:h=500:t=fill:c=0x101828' }) },
  { name: 'audio delayed 0.3 s', apply: (d) => refilter(d, R, { af: 'adelay=300,atrim=0:12' }) },
];
