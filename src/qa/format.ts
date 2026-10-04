/** Text output of `look` and `check`: at most 40 lines, findings numbered, each with its crop, line and fix. */
import { relative } from 'node:path';
import type { Finding } from '../plugin/api.js';
import type { LookReport, SoundSummary } from './look.js';

export interface FormatOptions {
  /** the project file as the user typed it: replaces <file> in fixes */
  file: string;
  /** 1-based line of a clip in the project file */
  lineOf?: (clipId: string) => number | undefined;
  /** line budget (default 40) */
  max?: number;
  /** paths are shown relative to this directory (default: cwd) */
  cwd?: string;
}

const SEV = { error: 'error', warning: 'warn', info: 'info' } as const;
const rel = (p: string, o: FormatOptions) => { const r = relative(o.cwd ?? process.cwd(), p); return r.startsWith('..') && r.split('/').length > 4 ? p : r || p; };

export function findingLine(f: Finding, n: number, o: FormatOptions, crop?: string): string {
  const parts = [`  ${n} ${SEV[f.severity]} ${f.message}`];
  if (crop) parts.push(rel(crop, o));
  const line = f.clip ? o.lineOf?.(f.clip) : undefined;
  if (line) parts.push(`line ${line}`);
  if (f.fix) parts.push(`fix: ${f.fix.replaceAll('<file>', o.file)}`);
  return parts.join('   ');
}

/** Numbered findings within `budget` lines; the rest summarised in one line. */
function findingLines(fs: Finding[], budget: number, o: FormatOptions, crops = new Map<number, string>(), more = ''): string[] {
  if (fs.length <= budget) return fs.map((f, i) => findingLine(f, i + 1, o, crops.get(i)));
  const shown = Math.max(0, budget - 1), rest = fs.slice(shown);
  const counts = (['error', 'warning', 'info'] as const).map((s) => [s, rest.filter((f) => f.severity === s).length] as const).filter(([, c]) => c).map(([s, c]) => `${c} ${s}`);
  return [...fs.slice(0, shown).map((f, i) => findingLine(f, i + 1, o, crops.get(i))), `  … ${rest.length} more (${counts.join(', ')})${more}`];
}

const issues = (n: number) => (n ? `QA ${n} issue${n > 1 ? 's' : ''}` : 'QA no issues');

export function formatSound(s: SoundSummary): string {
  const fin = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-inf');
  const parts = [`sound ${fin(s.integrated)} LUFS, peak ${fin(s.truePeak)} dBTP, LRA ${fin(s.lra)}`];
  if (s.silences.length) {
    const sil = s.silences.slice(0, 6).map((x) => `${x.start.toFixed(2)}–${x.end.toFixed(2)}`).join(', ');
    parts.push(`silences ${sil}${s.silences.length > 6 ? ` +${s.silences.length - 6}` : ''}`);
  } else parts.push('no silences');
  if (s.bpm) parts.push(`~${Math.round(s.bpm)} BPM (${s.beats} onsets)`);
  return parts.join(' · ');
}

export function formatLook(r: LookReport, o: FormatOptions): string[] {
  const max = o.max ?? 40;
  const span = r.frames.length ? `${(r.frames[0]! / r.fps).toFixed(2)}–${(r.frames.at(-1)! / r.fps).toFixed(2)}` : '-';
  const head = [`wrote ${rel(r.sheet, o)} (${r.frames.length} frames ${span}, ${r.size[0]}x${r.size[1]}) in ${r.seconds.toFixed(1)} s`, issues(r.findings.length)];
  const tail = [...(r.sound ? [formatSound(r.sound)] : []), ...r.notes.slice(0, 2).map((n) => `note: ${n}`)];
  const crops = new Map(r.crops.map((c) => [c.finding, c.path]));
  return [...head, ...findingLines(r.findings, max - head.length - tail.length, o, crops, `; all of them: mgl look ${o.file} --json`), ...tail];
}

export function formatFindings(fs: Finding[], o: FormatOptions): string[] {
  const max = o.max ?? 40;
  return [issues(fs.length), ...findingLines(fs, max - 1, o, undefined, `; all of them: mgl check ${o.file} --json`)];
}
