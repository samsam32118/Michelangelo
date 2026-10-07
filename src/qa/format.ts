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
  if (!(s.integrated > -60)) return 'sound: silent (no audible audio in the mix)';
  const parts = [`sound ${fin(s.integrated)} LUFS, peak ${fin(s.truePeak)} dBTP, LRA ${fin(s.lra)}`];
  if (s.silences.length) {
    const sil = s.silences.slice(0, 6).map((x) => `${x.start.toFixed(2)}–${x.end.toFixed(2)}`).join(', ');
    parts.push(`silences ${sil}${s.silences.length > 6 ? ` +${s.silences.length - 6}` : ''}`);
  } else parts.push('no silences');
  if (s.bpm) parts.push(`~${Math.round(s.bpm)} BPM (${s.beats} onsets)`);
  return parts.join(' · ');
}

const SCENE_LINES = 14;
const MARK = { idea: 'idea', issue: '⚠', changed: '●' } as Record<string, string>;
const trunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** One line per scene: `  3 "Work in 25-minute blocks" 5.8–9.1s ⚠ ● · hook higher (y 691→500)`. */
function storyLines(sb: NonNullable<LookReport['storyboard']>, fps: number, o: FormatOptions): string[] {
  const t = (f: number) => (f / fps).toFixed(1);
  const lines = sb.scenes.slice(0, sb.scenes.length > SCENE_LINES ? SCENE_LINES - 1 : SCENE_LINES).map((s) => {
    const m = s.marks.map((x) => MARK[x] ?? x).join(' ');
    const why = s.changes[0] ?? s.issue ?? (s.issues ? `${s.issues} issue${s.issues > 1 ? 's' : ''}` : '');
    return `  ${s.n} ${s.note ? 'note ' : ''}"${trunc(s.label, 40)}" ${t(s.at)}–${t(s.at + s.len)}s${m ? ' ' + m : ''}${why ? ` · ${trunc(why, 48)}` : ''}`;
  });
  if (sb.scenes.length > lines.length) lines.push(`  … ${sb.scenes.length - lines.length} more: mgl show ${o.file} --scenes`);
  if (sb.notes.length) lines.push(`changed outside scenes: ${trunc(sb.notes.slice(0, 3).join('; '), 100)}`);
  return lines;
}

export function formatLook(r: LookReport, o: FormatOptions): string[] {
  const max = o.max ?? 40;
  const sb = r.storyboard;
  if (sb?.detail) {
    // --scene: the level-2 image and text
    const head = `wrote ${rel(r.sheet, o)} (scene ${sb.scene} of ${sb.scenes.length}: 3 moments + each layer alone, ${r.size[0]}x${r.size[1]}) in ${r.seconds.toFixed(1)} s`;
    const tail = r.notes.slice(0, 2).map((n) => `note: ${n}`);
    const body = sb.detail.slice(0, max - 1 - tail.length);
    return [head, ...body, ...tail];
  }
  if (sb) {
    const qaSpan = r.frames.length ? `${(r.frames[0]! / r.fps).toFixed(2)}–${(r.frames.at(-1)! / r.fps).toFixed(2)}` : '-';
    const head = [
      `wrote ${rel(r.sheet, o)} (storyboard: ${sb.scenes.length} scene${sb.scenes.length === 1 ? '' : 's'}, ${r.size[0]}x${r.size[1]}; QA on ${r.frames.length} frames ${qaSpan}) in ${r.seconds.toFixed(1)} s`,
      ...(sb.page ? [`page: ${rel(sb.page, o)}${sb.since && (sb.notes.length || sb.scenes.some((s) => s.marks.includes('changed'))) ? ` (● = changed since the storyboard of ${sb.since.slice(0, 16).replace('T', ' ')})` : ''}`] : []),
    ];
    const tail = [...(r.sound ? [formatSound(r.sound)] : []), ...r.notes.slice(0, 2).map((n) => `note: ${n}`)];
    const scenes = storyLines(sb, r.fps, o).slice(0, Math.max(1, max - head.length - tail.length - 3));
    const crops = new Map(r.crops.map((c) => [c.finding, c.path]));
    return [...head, ...scenes, issues(r.findings.length), ...findingLines(r.findings, Math.max(1, max - head.length - scenes.length - 1 - tail.length), o, crops, `; all of them: mgl look ${o.file} --json`), ...tail].slice(0, max);
  }
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
