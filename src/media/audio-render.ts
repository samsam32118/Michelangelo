/**
 * renderAudio: an AudioPlan → 48 kHz stereo WAV, through one ffmpeg -filter_complex_script.
 * Segments are trimmed by sample, tempo-adjusted and enveloped (clip gain); a clip with fx has its segments joined
 * and run through its fx chain once (latency-compensated); then fades, and everything is laid end to end in
 * non-overlapping lanes (concat with exact silent gaps, so cost is linear in the timeline length).
 * Per bus: mix → bus fx → duck (sidechaincompress) → bus gain/mute; summed into master and loudness-normalised
 * (two passes). Order in a clip: gain → fx → fades.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fail } from '../core/errors.js';
import type { AudioPlan, AudioSegment, FilterSpec } from '../render/types.js';
import { getFfmpeg } from './ffmpeg.js';
import { escapeValue, filtersToString } from './filters.js';
import { probe, type MediaInfoExt } from './probe.js';
import { run } from './proc.js';

const SR = 48000;

export interface RenderAudioOptions {
  baseDir?: string;
  cacheDir?: string;
  /** keep the generated filter script (debugging) */
  keepScript?: string;
  /** render only this bus's contribution to master (see MediaBackend.renderAudio); 'all' = stems in one multichannel WAV */
  bus?: string;
  /** PCM bit depth of the WAV (default 16) */
  pcmDepth?: 16 | 24;
}

/** graph-level solo: only `bus` (and the buses that feed it) reach master; every bus is still built (ducking sidechains) */
interface GraphOptions extends RenderAudioOptions { solo?: string }

/**
 * sidechaincompress settings that lower the ducked bus by ≈ db while the sidechain has signal.
 * The sidechain is first driven into a hard clip (SIDECHAIN_DRIVE), so any audible signal arrives at
 * ≈ 0 dBFS whatever its level; the threshold and ratio then give a fixed reduction of `db`.
 */
export function duckParams(db: number, attack: number, release: number) {
  const ref = -1;
  const span = Math.max(20, db / 0.95);
  const thresholdDb = Math.max(-60, ref - span);
  const ratio = Math.min(20, Math.max(1, 1 / (1 - db / (ref - thresholdDb))));
  return {
    threshold: Math.pow(10, thresholdDb / 20),
    ratio,
    attack: Math.min(2000, Math.max(0.01, attack)),
    release: Math.min(9000, Math.max(0.01, release)),
  };
}
export const SIDECHAIN_DRIVE = 'volume=40dB,asoftclip=type=hard';

/** atempo filters for a speed factor (each stage within 0.5–2 for quality). */
export function atempoChain(f: number): string[] {
  const out: string[] = [];
  if (!(f > 0) || Math.abs(f - 1) < 1e-9) return out;
  while (f > 2 + 1e-9) { out.push('atempo=2'); f /= 2; }
  while (f < 0.5 - 1e-9) { out.push('atempo=0.5'); f /= 0.5; }
  if (Math.abs(f - 1) > 1e-9) out.push(`atempo=${Number(f.toFixed(6))}`);
  return out;
}

/** A volume filter for a dB envelope [[sampleOffset, dB], ...] (linear in dB between points). */
export function volumeFilter(gain: [number, number][]): string | null {
  if (!gain.length) return null;
  if (gain.length === 1) return gain[0]![1] === 0 ? null : `volume=${gain[0]![1]}dB`;
  const pts = gain.map(([s, db]) => [s / SR, db] as [number, number]);
  let expr = `${pts[pts.length - 1]![1]}`;
  for (let i = pts.length - 2; i >= 0; i--) {
    const [t0, g0] = pts[i]!, [t1, g1] = pts[i + 1]!;
    const seg = t1 > t0 ? `${g0}+(${g1 - g0})*(t-${t0})/${t1 - t0}` : `${g1}`;
    expr = `if(lt(t,${t1}),${seg},${expr})`;
  }
  if (pts[0]![0] > 0) expr = `if(lt(t,${pts[0]![0]}),${pts[0]![1]},${expr})`;
  return `asetnsamples=n=256,volume=${escapeValue(`pow(10,(${expr})/20)`)}:eval=frame`;
}

/**
 * Output delay in samples (48 kHz) of an audio filter: its own `latency`, else the measured lookahead of known
 * ffmpeg filters (alimiter is compensated by its own latency option, see fxFilters).
 */
export function filterLatency(f: FilterSpec): number {
  if (typeof f.latency === 'number' && f.latency > 0) return Math.round(f.latency);
  const a = f.args ?? {};
  const sec = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  switch (f.filter) {
    case 'afftdn': return 1200; // 2400-sample window at 48 kHz, half of it ahead
    case 'anlmdn': return Math.round(sec(a.r ?? a.research, 0.006) * SR) + Math.round(sec(a.p ?? a.patch, 0.002) * SR);
    case 'superequalizer': return 4095;
    default: return 0;
  }
}
/** alimiter delays by its attack unless `latency` is on: turn it on (an explicit latency=false is respected). */
function fxFilters(filters: FilterSpec[]): FilterSpec[] {
  return filters.map((f) => (f.filter === 'alimiter' && f.args?.latency === undefined ? { ...f, args: { ...f.args, latency: true } } : f));
}
/**
 * Audio-stage effect filters as filtergraph text (allowlisted and escaped), latency-compensated, or '' for none:
 * the input is padded by the chain's total lookahead L and the first L output samples are dropped, so a transient
 * keeps its sample position.
 */
function audioStage(filters: FilterSpec[] | undefined, baseDir?: string): string {
  if (!filters?.length) return '';
  const fs = fxFilters(filters);
  const body = filtersToString(fs, { stage: 'audio', ...(baseDir ? { baseDir } : {}) });
  const L = fs.reduce((n, f) => n + filterLatency(f), 0);
  return L > 0 ? `apad=pad_len=${L},${body},atrim=start_sample=${L},asetpts=PTS-STARTPTS` : body;
}
/** back to the mix format after effects (a pan to mono or a resample must not change the bus layout) */
const AFTER_FX = `aresample=${SR},aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo`;

interface Src { path: string; label: string; info: MediaInfoExt; segs: AudioSegment[] }

/** The filter script for the mix up to (and including) master, with `[out]` of exactly plan.length samples. */
export async function buildMixGraph(plan: AudioPlan, opts: GraphOptions = {}): Promise<{ inputs: string[]; script: string; dropped: string[] }> {
  const L = plan.length;
  const srcs = new Map<string, Src>();
  const dropped: string[] = [];
  for (const s of plan.segments) {
    if (s.end <= s.start) continue;
    if (!(s.speed.num > 0)) continue;
    const path = isAbsolute(s.src) ? s.src : resolve(opts.baseDir ?? '.', s.src);
    let e = srcs.get(path);
    if (!e) {
      const info = await probe(path, opts.cacheDir ? { cacheDir: opts.cacheDir } : {});
      e = { path, label: '', info, segs: [] };
      srcs.set(path, e);
    }
    if (e.info.hasAudio) e.segs.push(s); else dropped.push(s.clipId);
  }
  const used = [...srcs.values()].filter((s) => s.segs.length);
  const lines: string[] = [];
  const inputs: string[] = [];
  /** what goes into the bus lanes: a segment, or a clip's segments joined and run through its fx once */
  interface Item { start: number; end: number; bus: string; label: string }
  const items: Item[] = [];
  /** segments with clip fx, grouped per clip (pieces of one clip never overlap; instances that do get their own group) */
  const groups: { clipId: string; bus: string; filters: FilterSpec[]; end: number; parts: { seg: AudioSegment; label: string }[] }[] = [];
  let n = 0, pieceN = 0;
  used.forEach((src, i) => {
    inputs.push(src.path);
    const fmt = src.info.channels === 1 ? 'pan=stereo|c0=c0|c1=c0' : 'aformat=channel_layouts=stereo';
    const outs = src.segs.map(() => `s${n++}`);
    lines.push(`[${i}:a]aresample=${SR}:async=1:first_pts=0,${fmt},aformat=sample_fmts=fltp:sample_rates=${SR}${outs.length > 1 ? `,asplit=${outs.length}` : ''}${outs.map((o) => `[${o}]`).join('')}`);
    // source time 0 = the first video frame (or the first audio sample) on the container clock
    const zero = Math.round(((src.info.hasVideo ? src.info.startTime ?? 0 : src.info.audioStart ?? 0) - (src.info.formatStart ?? 0)) * SR);
    src.segs.forEach((s, k) => {
      const N = s.end - s.start;
      const sp = s.speed.num / s.speed.den;
      const s0 = Math.max(0, zero + Math.floor((s.sourceFrame * SR * s.rate.den) / s.rate.num + 1e-6));
      const need = Math.ceil(N * sp) + (Math.abs(sp - 1) > 1e-9 ? 8192 : 0);
      const chain = [`atrim=start_sample=${s0}:end_sample=${s0 + need}`, 'asetpts=PTS-STARTPTS', ...atempoChain(sp), `apad=whole_len=${N}`, `atrim=end_sample=${N}`];
      // clip gain first: the clip fx see the level the editor set (a limiter then holds its ceiling)
      const vol = volumeFilter(s.gain);
      if (vol) chain.push(vol);
      if (s.filters?.length) {
        const lab = `p${pieceN++}`;
        lines.push(`[${outs[k]}]${chain.join(',')}[${lab}]`);
        let g = groups.find((x) => x.clipId === s.clipId && x.bus === s.bus && x.end <= s.start);
        if (!g) { g = { clipId: s.clipId, bus: s.bus, filters: s.filters, end: 0, parts: [] }; groups.push(g); }
        g.parts.push({ seg: s, label: lab });
        g.end = s.end;
        return;
      }
      if (s.fadeIn > 0) chain.push(`afade=t=in:start_sample=0:nb_samples=${Math.min(s.fadeIn, N)}`);
      if (s.fadeOut > 0) chain.push(`afade=t=out:start_sample=${Math.max(0, N - s.fadeOut)}:nb_samples=${Math.min(s.fadeOut, N)}`);
      const lab = `g${items.length}`;
      lines.push(`[${outs[k]}]${chain.join(',')}[${lab}]`);
      items.push({ start: s.start, end: s.end, bus: s.bus, label: lab });
    });
  });

  let z = 0;
  const silence = (len: number) => { const l = `z${z++}`; lines.push(`anullsrc=r=${SR}:cl=stereo:nb_samples=1024,aformat=sample_fmts=fltp,atrim=end_sample=${len}[${l}]`); return l; };

  // clip fx: the clip's pieces (loop wraps, remap pieces, nested-comp repeats) laid end to end with exact silent
  // gaps, then one fx chain over the continuous sound (no restart or dropout at a boundary), then the fades
  groups.forEach((g, gi) => {
    g.parts.sort((a, b) => a.seg.start - b.seg.start);
    const G0 = g.parts[0]!.seg.start, G1 = g.end, N = G1 - G0;
    const parts: string[] = [];
    let at = G0;
    for (const p of g.parts) {
      if (p.seg.start > at) parts.push(silence(p.seg.start - at));
      parts.push(p.label);
      at = p.seg.end;
    }
    const chain = [audioStage(g.filters, opts.baseDir), AFTER_FX, `apad=whole_len=${N}`, `atrim=end_sample=${N}`];
    // fades on the joined sound: in from the first piece that fades in, out to the end of the last that fades out
    const fin = g.parts.filter((p) => p.seg.fadeIn > 0), fout = g.parts.filter((p) => p.seg.fadeOut > 0);
    if (fin.length) {
      const endIn = Math.max(...fin.map((p) => p.seg.start + p.seg.fadeIn)) - G0;
      const s0 = fin[0]!.seg.start - G0;
      chain.push(`afade=t=in:start_sample=${s0}:nb_samples=${Math.max(1, endIn - s0)}`);
    }
    if (fout.length) {
      const last = fout[fout.length - 1]!.seg;
      const startOut = Math.min(...fout.map((p) => p.seg.end - p.seg.fadeOut)) - G0;
      chain.push(`afade=t=out:start_sample=${startOut}:nb_samples=${Math.max(1, last.end - G0 - startOut)}`);
    }
    const lab = `c${gi}`;
    lines.push(parts.length === 1 ? `[${parts[0]}]${chain.join(',')}[${lab}]` : `${parts.map((x) => `[${x}]`).join('')}concat=n=${parts.length}:v=0:a=1,${chain.join(',')}[${lab}]`);
    items.push({ start: G0, end: G1, bus: g.bus, label: lab });
  });

  // lanes per bus: greedy interval packing, each lane is one concat of gaps and segments
  const busInputs = new Map<string, string[]>();
  const byBus = new Map<string, Item[]>();
  for (const s of items) { if (!byBus.has(s.bus)) byBus.set(s.bus, []); byBus.get(s.bus)!.push(s); }
  let laneN = 0;
  for (const [bus, segs] of byBus) {
    segs.sort((a, b) => a.start - b.start);
    const lanes: { end: number; parts: string[] }[] = [];
    for (const s of segs) {
      let lane = lanes.find((l) => l.end <= s.start);
      if (!lane) { lane = { end: 0, parts: [] }; lanes.push(lane); }
      if (s.start > lane.end) lane.parts.push(silence(s.start - lane.end));
      lane.parts.push(s.label);
      lane.end = s.end;
    }
    for (const lane of lanes) {
      const l = `lane${laneN++}`;
      lines.push(lane.parts.length === 1 ? `[${lane.parts[0]}]anull[${l}]` : `${lane.parts.map((p) => `[${p}]`).join('')}concat=n=${lane.parts.length}:v=0:a=1[${l}]`);
      if (!busInputs.has(bus)) busInputs.set(bus, []);
      busInputs.get(bus)!.push(l);
    }
  }

  // buses in dependency order: children (to) and duck sources before the bus that uses them
  const buses = new Map(plan.buses.map((b) => [b.id, b]));
  if (!buses.has('master')) buses.set('master', { id: 'master', gainDb: 0, muted: false, to: '' });
  for (const id of byBus.keys()) if (!buses.has(id)) buses.set(id, { id, gainDb: 0, muted: false, to: 'master' });
  const parentOf = (id: string) => (id === 'master' ? '' : buses.get(id)!.to || 'master');
  const order: string[] = [];
  const state = new Map<string, 1 | 2>();
  const dfs = (id: string) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) fail('E_BUS_CYCLE', `bus "${id}" routes or ducks in a cycle.`, 'check the buses table: "to" and "duck.by" must not loop back.');
    state.set(id, 1);
    for (const b of buses.values()) if (b.id !== id && parentOf(b.id) === id) dfs(b.id);
    const d = buses.get(id)!.duck;
    if (d && buses.has(d.by)) dfs(d.by);
    state.set(id, 2);
    order.push(id);
  };
  for (const id of buses.keys()) dfs(id);
  if (order[order.length - 1] !== 'master') { order.splice(order.indexOf('master'), 1); order.push('master'); }

  // solo: `under` = the soloed bus and the buses feeding it (master alone = its own lanes); `path` = its route to master
  let under: Set<string> | null = null, path: Set<string> | null = null;
  if (opts.solo !== undefined) {
    if (!buses.has(opts.solo)) fail('E_REF', `bus "${opts.solo}" does not exist.`, `use one of: ${[...buses.keys()].join(', ')} (or all).`);
    under = new Set([opts.solo]);
    if (opts.solo !== 'master') for (let grew = true; grew;) { grew = false; for (const b of buses.keys()) if (!under.has(b) && under.has(parentOf(b))) { under.add(b); grew = true; } }
    path = new Set();
    for (let id = opts.solo; id; id = parentOf(id)) path.add(id);
  }
  const outLabel = new Map<string, string>();
  const consumers = new Map<string, string[]>();
  const usedLanes = new Set<string>();
  for (const id of order) {
    const b = buses.get(id)!;
    const onPath = !!path?.has(id) && !under!.has(id);
    const ins = onPath ? [] : [...(busInputs.get(id) ?? [])];
    for (const c of order) {
      if (c === id || parentOf(c) !== id || !outLabel.has(c)) continue;
      if (onPath && !path!.has(c)) continue; // a sibling of the soloed route: muted
      if (under?.has(id) && !under.has(c)) continue; // master soloed alone: its child buses are muted
      ins.push(takeOut(c));
    }
    if (!ins.length) continue;
    for (const x of ins) usedLanes.add(x);
    let cur = `bus_${id}_mix`;
    lines.push(ins.length === 1
      ? `[${ins[0]}]apad=whole_len=${L},atrim=end_sample=${L}[${cur}]`
      : `${ins.map((x) => `[${x}]`).join('')}amix=inputs=${ins.length}:normalize=0:duration=longest:dropout_transition=0,apad=whole_len=${L},atrim=end_sample=${L}[${cur}]`);
    // the bus's own fx run before the duck, so ducking lowers the bus by the requested dB (a compressor after the
    // duck would shrink it); the duck, then the bus gain, come last
    const bfx = audioStage(b.filters, opts.baseDir);
    if (bfx) {
      const nxt = `bus_${id}_fx`;
      lines.push(`[${cur}]${bfx},${AFTER_FX},apad=whole_len=${L},atrim=end_sample=${L}[${nxt}]`);
      cur = nxt;
    }
    if (b.duck && outLabel.has(b.duck.by)) {
      const sc = takeOut(b.duck.by);
      const p = duckParams(b.duck.db, b.duck.attack, b.duck.release);
      const nxt = `bus_${id}_duck`;
      lines.push(`[${sc}]${SIDECHAIN_DRIVE}[${sc}_d]`);
      lines.push(`[${cur}][${sc}_d]sidechaincompress=threshold=${p.threshold.toFixed(6)}:ratio=${p.ratio.toFixed(4)}:attack=${p.attack}:release=${p.release}:makeup=1:knee=1:detection=rms:link=maximum[${nxt}]`);
      cur = nxt;
    }
    const post: string[] = [];
    if (b.muted) post.push('volume=0');
    else if (b.gainDb) post.push(`volume=${b.gainDb}dB`);
    if (post.length) { const nxt = `bus_${id}_out`; lines.push(`[${cur}]${post.join(',')}[${nxt}]`); cur = nxt; }
    outLabel.set(id, cur);
    consumers.set(id, []);
  }
  function takeOut(id: string): string {
    const l = `${outLabel.get(id)}_u${consumers.get(id)!.length}`;
    consumers.get(id)!.push(l);
    return l;
  }
  // every bus output feeds its consumers through asplit (or directly when used once)
  const final: string[] = [];
  for (const [id, label] of outLabel) {
    const us = consumers.get(id)!;
    if (id === 'master') us.push('out');
    if (us.length === 1) {
      // rename by an anull
      final.push(`[${label}]anull[${us[0]}]`);
    } else if (us.length > 1) final.push(`[${label}]asplit=${us.length}${us.map((u) => `[${u}]`).join('')}`);
    else final.push(`[${label}]anullsink`);
  }
  // lanes of buses muted by a solo (or with nowhere to go) still need a sink, or ffmpeg refuses the graph
  for (const ls of busInputs.values()) for (const l of ls) if (!usedLanes.has(l)) final.push(`[${l}]anullsink`);
  if (!outLabel.has('master')) final.push(`anullsrc=r=${SR}:cl=stereo:nb_samples=1024,atrim=end_sample=${L}[out]`);
  return { inputs, script: [...lines, ...final].join(';\n') + '\n', dropped };
}

async function runGraph(ffmpeg: string, inputs: string[], script: string, out: string, codec: string, dir: string, keep?: string) {
  const path = join(dir, 'graph.txt');
  await writeFile(path, script);
  if (keep) await writeFile(keep, script);
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y'];
  for (const i of inputs) args.push('-i', i);
  args.push('-filter_complex_script', path, '-map', '[out]', '-ac', '2', '-ar', String(SR), '-c:a', codec, '-f', 'wav', out);
  await run(ffmpeg, args, { what: 'rendering the audio mix', fix: 'check the audio assets (mgl show <file>); if this persists, report it with the script from renderAudio({keepScript})' });
}

export interface LoudnormMeasure { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string }

export async function measureLoudnorm(ffmpeg: string, file: string, lufs: number, peak: number): Promise<LoudnormMeasure> {
  const r = await run(ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-v', 'info', '-i', file, '-af', `loudnorm=I=${lufs}:TP=${peak}:LRA=11:print_format=json`, '-f', 'null', '-'], { what: 'measuring loudness' });
  const m = /\{[\s\S]*?\}/.exec(r.stderr.slice(r.stderr.lastIndexOf('[Parsed_loudnorm')));
  if (!m) fail('E_MEDIA', 'loudnorm printed no measurement.', 'check that this ffmpeg has the loudnorm filter (mgl doctor).');
  return JSON.parse(m[0]) as LoudnormMeasure;
}

/** Render the plan to a 48 kHz stereo WAV (16-bit unless pcmDepth: 24) of exactly plan.length samples. */
export async function renderAudio(plan: AudioPlan, out: string, opts: RenderAudioOptions = {}): Promise<{ dropped: string[]; notes: string[] }> {
  const ff = await getFfmpeg();
  const L = Math.max(0, Math.floor(plan.length));
  const pcm = opts.pcmDepth === 24 ? 'pcm_s24le' : 'pcm_s16le';
  const notes: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'mgl-audio-'));
  try {
    if (L === 0) fail('E_RANGE', 'the audio plan is empty (0 samples).', 'render a comp or range with a positive length.');
    const stems = opts.bus === 'all' ? stemBuses(plan) : opts.bus !== undefined ? [opts.bus] : null;
    const live = plan.segments.filter((s) => s.end > s.start && s.speed.num > 0);
    if (!live.length) {
      const ch = stems ? 2 * stems.length : 2;
      await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=${SR}:cl=stereo`, '-af', `atrim=end_sample=${L}`, ...(ch > 2 ? ['-ac', String(ch)] : []), '-c:a', pcm, '-f', 'wav', out], { what: 'writing silence' });
      return { dropped: [], notes };
    }
    const full = { ...plan, length: L };
    const master = plan.buses.find((b) => b.id === 'master');
    const target = master?.loudness && !master.muted ? master.loudness : undefined;
    // master loudness: measured on the full mix; a stem gets the same gain so the stems sum to the mix
    let gainDb: number | null = null, limited = false, dropped: string[] = [];
    let mixAf = 'anull';
    if (target) {
      const g = await buildMixGraph(full, opts);
      dropped = g.dropped;
      const pre = join(dir, 'pre.wav');
      await runGraph(ff.ffmpeg, g.inputs, g.script, pre, 'pcm_f32le', dir, stems ? undefined : opts.keepScript);
      const m = await measureLoudnorm(ff.ffmpeg, pre, target.lufs, target.peak);
      const I = Number(m.input_i), TP = Number(m.input_tp);
      if (!Number.isFinite(I) || I < -70) { gainDb = 0; mixAf = 'anull'; } // silence: nothing to normalise
      else {
        gainDb = target.lufs - I;
        limited = TP + gainDb > target.peak;
        mixAf = limited
          ? `loudnorm=I=${target.lufs}:TP=${target.peak}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=${SR}`
          : `volume=${gainDb.toFixed(3)}dB`;
      }
      if (!stems) {
        await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', pre, '-af', `${mixAf},apad=whole_len=${L},atrim=end_sample=${L}`, '-ar', String(SR), '-c:a', pcm, '-f', 'wav', out], { what: 'normalising loudness' });
        return { dropped, notes };
      }
    }
    if (!stems) {
      const g = await buildMixGraph(full, opts);
      await runGraph(ff.ffmpeg, g.inputs, g.script, out, pcm, dir, opts.keepScript);
      return { dropped: g.dropped, notes };
    }
    // stems: each bus's contribution to master, with the mix's loudness gain (never normalised on its own)
    const files: string[] = [];
    for (const [k, bus] of stems.entries()) {
      const g = await buildMixGraph(full, { ...opts, solo: bus });
      if (!dropped.length) dropped = g.dropped;
      const raw = join(dir, `stem${k}.wav`);
      await runGraph(ff.ffmpeg, g.inputs, g.script, raw, gainDb ? 'pcm_f32le' : pcm, dir, undefined);
      if (gainDb) {
        const fin = join(dir, `stem${k}-g.wav`);
        await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', raw, '-af', `volume=${gainDb.toFixed(3)}dB,apad=whole_len=${L},atrim=end_sample=${L}`, '-c:a', pcm, '-f', 'wav', fin], { what: `applying the master gain to stem ${bus}` });
        files.push(fin);
      } else files.push(raw);
    }
    if (target) {
      notes.push(`stem${stems.length > 1 ? 's' : ''} not loudness-normalised on ${stems.length > 1 ? 'their' : 'its'} own: the full mix's master gain (${gainDb! >= 0 ? '+' : ''}${gainDb!.toFixed(1)} dB, to ${target.lufs} LUFS) is applied so stems sum to the mix`);
      if (limited) notes.push(`the full mix is also peak-limited to ${target.peak} dBTP; stems carry the gain without the limiter, so their sum can peak higher than the mix`);
    } else notes.push(`stem${stems.length > 1 ? 's' : ''}: bus contribution${stems.length > 1 ? 's' : ''} to master (other buses muted)`);
    const nonlinear = plan.buses.find((b) => b.id === 'master')?.filters?.length;
    if (nonlinear) notes.push('master has audio effects; they run on each stem separately, so non-linear ones (compressors, limiters) make the stems differ from the mix');
    const parent = (id: string) => (id === 'master' ? '' : plan.buses.find((b) => b.id === id)?.to || 'master');
    const feeds = (from: string, bus: string) => { if (bus === 'master') return from === 'master'; for (let id = from; id; id = parent(id)) if (id === bus) return true; return false; };
    const empty = stems.filter((b) => !live.some((sg) => feeds(sg.bus, b)));
    if (empty.length) notes.push(`bus${empty.length > 1 ? 'es' : ''} ${empty.join(', ')} ${empty.length > 1 ? 'have' : 'has'} no sound in this range, so ${empty.length > 1 ? 'their stems are' : 'its stem is'} silent (a track with no bus sends to master)`);
    const mutedStems = stems.filter((b) => plan.buses.find((x) => x.id === b)?.muted);
    if (mutedStems.length) notes.push(`bus${mutedStems.length > 1 ? 'es' : ''} ${mutedStems.join(', ')} ${mutedStems.length > 1 ? 'are' : 'is'} muted, so ${mutedStems.length > 1 ? 'their stems are' : 'its stem is'} silent`);
    if (files.length === 1) { await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', files[0]!, '-c:a', pcm, '-f', 'wav', out], { what: 'writing the stem' }); return { dropped, notes }; }
    const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y'];
    for (const f of files) args.push('-i', f);
    args.push('-filter_complex', `${files.map((_, i) => `[${i}:a]`).join('')}amerge=inputs=${files.length}[out]`, '-map', '[out]', '-c:a', pcm, '-f', 'wav', out);
    await run(ff.ffmpeg, args, { what: 'joining the stems into one multichannel WAV' });
    notes.push(`${files.length * 2} channels: ${stems.map((b, i) => `${2 * i + 1}-${2 * i + 2} ${b === 'master' ? 'master (tracks sent straight to master)' : b}`).join(', ')}`);
    return { dropped, notes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The stems of bus "all": every bus feeding master (sorted by id), plus master itself (last) when tracks send to it directly. */
export function stemBuses(plan: AudioPlan): string[] {
  const ids = new Set(plan.buses.map((b) => b.id));
  for (const s of plan.segments) ids.add(s.bus);
  const to = (id: string) => plan.buses.find((b) => b.id === id)?.to || 'master';
  const out = [...ids].filter((id) => id !== 'master' && to(id) === 'master').sort();
  if (plan.segments.some((s) => s.bus === 'master')) out.push('master');
  return out.length ? out : ['master'];
}
