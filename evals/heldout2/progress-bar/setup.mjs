import { join } from 'node:path';
import { speechTrack, videoWithAudio, finish, hasDrawtext, drawtext } from '../_lib/fx.mjs';

export const D = 10;
export async function setup(dir) {
  await hasDrawtext();
  const vo = join(dir, '.golden', 'vo.wav');
  await speechTrack(vo, [[0.3, 'Open the settings panel on the right.'], [3.4, 'Then pick export, and choose the format you need.'], [7.2, 'Press save and you are done.']], D);
  const g = [
    'drawbox=x=80:y=80:w=1100:h=820:color=0x3e4c59:t=fill', 'drawbox=x=1240:y=80:w=600:h=820:color=0x52606d:t=fill',
    'drawbox=x=120:y=130:w=1020:h=60:color=0x9aa5b1:t=fill', 'drawbox=x=1280:y=140:w=520:h=90:color=0x2680c2:t=fill',
    'drawbox=x=1280:y=270:w=520:h=90:color=0x7b8794:t=fill', 'drawbox=x=1280:y=400:w=520:h=90:color=0x7b8794:t=fill',
    drawtext('Project settings', { fontsize: 44, fontcolor: 'white', x: 140, y: 140 }),
    drawtext('Export', { fontsize: 40, fontcolor: 'white', x: 1300, y: 160 }),
  ].filter(Boolean);
  // moving parts: a scrolling list panel, a highlight sliding down the menu, the cursor
  const vf = `[0:v]${g.join(',')}[bg];color=c=0xcbd2d9:s=900x180:r=30:d=${D}[p];color=c=0xf0b429:s=520x90:r=30:d=${D}[h];color=c=white:s=24x36:r=30:d=${D}[c]`
    + `;[bg][p]overlay=x=160:y='560-40*t'[b1];[b1][h]overlay=x=1280:y='270+50*t'[b2];[b2][c]overlay=x='200+90*t':y='300+40*t'[v]`;
  await videoWithAudio(join(dir, 'tutorial.mp4'), { src: `color=c=0x1f2933:s=1920x1080:r=30:d=${D}`, vf, audio: vo, d: D });
  return finish(dir, {});
}
