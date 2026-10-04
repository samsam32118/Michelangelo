import { join } from 'node:path';
import { speechTrack, videoWithAudio, finish, hasDrawtext, drawtext } from '../_lib/fx.mjs';

export const D = 9;
export async function setup(dir) {
  await hasDrawtext();
  const vo = join(dir, '.golden', 'vo.wav');
  await speechTrack(vo, [[0.3, 'This is the main window of the editor.'], [3.1, 'Up here are the settings. Turn on auto save, and set the interval to five minutes.'], [7.4, 'That is all there is to it.']], D);
  const st = [
    'drawbox=x=40:y=40:w=860:h=1000:color=0x323f4b:t=fill', 'drawbox=x=80:y=600:w=780:h=400:color=0x3e4c59:t=fill',
    'drawbox=x=1000:y=40:w=880:h=480:color=0x52606d:t=fill', 'drawbox=x=1000:y=580:w=880:h=460:color=0x3e4c59:t=fill',
    drawtext('Settings', { fontsize: 48, fontcolor: 'white', x: 1040, y: 60 }),
    ...['Auto save', 'Interval', 'Theme', 'Language', 'Backups'].map((t, i) => drawtext(t, { fontsize: 34, fontcolor: '0xe4e7eb', x: 1050, y: 140 + i * 72 })),
    ...[0, 1, 2, 3, 4].map((i) => `drawbox=x=1560:y=${136 + i * 72}:w=${i % 2 ? 260 : 110}:h=46:color=${['0x2680c2', 0x9aa5b1, '0x3ebd93', '0xf0b429', '0xe12d39'][i].toString().replace(/^(\d+)$/, (n) => '0x' + Number(n).toString(16))}:t=fill`),
    drawtext('Timeline', { fontsize: 40, fontcolor: 'white', x: 80, y: 60 }),
  ].filter(Boolean);
  const vf = `[0:v]${st.join(',')}[bg];color=c=0xcbd2d9:s=700x120:r=30:d=${D}[p];color=c=0xffffff:s=22x34:r=30:d=${D}[c];color=c=0x3ebd93:s=40x40:r=30:d=${D}[k]`
    + `;[bg][p]overlay=x=120:y='700+20*t'[b1];[b1][k]overlay=x='1050+80*t':y=470[b2];[b2][c]overlay=x='1100+60*t':y='200+20*t'[v]`;
  await videoWithAudio(join(dir, 'screencast.mp4'), { src: `color=c=0x1f2933:s=1920x1080:r=30:d=${D}`, vf, audio: vo, d: D });
  return finish(dir, {});
}
