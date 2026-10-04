import { join } from 'node:path';
import { video, writeText, finish, X264, ensureDir } from '../_lib/fixtures.mjs';
import { ff } from '../_lib/proc.mjs';

export const SOURCES = {
  'clips/a.mp4': { src: 'testsrc2=size=1920x1080:rate=30', hz: 330 },
  'clips/b.mp4': { src: 'smptebars=size=1920x1080:rate=30', hz: 440 },
  'clips/c.mp4': { src: 'mandelbrot=size=480x270:rate=30', vf: 'scale=1920:1080:flags=bicubic,format=yuv420p', hz: 550 },
  'clips/d.mp4': { src: 'color=c=teal:size=1920x1080:rate=30', box: true, hz: 660 },
};
export const HIGHLIGHTS = [
  { source: 'clips/a.mp4', in: '0:02.0', out: '0:05.0', caption: 'Fast start' },
  { source: 'clips/b.mp4', in: '0:07.5', out: '0:10.0', caption: 'Big save' },
  { source: 'clips/c.mp4', in: '0:04.0', out: '0:08.0', caption: 'Deep dive' },
  { source: 'clips/a.mp4', in: '0:12.0', out: '0:14.5', caption: 'Comeback' },
  { source: 'clips/d.mp4', in: '0:09.0', out: '0:12.0', caption: 'Final whistle' },
];
export const XF = 0.5;
export const secs = (s) => { const [m, x] = s.split(':'); return Number(m) * 60 + Number(x); };

export async function setup(dir) {
  for (const [rel, s] of Object.entries(SOURCES)) {
    const audio = `sine=f=${s.hz}:r=48000:d=20`;
    if (s.box) {
      // teal with a moving white box (so the clip is not a still)
      ensureDir(join(dir, rel));
      await ff(['-f', 'lavfi', '-i', `${s.src}:d=20`, '-f', 'lavfi', '-i', 'color=c=white:size=300x300:rate=30:d=20', '-f', 'lavfi', '-i', audio,
        '-filter_complex', "[0:v][1:v]overlay=x='mod(t*150\\,1620)':y=390:eval=frame,format=yuv420p[v]", '-map', '[v]', '-map', '2:a', ...X264, '-c:a', 'aac', '-ac', '1', '-t', '20', join(dir, rel)]);
    } else await video(join(dir, rel), { src: s.src, d: 20, vf: s.vf, audio });
  }
  writeText(join(dir, 'highlights.json'), `${JSON.stringify(HIGHLIGHTS, null, 2)}\n`);
  return finish(dir, { highlights: HIGHLIGHTS, xf: XF });
}
