/**
 * Captions, pure: SRT / WebVTT parsing and writing, script chunking, word-timing estimates.
 * Times here are seconds (floats from the file); commands convert them to frames.
 */
import { fail } from './errors.js';

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
  /** absolute start time (s) of each word of `text`, when the file has them */
  words?: number[];
  speaker?: string;
}

export interface ParsedCaptions {
  format: 'srt' | 'vtt';
  cues: CaptionCue[];
  /** true when at least one cue had inline word timestamps */
  wordTimes: boolean;
  /** skipped or repaired blocks */
  warnings: string[];
}

const TIMING_RE = /^\s*((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})(?:\s+.*)?$/;
const INLINE_TS_RE = /<((?:\d+:)?\d{1,2}:\d{2}\.\d{1,3})>/g;

/** "01:02:03,500", "02:03.5", "1:02:03.500" → seconds */
export function parseTimestamp(s: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) fail('E_CAPTIONS', `"${s}" is not a caption timestamp.`, 'use hh:mm:ss,mmm (SRT) or hh:mm:ss.mmm / mm:ss.mmm (VTT).');
  const ms = Number(m[4]!.padEnd(3, '0'));
  return (Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) + ms / 1000;
}

export function formatTimestamp(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp|lrm|rlm|#\d+);/g, (_, e: string) =>
    e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : e === 'nbsp' ? ' ' : e === 'lrm' || e === 'rlm' ? '' : String.fromCodePoint(Number(e.slice(1))));
}

/** Strip markup, keep words; inline timestamps give word start times. */
function parsePayload(lines: string[], start: number): { text: string; words?: number[]; speaker?: string } {
  const raw = lines.join('\n');
  const speaker = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(raw)?.[1]?.trim();
  const segments: { t: number; s: string }[] = [];
  let last = 0, t = start, timed = false;
  for (const m of raw.matchAll(INLINE_TS_RE)) {
    segments.push({ t, s: raw.slice(last, m.index) });
    t = parseTimestamp(m[1]!);
    last = m.index! + m[0].length;
    timed = true;
  }
  segments.push({ t, s: raw.slice(last) });
  const words: { w: string; t: number }[] = [];
  let joinNext = false;
  for (const seg of segments) {
    const s = decodeEntities(seg.s.replace(/<[^>]*>/g, '')).replace(/\{\\[^}]*\}/g, '');
    if (!s) continue;
    const toks = s.split(/\s+/).filter(Boolean);
    toks.forEach((w, i) => {
      if (i === 0 && joinNext && !/^\s/.test(s) && words.length) words[words.length - 1]!.w += w;
      else words.push({ w, t: seg.t });
    });
    joinNext = !/\s$/.test(s);
  }
  const out: { text: string; words?: number[]; speaker?: string } = { text: words.map((w) => w.w).join(' ') };
  if (timed) out.words = words.map((w) => w.t);
  if (speaker) out.speaker = speaker;
  return out;
}

function normalise(text: string): string[] {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
}

function blocks(lines: string[]): { line: number; lines: string[] }[] {
  const out: { line: number; lines: string[] }[] = [];
  let cur: { line: number; lines: string[] } | null = null;
  lines.forEach((l, i) => {
    if (!l.trim()) { cur = null; return; }
    if (!cur) { cur = { line: i + 1, lines: [] }; out.push(cur); }
    cur.lines.push(l);
  });
  return out;
}

function cueFromBlock(b: { line: number; lines: string[] }, warnings: string[]): CaptionCue | null {
  const ti = b.lines.findIndex((l) => l.includes('-->'));
  if (ti < 0 || ti > 1) { warnings.push(`line ${b.line}: skipped a block with no "start --> end" timing line.`); return null; }
  const m = TIMING_RE.exec(b.lines[ti]!);
  if (!m) { warnings.push(`line ${b.line + ti}: skipped a cue with an unreadable timing line "${b.lines[ti]!.trim()}".`); return null; }
  const start = parseTimestamp(m[1]!), end = parseTimestamp(m[2]!);
  const p = parsePayload(b.lines.slice(ti + 1), start);
  if (!p.text) return null;
  if (end <= start) { warnings.push(`line ${b.line + ti}: cue ends before it starts; skipped.`); return null; }
  const cue: CaptionCue = { start, end, text: p.text };
  if (p.words) cue.words = p.words.map((w) => Math.min(Math.max(w, start), end));
  if (p.speaker) cue.speaker = p.speaker;
  return cue;
}

export function parseSrt(text: string): ParsedCaptions {
  const warnings: string[] = [];
  const cues = blocks(normalise(text)).map((b) => cueFromBlock(b, warnings)).filter((c): c is CaptionCue => !!c);
  return finish('srt', cues, warnings);
}

export function parseVtt(text: string): ParsedCaptions {
  const lines = normalise(text);
  if (!/^WEBVTT(\s|$)/.test(lines[0] ?? '')) fail('E_CAPTIONS', 'a WebVTT file must start with "WEBVTT".', 'add "WEBVTT" as the first line, or use an .srt file.');
  const warnings: string[] = [];
  const cues: CaptionCue[] = [];
  for (const b of blocks(lines).slice(1)) {
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(b.lines[0]!)) continue;
    const c = cueFromBlock(b, warnings);
    if (c) cues.push(c);
  }
  return finish('vtt', cues, warnings);
}

function finish(format: 'srt' | 'vtt', cues: CaptionCue[], warnings: string[]): ParsedCaptions {
  cues.sort((a, b) => a.start - b.start);
  return { format, cues, wordTimes: cues.some((c) => c.words), warnings };
}

/** Parse by file name (".vtt") or content (a "WEBVTT" header). */
export function parseCaptions(text: string, file = ''): ParsedCaptions {
  const vtt = /\.vtt$/i.test(file) || /^﻿?WEBVTT/.test(text);
  if (!vtt && !/-->/.test(text)) fail('E_CAPTIONS', `${file || 'the text'} has no caption cues ("start --> end" lines).`, 'give an .srt or .vtt file; for a plain script use captions.from-text.');
  return vtt ? parseVtt(text) : parseSrt(text);
}

export function toSrt(cues: CaptionCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${formatTimestamp(c.start, ',')} --> ${formatTimestamp(c.end, ',')}\n${c.text}\n`).join('\n');
}

export function toVtt(cues: CaptionCue[]): string {
  const body = cues.map((c) => {
    const words = c.text.split(/\s+/).filter(Boolean);
    let text = c.text;
    if (c.words && c.words.length === words.length) text = words.map((w, i) => (i === 0 ? w : `<${formatTimestamp(c.words![i]!, '.')}>${w}`)).join(' ');
    if (c.speaker) text = `<v ${c.speaker}>${text}`;
    return `${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}\n${text}\n`;
  });
  return ['WEBVTT\n', ...body].join('\n');
}

export function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Word start offsets within a cue of length `duration` when the file has none: proportional to word
 * length (+1 for the gap), so long words get more time. Units follow `duration` (seconds or frames);
 * with `integer` the offsets are floored to whole units and kept strictly increasing where possible.
 */
export function estimateWordTimes(text: string | string[], duration: number, integer = false): number[] {
  const words = Array.isArray(text) ? text : wordsOf(text);
  const weights = words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length + 1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const out = weights.map((w) => { const t = (acc / total) * duration; acc += w; return t; });
  if (!integer) return out;
  const r = out.map(Math.floor);
  for (let i = 1; i < r.length; i++) if (r[i]! <= r[i - 1]! && r[i - 1]! + 1 < duration) r[i] = r[i - 1]! + 1;
  return r;
}

/**
 * Split a script into caption chunks: by line and sentence, then into balanced pieces of at most
 * `maxWords` words.
 */
export function splitScript(text: string, maxWords = 6): string[] {
  const max = Math.max(1, Math.floor(maxWords));
  const sentences = text.replace(/\r\n?/g, '\n').split('\n')
    .flatMap((l) => l.split(/(?<=[.!?…])\s+(?=\S)/))
    .map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    const w = wordsOf(s);
    const parts = Math.ceil(w.length / max);
    const size = Math.ceil(w.length / parts);
    for (let i = 0; i < w.length; i += size) out.push(w.slice(i, i + size).join(' '));
  }
  return out;
}
