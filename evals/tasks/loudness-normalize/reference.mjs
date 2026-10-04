// Reference solution with plain ffmpeg: mix like the project, then two-pass loudnorm to -14 LUFS / -1.5 dBTP.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ffmpeg, ffmpegLog, readProject, formatProject } from '../../lib/index.mjs';

export async function solve(dir) {
  mkdirSync(join(dir, 'out'), { recursive: true });
  const mix = join(dir, 'out/premix.wav');
  await ffmpeg(['-i', join(dir, 'media/speech.wav'), '-i', join(dir, 'media/tones.wav'), '-filter_complex',
    '[0:a]atrim=0:10,adelay=500:all=1,aformat=channel_layouts=stereo[s];[1:a]aformat=channel_layouts=stereo[t];[s][t]amix=inputs=2:normalize=0:duration=longest', '-t', '12', '-ar', '48000', mix]);
  const log = await ffmpegLog(['-i', mix, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=20:print_format=json', '-f', 'null', '-']);
  const m = JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1));
  const af = `loudnorm=I=-14:TP=-1.5:LRA=20:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  await ffmpeg(['-i', mix, '-af', `${af},aresample=48000`, '-c:a', 'pcm_s16le', join(dir, 'out/mix.wav')]);
  await ffmpeg(['-i', join(dir, 'out/mix.wav'), '-c:a', 'libmp3lame', '-b:a', '192k', join(dir, 'out/mix.mp3')]);
  // the edit as a project too (plain JSON): graders check the library's file carries it
  const p = readProject(join(dir, 'mix.mgl.json'));
  p.buses = [{ id: 'master', loudness: { lufs: -14, peak: -1.5 } }];
  writeFileSync(join(dir, 'mix.mgl.json'), formatProject(p));
}
