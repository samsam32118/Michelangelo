/** `mgl render` (estimate first, then render, verify) and `mgl look` (contact sheet + QA + sound). */
import { basename, dirname, extname, join, relative } from 'node:path';
import { fail } from '../core/errors.js';
import { parseRate, parseTime } from '../core/time.js';
import type { RenderResult } from '../render/pipeline.js';
import { assertRenderable, open, qaModule, type MglProject } from '../sdk/index.js';
import { bool, bytesText, int, secondsText, str, type Args, type Out } from './io.js';

const CODEC: Record<string, string> = { h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', prores: 'ProRes', aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', flac: 'FLAC', png: 'PNG', gif: 'GIF', apng: 'APNG', pcm_s16le: 'PCM', pcm_s24le: 'PCM', subrip: 'SRT', webvtt: 'WebVTT' };
const codecName = (c?: string) => (c ? CODEC[c] ?? c : '');

const shown = (f: string) => { const r = relative(process.cwd(), f); return r && !r.startsWith('..') ? r : f; };

/** "out/x.mp4 (30.0 s, 1080x1920, H.264/AAC, 9.8 MB) in 31 s (1.0x real time)" */
function resultLine(r: RenderResult): string {
  const what = [r.seconds ? `${r.seconds.toFixed(1)} s` : '', r.width ? `${r.width}x${r.height}` : '', [codecName(r.codec), codecName(r.audioCodec)].filter(Boolean).join('/'), bytesText(r.bytes)].filter(Boolean).join(', ');
  return `${shown(r.out)} (${what}) in ${secondsText(r.wallSec)}${r.frames > 1 ? ` (${r.realtimeFactor.toFixed(1)}x real time)` : ''}`;
}

function quality(a: Args): 'draft' | 'final' | 'hq' {
  const q = (['draft', 'final', 'hq'] as const).filter((k) => bool(a, k));
  if (q.length > 1) fail('E_ARG', `choose one of --draft, --final, --hq (got ${q.map((x) => '--' + x).join(' ')}).`, 'draft = half size and fast; final = delivery (default); hq = final with a slower, better encode.');
  return q[0] ?? 'final';
}

function parseRange(s: string): [string, string] {
  const m = /^(.+?)-(.+)$/.exec(s.trim());
  if (!m) fail('E_ARG', `--range "${s}" is not a range.`, 'use start-end, e.g. --range 2s-5s or --range 60-150 (frames).');
  return [m[1]!, m[2]!];
}

export async function render(a: Args, o: Out) {
  const file = a.pos[0];
  if (!file) fail('E_USAGE', 'render needs a file.', 'mgl render video.mgl.json out/video.mp4 --draft');
  if (bool(a, 'status')) return status(file, o);
  const still = str(a, 'still');
  const base = basename(file).replace(/\.mgl\.json$|\.json$/, '');
  const out = a.pos[1] ?? join(dirname(file), 'out', `${base}${still !== undefined ? '.png' : '.mp4'}`);
  if (still !== undefined && extname(out).toLowerCase() !== '.png') fail('E_ARG', `--still writes a PNG, but the output is ${out}.`, `use an output ending in .png: mgl render ${file} frame.png --still ${still}`);
  const q = quality(a);
  const p = await open(file);
  const opts: Parameters<MglProject['render']>[1] = { quality: q };
  const comp = str(a, 'comp');
  if (comp) opts.comp = comp;
  if (str(a, 'range')) opts.range = parseRange(str(a, 'range')!);
  if (still !== undefined) opts.still = still;
  if (bool(a, 'alpha')) opts.alpha = true;
  const segs = int(a, 'segments');
  if (segs) opts.segments = segs;
  const ext = extname(out).toLowerCase();
  const isVideo = ['.mp4', '.webm', '.mov', '.gif'].includes(ext);

  if (bool(a, 'detach')) return detach(p, file, out, opts, isVideo, o);

  let estimated = false;
  const estLine = (note: string, seconds: number) => {
    if (estimated) return;
    estimated = true;
    o.line(note + (seconds > 120 ? '  (over 2 min: next time add --detach and poll with --status)' : ''));
    o.set({ estimate: { seconds, note } });
    o.flush();
  };
  if (!isVideo) estLine(`est. <1 s (${ext === '.png' ? 'still' : ext.slice(1)})`, 0.5);
  opts.onEstimate = (e) => estLine(e.note, e.seconds);
  const tty = !o.json && !o.quiet && process.stderr.isTTY;
  if (tty) opts.onProgress = (pr) => process.stderr.write(`\rrendering ${Math.round((pr.frame / pr.total) * 100)}% ${pr.frame}/${pr.total} frames, ${pr.fps.toFixed(0)} fps, eta ${secondsText(pr.etaSec)}   `);
  const r = await p.render(out, opts);
  if (tty) process.stderr.write('\r\x1b[K');
  if (!estimated) estLine('est. (no estimate)', 0);
  o.line(`wrote ${resultLine(r)}`);
  for (const n of r.notes ?? []) o.line(`note: ${n}`);
  o.set({ out: r.out, result: r });
}

async function detach(p: MglProject, file: string, out: string, opts: Parameters<MglProject['render']>[1] & object, isVideo: boolean, o: Out) {
  const pipeline = await import('../render/pipeline.js');
  const comp = pipeline.resolveComp(p.data, opts.comp);
  const rate = parseRate(comp.fps);
  const range = opts.range ? [parseTime(opts.range[0], rate, 'range start'), parseTime(opts.range[1], rate, 'range end')] as [number, number] : undefined;
  assertRenderable(p);
  if (isVideo) {
    const e = await pipeline.estimate(p.data, { baseDir: p.dir, registry: p.registry, comp: comp.id, quality: opts.quality ?? 'final', out, ...(range ? { range } : {}), ...(opts.segments ? { segments: opts.segments } : {}) });
    o.line(e.note);
    o.set({ estimate: { seconds: e.seconds, note: e.note } });
  } else o.line(`est. <1 s (${extname(out).slice(1)})`);
  const s = await pipeline.renderDetached(file, out, { comp: comp.id, quality: opts.quality ?? 'final', ...(range ? { range } : {}), ...(opts.alpha ? { alpha: true } : {}), ...(opts.segments ? { segments: opts.segments } : {}), ...(opts.still !== undefined ? { still: parseTime(opts.still, rate, 'still') } : {}) });
  o.line(`rendering ${shown(s.out)} in the background (pid ${s.pid})`);
  o.hint(`check: mgl render ${file} --status`);
  o.set({ detached: true, pid: s.pid, out: s.out, statusFile: s.statusFile });
}

async function status(file: string, o: Out) {
  const { renderStatus } = await import('../render/pipeline.js');
  const s = renderStatus(file);
  if (s.status === 'running') o.line(`running: ${shown(s.out)} ${Math.round(s.progress * 100)}%${s.etaSec !== undefined ? `, eta ${secondsText(s.etaSec)}` : ''} (pid ${s.pid}, started ${s.startedAt})`);
  else if (s.status === 'done' && s.result) o.line(`done: wrote ${resultLine(s.result)}`);
  else {
    o.line(`failed: ${s.error?.code ?? 'E_RENDER'}: ${s.error?.message ?? 'unknown error'}`, `  fix: ${s.error?.fix ?? 'run the render again without --detach.'}`);
    o.exit = 1;
  }
  o.set({ status: s });
}

export async function look(a: Args, o: Out) {
  const file = a.pos[0];
  if (!file) fail('E_USAGE', 'look needs a file.', 'mgl look video.mgl.json');
  const p = await open(file);
  const opts: Parameters<MglProject['look']>[0] & object = {};
  if (str(a, 'at')) opts.at = str(a, 'at')!.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const n = int(a, 'frames');
  if (n !== undefined) opts.frames = n;
  if (str(a, 'comp')) opts.comp = str(a, 'comp')!;
  if (bool(a, 'cuts')) opts.cuts = true;
  if (bool(a, 'no-audio')) opts.audio = false;
  await lookEstimate(p, opts, o);
  const qa = await qaModule();
  const report = await p.look(opts);
  o.line(...(qa?.formatLook ? (qa.formatLook(report, { file, lineOf: (id: string) => p.line('clips', id) }) as string[]) : [JSON.stringify(report)]));
  const findings = report.findings ?? [];
  if (bool(a, 'strict') && findings.some((f) => f.severity === 'error')) o.exit = 1;
  o.set({ ...report, issues: findings.length });
}

/** Print an estimate first when a look may take over 2 minutes (long comps or many video layers). */
async function lookEstimate(p: MglProject, opts: { frames?: number; at?: unknown[]; cuts?: boolean; comp?: string; audio?: boolean }, o: Out) {
  const pipeline = await import('../render/pipeline.js');
  const comp = pipeline.resolveComp(p.data, opts.comp);
  const { compLength } = await import('../render/evaluate.js');
  const seconds = (compLength(p.data, comp.id) * parseRate(comp.fps).den) / parseRate(comp.fps).num;
  const videos = p.clips({ comp: comp.id }).filter((c) => c.asset !== undefined).length;
  if (seconds < 300 && videos < 8) return; // a look of a typical project takes seconds
  const e = await pipeline.estimate(p.data, { baseDir: p.dir, registry: p.registry, comp: comp.id, quality: 'draft', range: [0, Math.min(compLength(p.data, comp.id), 3)] });
  const n = opts.at?.length ?? (opts.cuts ? 24 : opts.frames ?? 12);
  const est = (n * (e.perFrameMs + e.decodeMs * 4)) / 1000 + (opts.audio === false ? 0 : seconds * 0.05);
  if (est > 120) { o.line(`est. ${Math.round(est)} s (look: ${n} frames + sound analysis of ${Math.round(seconds)} s)`); o.flush(); }
}
