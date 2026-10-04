import { black, swap } from '../_lib/mutate.mjs';
import { ff } from '../_lib/proc.mjs';

const R = 'out/chart.mp4';
export const mutants = [
  { name: 'black', apply: (d) => black(d, R) },
  { name: 'frozen final frame (no growth)', apply: (d) => swap(d, R, (s, dst) => ff(['-sseof', '-0.5', '-i', s, '-vf', 'trim=end_frame=1,tpad=stop_mode=clone:stop_duration=7,setpts=PTS-STARTPTS', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', dst])) },
  { name: 'labels missing', apply: (d) => swap(d, R, (s, dst) => ff(['-i', s, '-vf', 'drawbox=x=0:y=856:w=1920:h=224:t=fill:c=white', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', dst])) },
  { name: 'grey background', apply: (d) => swap(d, R, (s, dst) => ff(['-i', s, '-vf', 'drawbox=x=0:y=0:w=60:h=60:t=fill:c=0xe5e7eb', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', dst])) },
];
