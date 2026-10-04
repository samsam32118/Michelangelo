/**
 * Provider-backed commands (plugin API 1.3): audio.speak (text-to-speech through the first 'speak' provider) and
 * captions.from-speech (word-timed captions from a voice clip: the timings audio.speak stored, or a 'transcribe'
 * provider). The library ships no models: providers come as plugins (examples/plugins/kokoro-voice, flite-voice). Without
 * one, both commands fail with E_NO_PROVIDER naming how to add one and the offline fallback.
 */
import { z } from 'zod';
import { fail } from '../errors.js';
import { defineCommand, TimeArg, type CommandContext, type TimedWord } from './registry.js';
import { Id, type Asset, type Clip, type Comp, type Cue, type Track } from '../schema/index.js';
import { clipEnd, speedOf } from './clip.js';
import { StyleArg, captionsClip, checkStyleRef, cuesOf, nextCueId, speechEnvelope } from './captions.js';
import { defaultCompId, placeLayers } from './template.js';
import { paramsHash } from '../../audiogen/dsp.js';
import { alignWords, snapToOnsets, textWords } from '../align.js';
import { timeCues } from '../cue-timing.js';

declare module './registry.js' {
  interface CommandServices {
    writeFile?(path: string, data: Uint8Array): Promise<void>;
    fileExists?(path: string): Promise<boolean>;
  }
}

export const VO_DIR = 'media/generated';
/** bump when the sidecar format or the cache key changes */
const VO_VERSION = 1;

/** What audio.speak stores next to the WAV (`<wav>.json`): captions.from-speech reads the word timings from it. */
export interface SpeechMeta {
  v: number;
  provider: string;
  voice?: string;
  speed?: number;
  text: string;
  /** seconds */
  duration: number;
  /** word times in seconds from the start of the file; absent when neither the provider nor alignment gave any */
  words?: TimedWord[];
  /** where `words` came from: the provider (checked against the sound), or aligned to the sound by Michelangelo */
  timing?: 'provider' | 'aligned';
}

const PLUGIN_FIX = 'add a speak plugin to the project: examples/plugins/kokoro-voice from the Michelangelo repository (natural voices; npm install in it, ~330 MB model on first use), examples/plugins/flite-voice (no downloads), or the 20-line ffmpeg-flite plugin in "mgl docs audio" (section Speech); then "mgl plugin trust plugins/<name>" and "mgl edit <file> project.set plugins=\'{"<name>": "^1.0.0"}\'"';

export function voPath(key: Record<string, unknown>): string {
  return `${VO_DIR}/vo-${paramsHash({ v: VO_VERSION, ...key }, 12)}.wav`;
}

const fpsOf = (ctx: CommandContext, comp: Comp) => { const r = ctx.rate(comp); return r.num / r.den; };
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const overlaps = (c: Clip, at: number, end: number) => c.at < end && at < clipEnd(c);


/** A dialogue-bus track of `comp` free over [at, end), or a new one ("VO", "VO2", ...). */
function dialogueTrack(ctx: CommandContext, comp: Comp, at: number, end: number, want?: string): string {
  const tracks = (ctx.project.tracks ??= []);
  const clips = ctx.project.clips ?? [];
  if (want) {
    const t = tracks.find((x) => x.id === want);
    if (t) {
      if (!t.audio) fail('E_TRACK_KIND', `track "${want}" is a visual track.`, 'use an audio track, or a new id (it is created on the dialogue bus).');
      const hit = clips.find((c) => c.track === want && overlaps(c, at, end));
      if (hit) fail('E_OVERLAP', `the voice would overlap "${hit.id}" (${hit.at}–${clipEnd(hit)}) on track ${want}.`, 'omit track= to pick a free one, or give another at=.');
      return want;
    }
    tracks.push({ id: want, comp: comp.id, audio: true, bus: 'dialogue' });
    ctx.note(`created track ${want} on the dialogue bus.`);
    return want;
  }
  const free = tracks.find((t) => t.comp === comp.id && t.audio && t.bus === 'dialogue' && !clips.some((c) => c.track === t.id && overlaps(c, at, end)));
  if (free) return free.id;
  const id = ctx.newId('VO');
  const nt: Track = { id, comp: comp.id, audio: true, bus: 'dialogue' };
  tracks.push(nt);
  ctx.note(`created track ${id} on the dialogue bus.`);
  return id;
}

/** End of the last clip on the comp's dialogue tracks (so repeated audio.speak calls follow each other). */
function dialogueEnd(ctx: CommandContext, comp: Comp): number {
  const ids = new Set((ctx.project.tracks ?? []).filter((t) => t.comp === comp.id && t.audio && t.bus === 'dialogue').map((t) => t.id));
  return (ctx.project.clips ?? []).filter((c) => ids.has(c.track)).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

/** Clean, monotonic word times inside [0, duration]. */
export function normaliseWords(words: TimedWord[] | undefined, duration: number): TimedWord[] | undefined {
  if (!words?.length) return undefined;
  const out: TimedWord[] = [];
  let prev = 0;
  for (const w of words) {
    const text = String(w.text ?? '').trim();
    if (!text || !Number.isFinite(w.start)) continue;
    const start = round3(Math.min(Math.max(prev, w.start), duration));
    const o: TimedWord = { text, start };
    if (w.end !== undefined && Number.isFinite(w.end)) o.end = round3(Math.min(Math.max(start, w.end), duration));
    if (w.confidence !== undefined) o.confidence = w.confidence;
    out.push(o);
    prev = start;
  }
  return out.length ? out : undefined;
}

/** Words of a text with estimated times over [0, duration] (weighted by letters; a pause after punctuation). */
export function estimateTimedWords(text: string, duration: number): TimedWord[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const weight = (w: string) => Math.max(1, w.replace(/[^\p{L}\p{N}]/gu, '').length) + 1 + (/[.!?]$/.test(w) ? 4 : /[,;:]$/.test(w) ? 2 : 0);
  const total = words.reduce((n, w) => n + weight(w), 0);
  let t = 0;
  return words.map((w) => {
    const d = (weight(w) / total) * duration;
    const o = { text: w, start: round3(t), end: round3(t + d * (/[.!?,;:]$/.test(w) ? 0.7 : 0.95)) };
    t += d;
    return o;
  });
}

/** Words a caption cue should not end on (articles, prepositions, conjunctions, possessives). */
const WEAK_END = new Set(['a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'and', 'or', 'but', 'with', 'from', 'my', 'your', 'our', 'their', 'his', 'her', 'its', 'is', 'are', 'that', 'this']);

/**
 * Group timed words (timeline seconds) into caption cues of at most `maxWords` words, the way people chunk speech:
 * first into phrases (a cue ends at sentence punctuation, at a pause of 0.35 s or more, and at a comma, semicolon
 * or colon once it has 2+ words or when the voice pauses on or draws out the word there), then each long phrase into balanced parts
 * (6 words at 3 → 3 + 3, never 3 + 3 + ... + 1), moving a split so a cue does not end on "of", "the", "my" ...
 */
export function groupWords(words: TimedWord[], maxWords: number): TimedWord[][] {
  const max = Math.max(1, maxWords);
  const phrases: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    const end = w.end ?? next?.start ?? w.start;
    const pause = next ? next.start - end : 0;
    // a lone word before a comma is its own beat when the voice pauses or draws it out ("First, ...")
    const clause = /[,;:]["')\]]?$/.test(w.text) && (cur.length >= 2 || pause >= 0.15 || end - w.start >= 0.35);
    if (!next || /[.!?…]["')\]]?$/.test(w.text) || clause || pause >= 0.35) { phrases.push(cur); cur = []; }
  });
  const weak = (w: TimedWord) => WEAK_END.has(w.text.toLowerCase().replace(/[^a-z']/g, ''));
  const out: TimedWord[][] = [];
  for (const ph of phrases) {
    const n = ph.length, k = Math.ceil(n / max);
    if (k <= 1) { out.push(ph); continue; }
    // balanced sizes, larger first; then each split moves one word earlier (or later) off a weak word if it fits
    const sizes = Array.from({ length: k }, (_, i) => Math.floor(n / k) + (i < n % k ? 1 : 0));
    const cuts: number[] = [];
    sizes.reduce((acc, sz, i) => { if (i < k - 1) cuts.push(acc + sz); return acc + sz; }, 0);
    for (let c = 0; c < cuts.length; c++) {
      const lo = c ? cuts[c - 1]! : 0, hi = c + 1 < cuts.length ? cuts[c + 1]! : n;
      const at = cuts[c]!;
      if (!weak(ph[at - 1]!)) continue;
      if (at - 1 - lo >= 1 && hi - (at - 1) <= max) cuts[c] = at - 1;
      else if (at + 1 - lo <= max && hi - (at + 1) >= 1 && !weak(ph[at]!)) cuts[c] = at + 1;
    }
    let from = 0;
    for (const c of [...cuts, n]) { out.push(ph.slice(from, c)); from = c; }
  }
  return out;
}

async function readMeta(ctx: CommandContext, src: string): Promise<SpeechMeta | undefined> {
  const s = ctx.services;
  if (!s.readText) return undefined;
  if (s.fileExists && !(await s.fileExists(`${src}.json`))) return undefined;
  try {
    const m = JSON.parse(await s.readText(`${src}.json`)) as SpeechMeta;
    return typeof m.text === 'string' && typeof m.duration === 'number' ? m : undefined;
  } catch { return undefined; }
}

// ------------------------------------------------------------------------------------------- audio.speak

defineCommand({
  op: 'audio.speak', group: 'audio',
  doc: 'Text to speech through the project\'s speak provider (a plugin, e.g. kokoro-voice or flite-voice): writes media/generated/vo-<hash>.wav (reused when text, voice and speed repeat), adds it as an asset + clip on the dialogue bus (after the previous voice line unless at= is given), and stores word timings for captions.from-speech (the provider\'s, with phrase onsets snapped to the sound, or the text aligned to the sound when it gives none). voice and speed (0.5..2) are provider-specific; E_NO_PROVIDER when the project has none.',
  schema: z.strictObject({
    text: z.string().min(1), voice: z.string().min(1).optional(), speed: z.number().min(0.5).max(2).optional(),
    track: Id.optional(), at: TimeArg.optional(), id: Id.optional(), comp: Id.optional(), gain: z.number().min(-60).max(12).optional(),
  }),
  primary: 'text', example: { text: 'Three tips for better sleep.', voice: 'slt' },
  async apply(ctx, p) {
    const s = ctx.services;
    if (!s.speak) fail('E_NO_PROVIDER', 'audio.speak needs a text-to-speech provider, and this project has none.', `${PLUGIN_FIX}. Offline fallback without speech: record or add a voice file (asset.add + clip.add on a dialogue track), then captions.from-text voice=<clip> text="...".`);
    if (!s.writeFile) fail('E_NO_SERVICE', 'audio.speak writes a WAV, and no file service is available here.', 'run it through the CLI (mgl edit) or the SDK (open(file)).');
    if (p.id !== undefined && (ctx.project.clips ?? []).some((c) => c.id === p.id)) fail('E_DUPLICATE_ID', `clip "${p.id}" already exists.`, 'choose another id, or omit it.');
    const text = p.text.replace(/\s+/g, ' ').trim();
    const comp = p.comp ? ctx.comp(p.comp) : p.track && (ctx.project.tracks ?? []).some((t) => t.id === p.track) ? ctx.compOfTrack(p.track) : ctx.comp(defaultCompId(ctx));
    const fps = fpsOf(ctx, comp);
    const key = { provider: s.speak.id, text, voice: p.voice ?? null, speed: p.speed ?? null };
    const rel = voPath(key);
    let meta = await readMeta(ctx, rel);
    const reused = !!meta && (!s.fileExists || (await s.fileExists(rel)));
    if (!reused) {
      const r = await s.speak.speak({ text, ...(p.voice !== undefined ? { voice: p.voice } : {}), ...(p.speed !== undefined ? { speed: p.speed } : {}), out: rel });
      let duration: number | undefined;
      if (s.probe) duration = (await s.probe(rel)).duration;
      const words0 = r.words?.length ? r.words : undefined;
      duration ??= words0 ? Math.max(...words0.map((w) => w.end ?? w.start)) + 0.3 : undefined;
      if (!duration || duration <= 0) fail('E_PROVIDER', `speak provider "${s.speak.id}" wrote audio with no length.`, 'check the provider (mgl doctor lists it).');
      // provider timings are checked against the sound (phrase onsets snap to where the voice starts); without
      // any, the text is aligned to the sound, so every provider gets word-timed captions
      let words = normaliseWords(words0, duration);
      let timing: SpeechMeta['timing'] = words ? 'provider' : undefined;
      const env = await speechEnvelope(ctx, rel);
      if (env && words) words = normaliseWords(snapToOnsets(words, env), duration);
      else if (env) { words = normaliseWords(alignWords(textWords(text), env), duration); if (words) timing = 'aligned'; }
      meta = { v: VO_VERSION, provider: s.speak.id, ...(p.voice !== undefined ? { voice: p.voice } : {}), ...(p.speed !== undefined ? { speed: p.speed } : {}), text, duration: round3(duration), ...(words ? { words, timing } : {}) };
      await s.writeFile(`${rel}.json`, new TextEncoder().encode(JSON.stringify(meta, null, 1) + '\n'));
    }
    const m = meta!;
    const assets = (ctx.project.assets ??= []);
    let asset: Asset | undefined = assets.find((a) => a.src === rel);
    if (!asset) { let aid = ctx.newId('vo'); if (aid === p.id) aid = ctx.newId('vo-audio'); asset = { id: aid, src: rel, note: `speech (${m.provider}${m.voice ? `, ${m.voice}` : ''}): ${text.length > 60 ? text.slice(0, 57) + '...' : text}` }; assets.push(asset); }
    const at = p.at !== undefined ? ctx.time(p.at, comp, 'at') : dialogueEnd(ctx, comp);
    const len = Math.max(1, Math.round(m.duration * fps));
    const track = dialogueTrack(ctx, comp, at, at + len, p.track);
    const clip: Clip = { id: p.id ?? ctx.newId('line'), track, at, len, asset: asset.id, ...(p.gain ? { gain: p.gain } : {}) };
    (ctx.project.clips ??= []).push(clip);
    if (typeof comp.length === 'number' && at + len > comp.length) ctx.note(`the voice ends at frame ${at + len}, after the end of comp "${comp.id}" (${comp.length}); extend it with comp.set ${comp.id} length=${at + len} (or length=auto).`);
    ctx.out.id = clip.id; ctx.out.asset = asset.id; ctx.out.src = rel; ctx.out.duration = m.duration; ctx.out.at = at; ctx.out.end = at + len;
    ctx.out.timings = m.words ? m.timing ?? 'provider' : 'none';
    if (m.words) ctx.out.words = m.words;
    ctx.out.generated = !reused;
    ctx.summary(`added voice "${clip.id}" on ${track} at ${at}–${at + len} (${m.duration.toFixed(2)}s, ${m.provider}${m.voice ? ` voice ${m.voice}` : ''}${m.speed ? ` ×${m.speed}` : ''}); ${reused ? 'reused' : 'generated'} ${rel}${m.words ? ` with ${m.words.length} word timings${m.timing === 'aligned' ? ' (aligned to the sound)' : ''}` : ''}. Captions: captions.from-speech clip=${clip.id}.`);
  },
});

// ------------------------------------------------------------------------------------------- captions.from-speech

type Source = 'speak' | 'aligned' | 'transcribe' | 'estimated';

/** Timed words of one voice clip, in timeline seconds, limited to the clip's visible range. */
async function clipWords(ctx: CommandContext, voice: Clip, lang?: string): Promise<{ words: TimedWord[]; source: Source }> {
  if (voice.asset === undefined) fail('E_ARG', `clip "${voice.id}" is not a media clip.`, 'give the id of an audio or video clip with speech (audio.speak adds one).');
  const asset = (ctx.project.assets ?? []).find((a) => a.id === voice.asset);
  if (!asset) fail('E_REF', `asset "${voice.asset}" does not exist.`, 'add it with asset.add.');
  const fps = fpsOf(ctx, ctx.compOfClip(voice));
  const meta = await readMeta(ctx, asset.src);
  let words: TimedWord[] | undefined, source: Source;
  if (meta?.words?.length) { words = meta.words; source = meta.timing === 'aligned' ? 'aligned' : 'speak'; }
  else if (ctx.services.transcribe) {
    const r = await ctx.services.transcribe.transcribe({ file: asset.src, ...(lang ? { lang } : {}) });
    words = normaliseWords(r.words, Number.POSITIVE_INFINITY);
    if (!words) fail('E_NO_SPEECH', `transcribe provider "${ctx.services.transcribe.id}" found no words in ${asset.src}.`, `check that the clip has speech, or use captions.from-text voice=${voice.id} text="..." with the script.`);
    source = 'transcribe';
  } else if (meta) {
    const env = await speechEnvelope(ctx, asset.src);
    if (env) { words = alignWords(textWords(meta.text), env); source = 'aligned'; }
    else { words = estimateTimedWords(meta.text, meta.duration); source = 'estimated'; }
  } else {
    return fail('E_NO_PROVIDER', `captions.from-speech needs word timings for "${voice.id}", and the project has no transcribe provider.`, `make the voice with audio.speak (it stores timings), or add a transcribe plugin (a TranscribeProvider, plugin API 1.3: mgl docs plugins). Offline fallback: captions.from-text voice=${voice.id} text="<the script>" (times the script to the speech).`);
  }
  // source seconds → timeline seconds; keep the words that start inside the clip
  const sp = speedOf(voice);
  const k = sp.num ? sp.den / sp.num : 0;
  const inF = voice.in ?? 0;
  const tl = (sec: number) => (voice.at + (sec * fps - inF) * k) / fps;
  const lo = voice.at / fps, hi = clipEnd(voice) / fps;
  const out = words!.map((w) => ({ text: w.text, start: tl(w.start), ...(w.end !== undefined ? { end: Math.min(hi, tl(w.end)) } : {}) }))
    .filter((w) => w.start >= lo - 0.5 / fps && w.start < hi);
  return { words: out, source };
}

/** The voice clips to caption: `clip`, `clips`, or every media clip on the default comp's dialogue-bus tracks. */
function voiceClips(ctx: CommandContext, p: { clip?: string; clips?: string[] }): Clip[] {
  if (p.clip !== undefined && p.clips !== undefined) fail('E_ARG', 'captions.from-speech takes clip= or clips=, not both.', 'clip=line1 for one voice clip, clips=["line1","line2"] for several (one captions clip).');
  if (p.clip !== undefined) return [ctx.clip(p.clip)];
  if (p.clips !== undefined) return p.clips.map((id) => ctx.clip(id)).sort((a, b) => a.at - b.at);
  const comp = defaultCompId(ctx);
  const dialogue = new Set((ctx.project.tracks ?? []).filter((t) => t.comp === comp && t.audio && t.bus === 'dialogue').map((t) => t.id));
  const found = (ctx.project.clips ?? []).filter((c) => dialogue.has(c.track) && c.asset !== undefined && !c.muted).sort((a, b) => a.at - b.at);
  if (!found.length) fail('E_ARG', `comp "${comp}" has no voice clips on a dialogue-bus track.`, 'make one with audio.speak text="...", or name the clip: captions.from-speech clip=<id>.');
  return found;
}

defineCommand({
  op: 'captions.from-speech', group: 'captions',
  doc: 'Word-timed caption cues from voice clips (clip=, clips=[...], or by default every voice clip on the dialogue bus, into one captions clip): uses the timings audio.speak stored, else the project\'s transcribe provider (a plugin), else (clips made by audio.speak) aligns the stored text to the sound. Cues of at most maxWords words (default 4) break at sentences, commas and pauses, appear just before their first word and stay long enough to read (CUE_TIMING: mgl docs text-and-captions). Fills `id` (a captions clip, cues replaced) or creates one. E_NO_PROVIDER when nothing can time the words (fallback: captions.from-text voice=<clip> text=...).',
  schema: z.strictObject({ clip: Id.optional(), clips: z.array(Id).min(1).optional(), style: StyleArg.optional(), maxWords: z.number().int().min(1).max(12).optional(), id: Id.optional(), track: Id.optional(), lang: z.string().min(2).optional() }),
  primary: 'clip', example: { style: 'karaoke', maxWords: 3 },
  async apply(ctx, p) {
    const voices = voiceClips(ctx, p);
    const comp = ctx.compOfClip(voices[0]!);
    if (voices.some((v) => ctx.compOfClip(v).id !== comp.id)) fail('E_ARG', 'the voice clips are in different comps.', 'caption one comp at a time (clips=[...] from one comp).');
    const fps = fpsOf(ctx, comp);
    const sources = new Set<Source>();
    const timed: TimedWord[] = [];
    for (const v of voices) {
      const r = await clipWords(ctx, v, p.lang);
      sources.add(r.source);
      timed.push(...r.words);
    }
    timed.sort((a, b) => a.start - b.start);
    if (sources.has('estimated')) ctx.note('the speak provider gave no word timings and the sound could not be analysed here; estimated them from the text (a transcribe provider gives exact ones).');
    if (!timed.length) fail('E_NO_SPEECH', `no words fall inside ${voices.map((v) => `"${v.id}"`).join(', ')}.`, 'check the clips\' in/len, or caption other clips.');
    const groups = groupWords(timed, p.maxWords ?? 4);
    // a cue may appear a frame or two before its voice clip starts (CUE_TIMING.lead), never before frame 0
    const lo = Math.max(0, Math.min(...voices.map((v) => v.at)) - Math.ceil(0.1 * fps)), hi = Math.max(...voices.map(clipEnd));
    const cues = timeCues(groups, fps, lo, hi);
    // the target captions clip
    const span0 = cues[0]!.at, span1 = cues[cues.length - 1]!.at + cues[cues.length - 1]!.len;
    let c: Clip;
    const existing = p.id ? (ctx.project.clips ?? []).find((x) => x.id === p.id) : undefined;
    if (existing) {
      c = captionsClip(ctx, existing.id);
      if (p.style !== undefined) { checkStyleRef(ctx, p.style); c.style = p.style; }
      const old = cuesOf(ctx, c.id);
      if (old.length) { ctx.project.cues = (ctx.project.cues ?? []).filter((q) => q.clip !== c.id); ctx.note(`replaced the ${old.length} existing cue(s) of "${c.id}".`); }
      if (span0 < c.at || span1 > clipEnd(c)) {
        const blocked = (ctx.project.clips ?? []).find((x) => x.track === c.track && x.id !== c.id && overlaps(x, span0, span1));
        if (blocked) fail('E_OVERLAP', `the cues span ${span0}–${span1}, beyond captions clip "${c.id}", and "${blocked.id}" on ${c.track} is in the way.`, `omit id= to create a new captions clip, or make room (clip.trim ${blocked.id}).`);
        if (c.clock) fail('E_ARG', `captions clip "${c.id}" has a clock offset; it cannot be re-spanned.`, 'omit id= to create a new captions clip.');
        c.at = span0; c.len = span1 - span0;
        ctx.note(`set "${c.id}" to ${span0}–${span1} to fit the speech.`);
      }
    } else {
      if (p.id !== undefined) ctx.note(`created captions clip "${p.id}".`);
      const style = p.style ?? 'caption';
      checkStyleRef(ctx, style);
      const [track] = placeLayers(ctx, comp.id, [[{ at: span0, len: span1 - span0 }]], p.track ? { track: p.track } : {});
      c = { id: p.id ?? ctx.newId('captions'), track: track!, at: span0, len: Math.max(1, span1 - span0), captions: true, style };
      (ctx.project.clips ??= []).push(c);
    }
    const ids: string[] = [];
    for (const q of cues) {
      const cue: Cue = { id: nextCueId(ctx), clip: c.id, at: q.at - c.at, len: q.len, text: q.text, words: q.words };
      (ctx.project.cues ??= []).push(cue);
      ids.push(cue.id);
    }
    const source = sources.size === 1 ? [...sources][0]! : 'mixed';
    ctx.out.clip = c.id; ctx.out.cues = ids.length; ctx.out.source = source; ctx.out.words = timed.length; ctx.out.voices = voices.map((v) => v.id);
    const how: Record<string, string> = { speak: 'stored by audio.speak', aligned: 'aligned to the sound', transcribe: `transcribed by ${ctx.services.transcribe?.id}`, estimated: 'estimated from the text', mixed: [...sources].join(' + ') };
    ctx.summary(`created ${ids.length} word-timed cue(s) in captions clip "${c.id}" from ${voices.map((v) => `"${v.id}"`).join(', ')} (${timed.length} words, timings: ${how[source]}).`);
  },
});
