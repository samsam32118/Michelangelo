// Reference solution with plain ffmpeg + Node (no Michelangelo): a moving gradient with a sweeping bar, one text card
// per sentence (drawtext), a synthesised music bed normalised to -14 LUFS; plus the edit as a hand-written project.
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { ffmpeg, readSetup, formatProject, loudnormFilter } from '../../lib/index.mjs';
import { hasDrawtext, font } from '../../lib/fixtures.mjs';

const wrap = (s, n = 16) => { const lines = ['']; for (const w of s.split(' ')) { if ((lines[lines.length - 1] + ' ' + w).trim().length > n) lines.push(w); else lines[lines.length - 1] = (lines[lines.length - 1] + ' ' + w).trim(); } return lines.join('\n'); };

export async function solve(dir) {
  const { info } = readSetup(dir);
  const S = info.sentences, per = 4, D = S.length * per;
  const o = join(dir, 'out');
  mkdirSync(o, { recursive: true });
  const dt = await hasDrawtext();
  const cards = S.map((s, i) => {
    const f = join(o, `.s${i}.txt`);
    writeFileSync(f, wrap(s));
    return dt ? `drawtext=fontfile='${font()}':textfile='${f}':fontsize=${i === 0 ? 96 : 84}:fontcolor=white:borderw=5:bordercolor=black:line_spacing=12:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${i * per},${(i + 1) * per - 0.04})'`
      : Array.from({ length: 6 + i }, (_, k) => `drawbox=x=${140 + k * 110}:y=860:w=40:h=${120 + 20 * (k % 3)}:color=white:t=fill:enable='between(t,${i * per},${(i + 1) * per - 0.04})'`).join(',');
  });
  const music = join(o, '.music.wav');
  const chord = [220, 277.18, 329.63].map((f) => `0.15*sin(2*PI*${f}*t)`).join('+');
  await ffmpeg(['-f', 'lavfi', '-i', `aevalsrc='(${chord})*(0.6+0.4*sin(2*PI*2*t))+0.3*sin(2*PI*55*t)*exp(-8*mod(t,0.5))':s=48000:c=stereo:d=${D}`, '-c:a', 'pcm_s16le', music]);
  const af = await loudnormFilter(music, { I: -14, TP: -1.5 });
  await ffmpeg(['-f', 'lavfi', '-i', `gradients=s=1080x1920:c0=0x1d2b64:c1=0xf8cdda:speed=0.03:r=30:d=${D}`, '-f', 'lavfi', '-i', `color=c=0xffcc00:s=1080x24:r=30:d=${D}`, '-i', music,
    '-filter_complex', `[0:v][1:v]overlay=x=0:y='mod(t*300\\,1920)'[bg];[bg]${cards.join(',')},format=yuv420p[v];[2:a]${af},aresample=48000[a]`,
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '160k', '-t', String(D), join(o, 'short.mp4')]);
  for (let i = 0; i < S.length; i++) rmSync(join(o, `.s${i}.txt`), { force: true });
  rmSync(music, { force: true });
  writeFileSync(join(dir, 'short.mgl.json'), formatProject({ michelangelo: 1, project: { platform: 'shorts' }, comps: [{ id: 'main', size: [1080, 1920], fps: 30, length: D * 30 }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }],
    clips: [{ id: 'bg', track: 'V1', at: 0, len: D * 30, color: '#1d2b64' }, ...S.map((s, i) => ({ id: `s${i + 1}`, track: 'T1', at: i * per * 30, len: per * 30, text: s, style: 'title', animate: { in: 'pop' } }))] }));
}
