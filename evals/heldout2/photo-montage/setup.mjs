import { join } from 'node:path';
import { finish, ensureDir } from '../_lib/fx.mjs';
import { ffmpeg } from '../../lib/util.mjs';

export const COLORS = [[170, 60, 50], [60, 140, 70], [50, 80, 160], [200, 130, 40], [120, 60, 150]];
const hx = (c) => '0x' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

export async function setup(dir) {
  for (let k = 0; k < 5; k++) {
    const c = COLORS[k], dark = c.map((v) => Math.round(v * 0.55)), mid = c.map((v) => Math.round(v * 0.8));
    const shapes = [
      `drawbox=x=${100 + k * 70}:y=700:w=520:h=300:color=${hx(dark)}:t=fill`,
      `drawbox=x=${1100 - k * 40}:y=760:w=600:h=250:color=${hx(mid)}:t=fill`,
      `drawbox=x=${300 + k * 90}:y=860:w=260:h=160:color=${hx(dark.map((v) => Math.round(v * 0.6)))}:t=fill`,
      'drawbox=x=743:y=515:w=50:h=50:color=white:t=fill', 'drawbox=x=1127:y=515:w=50:h=50:color=white:t=fill',
      'drawbox=x=737:y=509:w=62:h=62:color=black:t=6', 'drawbox=x=1121:y=509:w=62:h=62:color=black:t=6',
    ];
    const f = ensureDir(join(dir, `photos/${k + 1}.jpg`));
    await ffmpeg(['-f', 'lavfi', '-i', `color=c=${hx(c)}:s=1920x1080:d=1`, '-vf', shapes.join(','), '-frames:v', '1', '-q:v', '2', f]);
  }
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=f=220:d=24', '-f', 'lavfi', '-i', 'sine=f=277.18:d=24', '-f', 'lavfi', '-i', 'sine=f=329.63:d=24',
    '-filter_complex', '[0][1][2]amix=inputs=3:normalize=0,volume=-14dB,tremolo=f=0.5:d=0.3[a]', '-map', '[a]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', join(dir, 'music.wav')]);
  return finish(dir, {});
}
