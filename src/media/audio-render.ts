/**
 * renderAudio: an AudioPlan → 48 kHz stereo WAV, through one ffmpeg -filter_complex_script.
 * Segments are trimmed by sample, tempo-adjusted, enveloped and faded, then laid end to end in
 * non-overlapping lanes (concat with exact silent gaps, so cost is linear in the timeline length),
 * mixed per bus, ducked with sidechaincompress, summed into master and loudness-normalised (two passes).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fail } from '../core/errors.js';
import type { AudioPlan, AudioSegment } from '../render/types.js';
import { getFfmpeg } from './ffmpeg.js';
import { escapeValue } from './filters.js';
import { probe, type MediaInfoExt } from './probe.js';
import { run } from './proc.js';

const SR = 48000;

export interface RenderAudioOptions { baseDir?: string; cacheDir?: string; /** keep the generated filter script (debugging) */ keepScript?: string }

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

interface Src { path: string; label: string; info: MediaInfoExt; segs: AudioSegment[] }

/** The filter script for the mix up to (and including) master, with `[out]` of exactly plan.length samples. */
export async function buildMixGraph(plan: AudioPlan, opts: RenderAudioOptions = {}): Promise<{ inputs: string[]; script: string; dropped: string[] }> {
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
  const segLabel = new Map<AudioSegment, string>();
  let n = 0;
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
      const vol = volumeFilter(s.gain);
      if (vol) chain.push(vol);
      if (s.fadeIn > 0) chain.push(`afade=t=in:start_sample=0:nb_samples=${Math.min(s.fadeIn, N)}`);
      if (s.fadeOut > 0) chain.push(`afade=t=out:start_sample=${Math.max(0, N - s.fadeOut)}:nb_samples=${Math.min(s.fadeOut, N)}`);
      const lab = `g${segLabel.size}`;
      lines.push(`[${outs[k]}]${chain.join(',')}[${lab}]`);
      segLabel.set(s, lab);
    });
  });

  let z = 0;
  const silence = (len: number) => { const l = `z${z++}`; lines.push(`anullsrc=r=${SR}:cl=stereo:nb_samples=1024,aformat=sample_fmts=fltp,atrim=end_sample=${len}[${l}]`); return l; };

  // lanes per bus: greedy interval packing, each lane is one concat of gaps and segments
  const busInputs = new Map<string, string[]>();
  const byBus = new Map<string, AudioSegment[]>();
  for (const s of segLabel.keys()) { if (!byBus.has(s.bus)) byBus.set(s.bus, []); byBus.get(s.bus)!.push(s); }
  let laneN = 0;
  for (const [bus, segs] of byBus) {
    segs.sort((a, b) => a.start - b.start);
    const lanes: { end: number; parts: string[] }[] = [];
    for (const s of segs) {
      let lane = lanes.find((l) => l.end <= s.start);
      if (!lane) { lane = { end: 0, parts: [] }; lanes.push(lane); }
      if (s.start > lane.end) lane.parts.push(silence(s.start - lane.end));
      lane.parts.push(segLabel.get(s)!);
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

  const outLabel = new Map<string, string>();
  const consumers = new Map<string, string[]>();
  for (const id of order) {
    const b = buses.get(id)!;
    const ins = [...(busInputs.get(id) ?? [])];
    for (const c of order) if (c !== id && parentOf(c) === id && outLabel.has(c)) ins.push(takeOut(c));
    if (!ins.length) continue;
    let cur = `bus_${id}_mix`;
    lines.push(ins.length === 1
      ? `[${ins[0]}]apad=whole_len=${L},atrim=end_sample=${L}[${cur}]`
      : `${ins.map((x) => `[${x}]`).join('')}amix=inputs=${ins.length}:normalize=0:duration=longest:dropout_transition=0,apad=whole_len=${L},atrim=end_sample=${L}[${cur}]`);
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

/** Render the plan to a 48 kHz stereo 16-bit WAV of exactly plan.length samples. */
export async function renderAudio(plan: AudioPlan, out: string, opts: RenderAudioOptions = {}): Promise<{ dropped: string[] }> {
  const ff = await getFfmpeg();
  const L = Math.max(0, Math.floor(plan.length));
  const dir = await mkdtemp(join(tmpdir(), 'mgl-audio-'));
  try {
    if (L === 0) fail('E_RANGE', 'the audio plan is empty (0 samples).', 'render a comp or range with a positive length.');
    const live = plan.segments.filter((s) => s.end > s.start && s.speed.num > 0);
    if (!live.length) {
      await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=${SR}:cl=stereo`, '-af', `atrim=end_sample=${L}`, '-c:a', 'pcm_s16le', '-f', 'wav', out], { what: 'writing silence' });
      return { dropped: [] };
    }
    const g = await buildMixGraph({ ...plan, length: L }, opts);
    const master = plan.buses.find((b) => b.id === 'master');
    if (!master?.loudness || master.muted) {
      await runGraph(ff.ffmpeg, g.inputs, g.script, out, 'pcm_s16le', dir, opts.keepScript);
      return { dropped: g.dropped };
    }
    const { lufs, peak } = master.loudness;
    const pre = join(dir, 'pre.wav');
    await runGraph(ff.ffmpeg, g.inputs, g.script, pre, 'pcm_f32le', dir, opts.keepScript);
    const m = await measureLoudnorm(ff.ffmpeg, pre, lufs, peak);
    const I = Number(m.input_i), TP = Number(m.input_tp);
    let af: string;
    if (!Number.isFinite(I) || I < -70) af = 'anull'; // silence: nothing to normalise
    else if (TP + (lufs - I) <= peak) af = `volume=${(lufs - I).toFixed(3)}dB`;
    else af = `loudnorm=I=${lufs}:TP=${peak}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=${SR}`;
    await run(ff.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', pre, '-af', `${af},apad=whole_len=${L},atrim=end_sample=${L}`, '-ar', String(SR), '-c:a', 'pcm_s16le', '-f', 'wav', out], { what: 'normalising loudness' });
    return { dropped: g.dropped };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
