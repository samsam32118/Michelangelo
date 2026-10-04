import { join } from 'node:path';
import { speechTrack, finish, ensureDir, X264 } from '../_lib/fx.mjs';
import { ffmpeg } from '../../lib/util.mjs';

export const FLASH = [1.0, 4.5, 8.2, 10.6];
export const LAG = 13 / 30;
export const D = 12;

export async function setup(dir) {
  const vo = join(dir, '.golden', 'vo.wav');
  await speechTrack(vo, [[1.75, 'So the first thing we did was rent a tiny office.'], [5.25, 'It was cheap, and honestly a little cold.'], [8.95, 'But it worked.']], D);
  const mix = join(dir, '.golden', 'mix.wav');
  const beeps = FLASH.map((t, i) => `sine=f=2000:d=0.06,volume=-8dB,adelay=${Math.round((t + LAG) * 1000)}:all=1,apad=whole_dur=${D}[b${i}]`).join(';');
  await ffmpeg(['-i', vo, '-filter_complex', `${beeps};[0:a]${FLASH.map((_, i) => `[b${i}]`).join('')}amix=inputs=${FLASH.length + 1}:normalize=0:duration=first,atrim=0:${D}[a]`,
    '-map', '[a]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', mix]);
  const en = FLASH.map((t) => `between(n,${Math.round(t * 30)},${Math.round(t * 30) + 1})`).join('+');
  const fc = `color=c=0x5a5a5a:s=1280x720:r=30:d=${D}[bg];color=c=0x2e7d32:s=200x200:r=30:d=${D}[g];color=c=0xc62828:s=120x300:r=30:d=${D}[r];color=c=white:s=1280x720:r=30:d=${D}[w]`
    + `;[bg][g]overlay=x='100+80*t':y=200[a1];[a1][r]overlay=x=900:y='50+25*t'[a2];[a2][w]overlay=0:0:enable='${en}'[v]`;
  ensureDir(join(dir, 'interview.mp4'));
  await ffmpeg(['-filter_complex', fc, '-i', mix, '-map', '[v]', '-map', '0:a', ...X264, '-c:a', 'aac', '-b:a', '192k', '-t', String(D), join(dir, 'interview.mp4')]);
  return finish(dir, {});
}
