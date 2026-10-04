import { join } from 'node:path';
import { finish, ensureDir, X264 } from '../_lib/fx.mjs';
import { ffmpeg } from '../../lib/util.mjs';

export const D = 8;
export const SX = '40+25*sin(7.1*t)+12*sin(13.3*t)';
export const SY = '22+14*sin(8.3*t+1)+7*sin(17*t)';
export const MARKERS = { magenta: [730, 510], cyan: [1330, 630] };

export async function setup(dir) {
  const world = ensureDir(join(dir, '.golden', 'world.png'));
  const boxes = [[100, 100, 380, 260, '0x8a6d4b'], [560, 150, 300, 200, '0x4b6a8a'], [1000, 80, 420, 300, '0x9c9c8c'], [1500, 200, 380, 340, '0x7b5c3a'],
    [180, 520, 360, 200, '0x5a7f9c'], [900, 420, 260, 300, '0xa08a70'], [1500, 650, 400, 260, '0x6e7f5a'], [300, 900, 600, 180, '0x8c7a6a'], [1100, 880, 500, 200, '0x5f6f8f']];
  const vf = ['noise=alls=40:allf=u', ...boxes.map(([x, y, w, h, c]) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${c}:t=fill`),
    ...boxes.map(([x, y, w, h]) => `drawbox=x=${x + 20}:y=${y + 20}:w=${w - 40}:h=${h - 40}:color=0xd0d0c0:t=4`),
    'drawbox=x=700:y=480:w=60:h=60:color=0xff00ff:t=fill', 'drawbox=x=1300:y=600:w=60:h=60:color=0x00ffff:t=fill'];
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x55703f:s=2000x1124:d=1', '-vf', vf.join(','), '-frames:v', '1', world]);
  const fc = `[0:v]fps=30,format=yuv420p[w];color=c=0xffd700:s=100x100:r=30:d=${D}[b];[w][b]overlay=x='200+170*t':y=780:shortest=1[s];[s]crop=1920:1080:x='${SX}':y='${SY}'[v]`;
  await ffmpeg(['-loop', '1', '-framerate', '30', '-t', String(D), '-i', world, '-filter_complex', fc, '-map', '[v]', ...X264, '-t', String(D), join(dir, 'handheld.mp4')]);
  return finish(dir, {});
}
