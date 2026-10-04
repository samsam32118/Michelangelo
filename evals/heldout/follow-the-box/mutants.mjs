import { black, frozen, refilter, swap } from '../_lib/mutate.mjs';
import { ff } from '../_lib/proc.mjs';
import { PATH } from './setup.mjs';

const R = 'out/tracked.mp4';
export const mutants = [
  { name: 'black', apply: (d) => black(d, R) },
  { name: 'frozen', apply: (d) => frozen(d, R) },
  { name: 'label pinned to the centre', apply: (d) => swap(d, R, (_s, dst) => ff(['-i', `${d}/drone.mp4`, '-vf', 'drawbox=x=850:y=400:w=220:h=64:t=fill:c=white', '-c:v', 'libx264', '-preset', 'ultrafast', dst])) },
  { name: 'label lags 0.5 s behind', apply: (d) => swap(d, R, (_s, dst) => {
    const lag = (e) => e.replaceAll('*t', '*(t-0.5)');
    const fc = `color=c=white:s=220x64:r=30:d=8,format=yuva420p[p];[0:v][p]overlay=x='${lag(PATH.cx)}-110':y='${lag(PATH.cy)}-144':eval=frame[v]`;
    return ff(['-i', `${d}/drone.mp4`, '-filter_complex', fc, '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-t', '8', dst]);
  }) },
  { name: 'box covered', apply: (d) => refilter(d, R, { vf: "drawbox=x=0:y=0:w=iw:h=ih:t=fill:c=black@0.7" }) },
];
