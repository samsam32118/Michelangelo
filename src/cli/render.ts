/** `mgl render` (estimate first, then render, verify) and `mgl look` (contact sheet + QA + sound). */
import { basename, dirname, extname, join, relative } from 'node:path';
import { fail } from '../core/errors.js';
import { parseRate, parseTime } from '../core/time.js';
import type { RenderResult } from '../render/pipeline.js';
import { assertRenderable, open, parsePlatforms, qaModule, DELIVERY_FIELDS, type MglProject, type RenderOpts } from '../sdk/index.js';
import { bool, bytesText, int, secondsText, str, type Args, type Out } from './io.js';

const CODEC: Record<string, string> = { h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', prores: 'ProRes', aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', flac: 'FLAC', png: 'PNG', gif: 'GIF', apng: 'APNG', pcm_s16le: 'PCM 16-bit', pcm_s24le: 'PCM 24-bit', subrip: 'SRT', webvtt: 'WebVTT', 'webvtt-chapters': 'WebVTT chapters', chapters: 'YouTube chapters' };
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

const PRORES = ['proxy', 'lt', '422', 'hq', '4444', '4444xq'] as const;

/** Stem and delivery flags (--bus, --crf, --bitrate, --audio-bitrate, --pcm, --prores, --timecode, --color-range) as RenderOpts. */
export function deliveryFlags(a: Args): Pick<RenderOpts, 'bus' | 'crf' | 'bitrate' | 'audioBitrate' | 'pcmDepth' | 'prores' | 'timecode' | 'colorRange'> {
  const d: ReturnType<typeof deliveryFlags> = {};
  const bus = str(a, 'bus');
  if (bus !== undefined) d.bus = bus;
  const crf = int(a, 'crf');
  if (crf !== undefined) d.crf = crf;
  const rate = (k: string) => {
    const v = str(a, k);
    if (v !== undefined && !/^\d+(\.\d+)?[kKmM]?$/.test(v)) fail('E_ARG', `--${k} "${v}" is not a bitrate.`, `write it like ${k === 'bitrate' ? '8M or 2500k' : '320k'}.`);
    return v;
  };
  const br = rate('bitrate'), abr = rate('audio-bitrate');
  if (br !== undefined) d.bitrate = br;
  if (abr !== undefined) d.audioBitrate = abr;
  const pcm = str(a, 'pcm');
  if (pcm !== undefined) {
    if (pcm !== '16' && pcm !== '24') fail('E_ARG', `--pcm ${pcm} is not a PCM bit depth.`, 'use --pcm 16 or --pcm 24 (for .wav, .flac and .mov audio).');
    d.pcmDepth = pcm === '24' ? 24 : 16;
  }
  const pr = str(a, 'prores');
  if (pr !== undefined) {
    const v = pr.toLowerCase().replace(/^prores[-_ ]?/, '').replace(/^422[-_ ]?(hq|lt|proxy)$/, '$1');
    if (!(PRORES as readonly string[]).includes(v)) fail('E_ARG', `--prores ${pr} is not a ProRes profile.`, `use one of ${PRORES.join(', ')} (render to .mov).`);
    d.prores = v as (typeof PRORES)[number];
  }
  const tc = str(a, 'timecode');
  if (tc !== undefined) d.timecode = tc;
  const cr = str(a, 'color-range');
  if (cr !== undefined) {
    const v = ({ tv: 'tv', limited: 'tv', mpeg: 'tv', pc: 'pc', full: 'pc', jpeg: 'pc' } as Record<string, 'tv' | 'pc'>)[cr.toLowerCase()];
    if (!v) fail('E_ARG', `--color-range ${cr} is not a colour range.`, 'use tv (limited, the default) or pc (full).');
    d.colorRange = v;
  }
  return d;
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
  Object.assign(opts, deliveryFlags(a));
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
  if (!isVideo) estLine(`est. <1 s (${ext === '.png' ? 'still' : /\.chapters\.(txt|vtt)$/i.test(out) ? 'chapters' : ext.slice(1)})`, 0.5);
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
    const e = await pipeline.estimate(p.data, { baseDir: p.dir, registry: p.registry, comp: comp.id, quality: opts.quality ?? 'final', out, ...(range ? { range } : {}), ...(opts.segments ? { segments: opts.segments } : {}), ...(opts.alpha ? { alpha: true } : {}), ...(opts.prores ? { prores: opts.prores } : {}) });
    o.line(e.note);
    o.set({ estimate: { seconds: e.seconds, note: e.note } });
  } else o.line(`est. <1 s (${extname(out).slice(1)})`);
  const s = await pipeline.renderDetached(file, out, { comp: comp.id, quality: opts.quality ?? 'final', ...(range ? { range } : {}), ...(opts.alpha ? { alpha: true } : {}), ...(opts.segments ? { segments: opts.segments } : {}), ...(opts.still !== undefined ? { still: parseTime(opts.still, rate, 'still') } : {}), ...Object.fromEntries(DELIVERY_FIELDS.filter((k) => opts[k] !== undefined).map((k) => [k, opts[k]])) });
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
  if (str(a, 'platform')) opts.platforms = parsePlatforms(str(a, 'platform')!);
  if (bool(a, 'alpha')) opts.alpha = true;
  if (bool(a, 'safe')) opts.safe = true;
  opts.displayFile = file;
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
  const qa = await qaModule();
  if (!qa?.estimateLook) return;
  const e = await qa.estimateLook(p.data, { baseDir: p.dir, registry: p.registry, ...(opts.comp ? { comp: opts.comp } : {}), ...(opts.at?.length ? { n: opts.at.length } : opts.frames !== undefined ? { n: opts.frames } : {}), ...(opts.cuts ? { cuts: true } : {}), ...(opts.audio === false ? { audio: false } : {}) });
  if (e.slow) { o.line(e.note); o.flush(); }
}
