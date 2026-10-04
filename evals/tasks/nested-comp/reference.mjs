// Reference solution: a hand-written project (badge comp used 3 times) and the render drawn with plain ffmpeg.
// The three instances (0-5 s, 3-8 s, 6-11 s) are never all on screen at once.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  writeFileSync(join(dir, 'badges.mgl.json'), formatProject({ michelangelo: 1,
    comps: [{ id: 'main', size: [1920, 1080], fps: 30, length: 330, bg: '#202830' }, { id: 'badge', size: [1080, 1080], fps: 30, length: 150 }],
    tracks: [{ id: 'B1', comp: 'badge' }, { id: 'B2', comp: 'badge' }, { id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }, { id: 'V3', comp: 'main' }],
    clips: [
      { id: 'disc', track: 'B1', at: 0, len: 150, shape: { type: 'ellipse', size: [1040, 1040], fill: '#e63240' }, rotate: [[0, 0], [150, 360]] },
      { id: 'new', track: 'B2', at: 0, len: 150, text: 'NEW', rotate: [[0, 0], [150, 360]] },
      { id: 'u1', track: 'V1', at: 0, len: 150, comp: 'badge', x: 250, y: 540, scale: 0.28 },
      { id: 'u2', track: 'V2', at: 90, len: 150, comp: 'badge', x: 825, y: 540, scale: 0.42 },
      { id: 'u3', track: 'V3', at: 180, len: 150, comp: 'badge', x: 1510, y: 540, scale: 0.57 },
    ] }));
  mkdirSync(join(dir, 'out'), { recursive: true });
  // the badge drawn once (a disc with an off-centre bar standing in for the text), then rotated per frame
  const png = join(dir, 'out/.badge.png');
  await ffmpeg(['-f', 'lavfi', '-i', "color=c=black@0:s=1080x1080:d=1,format=rgba,geq=r='230':g='50':b='60':a='if(lte(hypot(X-540\\,Y-540)\\,520)\\,255\\,0)',drawbox=x=540:y=490:w=420:h=100:color=white:t=fill", '-frames:v', '1', png]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x202830:s=1920x1080:r=30:d=11', '-loop', '1', '-framerate', '30', '-t', '5', '-i', png, '-filter_complex',
    '[1:v]format=rgba,rotate=a=2*PI*t/5:c=none,split=3[a][b][c];[a]scale=300:300[a1];[b]scale=450:450,setpts=PTS+3/TB[b1];[c]scale=620:620,setpts=PTS+6/TB[c1];'
    + '[0:v][a1]overlay=100:390:eof_action=pass[v1];[v1][b1]overlay=600:315:eof_action=pass[v2];[v2][c1]overlay=1200:230:eof_action=pass,format=yuv420p[v]',
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', join(dir, 'out/badges.mp4')]);
}
