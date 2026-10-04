/**
 * Render benchmark: three reference projects built programmatically with generated media (ffmpeg lavfi, flite),
 * measuring `look` (12 stills at 0.5 scale), a draft render and a final render against the targets
 * (look < 10 s, draft ≤ 1× real time, final ≤ 3× real time) and FrameCraft's 6.4×.
 *
 *   node --import tsx scripts/bench.ts [--seconds=30] [--only=short,text,hevc] [--media=<dir>] [--no-write]
 *
 * Writes bench/results/<date>.json and .md. A failing stage is reported in its row; the others still run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectFile } from '../src/core/schema/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k!, v ?? 'true']; }));
const SECONDS = Number(args.seconds ?? 30);
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const FPS = 30;
const LEN = SECONDS * FPS;
const TARGETS = { look: 10, draft: 1, final: 3, framecraft: 6.4 };

// ------------------------------------------------------------------------------------------- media

function ff(a: string[]) { execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...a], { stdio: ['ignore', 'ignore', 'pipe'] }); }

function makeMedia(dir: string) {
  mkdirSync(dir, { recursive: true });
  const make = (name: string, fn: (out: string) => void) => {
    const out = join(dir, name);
    if (!existsSync(out)) { const t = Date.now(); fn(out + '.tmp' + name.slice(name.lastIndexOf('.'))); execFileSync('mv', [out + '.tmp' + name.slice(name.lastIndexOf('.')), out]); console.error(`  made ${name} in ${((Date.now() - t) / 1000).toFixed(1)} s`); }
    return out;
  };
  const d = SECONDS;
  return {
    bg: make(`bg-1080p-h264-${d}.mp4`, (o) => ff(['-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30:d=${d}`, '-f', 'lavfi', '-i', `sine=f=200:r=48000:d=${d}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-shortest', o])),
    pip: make(`pip-720p-h264-${d}.mp4`, (o) => ff(['-f', 'lavfi', '-i', `smptebars=s=1280x720:r=30:d=${d}`, '-vf', "drawbox=x='mod(t*240,1200)':y=300:w=80:h=80:color=white:t=fill", '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60', o])),
    hevc4k: make(`uhd-hevc-${d}.mp4`, (o) => ff(['-f', 'lavfi', '-i', `testsrc2=s=3840x2160:r=30:d=${d}`, '-c:v', 'libx265', '-preset', 'ultrafast', '-g', '60', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', o])),
    hevc1080: make(`hd-hevc-${d}.mp4`, (o) => ff(['-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30:d=${d}`, '-vf', 'hue=h=120', '-c:v', 'libx265', '-preset', 'ultrafast', '-g', '60', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', o])),
    logo: make('logo.png', (o) => ff(['-f', 'lavfi', '-i', 'color=c=0xffd400:s=256x256', '-vf', "geq=r='255':g='212':b='0':a='if(lt(hypot(X-128,Y-128),120),255,0)'", '-frames:v', '1', '-pix_fmt', 'rgba', o])),
    music: make(`music-${d}.wav`, (o) => ff(['-f', 'lavfi', '-i', `aevalsrc='0.2*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*2*t))+0.15*sin(2*PI*330*t)+0.1*sin(2*PI*440*t)':s=48000:d=${d}`, '-ac', '2', o])),
    voice: make('voice.wav', (o) => ff(['-f', 'lavfi', '-i', "flite=text='Here is a quick look at the new feature. It renders fast and the captions follow every word.':voice=slt", '-ar', '48000', o])),
  };
}

// ------------------------------------------------------------------------------------------- projects

type Clip = NonNullable<ProjectFile['clips']>[number];
const WORDS = 'this is how a typical short looks with captions on every word right here'.split(' ');

function short(m: ReturnType<typeof makeMedia>): ProjectFile {
  const clips: Clip[] = [
    { id: 'bg', track: 'V1', at: 0, len: LEN, asset: 'bg', scale: [[0, 1], [LEN, 1.15]] },
    { id: 'pip', track: 'V2', at: 0, len: LEN, asset: 'pip', fit: 'contain', scale: 0.4, x: 760, y: 420 },
    { id: 'card', track: 'V3', at: 0, len: LEN, shape: { type: 'rect', size: [920, 260], radius: 32, fill: '#000000aa' }, y: 1500 },
    { id: 'dot', track: 'V4', at: 0, len: LEN, shape: { type: 'ellipse', size: [60, 60], fill: '#ff3355' }, x: [[0, 120], [LEN, 960]], y: 1780 },
    { id: 'logo', track: 'V5', at: 0, len: LEN, asset: 'logo', fit: 'none', scale: 0.5, x: 960, y: 140 },
    { id: 'title', track: 'V6', at: 0, len: Math.min(LEN, 150), text: 'Big News Today', style: 'title', y: [[0, 300], [20, 260, 'outBack']], scale: [[0, 0.8], [20, 1]], opacity: [[0, 0], [10, 1]], animate: { in: 'pop', by: 'word' } },
    { id: 'subs', track: 'V7', at: 0, len: LEN, captions: true, style: 'karaoke', y: 1500 },
    { id: 'music', track: 'A1', at: 0, len: LEN, asset: 'music', gain: -6 },
    { id: 'voice', track: 'A2', at: 30, len: Math.min(LEN - 30, 180), asset: 'voice' },
  ] as Clip[];
  const cueLen = Math.floor(LEN / 30);
  const cues = Array.from({ length: 30 }, (_, i) => {
    const words = [WORDS[i % WORDS.length]!, WORDS[(i + 1) % WORDS.length]!, WORDS[(i + 2) % WORDS.length]!];
    return { id: `q${i + 1}`, clip: 'subs', at: i * cueLen, len: cueLen, text: words.join(' '), words: words.map((_, k) => Math.floor((k * cueLen) / 3)) };
  });
  return {
    michelangelo: 1,
    project: { name: 'bench-short', platform: 'shorts' },
    assets: [{ id: 'bg', src: m.bg }, { id: 'pip', src: m.pip }, { id: 'logo', src: m.logo }, { id: 'music', src: m.music }, { id: 'voice', src: m.voice }],
    comps: [{ id: 'main', size: [1080, 1920], fps: FPS, bg: '#000000' }],
    tracks: [...[1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: `V${i}`, comp: 'main' })), { id: 'A1', comp: 'main', audio: true, bus: 'music' }, { id: 'A2', comp: 'main', audio: true, bus: 'voice' }],
    clips,
    cues,
    buses: [{ id: 'music', duck: { by: 'voice', db: 9 } }, { id: 'voice' }, { id: 'master', loudness: { lufs: -14, peak: -1 } }],
  } as ProjectFile;
}

function textOnly(): ProjectFile {
  const lines = ['Motion', 'graphics', 'with only', 'text and', 'shapes', 'rendered', 'by Skia', 'in real time'];
  const per = Math.floor(LEN / lines.length);
  const anims = ['pop', 'slide-up', 'bounce', 'wave', 'blur-in', 'drop', 'typewriter', 'scale-in'];
  const clips: Clip[] = [
    { id: 'grad', track: 'V1', at: 0, len: LEN, shape: { type: 'rect', size: [1080, 1920], gradient: { type: 'linear', stops: [[0, '#1b1464'], [1, '#e8467c']], angle: 90 } } },
    { id: 'ring', track: 'V2', at: 0, len: LEN, shape: { type: 'ellipse', size: [700, 700], fill: 'none', stroke: '#ffffff55', strokeWidth: 12 }, scale: [[0, 0.8], [LEN, 1.3]] },
    { id: 'star', track: 'V3', at: 0, len: LEN, shape: { type: 'star', size: [300, 300], sides: 5, fill: '#ffd400' }, rotate: [[0, 0], [LEN, 720]], y: 1500 },
    ...lines.map((t, i) => ({ id: `t${i}`, track: i % 2 ? 'V4' : 'V5', at: i * per, len: per, text: t, style: i % 3 ? 'pop' : 'title', y: 900, animate: { in: anims[i % anims.length]!, by: i % 2 ? 'char' : 'word' } })),
    { id: 'label', track: 'V6', at: 0, len: LEN, text: 'BENCHMARK', style: 'label', y: 200, opacity: [[0, 0], [30, 1]] },
  ] as Clip[];
  return {
    michelangelo: 1,
    comps: [{ id: 'main', size: [1080, 1920], fps: FPS, bg: '#000000' }],
    tracks: [1, 2, 3, 4, 5, 6].map((i) => ({ id: `V${i}`, comp: 'main' })),
    clips,
  } as ProjectFile;
}

function hevc(m: ReturnType<typeof makeMedia>): ProjectFile {
  return {
    michelangelo: 1,
    assets: [{ id: 'uhd', src: m.hevc4k }, { id: 'hd', src: m.hevc1080 }],
    comps: [{ id: 'main', size: [1920, 1080], fps: FPS, bg: '#000000' }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'V2', comp: 'main' }],
    clips: [
      { id: 'uhd', track: 'V1', at: 0, len: LEN, asset: 'uhd' },
      { id: 'pip', track: 'V2', at: 0, len: LEN, asset: 'hd', scale: 0.35, x: 1500, y: 300 },
    ],
  } as ProjectFile;
}

// ------------------------------------------------------------------------------------------- measure

interface Row { project: string; size: string; seconds: number; look?: number; draft?: number; draftRt?: number; draftEst?: number; final?: number; finalRt?: number; finalEst?: number; segments?: number; draftSegments?: number; errors: string[] }

async function main() {
  const pipeline = await import('../src/render/pipeline.js').catch((e: Error) => { console.error(`render pipeline unavailable: ${e.message}`); return null; });
  const work = mkdtempSync(join(tmpdir(), 'mgl-bench-'));
  const mediaDir = String(args.media ?? join(tmpdir(), 'mgl-bench-media'));
  console.error(`bench: ${SECONDS} s projects, ${cpus().length} cpus (${cpus()[0]?.model ?? '?'}), media in ${mediaDir}`);
  const m = makeMedia(mediaDir);
  const projects: [string, ProjectFile][] = ([['short', short(m)], ['text', textOnly()], ['hevc', hevc(m)]] as [string, ProjectFile][]).filter(([k]) => !ONLY || ONLY.has(k));
  const rows: Row[] = [];
  for (const [name, p] of projects) {
    const c = p.comps[0]!;
    const row: Row = { project: name, size: `${c.size[0]}x${c.size[1]}`, seconds: SECONDS, errors: [] };
    rows.push(row);
    writeFileSync(join(work, `${name}.mgl.json`), JSON.stringify(p, null, 1));
    if (!pipeline) { row.errors.push('pipeline module missing'); continue; }
    const stage = async (what: string, fn: () => Promise<void>) => {
      try { await fn(); } catch (e) { const err = e as { code?: string; message?: string }; row.errors.push(`${what}: ${err.code ? err.code + ' ' : ''}${err.message ?? e}`); console.error(`  ${name} ${what} failed: ${err.message}`); }
    };
    const frames = Array.from({ length: 12 }, (_, i) => Math.floor(((i + 0.5) * LEN) / 12));
    await stage('look', async () => {
      const t = performance.now();
      await pipeline.renderStills(p, { baseDir: work, frames, scale: 0.5 });
      row.look = (performance.now() - t) / 1000;
      console.error(`  ${name} look ${row.look.toFixed(2)} s`);
    });
    for (const q of ['draft', 'final'] as const) {
      await stage(q, async () => {
        let est = 0;
        const r = await pipeline.render(p, join(work, `${name}-${q}.mp4`), { baseDir: work, quality: q, onEstimate: (e) => { est = e.seconds; console.error(`  ${name} ${e.note}`); } });
        row[q] = r.wallSec; row[`${q}Rt`] = r.realtimeFactor; row[`${q}Est`] = est;
        if (q === 'final') row.segments = r.segments; else row.draftSegments = r.segments;
        console.error(`  ${name} ${q} ${r.wallSec.toFixed(1)} s (${r.realtimeFactor.toFixed(2)}x, ${r.width}x${r.height}, ${r.segments} segment(s))`);
      });
    }
  }
  if (!args.keep) rmSync(work, { recursive: true, force: true });

  const f = (v: number | undefined, d = 1) => (v === undefined ? '—' : v.toFixed(d));
  const ok = (v: number | undefined, t: number) => (v === undefined ? '' : v <= t ? ' ✓' : ' ✗');
  const md = [
    `# Render benchmark ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Machine: ${cpus().length} × ${cpus()[0]?.model ?? '?'}, ${(totalmem() / 2 ** 30).toFixed(0)} GB, Node ${process.version}. Projects are ${SECONDS} s at ${FPS} fps.`,
    `Targets: look < ${TARGETS.look} s · draft ≤ ${TARGETS.draft}× real time · final ≤ ${TARGETS.final}× · FrameCraft final ${TARGETS.framecraft}×.`,
    '',
    '| project | size | look 12 stills (s) | draft wall (s) | draft × RT | final wall (s) | final × RT | est. final (s) | segments draft/final | vs FrameCraft | errors |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.project} | ${r.size} | ${f(r.look, 2)}${ok(r.look, TARGETS.look)} | ${f(r.draft)} | ${f(r.draftRt, 2)}${ok(r.draftRt, TARGETS.draft)} | ${f(r.final)} | ${f(r.finalRt, 2)}${ok(r.finalRt, TARGETS.final)} | ${f(r.finalEst)} | ${r.draftSegments ?? '—'}/${r.segments ?? '—'} | ${r.finalRt ? `${(TARGETS.framecraft / r.finalRt).toFixed(1)}× faster` : '—'} | ${r.errors.join('; ').replace(/\|/g, '/') || ''} |`),
    '',
    'short: 1080p H.264 background + 720p PiP, keyframed title, 30 karaoke caption cues, shapes, logo, music + flite voice with ducking and loudness. text: text-only motion graphics. hevc: 4K HEVC background + 1080p HEVC PiP (1920x1080).',
    '',
  ].join('\n');
  console.log(md);
  if (!args['no-write']) {
    const dir = join(ROOT, 'bench', 'results');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/:/g, '-').slice(0, 16);
    writeFileSync(join(dir, `${stamp}.json`), JSON.stringify({ date: new Date().toISOString(), seconds: SECONDS, cpus: cpus().length, cpu: cpus()[0]?.model, node: process.version, targets: TARGETS, rows }, null, 2) + '\n');
    writeFileSync(join(dir, `${stamp}.md`), md);
    console.error(`wrote bench/results/${stamp}.json and .md`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
