import { silent, editText, replaceWith, swap } from '../_lib/mutate.mjs';
import { ff } from '../_lib/proc.mjs';

export const mutants = [
  { name: 'render without captions', apply: (d) => swap(d, 'out/vlog.mp4', (_s, dst) => ff(['-i', `${d}/media/bg.mp4`, '-i', `${d}/vlog.wav`, '-c:v', 'copy', '-c:a', 'aac', '-shortest', dst])) },
  { name: 'silent render', apply: (d) => silent(d, 'out/vlog.mp4') },
  { name: 'a word dropped', apply: (d) => editText(d, 'out/vlog.srt', (s) => s.replace(/\bcinnamon /, '')) },
  { name: 'vtt missing', apply: (d) => replaceWith(d, 'out/vlog.srt', 'out/vlog.vtt') },
  { name: 'cue shifted 1 s late', apply: (d) => editText(d, 'out/vlog.srt', (s) => s.replace(/00:00:01,(\d{3}) -->/, '00:00:02,$1 -->')) },
];
