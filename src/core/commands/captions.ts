/** Captions commands: import SRT/VTT, captions from a script, styling, and cue editing. Cue times are local to their captions clip. */
import { z } from 'zod';
import { fail } from '../errors.js';
import { defineCommand, TimeArg, type CommandContext } from './registry.js';
import { Id, inputSchemas, type Clip, type Cue, type TextStyle } from '../schema/index.js';
import { parseCaptions, splitScript, estimateWordTimes, wordsOf, type CaptionCue } from '../captions.js';
import { BUILTIN_STYLES } from '../load.js';
import { speedOf } from './clip.js';
import { keyLists } from '../keylists.js';
import { defaultCompId, placeLayers } from './template.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export const StyleArg = z.union([z.string().min(1), inputSchemas.TextStyle]);

export function captionsClip(ctx: CommandContext, id: string): Clip {
  const c = ctx.clip(id);
  if (!c.captions) fail('E_NOT_CAPTIONS', `clip "${id}" is not a captions clip.`, `use the id of a clip with "captions": true, or omit it to create one.`);
  return c;
}

export function cuesOf(ctx: CommandContext, clipId: string): Cue[] {
  return (ctx.project.cues ?? []).filter((q) => q.clip === clipId).sort((a, b) => a.at - b.at);
}

export function cue(ctx: CommandContext, id: string): Cue {
  const q = (ctx.project.cues ?? []).find((x) => x.id === id);
  if (!q) fail('E_REF', `cue "${id}" does not exist.`, 'list cues with: mgl show <file> --cues');
  return q;
}

/** The next free cue id: c1, c2, ... */
export function nextCueId(ctx: CommandContext): string {
  for (let n = (ctx.project.cues ?? []).length + 1; ; n++) {
    const id = ctx.newId(`c${n}`);
    if (id === `c${n}`) return id;
  }
}

export function checkStyleRef(ctx: CommandContext, style: string | TextStyle) {
  const ids = [...(ctx.project.styles ?? []).map((s) => s.id), ...BUILTIN_STYLES];
  const ref = typeof style === 'string' ? style : style.base;
  if (ref !== undefined && !ids.includes(ref)) fail('E_REF', `style "${ref}" does not exist.`, `use one of ${ids.join(', ')}, or add it with style.add.`);
}

/** Merge a style change into a clip's style: an id replaces it, an object merges field by field (null removes). */
export function mergeStyle(cur: Clip['style'], change: string | Record<string, unknown>): Clip['style'] {
  if (typeof change === 'string') return change;
  const base: Record<string, unknown> = typeof cur === 'string' ? { base: cur } : { ...(cur ?? {}) };
  for (const [k, v] of Object.entries(change)) { if (v === null) delete base[k]; else base[k] = v; }
  return Object.keys(base).length ? (base as TextStyle) : undefined;
}

/** Insert a cue next to the other cues of its clip (keeps the table readable). */
function insertCue(ctx: CommandContext, q: Cue) {
  const cues = (ctx.project.cues ??= []);
  let idx = -1;
  cues.forEach((x, i) => { if (x.clip === q.clip && x.at <= q.at) idx = i; });
  if (idx < 0) idx = cues.findIndex((x) => x.clip === q.clip) - 1;
  cues.splice(idx < -1 ? cues.length : idx + 1, 0, q);
}

function fitWords(text: string, len: number): number[] {
  return estimateWordTimes(text, len, true);
}

function overlapping(ctx: CommandContext, clipId: string, at: number, len: number, except: Set<string> = new Set()): Cue | undefined {
  return cuesOf(ctx, clipId).find((x) => !except.has(x.id) && x.at < at + len && at < x.at + x.len);
}

/** Replace (or create) the cues of a captions clip from absolute comp-frame cues. */
function writeCues(ctx: CommandContext, c: Clip, cues: { at: number; len: number; text: string; words?: number[]; speaker?: string }[]): string[] {
  const old = cuesOf(ctx, c.id);
  if (old.length) {
    ctx.project.cues = (ctx.project.cues ?? []).filter((q) => q.clip !== c.id);
    ctx.note(`replaced the ${old.length} existing cue(s) of "${c.id}".`);
  }
  // cue times are local to the clip and never negative: start the clip at the first cue when it is earlier
  const start = cues.reduce((m, k) => Math.min(m, k.at), Infinity);
  if (start < c.at) {
    const prev = (ctx.project.clips ?? []).filter((x) => x.track === c.track && x.id !== c.id && x.at < c.at && x.at + x.len > start).sort((a, b) => b.at + b.len - (a.at + a.len))[0];
    if (prev) fail('E_OVERLAP', `the first cue starts at frame ${start}, before captions clip "${c.id}" (frame ${c.at}), and "${prev.id}" on ${c.track} is in the way of moving its start.`, `make room first: mgl edit <file> clip.trim ${prev.id} end=${start}${prev.at >= start ? ` (or clip.move ${prev.id} track=<another track>)` : ''}, then run this again.`);
    const delta = start - c.at; // negative: the clip start moves earlier, its content stays in place
    c.at = start;
    c.len -= delta;
    c.clock = (c.clock ?? 0) + delta;
    if (c.clock === 0) delete c.clock;
    for (const l of keyLists(c)) l.keys.forEach((kf) => { kf[0] -= delta; });
    ctx.note(`moved the start of "${c.id}" to frame ${start} so the first cue shows.`);
  }
  const ids: string[] = [];
  for (const k of cues) {
    const q: Cue = { id: nextCueId(ctx), clip: c.id, at: k.at - c.at, len: k.len, text: k.text };
    if (k.words) q.words = k.words;
    if (k.speaker) q.speaker = k.speaker;
    (ctx.project.cues ??= []).push(q);
    ids.push(q.id);
  }
  const end = cues.reduce((m, k) => Math.max(m, k.at + k.len), 0);
  if (end > c.at + c.len) {
    const blocked = (ctx.project.clips ?? []).some((x) => x.track === c.track && x.id !== c.id && x.at < end && x.at + x.len > c.at + c.len);
    if (blocked) ctx.note(`cues run past the end of "${c.id}" (frame ${c.at + c.len}); the part after it is not shown. fix: trim the next clip on ${c.track}, then extend "${c.id}".`);
    else { ctx.note(`extended "${c.id}" to ${end - c.at} frames to fit the cues.`); c.len = end - c.at; }
  }
  return ids;
}

/** Use the given captions clip, or create one spanning [at, at+len) on a free visual track. */
function targetClip(ctx: CommandContext, p: { clip?: string; id?: string; track?: string; comp?: string; style?: string | TextStyle }, at: number, len: number, compId: string): Clip {
  if (p.clip) {
    const c = captionsClip(ctx, p.clip);
    if (p.style !== undefined) { checkStyleRef(ctx, p.style); c.style = p.style; }
    return c;
  }
  if (p.id && (ctx.project.clips ?? []).some((c) => c.id === p.id)) fail('E_DUPLICATE_ID', `clip "${p.id}" already exists.`, `pass clip=${p.id} to import into it, or choose another id.`);
  const style = p.style ?? 'caption';
  checkStyleRef(ctx, style);
  const [track] = placeLayers(ctx, compId, [[{ at, len }]], p.track ? { track: p.track } : {});
  const c: Clip = { id: p.id ?? ctx.newId('captions'), track: track!, at, len: Math.max(1, len), captions: true, style };
  (ctx.project.clips ??= []).push(c);
  return c;
}

function compFor(ctx: CommandContext, p: { clip?: string; track?: string; comp?: string }): string {
  if (p.clip) return ctx.compOfClip(ctx.clip(p.clip)).id;
  if (p.track) return ctx.track(p.track).comp;
  return p.comp ?? defaultCompId(ctx);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

defineCommand({
  op: 'captions.import', group: 'captions',
  doc: 'Import an SRT or WebVTT file as cues (file times are comp times; offset shifts them). Creates a captions clip spanning the cues, or fills `clip` (replacing its cues). Word timings come from VTT inline timestamps; words=true estimates them otherwise.',
  schema: z.strictObject({ file: z.string().min(1), clip: Id.optional(), track: Id.optional(), comp: Id.optional(), style: StyleArg.optional(), id: Id.optional(), offset: TimeArg.optional(), words: z.boolean().optional() }),
  primary: 'file', example: { file: 'media/subs.srt', style: 'karaoke', words: true },
  async apply(ctx, p) {
    if (!ctx.services.readText) fail('E_NO_SERVICE', 'reading files is not available here.', 'run through the SDK or CLI, or pass services.readText.');
    let text: string;
    try { text = await ctx.services.readText(p.file); } catch (e) {
      fail('E_NO_FILE', `cannot read ${p.file}: ${(e as Error).message}`, 'give the path relative to the project file.');
    }
    const parsed = parseCaptions(text, p.file);
    for (const w of parsed.warnings) ctx.note(`${p.file} ${w}`);
    const compId = compFor(ctx, p);
    const rate = ctx.rate(compId);
    const fr = (s: number) => Math.round((s * rate.num) / rate.den);
    const off = p.offset === undefined ? 0 : ctx.time(p.offset, compId, 'offset');
    const withWords = p.words ?? parsed.wordTimes;
    const raw = parsed.cues.map((q: CaptionCue) => ({ q, s: fr(q.start) + off, e: fr(q.end) + off }));
    const kept = raw.filter((k) => k.e > 0);
    if (kept.length < raw.length) ctx.note(`dropped ${raw.length - kept.length} cue(s) that end before frame 0 after the offset.`);
    if (!kept.length) fail('E_CAPTIONS', `${p.file} has no cues${raw.length ? ' after the offset' : ''}.`, raw.length ? 'use a smaller negative offset.' : 'check the file: each cue needs a "start --> end" line and text.');
    const cues = kept.map((k, i) => {
      const at = Math.max(0, k.s);
      // keep the file's timing exactly; when cues overlap, the later one is shown while both are active
      const next = kept[i + 1];
      if (next && next.s < k.e) ctx.note(`cues ${i + 1} and ${i + 2} overlap by ${k.e - next.s} frame(s) in the file; timings kept as written (cue ${i + 2} replaces cue ${i + 1} on screen while both are active; nothing to fix).`);
      const len = Math.max(1, k.e - at);
      const out: { at: number; len: number; text: string; words?: number[]; speaker?: string } = { at, len, text: k.q.text };
      if (k.q.speaker) out.speaker = k.q.speaker;
      if (withWords) {
        if (k.q.words) {
          let prev = 0;
          out.words = k.q.words.map((w) => (prev = Math.min(len - 1, Math.max(prev, fr(w) + off - at))));
        } else out.words = fitWords(k.q.text, len);
      }
      return out;
    });
    const at = cues[0]!.at, end = cues.reduce((m, k) => Math.max(m, k.at + k.len), 0);
    const c = targetClip(ctx, p, at, end - at, compId);
    const ids = writeCues(ctx, c, cues);
    ctx.out.clip = c.id;
    ctx.out.cues = ids.length;
    ctx.summary(`imported ${ids.length} cue(s) from ${p.file} into captions clip "${c.id}" (${parsed.format}${withWords ? ', word timings' + (parsed.wordTimes ? '' : ' estimated') : ''}).`);
  },
});

defineCommand({
  op: 'captions.from-text', group: 'captions',
  doc: 'Turn a script (text or a file) into caption cues of at most maxWords words, timed to the speech of a voice clip (silences skipped) or spread evenly over clip / at+len.',
  schema: z.strictObject({ text: z.string().optional(), file: z.string().optional(), clip: Id.optional(), voice: Id.optional(), track: Id.optional(), comp: Id.optional(), style: StyleArg.optional(), id: Id.optional(), maxWords: z.number().int().positive().optional(), at: TimeArg.optional(), len: TimeArg.optional(), words: z.boolean().optional(), silenceDb: z.number().optional(), minSilence: z.number().positive().optional() }),
  example: { file: 'script.txt', voice: 'vo', style: 'karaoke', maxWords: 4 },
  async apply(ctx, p) {
    if ((p.text === undefined) === (p.file === undefined)) fail('E_ARG', 'captions.from-text needs exactly one of "text" or "file".', 'e.g. text="First line. Second line." or file=script.txt');
    let script = p.text ?? '';
    if (p.file) {
      if (!ctx.services.readText) fail('E_NO_SERVICE', 'reading files is not available here.', 'pass the script as text=... instead.');
      try { script = await ctx.services.readText(p.file); } catch (e) { fail('E_NO_FILE', `cannot read ${p.file}: ${(e as Error).message}`, 'give the path relative to the project file.'); }
    }
    const chunks = splitScript(script, p.maxWords ?? 6);
    if (!chunks.length) fail('E_ARG', 'the script has no words.', 'give some text.');
    const voice = p.voice ? ctx.clip(p.voice) : undefined;
    const compId = voice ? ctx.compOfClip(voice).id : compFor(ctx, p);
    const rate = ctx.rate(compId);
    const existing = p.clip ? captionsClip(ctx, p.clip) : undefined;
    // speech segments on the timeline (comp frames)
    let segs: [number, number][];
    if (voice) {
      if (voice.asset === undefined) fail('E_ARG', `voice clip "${voice.id}" is not a media clip.`, 'give the id of an audio or video clip with speech.');
      if (!ctx.services.analyzeAudio) fail('E_NO_SERVICE', 'audio analysis is not available here.', 'run through the SDK or CLI, or omit voice to spread cues evenly.');
      const asset = (ctx.project.assets ?? []).find((a) => a.id === voice.asset);
      if (!asset) fail('E_REF', `asset "${voice.asset}" does not exist.`, 'add it with asset.add.');
      const an = await ctx.services.analyzeAudio(asset.src, { ...(p.silenceDb !== undefined ? { silenceDb: p.silenceDb } : {}), ...(p.minSilence !== undefined ? { minSilence: p.minSilence } : {}) });
      const sp = speedOf(voice);
      const toTl = (srcSec: number) => voice.at + ((srcSec * rate.num) / rate.den - (voice.in ?? 0)) * (sp.num ? sp.den / sp.num : 0);
      const speech: [number, number][] = [];
      let t = 0;
      for (const s of [...an.silences].sort((a, b) => a.start - b.start)) { if (s.start > t) speech.push([t, s.start]); t = Math.max(t, s.end); }
      if (an.duration > t) speech.push([t, an.duration]);
      segs = speech.map(([a, b]): [number, number] => [Math.max(voice.at, Math.round(toTl(a))), Math.min(voice.at + voice.len, Math.round(toTl(b)))]).filter(([a, b]) => b > a);
      if (!segs.length) { ctx.note(`no speech found in "${voice.id}"; spread the cues over the whole clip.`); segs = [[voice.at, voice.at + voice.len]]; }
    } else if (existing) segs = [[existing.at, existing.at + existing.len]];
    else {
      const at = p.at === undefined ? 0 : ctx.time(p.at, compId, 'at');
      const nWords = chunks.reduce((n, c) => n + wordsOf(c).length, 0);
      const len = p.len === undefined ? Math.max(chunks.length, Math.round((nWords * 0.4 * rate.num) / rate.den)) : ctx.time(p.len, compId, 'len');
      segs = [[at, at + len]];
    }
    // distribute chunks over speech time by word count
    const counts = chunks.map((c) => wordsOf(c).length);
    const W = counts.reduce((a, b) => a + b, 0);
    const T = segs.reduce((n, [a, b]) => n + b - a, 0);
    const map = (pos: number, preferNext: boolean): number => {
      let acc = 0;
      for (const [a, b] of segs) {
        const d = b - a;
        if (pos < acc + d || (!preferNext && pos === acc + d)) return a + (pos - acc);
        acc += d;
      }
      return segs[segs.length - 1]![1];
    };
    // chunk boundaries in speech time, snapped to a pause when one is near (sentences tend to end there)
    const edges: number[] = [];
    segs.reduce((acc, [a, b]) => { edges.push(acc + b - a); return acc + b - a; }, 0);
    const tol = Math.round((0.6 * rate.num) / rate.den);
    let w = 0;
    const bounds = [0, ...counts.map((n) => {
      w += n;
      const pos = Math.round((w / W) * T);
      const near = edges.reduce((best, e) => (Math.abs(e - pos) < Math.abs(best - pos) ? e : best), Infinity);
      return Math.abs(near - pos) <= tol ? near : pos;
    })];
    for (let i = 1; i < bounds.length; i++) bounds[i] = Math.max(bounds[i]!, bounds[i - 1]!);
    const cues: { at: number; len: number; text: string; words?: number[] }[] = [];
    let prevEnd = -Infinity;
    chunks.forEach((text, i) => {
      const s = Math.max(prevEnd, map(bounds[i]!, true));
      const e = Math.max(s + 1, map(bounds[i + 1]!, false));
      const q: (typeof cues)[number] = { at: s, len: e - s, text };
      if (p.words !== false) q.words = fitWords(text, e - s);
      cues.push(q);
      prevEnd = e;
    });
    const at = cues[0]!.at, end = cues[cues.length - 1]!.at + cues[cues.length - 1]!.len;
    const c = targetClip(ctx, { ...p, ...(existing ? { clip: existing.id } : {}) }, at, end - at, compId);
    const ids = writeCues(ctx, c, cues);
    ctx.out.clip = c.id;
    ctx.out.cues = ids.length;
    ctx.summary(`created ${ids.length} cue(s) in captions clip "${c.id}"${voice ? ` timed to the speech of "${voice.id}" (${segs.length} segment(s))` : ''}.`);
  },
});

defineCommand({
  op: 'captions.style', group: 'captions', doc: 'Style a captions clip: a style id replaces its style, an object merges into it (null removes a field), e.g. style={"highlight": "#00e5ff", "maxWords": 3}.',
  schema: z.strictObject({ id: Id, style: z.union([z.string().min(1), z.record(z.string(), z.unknown())]) }),
  primary: 'id', example: { id: 'subs', style: { highlight: '#00e5ff', maxWords: 3 } },
  apply(ctx, p) {
    const c = captionsClip(ctx, p.id);
    if (typeof p.style !== 'string') {
      const r = inputSchemas.TextStyle.partial().safeParse(Object.fromEntries(Object.entries(p.style).filter(([, v]) => v !== null)));
      if (!r.success) { const i = r.error.issues[0]!; fail('E_ARG', `captions.style: ${i.path.length ? `"${i.path.join('.')}" ` : ''}${i.message}.`, `style fields: ${Object.keys(inputSchemas.TextStyle.shape).join(', ')}`); }
    }
    const next = mergeStyle(c.style, p.style);
    if (next !== undefined) checkStyleRef(ctx, next);
    if (next === undefined) delete c.style; else c.style = next;
    ctx.summary(`captions "${c.id}" style ${typeof p.style === 'string' ? `set to "${p.style}"` : `updated (${Object.keys(p.style).join(', ')})`}.`);
  },
});

defineCommand({
  op: 'captions.shift', group: 'captions', doc: 'Shift every cue of a captions clip by `by` (negative = earlier), e.g. to fix subtitles that run late.',
  schema: z.strictObject({ id: Id, by: TimeArg }), primary: 'id', example: { id: 'subs', by: '-0.5s' },
  apply(ctx, p) {
    const c = captionsClip(ctx, p.id);
    const by = ctx.time(p.by, ctx.compOfClip(c), 'by');
    const cues = cuesOf(ctx, c.id);
    const first = cues[0];
    if (first && first.at + by < 0) fail('E_RANGE', `cue "${first.id}" would start ${-(first.at + by)} frame(s) before the clip.`, `shift by at most ${-first.at}, or move the clip earlier with clip.move and shift the cues later.`);
    for (const q of cues) q.at += by;
    const last = cues[cues.length - 1];
    if (last && last.at + last.len > c.len) ctx.note(`cue "${last.id}" now ends after the clip (frame ${c.len}); extend the clip with clip.trim.`);
    ctx.summary(`shifted ${cues.length} cue(s) of "${c.id}" by ${by} frame(s).`);
  },
});

const WordsArg = z.array(TimeArg);

defineCommand({
  op: 'cue.add', group: 'captions', doc: 'Add a cue to a captions clip (at = frames from the clip start); words are per-word start offsets from the cue start (optional).',
  schema: z.strictObject({ clip: Id, at: TimeArg, len: TimeArg, text: z.string().min(1), words: WordsArg.optional(), speaker: z.string().optional(), id: Id.optional() }),
  example: { clip: 'subs', at: '1s', len: '1.5s', text: 'Put your phone away' },
  apply(ctx, p) {
    const c = captionsClip(ctx, p.clip);
    const comp = ctx.compOfClip(c);
    const at = ctx.time(p.at, comp, 'at'), len = ctx.time(p.len, comp, 'len');
    if (len < 1 || at < 0) fail('E_RANGE', `a cue needs at ≥ 0 and len ≥ 1 (got at=${at}, len=${len}).`, 'cue times count from the captions clip start.');
    const hit = overlapping(ctx, c.id, at, len);
    if (hit) fail('E_OVERLAP', `the cue would overlap cue "${hit.id}" (${hit.at}–${hit.at + hit.len}).`, `use at=${hit.at + hit.len}, or shorten "${hit.id}" with cue.set.`);
    if (p.id && (ctx.project.cues ?? []).some((q) => q.id === p.id)) fail('E_DUPLICATE_ID', `cue "${p.id}" already exists.`, 'choose another id or omit it.');
    const q: Cue = { id: p.id ?? nextCueId(ctx), clip: c.id, at, len, text: p.text };
    if (p.words) q.words = checkWords(p.text, p.words.map((w) => ctx.time(w, comp, 'words')), len);
    if (p.speaker) q.speaker = p.speaker;
    insertCue(ctx, q);
    if (at + len > c.len) ctx.note(`cue "${q.id}" ends after the clip (frame ${c.len}); extend the clip with clip.trim.`);
    ctx.out.id = q.id;
    ctx.summary(`added cue "${q.id}" to "${c.id}" at ${at}–${at + len}.`);
  },
});

function checkWords(text: string, words: number[], len: number): number[] {
  const n = wordsOf(text).length;
  if (words.length !== n) fail('E_WORDS', `the text has ${n} word(s) but ${words.length} word time(s) were given.`, 'give one start offset (frames from the cue start) per word, or omit words to estimate them.');
  for (let i = 0; i < words.length; i++) {
    if (words[i]! < 0 || words[i]! >= len) fail('E_WORDS', `word ${i + 1} starts at ${words[i]}, outside the cue (0–${len - 1}).`, 'word times count from the cue start.');
    if (i && words[i]! < words[i - 1]!) fail('E_WORDS', `word ${i + 1} starts before word ${i}.`, 'word start offsets must not decrease.');
  }
  return words;
}

defineCommand({
  op: 'cue.set', group: 'captions', doc: 'Change a cue: text (word times are re-estimated when the word count changes), at, len, words (null removes them), speaker.',
  schema: z.strictObject({ id: Id, text: z.string().min(1).optional(), at: TimeArg.optional(), len: TimeArg.optional(), words: WordsArg.nullable().optional(), speaker: z.string().nullable().optional() }),
  primary: 'id', example: { id: 'c3', text: 'Put your phone in a drawer' },
  apply(ctx, p) {
    const q = cue(ctx, p.id);
    const c = ctx.clip(q.clip);
    const comp = ctx.compOfClip(c);
    const oldLen = q.len;
    if (p.at !== undefined) q.at = ctx.time(p.at, comp, 'at');
    if (p.len !== undefined) q.len = ctx.time(p.len, comp, 'len');
    if (q.len < 1 || q.at < 0) fail('E_RANGE', `a cue needs at ≥ 0 and len ≥ 1 (got at=${q.at}, len=${q.len}).`, 'cue times count from the captions clip start.');
    const hit = overlapping(ctx, c.id, q.at, q.len, new Set([q.id]));
    if (hit) fail('E_OVERLAP', `cue "${q.id}" would overlap cue "${hit.id}" (${hit.at}–${hit.at + hit.len}).`, `keep it within ${hit.at > q.at ? `0–${hit.at}` : `${hit.at + hit.len}–`}, or change "${hit.id}" first.`);
    if (p.text !== undefined) q.text = p.text;
    if (p.speaker !== undefined) { if (p.speaker === null) delete q.speaker; else q.speaker = p.speaker; }
    if (p.words === null) delete q.words;
    else if (p.words) q.words = checkWords(q.text, p.words.map((w) => ctx.time(w, comp, 'words')), q.len);
    else if (q.words && (p.text !== undefined || q.len !== oldLen)) {
      const n = wordsOf(q.text).length;
      if (n !== q.words.length) { q.words = fitWords(q.text, q.len); ctx.note(`re-estimated the word times of "${q.id}" (the word count changed).`); }
      else if (q.len !== oldLen) q.words = q.words.map((w) => Math.min(q.len - 1, Math.floor((w * q.len) / oldLen)));
    }
    ctx.summary(`cue "${q.id}" updated.`);
  },
});

defineCommand({
  op: 'cue.remove', group: 'captions', doc: 'Remove a cue (or several with ids).',
  schema: z.strictObject({ id: Id.optional(), ids: z.array(Id).optional() }), primary: 'id', example: { id: 'c3' },
  apply(ctx, p) {
    const ids = new Set([...(p.ids ?? []), ...(p.id ? [p.id] : [])]);
    if (!ids.size) fail('E_ARG', 'cue.remove needs id or ids.', 'example: mgl edit <file> cue.remove c3');
    for (const id of ids) cue(ctx, id);
    ctx.project.cues = (ctx.project.cues ?? []).filter((q) => !ids.has(q.id));
    ctx.summary(`removed ${ids.size} cue(s).`);
  },
});

defineCommand({
  op: 'cue.split', group: 'captions', doc: 'Split a cue in two: at a time (frames from the cue start; words before it stay) or before word index `word` (0-based).',
  schema: z.strictObject({ id: Id, at: TimeArg.optional(), word: z.number().int().positive().optional() }),
  primary: 'id', example: { id: 'c3', word: 3 },
  apply(ctx, p) {
    if ((p.at === undefined) === (p.word === undefined)) fail('E_ARG', 'cue.split needs exactly one of "at" or "word".', 'e.g. cue.split c3 word=3 (before the 4th word) or cue.split c3 at=20');
    const q = cue(ctx, p.id);
    const comp = ctx.compOfClip(ctx.clip(q.clip));
    const words = wordsOf(q.text);
    if (words.length < 2) fail('E_RANGE', `cue "${q.id}" has one word; nothing to split.`, 'use cue.set to change it.');
    const offs = q.words && q.words.length === words.length ? q.words : fitWords(q.text, q.len);
    let k: number, cut: number;
    if (p.word !== undefined) {
      k = p.word;
      if (k >= words.length) fail('E_RANGE', `cue "${q.id}" has ${words.length} words; word ${k} does not exist.`, `use word=1..${words.length - 1}.`);
      cut = offs[k]!;
    } else {
      cut = ctx.time(p.at!, comp, 'at');
      if (cut <= 0 || cut >= q.len) fail('E_RANGE', `at=${cut} is not inside cue "${q.id}" (1–${q.len - 1}).`, 'at counts frames from the cue start.');
      k = offs.findIndex((o) => o >= cut);
      if (k <= 0) fail('E_RANGE', `no word boundary at frame ${cut} of cue "${q.id}" (words start at ${offs.join(', ')}).`, 'split by word index instead: word=<n>.');
    }
    cut = Math.max(1, Math.min(q.len - 1, cut));
    const second: Cue = { id: nextCueId(ctx), clip: q.clip, at: q.at + cut, len: q.len - cut, text: words.slice(k).join(' ') };
    if (q.words) second.words = offs.slice(k).map((o) => Math.max(0, o - cut));
    if (q.speaker) second.speaker = q.speaker;
    q.text = words.slice(0, k).join(' ');
    q.len = cut;
    if (q.words) q.words = offs.slice(0, k).map((o) => Math.min(o, cut - 1));
    insertCue(ctx, second);
    ctx.out.id = second.id;
    ctx.summary(`split cue "${q.id}" at frame ${cut}: "${q.text}" | "${second.text}" ("${second.id}").`);
  },
});

defineCommand({
  op: 'cue.merge', group: 'captions', doc: 'Merge consecutive cues of one captions clip into the first (text joined, word times kept).',
  schema: z.strictObject({ ids: z.array(Id).min(2) }), example: { ids: ['c3', 'c4'] },
  apply(ctx, p) {
    const qs = [...new Set(p.ids)].map((id) => cue(ctx, id)).sort((a, b) => a.at - b.at);
    const clip = qs[0]!.clip;
    if (qs.some((q) => q.clip !== clip)) fail('E_ARG', 'cues to merge must belong to the same captions clip.', 'merge cues of one clip at a time.');
    const first = qs[0]!;
    const end = Math.max(...qs.map((q) => q.at + q.len));
    const between = overlapping(ctx, clip, first.at, end - first.at, new Set(qs.map((q) => q.id)));
    if (between) fail('E_ARG', `cue "${between.id}" lies between the cues to merge.`, `include it: ids=${JSON.stringify([...qs.map((q) => q.id), between.id])}`);
    const anyWords = qs.some((q) => q.words);
    const words: number[] = [];
    for (const q of qs) {
      const offs = q.words && q.words.length === wordsOf(q.text).length ? q.words : fitWords(q.text, q.len);
      words.push(...offs.map((o) => o + q.at - first.at));
    }
    first.text = qs.map((q) => q.text).join(' ');
    first.len = end - first.at;
    if (anyWords) first.words = words; else delete first.words;
    const drop = new Set(qs.slice(1).map((q) => q.id));
    ctx.project.cues = (ctx.project.cues ?? []).filter((q) => !drop.has(q.id));
    ctx.summary(`merged ${qs.length} cues into "${first.id}".`);
  },
});
