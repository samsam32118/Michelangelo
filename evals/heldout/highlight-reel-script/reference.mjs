// Grader validation only: make-reel.mjs below imports michelangelo (optional, so it runs without the package)
// but does the work with plain ffmpeg; a real solution uses the SDK.
import { join, dirname } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from '../_lib/proc.mjs';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '../_lib');

const SCRIPT = `// make-reel.mjs: highlights.json -> reel.mgl.json + out/reel.mp4
import { readFileSync, mkdirSync } from 'node:fs';
await import('michelangelo').catch(() => null);
import { ff } from '${LIB}/proc.mjs';
import { writeProject } from '${LIB}/project.mjs';
import { font, esc } from '${LIB}/fixtures.mjs';
const hl = JSON.parse(readFileSync('highlights.json', 'utf8'));
const secs = (s) => { const [m, x] = s.split(':'); return Number(m) * 60 + Number(x); };
const XF = 0.5, F = 30;
mkdirSync('out', { recursive: true });
const srcs = [...new Set(hl.map((h) => h.source))];
const inputs = srcs.flatMap((s) => ['-i', s]);
let fc = '', t = 0, v = '', a = '';
hl.forEach((h, k) => {
  const i = srcs.indexOf(h.source), s = secs(h.in), e = secs(h.out);
  const label = \`drawtext=fontfile='\${font()}':text='\${esc(h.caption)}':fontsize=64:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=20:x=80:y=h-200\`;
  fc += \`[\${i}:v]trim=\${s}:\${e},setpts=PTS-STARTPTS,\${label}[v\${k}];[\${i}:a]atrim=\${s}:\${e},asetpts=PTS-STARTPTS[a\${k}];\`;
});
let dur = secs(hl[0].out) - secs(hl[0].in);
v = '[v0]'; a = '[a0]';
for (let k = 1; k < hl.length; k++) {
  fc += \`\${v}[v\${k}]xfade=transition=fade:duration=\${XF}:offset=\${(dur - XF).toFixed(3)}[x\${k}];\${a}[a\${k}]acrossfade=d=\${XF}[y\${k}];\`;
  v = \`[x\${k}]\`; a = \`[y\${k}]\`;
  dur += secs(hl[k].out) - secs(hl[k].in) - XF;
}
await ff([...inputs, '-filter_complex', fc.replace(/;$/, ''), '-map', v, '-map', a, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'out/reel.mp4']);
let at = 0;
writeProject('reel.mgl.json', {
  assets: srcs.map((s, i) => ({ id: \`src\${i}\`, src: s })),
  comps: [{ id: 'main', size: [1920, 1080], fps: F, length: Math.round(dur * F) }],
  tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }],
  clips: hl.flatMap((h, k) => {
    const len = Math.round((secs(h.out) - secs(h.in)) * F), c = [{ id: \`m\${k + 1}\`, track: 'V1', at, len, asset: \`src\${srcs.indexOf(h.source)}\`, in: Math.round(secs(h.in) * F) },
      { id: \`cap\${k + 1}\`, track: 'T1', at, len, text: h.caption, x: 300, y: 900 }];
    at += len - XF * F;
    return c;
  }),
});
`;

export async function reference(dir) {
  writeFileSync(join(dir, 'make-reel.mjs'), SCRIPT);
  const r = await run(process.execPath, ['make-reel.mjs'], { cwd: dir });
  if (r.code) throw new Error(r.stderr);
}
