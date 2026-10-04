// Reference solution with plain ffmpeg (no Michelangelo): a synthesised chord bed, a noise-hit + thump effect at
// each cut and at the title, mixed with the edit's voice and normalised (two-pass loudnorm) to -14 LUFS / -3 dBTP (headroom for the AAC encode);
// the picture is copied. The same edit is written into the project as plain JSON.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, readSetup, readProject, formatProject, loudnormFilter } from '../../lib/index.mjs';

export async function solve(dir) {
  const { info } = readSetup(dir);
  const times = [info.title.start, ...info.cuts];
  mkdirSync(join(dir, 'out'), { recursive: true });
  mkdirSync(join(dir, 'sfx'), { recursive: true });
  const music = join(dir, 'sfx/music.wav'), hit = join(dir, 'sfx/hit.wav'), mix = join(dir, 'out/.premix.wav');
  const chord = [110, 164.81, 220, 277.18].map((f) => `0.045*sin(2*PI*${f}*t)`).join('+');
  await ffmpeg(['-f', 'lavfi', '-i', `aevalsrc='(${chord})*(0.75+0.25*sin(2*PI*0.25*t))':s=48000:c=stereo:d=20`, '-c:a', 'pcm_s16le', music]);
  await ffmpeg(['-f', 'lavfi', '-i', "aevalsrc='0.9*sin(2*PI*70*t)*exp(-12*t)':s=48000:d=0.6", '-f', 'lavfi', '-i', 'anoisesrc=d=0.6:c=pink:a=0.7:r=48000', '-filter_complex',
    '[1:a]afade=t=out:st=0:d=0.35:curve=exp[n];[0:a][n]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo', '-c:a', 'pcm_s16le', hit]);
  await ffmpeg(['-i', join(dir, 'edit.mp4'), '-i', music, '-i', hit, '-filter_complex',
    `[2:a]asplit=${times.length}${times.map((_, i) => `[s${i}]`).join('')};${times.map((t, i) => `[s${i}]adelay=${Math.round(t * 1000)}:all=1[h${i}]`).join(';')};`
    + `[0:a][1:a]${times.map((_, i) => `[h${i}]`).join('')}amix=inputs=${times.length + 2}:normalize=0:duration=first[m]`,
    '-map', '[m]', '-t', '20', '-ar', '48000', '-c:a', 'pcm_s16le', mix]);
  const af = await loudnormFilter(mix, { I: -14, TP: -3 });
  await ffmpeg(['-i', join(dir, 'edit.mp4'), '-i', mix, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', `${af},aresample=48000`, '-c:a', 'aac', '-b:a', '192k', '-t', '20', join(dir, 'out/final.mp4')]);
  // the same edit in the project
  const p = readProject(join(dir, 'edit.mgl.json'));
  p.assets.push({ id: 'music-wav', src: 'sfx/music.wav' }, { id: 'hit-wav', src: 'sfx/hit.wav' });
  p.tracks.push({ id: 'A2', comp: 'main', audio: true, bus: 'music' }, { id: 'A3', comp: 'main', audio: true, bus: 'sfx' });
  p.clips.push({ id: 'music', track: 'A2', at: 0, len: 600, asset: 'music-wav' }, ...times.map((t, i) => ({ id: `hit${i + 1}`, track: 'A3', at: Math.round(t * 30), len: 18, asset: 'hit-wav' })));
  p.project = { ...p.project, platform: 'youtube' };
  writeFileSync(join(dir, 'edit.mgl.json'), formatProject(p));
}
