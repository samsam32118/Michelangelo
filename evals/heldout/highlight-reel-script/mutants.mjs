import { readFileSync, writeFileSync } from 'node:fs';
import { black, silent, editText, swap } from '../_lib/mutate.mjs';
import { ff, run } from '../_lib/proc.mjs';

const R = 'out/reel.mp4';
export const mutants = [
  { name: 'black', apply: (d) => black(d, R) },
  { name: 'silent', apply: (d) => silent(d, R) },
  { name: 'labels removed', apply: (d) => swap(d, R, (s, dst) => ff(['-i', s, '-i', s, '-filter_complex', '[0:v]crop=iw:ih/2:0:0[t];[1:v]crop=iw:ih/2:0:ih/2,hflip[b];[t][b]vstack[v]', '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'copy', dst])) },
  { name: 'script hard-codes the list', apply: (d) => editText(d, 'make-reel.mjs', (s) => s.replace("JSON.parse(readFileSync('highlights.json', 'utf8'))", readFileSync(`${d}/highlights.json`, 'utf8').trim())) },
  { name: 'one caption for every moment', apply: async (d) => {
    const files = ['highlights.json', 'reel.mgl.json', 'out/reel.mp4'], keep = files.map((f) => readFileSync(`${d}/${f}`));
    writeFileSync(`${d}/highlights.json`, JSON.stringify(JSON.parse(keep[0]).map((h) => ({ ...h, caption: 'Highlights' }))));
    await run(process.execPath, ['make-reel.mjs'], { cwd: d });
    return () => files.forEach((f, i) => writeFileSync(`${d}/${f}`, keep[i]));
  } },
  { name: 'project lists 4 clips', apply: (d) => editText(d, 'reel.mgl.json', (s) => s.split('\n').filter((l) => !l.startsWith('{"id": "m5"') && !l.startsWith('{"id": "cap5"')).join('\n')) },
];
