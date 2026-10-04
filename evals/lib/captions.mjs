// Caption files (SRT / WebVTT) and caption cues from a raw project, as seconds. Independent of Michelangelo.
import { readFileSync } from 'node:fs';
import { compRate, compOfClip, clipsById, toFrames } from './project.mjs';

const TS = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
export function parseTs(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

/** Parse SRT or VTT text: [{start, end, text, words?: [abs seconds]}]. Inline <hh:mm:ss.mmm> tags give word starts. */
export function parseCaptions(text) {
  const blocks = text.replace(/\r/g, '').replace(/^﻿/, '').split(/\n\s*\n/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const start = parseTs(TS.exec(a)?.[1] ?? ''), end = parseTs(TS.exec(z)?.[1] ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const payload = lines.slice(ti + 1).join(' ');
    const words = [];
    let t = start, timed = false;
    for (const part of payload.split(/(<(?:\d+:)?\d{1,2}:\d{2}\.\d{1,3}>)/)) {
      const m = /^<(.*)>$/.exec(part);
      if (m && Number.isFinite(parseTs(m[1]))) { t = parseTs(m[1]); timed = true; continue; }
      for (const _w of part.replace(/<[^>]*>/g, '').split(/\s+/).filter(Boolean)) { words.push(t); t = t; }
    }
    const clean = payload.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    cues.push({ start, end, text: clean, ...(timed ? { words } : {}) });
  }
  return cues;
}

export const readCaptions = (file) => parseCaptions(readFileSync(file, 'utf8'));

/**
 * Cues of a raw project as absolute seconds in their comp: [{id, clip, start, end, text, words?: [abs s]}].
 * Cue times are local to their captions clip; word offsets are relative to the cue.
 */
export function projectCues(p, { clip } = {}) {
  const clips = clipsById(p);
  const out = [];
  for (const q of p.cues ?? []) {
    if (clip && q.clip !== clip) continue;
    const c = clips.get(q.clip);
    if (!c) continue;
    const comp = compOfClip(p, c);
    const rate = compRate(comp);
    const at = toFrames(c.at, rate), qa = toFrames(q.at, rate), ql = toFrames(q.len, rate);
    const s = (f) => f / rate;
    out.push({ id: q.id, clip: q.clip, start: s(at + qa), end: s(at + qa + ql), text: q.text, ...(Array.isArray(q.words) ? { words: q.words.map((w) => s(at + qa + toFrames(w, rate))) } : {}) });
  }
  return out.sort((a, b) => a.start - b.start);
}

export const normText = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
