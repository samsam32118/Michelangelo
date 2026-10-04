// Extra grading helpers for the held-out v2 set. Plain ffmpeg/ffprobe + raw JSON only (no Michelangelo imports).
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  probe, frameAt, crop, resize, ssimImages, pcm, findProjectUsing, readProject, validateRaw, assetPaths, round, ffmpeg,
} from '../../lib/index.mjs';

export * from '../../lib/index.mjs';

export const X264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p'];
export const AAC = ['-c:a', 'aac', '-b:a', '160k'];
export const ff = (args) => ffmpeg(args, { timeoutMs: 600_000 });

/** Basic container facts of an output: {ok, detail, info}. */
export async function mediaFacts(file, { w, h, dur, durTol = 0.2, audio, channels } = {}) {
  const info = await probe(file);
  if (!info) return { ok: false, detail: `${file.split('/').slice(-2).join('/')} missing or unreadable` };
  const bad = [];
  if (!info.video) bad.push('no video');
  if (w && (info.displayWidth !== w || info.displayHeight !== h)) bad.push(`size ${info.displayWidth}x${info.displayHeight} (want ${w}x${h})`);
  if (dur !== undefined && !(Math.abs(info.duration - dur) <= durTol)) bad.push(`duration ${round(info.duration, 2)} (want ${dur} +-${durTol})`);
  if (audio === true && !info.audio) bad.push('no audio');
  if (channels && info.audio?.channels !== channels) bad.push(`audio channels ${info.audio?.channels} (want ${channels})`);
  return { ok: !bad.length, info, detail: bad.length ? bad.join('; ') : `${info.displayWidth}x${info.displayHeight}, ${round(info.duration, 2)} s${info.audio ? `, audio ${info.audio.codec}/${info.audio.channels}ch` : ''}` };
}

/** SSIM of a region of image a against a region of image b, both brought to (tw, th). */
export async function regionSsim(a, ra, b, rb, tw = 480, th) {
  const ca = crop(a, ra), cb = crop(b, rb);
  const H = th ?? Math.max(16, Math.round((tw * ca.height) / Math.max(1, ca.width) / 2) * 2);
  return ssimImages(resize(ca, tw, H), resize(cb, tw, H));
}

/** Mean saturation (0..255, max-min of RGB) of a box. */
export function saturation(img, [x0, y0, w, h]) {
  let s = 0, n = 0;
  for (let y = y0; y < y0 + h; y += 2) for (let x = x0; x < x0 + w; x += 2) {
    const i = (y * img.width + x) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    s += Math.max(r, g, b) - Math.min(r, g, b); n++;
  }
  return n ? s / n : 0;
}

/** Mean absolute grey difference (0..255) between two same-size images. */
export function mad(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return 255;
  let s = 0;
  for (let i = 0; i < a.data.length; i += 4) s += Math.abs((a.data[i] + a.data[i + 1] + a.data[i + 2]) - (b.data[i] + b.data[i + 1] + b.data[i + 2])) / 3;
  return s / (a.data.length / 4);
}

/** Box-filter resize (area average): better than nearest for downscaling before comparisons. */
export function shrink(img, w, h) {
  const out = new Uint8Array(w * h * 4);
  const fx = img.width / w, fy = img.height / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx)), y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * img.width + xx) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
    const o = (y * w + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

/** Decode mono PCM of a channel (0 = left, 1 = right, undefined = downmix) at `rate`. */
export async function channelPcm(file, ch, { rate = 8000, start, duration } = {}) {
  if (ch === undefined) return pcm(file, { rate, start, duration });
  const { run, FFMPEG } = await import('../../lib/util.mjs');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (start !== undefined) args.push('-ss', String(start));
  args.push('-i', file);
  if (duration !== undefined) args.push('-t', String(duration));
  args.push('-vn', '-af', `pan=mono|c0=c${ch}`, '-ar', String(rate), '-f', 'f32le', '-');
  const r = await run(FFMPEG, args, { timeoutMs: 300_000 });
  if (r.code !== 0) return new Float32Array(0);
  const copy = new Uint8Array(r.stdout.length - (r.stdout.length % 4)); copy.set(r.stdout.subarray(0, copy.length));
  return new Float32Array(copy.buffer);
}

/** Best lag (samples, b relative to a: a[i + lag] ~ b[i]) and normalised correlation over [-maxLag, maxLag], using a window of a/b. */
export function bestLag(a, b, maxLag, { from = 0, len } = {}) {
  const n = Math.min(len ?? Infinity, b.length - from, a.length - from) - maxLag;
  let best = { lag: 0, corr: -2 };
  if (n <= 0) return best;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let num = 0, na = 0, nb = 0;
    for (let i = from + maxLag; i < from + n; i++) {
      const x = a[i + lag], y = b[i];
      num += x * y; na += x * x; nb += y * y;
    }
    const c = na > 0 && nb > 0 ? num / Math.sqrt(na * nb) : 0;
    if (c > best.corr) best = { lag, corr: c };
  }
  return best;
}

/** Over [s0, s1) samples of `out` with lag applied to `ref`: correlation and least-squares gain alpha (out ~ alpha * ref). */
export function corrGain(out, ref, lag, s0, s1) {
  let num = 0, no = 0, nr = 0;
  for (let i = Math.max(0, s0, -lag); i < Math.min(s1, out.length - Math.max(0, lag), ref.length); i++) {
    const o = out[i + lag], r = ref[i];
    if (o === undefined) continue;
    num += o * r; no += o * o; nr += r * r;
  }
  return { corr: no > 0 && nr > 0 ? num / Math.sqrt(no * nr) : 0, alpha: nr > 0 ? num / nr : 0, outRms: no, refRms: nr };
}

/** RMS envelope (dB) of samples in windows of `win` samples. */
export function envelope(s, win) {
  const out = [];
  for (let o = 0; o + win <= s.length; o += win) {
    let e = 0;
    for (let i = o; i < o + win; i++) e += s[i] * s[i];
    out.push(e / win);
  }
  return out;
}

/** Pearson correlation of two arrays (same length; truncates to the shorter). */
export function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; va += x * x; vb += y * y; }
  return va > 0 && vb > 0 ? num / Math.sqrt(va * vb) : 0;
}

/**
 * The named project file must exist, validate (raw format rules), reference every input, have the main comp size,
 * and satisfy pred. Returns {ok, detail, p}.
 */
export function namedProject(dir, file, { inputs = [], size, pred } = {}) {
  if (!existsSync(join(dir, file))) return { ok: false, detail: `${file} missing` };
  const r = findProjectUsing(dir, { inputs, size, pred, files: [file] });
  return r.p ? { ok: true, p: r.p, detail: `${file} valid, uses ${inputs.join(', ')}` } : { ok: false, detail: r.why };
}

/** Clips of a raw project whose asset src ends with name. */
export function clipsUsing(p, name, file = '') {
  const srcs = new Map((p.assets ?? []).map((a) => [a.id, String(a.src ?? '')]));
  return (p.clips ?? []).filter((c) => c.asset !== undefined && (srcs.get(c.asset) ?? '').split('/').pop() === name);
}

export { readProject, validateRaw, assetPaths, frameAt };

/** Fixture files recorded by setup are unchanged (an agent must not overwrite its inputs). Returns {ok, detail}. */
export async function inputsUnchanged(dir, names) {
  const { readSetup, sha256, isFile } = await import('../../lib/util.mjs');
  const s = readSetup(dir);
  const bad = names.filter((n) => !isFile(join(dir, n)) || sha256(join(dir, n)) !== s.hashes?.[n]);
  return { ok: !bad.length, detail: bad.length ? `changed or missing: ${bad.join(', ')}` : 'inputs unchanged' };
}

/** Max Pearson correlation of RMS envelopes (50 ms windows) of two files over lags of +-maxLagWin windows. */
export async function envelopeMatch(fileA, fileB, { ch, maxLagWin = 6, start, duration } = {}) {
  const [a, b] = await Promise.all([channelPcm(fileA, ch, { start, duration }), channelPcm(fileB, undefined, { start, duration })]);
  const ea = envelope(a, 400).map((v) => Math.sqrt(v)), eb = envelope(b, 400).map((v) => Math.sqrt(v));
  let best = -1;
  for (let l = -maxLagWin; l <= maxLagWin; l++) {
    const x = l >= 0 ? ea.slice(l) : ea, y = l >= 0 ? eb : eb.slice(-l);
    best = Math.max(best, pearson(x, y));
  }
  return best;
}

/** Onset times (s) of tone bursts at `freq` Hz: narrow band-pass, 5 ms RMS envelope, rising edges above `rel` x max. */
export async function toneOnsets(file, freq, { rel = 0.4, minGap = 0.3 } = {}) {
  const { run, FFMPEG } = await import('../../lib/util.mjs');
  const r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-vn', '-af', `bandpass=f=${freq}:width_type=h:w=150,bandpass=f=${freq}:width_type=h:w=150`, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { timeoutMs: 300_000 });
  if (r.code !== 0 || r.stdout.length < 4) return [];
  const copy = new Uint8Array(r.stdout.length - (r.stdout.length % 4)); copy.set(r.stdout.subarray(0, copy.length));
  const env = envelope(new Float32Array(copy.buffer), 80).map(Math.sqrt);
  const max = Math.max(...env);
  if (!(max > 1e-4)) return [];
  const res = [];
  let last = -1e9;
  for (let i = 1; i < env.length; i++) if (env[i] >= rel * max && env[i - 1] < rel * max && (i * 0.005) - last > minGap) { res.push(i * 0.005); last = i * 0.005; }
  return res;
}

/** Times (s) of flash groups: runs of frames whose mean luma exceeds `thresh`. */
export async function flashTimes(file, { thresh = 0.85 } = {}) {
  const { allFrames, lumaStats, probe } = await import('../../lib/index.mjs');
  const info = await probe(file);
  const fps = info?.fps || 30;
  const fr = await allFrames(file, { width: 64, height: 36 });
  const res = [];
  let prev = false;
  fr.forEach((f, i) => { const on = lumaStats(f).mean > thresh; if (on && !prev) res.push(i / fps); prev = on; });
  return res;
}
