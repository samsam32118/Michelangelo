// Audio measurements: EBU R128 loudness, silences, band energy (Goertzel on decoded PCM), RMS per window.
import { FFMPEG, run, ffmpegLog } from './util.mjs';

/** Integrated loudness (LUFS), loudness range (LU) and true peak (dBTP). Undefined values when there is no audio. */
export async function loudness(file) {
  try {
    const log = await ffmpegLog(['-i', file, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { timeoutMs: 300_000 });
    const sum = log.slice(log.lastIndexOf('Summary:'));
    const num = (re) => { const m = re.exec(sum); return m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : undefined; };
    return { integrated: num(/I:\s+(-?[\d.]+|-inf) LUFS/), range: num(/LRA:\s+(-?[\d.]+) LU/), truePeak: num(/Peak:\s+(-?[\d.]+|-inf) dBFS/) };
  } catch { return { integrated: undefined, range: undefined, truePeak: undefined }; }
}

/** Silent ranges [{start, end, duration}] (seconds) below `db` lasting ≥ `minDuration`. */
export async function silences(file, { db = -40, minDuration = 0.6 } = {}) {
  let log;
  try { log = await ffmpegLog(['-i', file, '-vn', '-af', `silencedetect=noise=${db}dB:d=${minDuration}`, '-f', 'null', '-']); } catch { return []; }
  const res = [];
  let start;
  for (const line of log.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/.exec(line);
    if (e && start !== undefined) { res.push({ start, end: Number(e[1]), duration: Number(e[2]) }); start = undefined; }
  }
  if (start !== undefined) {
    const d = /time=(\d+):(\d+):([\d.]+)/g;
    let last, m;
    while ((m = d.exec(log))) last = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (last !== undefined) res.push({ start, end: last, duration: last - start });
  }
  return res;
}

/** Decode mono float PCM at `rate` Hz for [start, start + duration) seconds (whole file by default). */
export async function pcm(file, { rate = 48000, start, duration } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (start !== undefined) args.push('-ss', String(start));
  args.push('-i', file);
  if (duration !== undefined) args.push('-t', String(duration));
  args.push('-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-');
  const r = await run(FFMPEG, args, { timeoutMs: 300_000 });
  if (r.code !== 0) return new Float32Array(0);
  const buf = r.stdout;
  const copy = new Uint8Array(buf.length - (buf.length % 4));
  copy.set(buf.subarray(0, copy.length));
  return new Float32Array(copy.buffer);
}

/** Goertzel power of frequency f in samples (amplitude-normalised: a full-scale sine ≈ 0 dB). Returns dB. */
export function goertzelDb(samples, f, rate = 48000) {
  const n = samples.length;
  if (!n) return -Infinity;
  const w = (2 * Math.PI * f) / rate, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = samples[i] * hann + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - c * s1 * s2;
  const amp = (2 * Math.sqrt(Math.max(0, power))) / (n * 0.5);
  return amp > 0 ? 20 * Math.log10(amp) : -Infinity;
}

/** Energy (dB, power sum) at frequencies over a time window of a file. */
export async function bandEnergy(file, freqs, { start = 0, duration, rate = 48000 } = {}) {
  const s = await pcm(file, { rate, start, duration });
  const p = freqs.reduce((acc, f) => acc + 10 ** (goertzelDb(s, f, rate) / 10), 0);
  return p > 0 ? 10 * Math.log10(p) : -Infinity;
}

/** Same as bandEnergy, but per frequency: {f: dB}. */
export async function toneLevels(file, freqs, { start = 0, duration, rate = 48000 } = {}) {
  const s = await pcm(file, { rate, start, duration });
  return Object.fromEntries(freqs.map((f) => [f, goertzelDb(s, f, rate)]));
}

/** Energy (dB RMS) after a band-pass between lo and hi Hz (ffmpeg highpass+lowpass) for a window. */
export async function bandpassRmsDb(file, lo, hi, { start = 0, duration } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(start), '-i', file];
  if (duration !== undefined) args.push('-t', String(duration));
  args.push('-vn', '-af', `highpass=f=${lo}:poles=2,highpass=f=${lo}:poles=2,lowpass=f=${hi}:poles=2,lowpass=f=${hi}:poles=2`, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-');
  const r = await run(FFMPEG, args);
  if (r.code !== 0 || r.stdout.length < 4) return -Infinity;
  const copy = new Uint8Array(r.stdout.length - (r.stdout.length % 4)); copy.set(r.stdout.subarray(0, copy.length));
  return rmsDb(new Float32Array(copy.buffer));
}

export function rmsDb(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return samples.length && s > 0 ? 10 * Math.log10(s / samples.length) : -Infinity;
}

/** RMS (dBFS) per window of `win` seconds over the whole file (or a window). */
export async function rmsWindows(file, { win = 0.05, rate = 16000, start, duration } = {}) {
  const s = await pcm(file, { rate, start, duration });
  const n = Math.max(1, Math.round(win * rate)), out = [];
  for (let o = 0; o + n <= s.length; o += n) out.push(rmsDb(s.subarray(o, o + n)));
  return out;
}

/** Normalised cross-correlation of b inside a (linear envelopes), searching offsets [from, to]; returns {offset, corr}. */
export function bestMatch(a, b, from = 0, to = a.length - b.length) {
  let best = { offset: -1, corr: -1 };
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  const db = b.map((v) => v - mb), nb = Math.sqrt(db.reduce((x, y) => x + y * y, 0));
  for (let o = Math.max(0, from); o <= Math.min(to, a.length - b.length); o++) {
    let ma = 0;
    for (let i = 0; i < b.length; i++) ma += a[o + i];
    ma /= b.length;
    let num = 0, na = 0;
    for (let i = 0; i < b.length; i++) { const d = a[o + i] - ma; num += d * db[i]; na += d * d; }
    const c = na > 0 && nb > 0 ? num / Math.sqrt(na) / nb : 0;
    if (c > best.corr) best = { offset: o, corr: c };
  }
  return best;
}

/** For references: the second-pass loudnorm filter (measured on `file`, linear) reaching I LUFS with true peak TP. */
export async function loudnormFilter(file, { I = -14, TP = -1.5, LRA = 20 } = {}) {
  const log = await ffmpegLog(['-i', file, '-vn', '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`, '-f', 'null', '-']);
  const m = JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1));
  return `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
}
