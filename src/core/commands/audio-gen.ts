/**
 * Generated sound: audio.music (a procedural music bed), audio.sfx (one sound effect) and audio.auto-sfx (fitting
 * effects on transitions, cuts, template and text entrances, linked to their source clips). The audio is
 * synthesised offline and deterministically (src/audiogen), written once to media/generated/ (named by a hash of
 * its parameters, so a repeat call reuses the file) and added as an asset + clip on a music or sfx bus track.
 */
import { z } from 'zod';
import { fail } from '../errors.js';
import { defineCommand, TimeArg, type CommandContext } from './registry.js';
import { Id, TABLES, type Asset, type Clip, type Comp, type Track } from '../schema/index.js';
import { framesToSeconds } from '../time.js';
import { clipEnd } from './clip.js';
import { busEntry } from './audio.js';
import { MOODS, SFX_TYPES, defaultIntensity, musicPath, parseKey, renderMusic, renderSfx, sfxDescribe, sfxPath, GENERATED_DIR, type Mood, type MusicParams, type SfxType } from '../../audiogen/index.js';

declare module './registry.js' {
  interface CommandServices {
    /** write a generated file (path relative to the project folder), creating folders as needed */
    writeFile?(path: string, data: Uint8Array): Promise<void>;
    /** whether a file exists (path relative to the project folder) */
    fileExists?(path: string): Promise<boolean>;
  }
}

/** Mood names other callers use (recipe styles) → our moods. */
const MOOD_ALIASES: Record<string, Mood> = { energetic: 'upbeat', driving: 'epic', calm: 'chill', happy: 'upbeat', cinematic: 'epic', tense: 'dramatic', relaxed: 'lofi', business: 'corporate' };
const MoodArg = z.enum([...MOODS, ...Object.keys(MOOD_ALIASES)] as [string, ...string[]]);
const SfxArg = z.enum(SFX_TYPES);

function mainComp(ctx: CommandContext): Comp {
  const id = ctx.project.project?.main ?? (ctx.project.comps.find((c) => c.id === 'main') ?? ctx.project.comps[0]!).id;
  return ctx.comp(id);
}

function compFor(ctx: CommandContext, p: { comp?: string; track?: string }): Comp {
  if (p.comp) return ctx.comp(p.comp);
  if (p.track && (ctx.project.tracks ?? []).some((t) => t.id === p.track)) return ctx.compOfTrack(p.track);
  return mainComp(ctx);
}

function needWriter(ctx: CommandContext, op: string) {
  if (!ctx.services.writeFile) fail('E_NO_SERVICE', `${op} writes a generated WAV, and no file service is available here.`, 'run it through the CLI (mgl edit) or the SDK (open(file)), which can write into the project folder.');
}

interface Cached<M> { meta: M; generated: boolean }

/** Write `rel` (and its .json metadata) unless both already exist; returns the metadata. */
async function ensureFile<M>(ctx: CommandContext, rel: string, render: () => { bytes: Uint8Array; meta: M }): Promise<Cached<M>> {
  const s = ctx.services;
  if (s.fileExists && s.readText && (await s.fileExists(rel)) && (await s.fileExists(`${rel}.json`))) {
    try { return { meta: JSON.parse(await s.readText(`${rel}.json`)) as M, generated: false }; } catch { /* regenerate */ }
  }
  const { bytes, meta } = render();
  await s.writeFile!(rel, bytes);
  await s.writeFile!(`${rel}.json`, new TextEncoder().encode(JSON.stringify(meta, null, 1) + '\n'));
  return { meta, generated: true };
}

function ensureAsset(ctx: CommandContext, src: string, base: string, note: string): Asset {
  const assets = (ctx.project.assets ??= []);
  let a = assets.find((x) => x.src === src);
  if (!a) { a = { id: ctx.newId(base), src, note }; assets.push(a); }
  return a;
}

const overlaps = (c: Clip, at: number, end: number) => c.at < end && at < clipEnd(c);

/** An audio track of `comp` on `bus` that is free over [at, end); created (id `<stem>`, `<stem>2`, ...) when none is. */
function busTrack(ctx: CommandContext, comp: Comp, bus: string, at: number, end: number, stem: string, want?: string, ignore?: Set<string>): string {
  const tracks = (ctx.project.tracks ??= []);
  const clips = (ctx.project.clips ?? []).filter((c) => !ignore?.has(c.id));
  if (want) {
    const t = tracks.find((x) => x.id === want);
    if (t) {
      if (!t.audio) fail('E_TRACK_KIND', `track "${want}" is a visual track.`, `use an audio track, or a new id (it is created on the ${bus} bus).`);
      const hit = clips.find((c) => c.track === want && overlaps(c, at, end));
      if (hit) fail('E_OVERLAP', `the sound would overlap "${hit.id}" (${hit.at}–${clipEnd(hit)}) on track ${want}.`, 'omit track= to pick a free one, or choose another time.');
      return want;
    }
    tracks.push({ id: want, comp: comp.id, audio: true, bus });
    ctx.note(`created track ${want} on the ${bus} bus.`);
    return want;
  }
  const free = tracks.find((t) => t.comp === comp.id && t.audio && t.bus === bus && !clips.some((c) => c.track === t.id && overlaps(c, at, end)));
  if (free) return free.id;
  const id = ctx.newId(stem);
  const nt: Track = { id, comp: comp.id, audio: true, bus };
  tracks.push(nt);
  ctx.note(`created track ${id} on the ${bus} bus.`);
  return id;
}

function compLength(ctx: CommandContext, comp: Comp): number | undefined {
  if (typeof comp.length === 'number') return comp.length;
  if (typeof comp.length === 'string' && comp.length !== 'auto') return ctx.time(comp.length, comp, 'length');
  const tracks = new Set((ctx.project.tracks ?? []).filter((t) => t.comp === comp.id).map((t) => t.id));
  const end = (ctx.project.clips ?? []).filter((c) => tracks.has(c.track)).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  return end || undefined;
}

function TABLE_IDS(ctx: CommandContext): Set<string> {
  const s = new Set<string>();
  for (const t of TABLES) for (const e of (ctx.project[t] as { id: string }[] | undefined) ?? []) s.add(e.id);
  return s;
}

const secs = (x: number) => `${x.toFixed(x < 10 ? 2 : 1)}s`;

// ------------------------------------------------------------------------------------------- audio.music

defineCommand({
  op: 'audio.music', group: 'audio',
  doc: 'Generate a music bed (offline, deterministic): mood upbeat|chill|dramatic|corporate|lofi|epic, optional bpm, key ("Am", "F# minor"), seed, intensity curve [[time, 0..1], ...] (times from the music start; layers enter as it rises) or energy 0..1, markers=beats|bars (exact grid markers); written to media/generated/ (reused when the parameters repeat), added as a looping clip on a music-bus track at -18 LUFS (re-running with the same id replaces it). marker.beats finds its beats.',
  schema: z.strictObject({
    len: TimeArg.optional(), mood: MoodArg.optional(), bpm: z.number().min(60).max(200).optional(), key: z.string().min(1).optional(),
    seed: z.number().int().min(0).optional(), intensity: z.array(z.tuple([TimeArg, z.number().min(0).max(1)])).min(1).optional(), energy: z.number().min(0).max(1).optional(),
    track: Id.optional(), at: TimeArg.optional(), gain: z.number().min(-60).max(12).optional(), id: Id.optional(), comp: Id.optional(),
    markers: z.enum(['beats', 'bars']).optional(),
  }),
  primary: 'mood', example: { mood: 'upbeat', len: '30s', seed: 1 },
  async apply(ctx, p) {
    needWriter(ctx, 'audio.music');
    const comp = compFor(ctx, p);
    const rate = ctx.rate(comp);
    const mood = (MOOD_ALIASES[p.mood ?? ''] ?? p.mood ?? 'upbeat') as Mood;
    if (p.key !== undefined && !parseKey(p.key)) fail('E_ARG', `audio.music: key "${p.key}" is not a key.`, 'use a note with an optional "m"/"minor", e.g. key=Am, key="F# minor", key=Bb.');
    if (p.intensity && p.energy !== undefined) fail('E_ARG', 'audio.music takes intensity= or energy=, not both.', 'energy=0.6 is a flat intensity curve; intensity=[["0s",0.4],["8s",1]] shapes it over time.');
    const prev = p.id !== undefined ? (ctx.project.clips ?? []).find((c) => c.id === p.id) : undefined;
    if (prev) {
      const a = (ctx.project.assets ?? []).find((x) => x.id === prev.asset);
      if (!a || !a.src.startsWith(`${GENERATED_DIR}/music-`)) fail('E_DUPLICATE_ID', `clip "${p.id}" already exists and is not a generated music bed.`, 'choose another id, or omit it.');
    }
    const at = p.at !== undefined ? ctx.time(p.at, comp, 'at') : prev?.at ?? 0;
    let len = p.len !== undefined ? ctx.time(p.len, comp, 'len') : prev?.len;
    if (len === undefined) { const cl = compLength(ctx, comp); len = cl !== undefined && cl > at ? cl - at : ctx.time('30s', comp); }
    if (len < 1) fail('E_RANGE', `len ${len} is too short.`, 'give a positive length, e.g. len="30s".');
    const lenSec = framesToSeconds(len, rate);
    let intensity: [number, number][] | undefined = p.intensity?.map(([t, v]) => [Math.round(framesToSeconds(ctx.time(t, comp, 'intensity time'), rate) * 1000) / 1000, v]);
    if (p.energy !== undefined) intensity = [[0, p.energy], [Math.round(lenSec * 1000) / 1000, p.energy]];
    const params: MusicParams = { len: lenSec, mood, seed: p.seed ?? 0, ...(p.bpm !== undefined ? { bpm: p.bpm } : {}), ...(p.key !== undefined ? { key: p.key } : {}), ...(intensity ? { intensity } : {}) };
    const rel = musicPath(params);
    const { meta, generated } = await ensureFile(ctx, rel, () => renderMusic(params));
    const asset = ensureAsset(ctx, rel, `music-${mood}`, `generated music: ${mood}, ${meta.bpm} BPM, ${meta.key}, ${meta.chords.join(' ')}`);
    const end = at + len;
    const ignore = prev ? new Set([prev.id]) : undefined;
    const track = prev && p.track === undefined ? busTrack(ctx, comp, 'music', at, end, 'MUS', prev.track, ignore) : busTrack(ctx, comp, 'music', at, end, 'MUS', p.track, ignore);
    const fadeOut = Math.min(Math.round((rate.num / rate.den) * 1.5), Math.floor(len / 4));
    const clip: Clip = { id: prev?.id ?? p.id ?? ctx.newId('bed'), track, at, len, asset: asset.id, loop: true, ...(fadeOut > 0 ? { fade: [0, fadeOut] as [number, number] } : {}) };
    // a dialogue under the music: sit the bed lower and duck it, unless the mix already says how
    const dialogue = new Set((ctx.project.tracks ?? []).filter((t) => t.comp === comp.id && t.audio && t.bus === 'dialogue').map((t) => t.id));
    const hasVoice = (ctx.project.clips ?? []).some((c) => dialogue.has(c.track) && overlaps(c, at, end));
    if (p.gain !== undefined) { if (p.gain !== 0) clip.gain = p.gain; }
    else if (hasVoice) clip.gain = -6;
    const clips = (ctx.project.clips ??= []);
    if (prev) clips.splice(clips.indexOf(prev), 1, clip); else clips.push(clip);
    let ducked = '';
    if (hasVoice && !(ctx.project.buses ?? []).find((b) => b.id === 'music')?.duck) {
      busEntry(ctx, 'music').duck = { by: 'dialogue', db: 9 };
      ducked = '; music ducks 9 dB under dialogue';
    }
    // exact beat/bar markers from the known grid (no analysis needed); re-running replaces them
    let marked = '';
    if (p.markers) {
      const prefix = p.markers === 'bars' ? 'bar' : 'beat';
      const step = p.markers === 'bars' ? meta.bar : meta.beat;
      const own = new RegExp(`^${prefix}\\d+$`);
      ctx.project.markers = (ctx.project.markers ?? []).filter((m) => !(m.comp === comp.id && own.test(m.id)));
      const fps = rate.num / rate.den;
      let n = 0;
      for (let k = 0; ; k++) {
        const f = at + Math.round(k * step * fps);
        if (f >= end) break;
        const id = `${prefix}${++n}`;
        if (TABLE_IDS(ctx).has(id)) fail('E_DUPLICATE_ID', `id "${id}" is already used by another entity.`, `rename it, or omit markers= and use marker.beats ${clip.id} prefix=<other>.`);
        (ctx.project.markers ??= []).push({ id, comp: comp.id, at: f });
      }
      marked = `Added ${n} ${prefix} markers ${prefix}1…${prefix}${n}.`;
    }
    ctx.out.id = clip.id; ctx.out.asset = asset.id; ctx.out.src = rel; ctx.out.bpm = meta.bpm; ctx.out.key = meta.key; ctx.out.chords = meta.chords; ctx.out.generated = generated;
    ctx.summary(`${prev ? 'replaced' : 'added'} music "${clip.id}" on ${track} at ${at}–${end}: ${mood}, ${meta.bpm} BPM, ${meta.key} (${meta.chords.join('–')}), ${meta.bars} bars of ${secs(meta.bar)}, loops; ${meta.lufs} LUFS, peak ${meta.truePeak} dBTP${clip.gain ? `, gain ${clip.gain} dB` : ''}${ducked}. ${generated ? 'Generated' : 'Reused'} ${rel}. Sounds like: ${meta.describe}. ${marked || `Beat markers: markers=beats (exact grid) or marker.beats ${clip.id}.`}`);
  },
});

// ------------------------------------------------------------------------------------------- audio.sfx

interface SfxMeta { duration: number; peakAt: number; lufs: number; truePeak: number; describe: string }

async function placeSfx(ctx: CommandContext, comp: Comp, type: SfxType, hitFrame: number, o: { seed: number; gain?: number; track?: string; id?: string; tags?: string[]; link?: string }) {
  const rate = ctx.rate(comp);
  const fps = rate.num / rate.den;
  const rel = sfxPath(type, o.seed);
  const { meta } = await ensureFile<SfxMeta>(ctx, rel, () => renderSfx(type, o.seed));
  const asset = ensureAsset(ctx, rel, `snd-${type}`, `generated sfx: ${type} — ${sfxDescribe(type)}`);
  const total = Math.max(1, Math.floor(meta.duration * fps));
  // the sound's peak lands on the hit frame; a start before 0 skips the head of the file
  let at = hitFrame - Math.round(meta.peakAt * fps), inF = 0;
  if (at < 0) { inF = -at; at = 0; }
  const len = Math.max(1, total - inF);
  const track = busTrack(ctx, comp, 'sfx', at, at + len, 'SFX', o.track);
  if (o.id !== undefined && (ctx.project.clips ?? []).some((c) => c.id === o.id)) fail('E_DUPLICATE_ID', `clip "${o.id}" already exists.`, 'choose another id or omit it.');
  const clip: Clip = { id: o.id ?? ctx.newId(`sfx-${type}`), track, at, len, asset: asset.id, ...(inF ? { in: inF } : {}), ...(o.gain ? { gain: o.gain } : {}), ...(o.link ? { link: o.link } : {}), ...(o.tags ? { tags: o.tags } : {}) };
  (ctx.project.clips ??= []).push(clip);
  return { clip, meta, rel };
}

defineCommand({
  op: 'audio.sfx', group: 'audio',
  doc: `Add a generated sound effect (offline, deterministic, seedable) on an sfx-bus track: type ${SFX_TYPES.join('|')}; at = the moment of the hit (a whoosh peaks there, a riser ends there); overlapping sounds go on extra sfx tracks; gain in dB.`,
  schema: z.strictObject({ type: SfxArg, at: TimeArg, gain: z.number().min(-60).max(12).optional(), seed: z.number().int().min(0).optional(), track: Id.optional(), id: Id.optional(), comp: Id.optional() }),
  primary: 'type', example: { type: 'whoosh', at: '2s' },
  async apply(ctx, p) {
    needWriter(ctx, 'audio.sfx');
    const comp = compFor(ctx, p);
    const hit = ctx.time(p.at, comp, 'at');
    const { clip, meta, rel } = await placeSfx(ctx, comp, p.type, hit, { seed: p.seed ?? 0, ...(p.gain !== undefined ? { gain: p.gain } : {}), ...(p.track ? { track: p.track } : {}), ...(p.id ? { id: p.id } : {}) });
    ctx.out.id = clip.id; ctx.out.src = rel;
    ctx.summary(`added ${p.type} "${clip.id}" on ${clip.track} at ${clip.at}–${clipEnd(clip)} (peak at frame ${hit}); ${sfxDescribe(p.type)}; ${meta.lufs} LUFS, peak ${meta.truePeak} dBTP${clip.gain ? `, gain ${clip.gain} dB` : ''}.`);
  },
});

// ------------------------------------------------------------------------------------------- audio.auto-sfx

const CATEGORIES = ['transitions', 'cuts', 'templates', 'text'] as const;
type Category = (typeof CATEGORIES)[number];
const DEFAULT_MAP: Record<Category, SfxType> = { transitions: 'whoosh', cuts: 'hit', templates: 'swoosh', text: 'pop' };
/** Default gain per category (dB): hits on every cut stay subtle. */
const DEFAULT_GAIN: Record<Category, number> = { transitions: 0, cuts: -5, templates: -1, text: -2 };
const PRIORITY: Record<Category, number> = { transitions: 0, cuts: 1, templates: 2, text: 3 };
const AUTO_TAG = 'auto-sfx';

const isPicture = (c: Clip) => c.asset !== undefined || c.gen !== undefined || c.color !== undefined || c.comp !== undefined;

defineCommand({
  op: 'audio.auto-sfx', group: 'audio',
  doc: 'Place fitting generated SFX on a comp: whoosh on transitions, hit on hard cuts, swoosh on template entrances, pop on text entrances (on= picks the kinds; map={"text":"click","cuts":"none"} changes or disables them). Each is linked to its source clip so it moves with it; re-running replaces the previous auto SFX.',
  schema: z.strictObject({
    on: z.array(z.enum(CATEGORIES)).min(1).optional(), map: z.partialRecord(z.enum(CATEGORIES), z.union([SfxArg, z.literal('none')])).optional(),
    gain: z.number().min(-60).max(12).optional(), seed: z.number().int().min(0).optional(), comp: Id.optional(), min: TimeArg.optional(),
  }),
  example: { on: ['transitions', 'text'], map: { text: 'pop' } },
  async apply(ctx, p) {
    needWriter(ctx, 'audio.auto-sfx');
    const comp = p.comp ? ctx.comp(p.comp) : mainComp(ctx);
    const rate = ctx.rate(comp);
    const fps = rate.num / rate.den;
    const on = new Set<Category>(p.on ?? CATEGORIES);
    const map = { ...DEFAULT_MAP, ...(p.map ?? {}) } as Record<Category, SfxType | 'none'>;
    const tracks = (ctx.project.tracks ?? []).filter((t) => t.comp === comp.id);
    const trackIds = new Set(tracks.map((t) => t.id));
    // re-running replaces: drop the previous auto SFX of this comp (and their now unused generated assets)
    const old = (ctx.project.clips ?? []).filter((c) => trackIds.has(c.track) && c.tags?.includes(AUTO_TAG));
    if (old.length) {
      const gone = new Set(old.map((c) => c.id));
      ctx.project.clips = (ctx.project.clips ?? []).filter((c) => !gone.has(c.id));
      const usedAssets = new Set((ctx.project.clips ?? []).map((c) => c.asset));
      ctx.project.assets = (ctx.project.assets ?? []).filter((a) => usedAssets.has(a.id) || !a.src.startsWith(`${GENERATED_DIR}/sfx-`));
      // empty sfx tracks we created earlier go too
      const busy = new Set((ctx.project.clips ?? []).map((c) => c.track));
      ctx.project.tracks = (ctx.project.tracks ?? []).filter((t) => !(t.comp === comp.id && t.audio && t.bus === 'sfx' && /^SFX\d*$/.test(t.id) && !busy.has(t.id)));
    }
    const total = compLength(ctx, comp) ?? 0;
    const visualTracks = tracks.filter((t) => !t.audio && !t.hidden);
    const vis = new Set(visualTracks.map((t) => t.id));
    const clips = (ctx.project.clips ?? []).filter((c) => vis.has(c.track) && !c.hidden);
    const persistent = (c: Clip) => total > 0 && c.len >= total * 0.9;
    type Ev = { cat: Category; frame: number; src: Clip };
    const evs: Ev[] = [];
    if (on.has('transitions')) for (const c of clips) {
      const tin = c.transition?.in, tout = c.transition?.out;
      if (tin) { const l = typeof tin.len === 'number' ? tin.len : ctx.time(tin.len, comp, 'transition len'); evs.push({ cat: 'transitions', frame: c.at + (tin.align === 'start' ? l / 2 : tin.align === 'end' ? -l / 2 : 0), src: c }); }
      if (tout) { const l = typeof tout.len === 'number' ? tout.len : ctx.time(tout.len, comp, 'transition len'); evs.push({ cat: 'transitions', frame: clipEnd(c) + (tout.align === 'start' ? l / 2 : tout.align === 'end' ? -l / 2 : 0), src: c }); }
    }
    if (on.has('cuts')) for (const t of visualTracks) {
      const seq = clips.filter((c) => c.track === t.id && isPicture(c) && !c.tags?.some((g) => g.startsWith('template:'))).sort((a, b) => a.at - b.at);
      for (let i = 1; i < seq.length; i++) {
        const a = seq[i - 1]!, b = seq[i]!;
        if (Math.abs(clipEnd(a) - b.at) > 1 || a.transition?.out || b.transition?.in) continue;
        evs.push({ cat: 'cuts', frame: b.at, src: b });
      }
    }
    if (on.has('templates')) {
      // one entrance per template instance: clips of the same template starting within 1 s of its first clip
      const byTag = new Map<string, Clip[]>();
      for (const c of clips) {
        const tag = c.tags?.find((g) => g.startsWith('template:'));
        if (!tag || tag === 'template:progress-bar' || persistent(c)) continue;
        byTag.set(tag, [...(byTag.get(tag) ?? []), c]);
      }
      for (const cs of byTag.values()) {
        let start = -Infinity;
        for (const c of cs.sort((a, b) => a.at - b.at)) if (c.at - start > fps) { start = c.at; evs.push({ cat: 'templates', frame: c.at, src: c }); }
      }
    }
    if (on.has('text')) for (const c of clips) {
      if (c.text === undefined || c.tags?.some((g) => g.startsWith('template:')) || persistent(c)) continue;
      evs.push({ cat: 'text', frame: c.at, src: c });
    }
    // one sound per moment: closer than `min` (default 0.25 s) keeps the higher-priority kind
    const minGap = p.min !== undefined ? ctx.time(p.min, comp, 'min') : Math.round(fps * 0.25);
    evs.sort((a, b) => a.frame - b.frame || PRIORITY[a.cat] - PRIORITY[b.cat]);
    const kept: Ev[] = [];
    for (const e of evs) {
      if (map[e.cat] === 'none') continue;
      const near = kept.find((k) => Math.abs(k.frame - e.frame) < minGap);
      if (!near) kept.push(e);
      else if (PRIORITY[e.cat] < PRIORITY[near.cat]) kept.splice(kept.indexOf(near), 1, e);
    }
    const placed: { id: string; type: SfxType; cat: Category; src: string; frame: number }[] = [];
    const base = p.seed ?? 0;
    const count: Partial<Record<Category, number>> = {};
    for (const e of kept) {
      const type = map[e.cat] as SfxType;
      const n = (count[e.cat] = (count[e.cat] ?? 0) + 1);
      const src = (ctx.project.clips ?? []).find((c) => c.id === e.src.id)!;
      const link = src.link ?? `sfx-${src.id}`;
      src.link = link;
      const gain = p.gain ?? DEFAULT_GAIN[e.cat];
      // three seeded variants per kind, so repeats differ without a file per event
      const { clip } = await placeSfx(ctx, comp, type, Math.max(0, Math.round(e.frame)), { seed: base * 3 + ((n - 1) % 3), ...(gain ? { gain } : {}), link, tags: [AUTO_TAG, `sfx-for:${src.id}`] });
      placed.push({ id: clip.id, type, cat: e.cat, src: src.id, frame: Math.round(e.frame) });
    }
    ctx.out.ids = placed.map((x) => x.id);
    ctx.out.placed = placed;
    const by = (CATEGORIES as readonly Category[]).map((c) => { const xs = placed.filter((x) => x.cat === c); return xs.length ? `${xs.length} ${xs[0]!.type} (${c})` : ''; }).filter(Boolean);
    const sfxTracks = [...new Set(placed.map((x) => (ctx.project.clips ?? []).find((c) => c.id === x.id)!.track))];
    ctx.summary(placed.length
      ? `placed ${placed.length} SFX${old.length ? ` (replacing ${old.length})` : ''}: ${by.join(', ')} on ${sfxTracks.join(', ')}; each is linked to its source clip and moves with it. Times (frames): ${placed.slice(0, 12).map((x) => `${x.type}@${x.frame}`).join(', ')}${placed.length > 12 ? ', ...' : ''}.`
      : `no ${[...on].join('/')} found to put SFX on${old.length ? ` (removed ${old.length} previous auto SFX)` : ''}.`);
  },
});
