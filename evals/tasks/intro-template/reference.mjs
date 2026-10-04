// Reference solution with plain ffmpeg + a hand-written project: a 4 s animated title card, then cook.mp4.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, formatProject } from '../../lib/index.mjs';
import { hasDrawtext, drawtext } from '../../lib/fixtures.mjs';

export async function solve(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(join(dir, 'intro.mgl.json'), formatProject({ michelangelo: 1, assets: [{ id: 'cook-mp4', src: 'cook.mp4' }], comps: [{ id: 'main', size: [1920, 1080], fps: 30, length: 360 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }], clips: [{ id: 'cook', track: 'V1', at: 120, len: 240, asset: 'cook-mp4' }, { id: 'title', track: 'T1', at: 0, len: 120, text: 'Kitchen Lab', style: 'title', animate: { in: 'pop', by: 'word' } }] }));
  const title = (await hasDrawtext()) ? drawtext('Kitchen Lab', { fontsize: "'40+60*min(t,1)'", fontcolor: 'white', borderw: 6, bordercolor: 'black' }) : 'drawbox=x=600:y=500:w=t*300:h=80:color=white:t=fill';
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x223344:size=1920x1080:rate=30:duration=4', '-i', join(dir, 'cook.mp4'), '-filter_complex',
    `[0:v]${title},format=yuv420p,setsar=1[a];[1:v]format=yuv420p,setsar=1[b];[a][b]concat=n=2:v=1:a=0[v]`, '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', join(dir, 'out/intro.mp4')]);
}
