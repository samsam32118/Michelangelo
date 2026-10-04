// Degraded outputs that the grader must reject (used by _validate.mjs).
import { join } from 'node:path';
import { black, frozen, silent, swap } from '../_lib/mutate.mjs';
import { ff } from '../_lib/proc.mjs';

const R = 'out/podcast.mp4';
export const mutants = [
  { name: 'black', apply: (d) => black(d, R) },
  { name: 'frozen', apply: (d) => frozen(d, R) },
  { name: 'silent', apply: (d) => silent(d, R) },
  { name: 'camera audio mixed in', apply: (d) => swap(d, R, (src, dst) => ff(['-i', src, '-i', join(d, 'guest.mp4'), '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', dst])) },
  { name: 'host camera only', apply: (d) => swap(d, R, (src, dst) => ff(['-i', join(d, 'host.mp4'), '-i', src, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'copy', dst])) },
];
