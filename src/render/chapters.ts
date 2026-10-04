/**
 * Chapters from markers: a comp's markers that have a note become chapters (YouTube description lines
 * "0:00 Title" or WebVTT chapter cues). Pure: no fs.
 */
import { fail } from '../core/errors.js';
import type { ProjectFile } from '../core/schema/index.js';
import { framesToSeconds, parseRate } from '../core/time.js';

export interface Chapter { start: number; title: string; marker?: string }

/** YouTube's rules: at least 3 chapters, the first at 0:00, each at least 10 s long. */
export const YT_MIN_CHAPTERS = 3;
export const YT_MIN_SECONDS = 10;

/**
 * The chapters of a comp in `range` (frames; times relative to its start): markers with a note, sorted by time.
 * When none starts at 0 an "Intro" chapter is added there (noted). Notes also warn about YouTube's rules.
 */
export function chapterList(project: ProjectFile, compId: string, range?: [number, number]): { chapters: Chapter[]; notes: string[] } {
  const comp = project.comps.find((c) => c.id === compId);
  if (!comp) return fail('E_REF', `comp "${compId}" does not exist.`, `use one of ${project.comps.map((c) => c.id).join(', ')}.`);
  const rate = parseRate(comp.fps);
  const [r0, r1] = range ?? [0, Number.POSITIVE_INFINITY];
  const all = (project.markers ?? []).filter((m) => m.comp === compId && m.at >= r0 && m.at < r1);
  const named = all.filter((m) => m.note && m.note.trim());
  const notes: string[] = [];
  if (!named.length) {
    fail('E_NO_CHAPTERS', `comp "${compId}" has no markers with a note${all.length ? ` (${all.length} marker${all.length > 1 ? 's have' : ' has'} no note)` : ''}, so there are no chapters.`,
      'add one per chapter: mgl edit <file> marker.add at=0 note="Intro" (the note is the chapter title).');
  }
  if (named.length < all.length) notes.push(`${all.length - named.length} marker${all.length - named.length > 1 ? 's' : ''} without a note skipped (a chapter's title is its marker's note)`);
  const chapters: Chapter[] = named
    .map((m) => ({ start: framesToSeconds(m.at - r0, rate), title: m.note!.trim().replace(/\s+/g, ' '), marker: m.id }))
    .sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
  if (chapters[0]!.start >= 0.5) {
    chapters.unshift({ start: 0, title: 'Intro' });
    notes.push('added an "Intro" chapter at 0:00 (the first chapter must start at 0:00); add a marker at 0 with a note to name it');
  } else chapters[0]!.start = 0;
  if (chapters.length < YT_MIN_CHAPTERS) notes.push(`warning: ${chapters.length} chapter${chapters.length > 1 ? 's' : ''}; YouTube needs at least ${YT_MIN_CHAPTERS} to show chapters`);
  const short = chapters.filter((c, i) => i + 1 < chapters.length && chapters[i + 1]!.start - c.start < YT_MIN_SECONDS);
  if (short.length) notes.push(`warning: ${short.map((c) => `"${c.title}" (${ytStamp(c.start)})`).join(', ')} ${short.length > 1 ? 'are' : 'is'} shorter than ${YT_MIN_SECONDS} s; YouTube ignores chapter lists with chapters under ${YT_MIN_SECONDS} s`);
  return { chapters, notes };
}

/** "0:00", "1:05", "1:02:03" (YouTube description timestamps; whole seconds, rounded down). */
export function ytStamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec + 1e-6));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function formatChaptersYouTube(chapters: Chapter[]): string {
  return chapters.map((c) => `${ytStamp(c.start)} ${c.title}`).join('\n') + '\n';
}

const vttStamp = (sec: number) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
};

/** WebVTT chapters (kind="chapters" track): each chapter ends where the next starts, the last at `duration`. */
export function formatChaptersVtt(chapters: Chapter[], duration: number): string {
  const cues = chapters.map((c, i) => {
    const end = i + 1 < chapters.length ? chapters[i + 1]!.start : Math.max(duration, c.start + 0.001);
    return `${i + 1}\n${vttStamp(c.start)} --> ${vttStamp(end)}\n${c.title.replace(/-->/g, '->')}\n`;
  });
  return `WEBVTT\n\n${cues.join('\n')}`;
}
