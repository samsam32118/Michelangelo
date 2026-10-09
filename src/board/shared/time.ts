/**
 * Times at the edge (DESIGN §3), implemented here because shared/ may not import core: 75 (frames), "75f", "2.5s",
 * "1:02.5" (m:ss.s), "1:02:03.5" (h:mm:ss.s), "00:01:02:15" (SMPTE, frames after the last colon). Seconds round to
 * the nearest frame. fps may be fractional (29.97...).
 */
import type { TimeLike } from './types.js';

export class TimeError extends Error {
  readonly code = 'E_TIME';
  constructor(message: string, readonly fix: string) { super(message); }
}

const FIX = 'use frames (75), seconds ("2.5s"), "m:ss.s" ("1:02.5") or timecode ("00:01:02:15").';

/** frames at `fps`; throws TimeError (code E_TIME, fix) when it is not a time */
export function parseTimeLike(t: TimeLike, fps: number): number {
  const rate = fps > 0 ? fps : 30;
  if (typeof t === 'number') {
    if (!Number.isFinite(t)) throw new TimeError(`time ${t} is not a number.`, 'give frames as an integer or seconds as "2.5s".');
    if (!Number.isInteger(t)) throw new TimeError(`time ${t} is not a whole number of frames.`, `bare numbers are frames; write seconds as "${t}s".`);
    return t;
  }
  const s = String(t).trim();
  let m: RegExpExecArray | null;
  const secs = (v: number) => Math.round(v * rate + 1e-9);
  if ((m = /^(-?\d+)f?$/.exec(s))) return Number(m[1]);
  if ((m = /^(-?\d+(?:\.\d+)?)s$/.exec(s))) return secs(Number(m[1]));
  if ((m = /^(\d+):(\d{1,2}):(\d{1,2}):(\d{1,3})$/.exec(s))) {
    const nominal = Math.round(rate);
    const [h, mi, se, ff] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
    if (ff >= nominal) throw new TimeError(`time "${s}": frame ${ff} is not below the rate ${nominal}.`, `frames in timecode go from 0 to ${nominal - 1}.`);
    return ((h * 60 + mi) * 60 + se) * nominal + ff;
  }
  if ((m = /^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s))) return secs((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3]));
  throw new TimeError(`time "${s}" is not a time.`, FIX);
}

/** parseTimeLike, or undefined */
export function tryTime(t: TimeLike | undefined, fps: number): number | undefined {
  if (t === undefined) return undefined;
  try { return parseTimeLike(t, fps); } catch { return undefined; }
}

/** m:ss.ss (the board's timecode, same as the server's still captions) */
export function formatTime(frames: number, fps: number): string {
  const s = Math.max(0, frames) / (fps > 0 ? fps : 30);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** frames → "2.5s" (what ops take) */
export const formatSeconds = (frames: number, fps: number): string => `${Number((frames / (fps > 0 ? fps : 30)).toFixed(3))}s`;

/** milliseconds → "180 ms", "2.4 s", "3.1 min" */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}
