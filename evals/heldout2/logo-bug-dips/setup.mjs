import { join } from 'node:path';
import { finish, ensureDir, X264 } from '../_lib/fx.mjs';
import { ffmpeg } from '../../lib/util.mjs';

export const CLIPS = [
  { f: 'clips/01.mp4', src: 'testsrc2=s=1280x720:r=30:d=4', vf: 'null', hz: 330 },
  { f: 'clips/02.mp4', src: 'testsrc2=s=1280x720:r=30:d=4', vf: 'hue=h=150,vflip', hz: 550 },
  { f: 'clips/03.mp4', src: 'testsrc=s=1280x720:r=30:d=4', vf: 'null', hz: 770 },
];
export const LOGO = [20, 32, 90];

export async function setup(dir) {
  for (const c of CLIPS) {
    ensureDir(join(dir, c.f));
    await ffmpeg(['-f', 'lavfi', '-i', c.src, '-f', 'lavfi', '-i', `sine=f=${c.hz}:d=4,volume=-12dB`, '-vf', `${c.vf},lutrgb=r=30+val*0.72:g=30+val*0.72:b=30+val*0.72`, ...X264, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-t', '4', join(dir, c.f)]);
  }
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x14205a:s=200x200:d=1', '-vf', "format=rgba,geq=r='20':g='32':b='90':a='if(lt(hypot(X-99.5,Y-99.5),90),255,0)'", '-frames:v', '1', join(dir, 'logo.png')]);
  return finish(dir, {});
}
