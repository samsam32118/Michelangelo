/**
 * planAudio: flatten every audible span of a comp (audio clips, video clips' own audio, nested comps)
 * into absolute 48 kHz sample spans. Pure: no ffmpeg, no file access (pass `hasAudio` to know which
 * video assets carry sound). Sample maths per DESIGN §16 #7: sample(f) = floor(f × 48000 × den / num).
 */
import { resolve } from 'node:path';
import { fail } from '../core/errors.js';
import type { Clip, Comp, ProjectFile, Track } from '../core/schema/index.js';
import { parseRate, parseSpeed, type Rate } from '../core/time.js';
import type { AudioPlan, AudioSegment } from '../render/types.js';

export const SAMPLE_RATE = 48000;
const NOT_AUDIBLE = /\.(png|jpe?g|webp|gif|bmp|svg|tiff?|avif|cube|3dl|srt|vtt|ttf|otf|woff2?|json|txt)$/i;

// ---------------------------------------------------------------------------- exact rationals
interface Q { n: bigint; d: bigint }
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
const q = (n: bigint | number, d: bigint | number = 1n): Q => {
  let N = BigInt(n), D = BigInt(d);
  if (D < 0n) { N = -N; D = -D; }
  const g = gcd(N, D);
  return { n: N / g, d: D / g };
};
const add = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Q, b: Q) => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d);
const div = (a: Q, b: Q) => q(a.n * b.d, a.d * b.n);
const cmp = (a: Q, b: Q) => { const x = a.n * b.d - b.n * a.d; return x < 0n ? -1 : x > 0n ? 1 : 0; };
const max = (a: Q, b: Q) => (cmp(a, b) >= 0 ? a : b);
const min = (a: Q, b: Q) => (cmp(a, b) <= 0 ? a : b);
const floorQ = (a: Q): bigint => { const f = a.n / a.d; return a.n < 0n && f * a.d !== a.n ? f - 1n : f; };
const toNum = (a: Q) => Number(a.n) / Number(a.d);
const fromRate = (r: Rate) => q(r.num, r.den);
/** A float (≤ 3 decimals in practice) as a rational. */
const fromFloat = (v: number): Q => (Number.isInteger(v) ? q(v) : q(Math.round(v * 1000), 1000));

/** Exact sample index of a (rational) frame position at `rate`. */
export function sampleOf(frame: Q | number, rate: Rate): number {
  const f = typeof frame === 'number' ? q(frame) : frame;
  return Number(floorQ(q(f.n * BigInt(SAMPLE_RATE) * BigInt(rate.den), f.d * BigInt(rate.num))));
}

// ---------------------------------------------------------------------------- planning
export interface PlanAudioOptions {
  /** directory asset paths resolve against (the project file's directory) */
  baseDir: string;
  /** [start, end) in frames of the comp: the plan covers only this range and starts at its start */
  range?: [number, number];
  /** does this video asset have an audio stream? (default: assume yes; renderAudio skips files without audio) */
  hasAudio?: (assetId: string, src: string) => boolean;
}

/** Map from a comp's frames to top-comp frames: top = a + f × m, visible for f in [w0, w1). */
interface Ctx { compId: string; a: Q; m: Q; w0: Q; w1: Q; depth: number }

function compLength(p: ProjectFile, comp: Comp, clipsByComp: Map<string, Clip[]>): number {
  if (typeof comp.length === 'number') return comp.length;
  let end = 0;
  for (const c of clipsByComp.get(comp.id) ?? []) end = Math.max(end, c.at + c.len);
  return end;
}

const speedOf = (c: Clip): Q => { const s = parseSpeed(c.speed ?? 1); return q(s.num, s.den); };

interface Piece { at: number; len: number; in: Q; speed: Q }

/** A clip's playback as constant-speed pieces in clip-local frames (remap keyframes become pieces). */
function piecesOf(c: Clip): Piece[] {
  const r = c.remap;
  if (r === undefined) return [{ at: 0, len: c.len, in: q(c.in ?? 0), speed: speedOf(c) }];
  if (typeof r === 'number') return []; // a constant remap is a freeze: silent
  const keys = (r as [number, number, unknown?][]).map(([f, v, e]) => ({ f, v: fromFloat(v), hold: e === 'hold' })).sort((x, y) => x.f - y.f);
  const out: Piece[] = [];
  for (let i = 0; i + 1 < keys.length; i++) {
    const k = keys[i]!, k2 = keys[i + 1]!;
    const s = Math.max(0, k.f), e = Math.min(c.len, k2.f);
    if (e <= s || k.hold) continue;
    const speed = div(sub(k2.v, k.v), q(k2.f - k.f));
    if (cmp(speed, q(0)) <= 0) continue; // frozen or reversed: silent
    out.push({ at: s, len: e - s, in: add(k.v, mul(speed, q(s - k.f))), speed });
  }
  return out;
}

/** Gain points [clip-local frame, dB] from a constant or keyframes (hold → step; other easings → linear). */
function gainKeys(c: Clip): [number, number][] {
  const g = c.gain;
  if (g === undefined) return [[0, 0]];
  if (typeof g === 'number') return [[0, g]];
  const keys = [...(g as [number, number, unknown?][])].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  keys.forEach(([f, v, e], i) => {
    out.push([f, v]);
    const next = keys[i + 1];
    if (e === 'hold' && next && next[0] - f > 0) out.push([next[0] - 1e-3, v]);
  });
  return out;
}

function interp(points: [number, number][], x: number): number {
  if (x <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!, [x0, y0] = points[i - 1]!;
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1]![1];
}

export function planAudio(project: ProjectFile, compId: string, opts: PlanAudioOptions): AudioPlan {
  const comps = new Map((project.comps ?? []).map((c) => [c.id, c]));
  const tracks = new Map((project.tracks ?? []).map((t) => [t.id, t]));
  const assets = new Map((project.assets ?? []).map((a) => [a.id, a]));
  const clipsByComp = new Map<string, Clip[]>();
  for (const c of project.clips ?? []) {
    const t = tracks.get(c.track);
    if (!t) continue;
    if (!clipsByComp.has(t.comp)) clipsByComp.set(t.comp, []);
    clipsByComp.get(t.comp)!.push(c);
  }
  const top = comps.get(compId);
  if (!top) fail('E_REF', `comp "${compId}" does not exist.`, `use one of: ${[...comps.keys()].join(', ')}.`);
  const topRate = parseRate(top.fps);
  const len = compLength(project, top, clipsByComp);
  const [r0, r1] = opts.range ?? [0, len];
  if (!(r1 >= r0 && r0 >= 0)) fail('E_RANGE', `range ${r0}-${r1} is not valid.`, 'give a range start ≤ end within the comp.');
  const base = sampleOf(r0, topRate);
  const segments: AudioSegment[] = [];

  const visit = (ctx: Ctx) => {
    if (ctx.depth > 32) fail('E_CYCLE', `comp nesting deeper than 32 levels at "${ctx.compId}".`, 'remove the cycle of nested comps.');
    const comp = comps.get(ctx.compId)!;
    const rate = parseRate(comp.fps);
    for (const c of clipsByComp.get(ctx.compId) ?? []) {
      const track = tracks.get(c.track)!;
      if (track.muted) continue;
      if (c.comp !== undefined) { nested(ctx, c, rate); continue; }
      if (c.asset === undefined || c.muted) continue;
      const asset = assets.get(c.asset);
      if (!asset) continue;
      const src = resolve(opts.baseDir, asset.src);
      if (asset.kind ? asset.kind !== 'audio' && asset.kind !== 'video' : NOT_AUDIBLE.test(asset.src)) continue;
      if (!track.audio && asset.kind !== 'audio' && opts.hasAudio && !opts.hasAudio(asset.id, src)) continue;
      leaf(ctx, c, track, src, rate);
    }
  };

  const leaf = (ctx: Ctx, c: Clip, track: Track, src: string, rate: Rate) => {
    const bus = track.bus ?? 'master';
    /** output sample of a clip-local frame */
    const S = (local: Q) => sampleOf(add(ctx.a, mul(add(q(c.at), local), ctx.m)), topRate) - base;
    const [fin, fout] = c.fade ?? [0, 0];
    const fadeInEnd = S(q(Math.min(fin, c.len))), fadeOutStart = S(q(c.len - Math.min(fout, c.len)));
    const gk = gainKeys(c).map(([f, db]) => [S(fromFloat(f)), db] as [number, number]);
    for (const p of piecesOf(c)) {
      if (cmp(p.speed, q(0)) <= 0) continue; // freeze: silent
      const v0 = max(q(c.at + p.at), ctx.w0), v1 = min(q(c.at + p.at + p.len), ctx.w1);
      if (cmp(v1, v0) <= 0) continue;
      const t0 = max(add(ctx.a, mul(v0, ctx.m)), q(r0)), t1 = min(add(ctx.a, mul(v1, ctx.m)), q(r1));
      if (cmp(t1, t0) <= 0) continue;
      const start = sampleOf(t0, topRate) - base, end = sampleOf(t1, topRate) - base;
      if (end <= start) continue;
      // source position at t0, in frames of this comp's rate: in + (local frames since piece start) × speed
      const local = sub(div(sub(t0, ctx.a), ctx.m), q(c.at + p.at));
      const srcFrame = add(p.in, mul(local, p.speed));
      // output speed: source seconds per output second
      const speed = div(mul(p.speed, fromRate(topRate)), mul(fromRate(rate), ctx.m));
      segments.push({
        clipId: c.id, src, start, end,
        sourceFrame: toNum(srcFrame), rate,
        speed: { num: Number(speed.n), den: Number(speed.d) },
        bus,
        gain: gk.length === 1 ? [[0, gk[0]![1]]] : clipGain(gk, start, end),
        fadeIn: fin > 0 ? Math.max(0, Math.min(end, fadeInEnd) - start) : 0,
        fadeOut: fout > 0 ? Math.max(0, end - Math.max(fadeOutStart, start)) : 0,
      });
    }
  };

  const clipGain = (pts: [number, number][], start: number, end: number): [number, number][] => {
    const out: [number, number][] = [[0, interp(pts, start)]];
    for (const [s, db] of pts) if (s > start && s < end) out.push([s - start, db]);
    if (pts.some(([s]) => s >= end) && end - start > 1) out.push([end - start, interp(pts, end)]);
    const dedup = out.filter((p, i) => i === 0 || p[0] !== out[i - 1]![0]);
    return dedup.length > 1 && dedup.every((p) => p[1] === dedup[0]![1]) ? [dedup[0]!] : dedup;
  };

  const nested = (ctx: Ctx, c: Clip, parentRate: Rate) => {
    const child = comps.get(c.comp!);
    if (!child) return;
    const sp = speedOf(c);
    if (cmp(sp, q(0)) <= 0) return; // frozen nested comp: silent
    const childRate = parseRate(child.fps);
    // parent frame = at + (cf - in) × R, R = parentRate / (childRate × speed)
    const R = div(fromRate(parentRate), mul(fromRate(childRate), sp));
    const m = mul(R, ctx.m);
    const inQ = q(c.in ?? 0);
    const a = add(ctx.a, mul(sub(q(c.at), mul(inQ, R)), ctx.m));
    const pv0 = max(q(c.at), ctx.w0), pv1 = min(q(c.at + c.len), ctx.w1);
    if (cmp(pv1, pv0) <= 0) return;
    const cv0 = add(inQ, div(sub(pv0, q(c.at)), R)), cv1 = add(inQ, div(sub(pv1, q(c.at)), R));
    const L = compLength(project, child, clipsByComp);
    if (L <= 0) return;
    if (!c.loop) {
      visit({ compId: child.id, a, m, w0: max(cv0, q(0)), w1: min(cv1, q(L)), depth: ctx.depth + 1 });
      return;
    }
    for (let k = Number(floorQ(div(cv0, q(L)))); cmp(q(k * L), cv1) < 0; k++) {
      const off = q(k * L);
      visit({ compId: child.id, a: add(a, mul(off, m)), m, w0: max(sub(cv0, off), q(0)), w1: min(sub(cv1, off), q(L)), depth: ctx.depth + 1 });
    }
  };

  visit({ compId, a: q(0), m: q(1), w0: q(0), w1: q(len), depth: 0 });
  segments.sort((x, y) => x.start - y.start || x.clipId.localeCompare(y.clipId));

  // buses: every bus referenced, project settings applied; master last
  const busDefs = new Map((project.buses ?? []).map((b) => [b.id, b]));
  const ids = new Set<string>(['master']);
  for (const s of segments) ids.add(s.bus);
  for (const b of project.buses ?? []) { ids.add(b.id); if (b.to) ids.add(b.to); if (b.duck) ids.add(b.duck.by); }
  for (const t of project.tracks ?? []) if (t.bus) ids.add(t.bus);
  const buses: AudioPlan['buses'] = [...ids].map((id) => {
    const b = busDefs.get(id);
    const e: AudioPlan['buses'][number] = { id, gainDb: b?.gain ?? 0, muted: !!b?.muted, to: id === 'master' ? '' : b?.to ?? 'master' };
    if (b?.duck) e.duck = { by: b.duck.by, db: b.duck.db, attack: b.duck.attack ?? 20, release: b.duck.release ?? 300 };
    if (b?.loudness) e.loudness = { lufs: b.loudness.lufs, peak: b.loudness.peak ?? -1 };
    return e;
  });
  return { sampleRate: SAMPLE_RATE, length: sampleOf(r1, topRate) - base, segments, buses };
}
