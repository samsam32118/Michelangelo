import { join } from 'node:path';
import { video, writeText, finish } from '../_lib/fixtures.mjs';
import { writeProject } from '../_lib/project.mjs';

export const CHAPTERS = [[0, 'Intro'], [12, 'Setup'], [25, 'First pass'], [41, 'Polish'], [53, 'Wrap-up']];
const mmss = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '0');

export async function setup(dir) {
  await video(join(dir, 'lesson.mp4'), { src: 'testsrc2=size=1920x1080:rate=30', d: 60, audio: 'sine=f=440:r=48000:d=60' });
  writeProject(join(dir, 'lesson.mgl.json'), {
    project: { name: 'Lesson' },
    assets: [{ id: 'lesson-mp4', src: 'lesson.mp4' }],
    comps: [{ id: 'main', size: [1920, 1080], fps: 30, length: 1800 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true }],
    clips: [{ id: 'lesson', track: 'V1', at: 0, len: 1800, asset: 'lesson-mp4', muted: true }, { id: 'lesson-audio', track: 'A1', at: 0, len: 1800, asset: 'lesson-mp4' }],
  });
  writeText(join(dir, 'chapters.csv'), `time,title\n${CHAPTERS.map(([t, n]) => `${mmss(t)},${n}`).join('\n')}\n`);
  return finish(dir, { chapters: CHAPTERS });
}
