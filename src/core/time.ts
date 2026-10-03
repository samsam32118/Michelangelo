/**
 * Time: integer frames at a comp's rate inside; seconds and timecode accepted at the edges.
 * Rates are rationals (num/den). No floating-point seconds are stored anywhere.
 */
import { fail } from './errors.js';

export interface Rate { num: number; den: number }

export type TimeInput = number | string;

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/** Parse a rate: 30, 29.97, "30000/1001", "24". */
export function parseRate(v: number | string): Rate {
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v > 0) return { num: v, den: 1 };
    const known: Record<string, Rate> = { '23.976': { num: 24000, den: 1001 }, '29.97': { num: 30000, den: 1001 }, '59.94': { num: 60000, den: 1001 } };
    const k = known[v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')] ?? known[String(v)];
    if (k) return k;
    fail('E_RATE', `fps ${v} is not a supported rate.`, 'use an integer (24, 25, 30, 50, 60) or a rational string like "30000/1001".');
  }
  const m = /^\s*(\d+)\s*(?:\/\s*(\d+))?\s*$/.exec(v);
  if (!m) return parseRate(Number(v));
  const num = Number(m[1]), den = m[2] ? Number(m[2]) : 1;
  if (!(num > 0 && den > 0)) fail('E_RATE', `fps "${v}" is not a valid rate.`, 'use an integer or "num/den" with positive parts.');
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

export function rateToNumber(r: Rate): number { return r.num / r.den; }
export function rateToString(r: Rate): string { return r.den === 1 ? String(r.num) : `${r.num}/${r.den}`; }

export interface ParsedTime { frames: number; rounded: boolean; exact: string }

/**
 * Parse an edge time into frames at `rate`.
 * Forms: 75 (frames), "75f", "2.5s", "1:02.5" (m:ss.s), "1:02:03.5" (h:mm:ss.s), "00:01:02:15" (SMPTE, frames after the last colon).
 */
export function parseTimeDetailed(v: TimeInput, rate: Rate, what = 'time'): ParsedTime {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail('E_TIME', `${what} ${v} is not a number.`, 'give frames as an integer or seconds as "2.5s".');
    if (!Number.isInteger(v)) fail('E_TIME', `${what} ${v} is not a whole number of frames.`, `bare numbers are frames; write seconds as "${v}s".`);
    return { frames: v, rounded: false, exact: String(v) };
  }
  const s = v.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(-?\d+)f?$/.exec(s))) return { frames: Number(m[1]), rounded: false, exact: s };
  if ((m = /^(-?\d+(?:\.\d+)?)s$/.exec(s))) return secondsToFrames(m[1]!, rate, s);
  if ((m = /^(\d+):(\d{1,2}):(\d{1,2}):(\d{1,3})$/.exec(s))) {
    // SMPTE timecode (non-drop): hh:mm:ss:ff at the nominal integer rate
    const nominal = Math.round(rate.num / rate.den);
    const [h, mi, se, ff] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
    if (ff >= nominal) fail('E_TIME', `${what} "${s}": frame ${ff} is not below the rate ${nominal}.`, `frames in timecode go from 0 to ${nominal - 1}.`);
    return { frames: ((h * 60 + mi) * 60 + se) * nominal + ff, rounded: false, exact: s };
  }
  if ((m = /^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s))) {
    const h = m[1] ? Number(m[1]) : 0;
    const secStr = m[3]!;
    const [ip, fp = ''] = secStr.split('.');
    const total = `${(h * 60 + Number(m[2])) * 60 + Number(ip)}${fp ? '.' + fp : ''}`;
    return secondsToFrames(total, rate, s);
  }
  return fail('E_TIME', `${what} "${s}" is not a time.`, 'use frames (75), seconds ("2.5s"), "m:ss.s" ("1:02.5") or timecode ("00:01:02:15").');
}

/** Exact decimal seconds → frames using integer arithmetic. */
function secondsToFrames(dec: string, rate: Rate, original: string): ParsedTime {
  const neg = dec.startsWith('-');
  const d = neg ? dec.slice(1) : dec;
  const [ip, fp = ''] = d.split('.');
  const scale = 10n ** BigInt(fp.length);
  const units = BigInt(ip! + fp); // seconds × scale
  // frames = seconds × num / den = units × num / (scale × den)
  const numer = units * BigInt(rate.num);
  const denom = scale * BigInt(rate.den);
  let q = numer / denom;
  const r = numer % denom;
  const rounded = r !== 0n;
  if (r * 2n >= denom) q += 1n;
  const frames = Number(q) * (neg ? -1 : 1);
  return { frames, rounded, exact: original };
}

export function parseTime(v: TimeInput, rate: Rate, what?: string): number {
  return parseTimeDetailed(v, rate, what).frames;
}

/** Frames → seconds as a number (for display and for ffmpeg arguments only). */
export function framesToSeconds(frames: number, rate: Rate): number {
  return (frames * rate.den) / rate.num;
}

/** Exact seconds string for ffmpeg (up to 6 decimals). */
export function framesToSecondsString(frames: number, rate: Rate): string {
  const s = framesToSeconds(frames, rate);
  return Number(s.toFixed(6)).toString();
}

/** Display: "2.50s". */
export function formatSeconds(frames: number, rate: Rate, digits = 2): string {
  return framesToSeconds(frames, rate).toFixed(digits);
}

/** Audio sample index of a frame boundary at `sampleRate` (exact, floor). */
export function frameToSample(frames: number, rate: Rate, sampleRate = 48000): number {
  return Math.floor((frames * sampleRate * rate.den) / rate.num);
}

/** Seconds (float, e.g. from analysis) → nearest frame. Only for values that come from measurements. */
export function secondsToNearestFrame(seconds: number, rate: Rate): number {
  return Math.round((seconds * rate.num) / rate.den);
}

/** A speed factor as a rational: 2, 0.5, "3/2", "1.25". Denominators are kept ≤ 1000. */
export function parseSpeed(v: number | string): Rate {
  if (typeof v === 'number') {
    if (!(v >= 0) || !Number.isFinite(v)) fail('E_SPEED', `speed ${v} is not valid.`, 'use a factor ≥ 0, e.g. 2 (twice as fast), 0.5, "3/2"; 0 freezes.');
    const den = 1000;
    const num = Math.round(v * den);
    const g = gcd(num, den);
    return { num: num / g, den: den / g };
  }
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(v);
  if (m) {
    const num = Number(m[1]), den = Number(m[2]);
    if (den === 0) fail('E_SPEED', `speed "${v}" divides by zero.`, 'use a positive denominator.');
    const g = gcd(num, den);
    return { num: num / g, den: den / g };
  }
  const n = Number(v);
  if (Number.isNaN(n)) fail('E_SPEED', `speed "${v}" is not a number.`, 'use a factor like 2, 0.5 or "3/2".');
  return parseSpeed(n);
}
