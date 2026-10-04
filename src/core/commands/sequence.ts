/** Sequencing commands: marker.beats (beat markers from a clip's audio) and clip.sequence (clips back to back, optionally cut on beats). */
import { z } from 'zod';
import { fail } from '../errors.js';
import { defineCommand, TimeArg, type CommandContext } from './registry.js';
import { FITS, Id, type Asset, type Clip, type Comp } from '../schema/index.js';
import { kindFromExtension } from './structure.js';
import { clipEnd, defaultTrack, speedOf } from './clip.js';
import { checkType } from './keys.js';
import { secondsToNearestFrame } from '../time.js';

/** Comp frames of the beats inside the part of the source a clip plays (sorted, unique). */
async function beatFrames(ctx: CommandContext, c: Clip): Promise<{ frames: number[]; bpm?: number }> {
  if (c.asset === undefined) fail('E_ARG', `clip "${c.id}" is not a media clip; beats come from its audio.`, 'use an audio clip, or a video clip with sound.');
  const asset = (ctx.project.assets ?? []).find((a) => a.id === c.asset);
  if (!asset) fail('E_REF', `asset "${c.asset}" does not exist.`, 'add it with asset.add.');
  const kind = asset.kind ?? kindFromExtension(asset.src);
  if (kind !== 'audio' && kind !== 'video') fail('E_ARG', `clip "${c.id}" is ${kind ? `a ${kind}` : 'not a media'} clip; beats come from audio.`, 'use an audio clip, or a video clip with sound.');
  if (c.remap !== undefined) fail('E_ARG', `clip "${c.id}" is time-remapped; beats cannot be mapped to the timeline.`, `remove the remap first: mgl edit <file> clip.set ${c.id} remap=null`);
  const sp = speedOf(c);
  if (sp.num === 0) fail('E_ARG', `clip "${c.id}" is a freeze frame (speed 0) and plays no audio.`, 'use a playing clip.');
  if (kind === 'video' && ctx.services.probe) {
    const info = await ctx.services.probe(asset.src);
    if (info.hasAudio === false) fail('E_ARG', `clip "${c.id}" (${asset.src}) has no audio stream.`, 'use the music or voice clip instead.');
  }
  if (!ctx.services.analyzeAudio) fail('E_NO_SERVICE', 'audio analysis is not available here.', 'run through the CLI or the SDK (open(file)), which provide media services.');
  const an = await ctx.services.analyzeAudio(asset.src);
  const rate = ctx.rate(ctx.compOfClip(c));
  const inF = c.in ?? 0;
  const out = new Set<number>();
  for (const s of an.beats ?? []) {
    // source seconds → clip-local frames at the clip's speed (exact rational, rounded once)
    const local = Math.round((((s * rate.num) / rate.den - inF) * sp.den) / sp.num);
    if (local >= 0 && local < c.len) out.add(c.at + local);
  }
  return { frames: [...out].sort((a, b) => a - b), ...(an.bpm ? { bpm: an.bpm } : {}) };
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

defineCommand({
  op: 'marker.beats', group: 'marker',
  doc: 'Add a marker on every beat of a clip\'s audio (music, or a video with sound), inside the part of the source the clip plays: ids <prefix>1, <prefix>2, ... (re-running replaces them); every=n keeps every nth beat, max= caps the count, min= requires at least that many.',
  schema: z.strictObject({ clip: Id, prefix: Id.optional(), min: z.number().int().min(1).optional(), max: z.number().int().min(1).optional(), every: z.number().int().min(1).optional() }),
  primary: 'clip', example: { clip: 'bed', every: 2, max: 16 },
  async apply(ctx, p) {
    const c = ctx.clip(p.clip);
    const comp = ctx.compOfClip(c);
    const prefix = p.prefix ?? 'beat';
    const { frames: all, bpm } = await beatFrames(ctx, c);
    let frames = all.filter((_f, i) => i % (p.every ?? 1) === 0);
    if (p.max !== undefined) frames = frames.slice(0, p.max);
    if (!frames.length || (p.min !== undefined && frames.length < p.min)) {
      fail('E_NO_BEATS', `found ${frames.length} beat(s) in clip "${c.id}" (${c.at}–${clipEnd(c)})${p.min !== undefined ? `, fewer than min=${p.min}` : ''}.`,
        all.length ? 'lower every= or min=, or lengthen the clip.' : 'use a clip with a clear rhythm (music), or add markers by hand with marker.add.');
    }
    // re-running replaces this prefix's numbered markers in the comp
    const own = new RegExp(`^${prefix.replace(/[.]/g, '\\.')}\\d+$`);
    const before = (ctx.project.markers ?? []).length;
    ctx.project.markers = (ctx.project.markers ?? []).filter((m) => !(m.comp === comp.id && own.test(m.id)));
    const replaced = before - ctx.project.markers.length;
    if (replaced) ctx.note(`replaced ${replaced} earlier "${prefix}" marker(s).`);
    const ids: string[] = [];
    frames.forEach((at, i) => {
      const want = `${prefix}${i + 1}`;
      const id = ctx.newId(want);
      ctx.project.markers!.push({ id, comp: comp.id, at, note: `beat ${i + 1} of "${c.id}"` });
      ids.push(id);
    });
    ctx.out.ids = ids;
    ctx.out.frames = frames;
    if (bpm) ctx.out.bpm = bpm;
    ctx.summary(`added ${ids.length} beat marker(s) ${ids[0]}…${ids[ids.length - 1]} at ${frames.slice(0, 6).join(', ')}${frames.length > 6 ? ', ...' : ''}${bpm ? ` (~${Math.round(bpm)} bpm)` : ''}.`);
  },
});

defineCommand({
  op: 'clip.sequence', group: 'clip',
  doc: 'Place one clip per file (srcs) or asset (assets) back to back on a track from at= (default 0), each len= long (default 2s; full=true plays each file\'s whole source length, from the probe); on=markers cuts on the markers whose id starts with prefix= (default "beat"), on=beats cuts on the beats of clip=<id>: each item starts on a beat and lasts until the next (the last lasts the median beat interval). Optional fit= and transition={type, len} between items; refuses overlaps.',
  schema: z.strictObject({
    srcs: z.array(z.string().min(1)).min(1).optional(), assets: z.array(Id).min(1).optional(), track: Id.optional(), at: TimeArg.optional(), len: TimeArg.optional(),
    on: z.enum(['markers', 'beats']).optional(), prefix: Id.optional(), clip: Id.optional(), fit: z.enum(FITS).optional(),
    transition: z.strictObject({ type: z.string().min(1), len: TimeArg }).optional(),
    full: z.boolean().optional(),
  }),
  example: { srcs: ['media/a.mp4', 'media/b.mp4', 'media/c.mp4'], on: 'markers', prefix: 'beat', fit: 'cover' },
  async apply(ctx, p) {
    if (!p.srcs === !p.assets) fail('E_ARG', 'clip.sequence needs srcs=[paths] or assets=[ids] (one of them).', 'example: mgl edit <file> clip.sequence srcs=\'["a.mp4","b.mp4"]\' len=2s');
    // the items: existing assets, or assets added (or reused) for the paths
    const assets = (ctx.project.assets ??= []);
    const items: Asset[] = [];
    if (p.srcs) for (const src of p.srcs) {
      let a = assets.find((x) => x.src === src);
      if (!a) {
        a = { id: ctx.newId(src.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase()), src };
        assets.push(a);
        ctx.note(`added asset "${a.id}" for ${src}.`);
      }
      items.push(a);
    }
    else for (const id of p.assets!) {
      const a = assets.find((x) => x.id === id);
      if (!a) fail('E_REF', `asset "${id}" does not exist.`, 'add it with asset.add, or pass srcs=[paths] instead.');
      items.push(a);
    }
    const kinds = items.map((a) => a.kind ?? kindFromExtension(a.src));
    const audio = kinds.every((k) => k === 'audio');
    if (!audio && kinds.some((k) => k === 'audio')) fail('E_ARG', 'clip.sequence mixes audio and visual files.', 'sequence audio and visual files in two commands (they go on different tracks).');
    if (p.on === 'beats' && !p.clip) fail('E_ARG', 'on=beats needs clip=<id> (the music clip whose beats set the cuts).', 'example: mgl edit <file> clip.sequence srcs=\'["a.mp4","b.mp4"]\' on=beats clip=bed');
    if (p.clip && p.on !== 'beats') fail('E_ARG', 'clip= is used only with on=beats.', 'add on=beats, or remove clip=.');
    if (p.prefix && p.on !== 'markers') fail('E_ARG', 'prefix= is used only with on=markers.', 'add on=markers, or remove prefix=.');
    if (p.full && p.on) fail('E_ARG', 'full=true plays whole files back to back; it does not combine with on= (the cuts set the lengths).', 'remove full=true or on=.');
    if (p.full && p.len !== undefined) fail('E_ARG', 'full=true takes each file\'s own length; it does not combine with len=.', 'remove len= (images still get 2s each), or remove full=true.');
    if (p.full && !ctx.services.probe) fail('E_NO_SERVICE', 'full=true needs the media probe to read each file\'s length.', 'run through the CLI or the SDK (open(file)), which provide media services.');

    let trackId = p.track;
    if (!trackId) {
      const main = ctx.project.project?.main ?? (ctx.project.comps.find((c) => c.id === 'main') ?? ctx.project.comps[0]!).id;
      const compId = p.clip ? ctx.compOfClip(ctx.clip(p.clip)).id : main;
      trackId = audio ? defaultTrack(ctx, true, compId) : (ctx.project.tracks ?? []).find((t) => t.comp === compId && !t.audio)?.id ?? defaultTrack(ctx, false, compId);
    }
    const track = ctx.track(trackId);
    if (!!track.audio !== audio) fail('E_TRACK_KIND', `track "${track.id}" is ${track.audio ? 'an audio' : 'a visual'} track but the items are ${audio ? 'audio' : 'visual'}.`, `use a ${audio ? 'audio' : 'visual'} track, or omit track=.`);
    const comp: Comp = ctx.comp(track.comp);
    const at0 = p.at !== undefined ? ctx.time(p.at, comp, 'at') : undefined;
    const each = ctx.time(p.len ?? '2s', comp, 'len');
    if (each < 1) fail('E_RANGE', `len ${each} is not positive.`, 'give len ≥ 1 frame, e.g. len=2s.');

    // the slots [start, len) of the items
    const slots: [number, number][] = [];
    if (p.full) {
      let t = at0 ?? 0;
      for (const [i, a] of items.entries()) {
        let len = each;
        if (kinds[i] === 'video' || kinds[i] === 'audio') {
          const info = await ctx.services.probe!(a.src);
          if (info.duration) len = Math.max(1, secondsToNearestFrame(info.duration, ctx.rate(comp)));
          else ctx.note(`"${a.src}" has no known duration; it gets ${each} frames.`);
        } else ctx.note(`"${a.src}" is ${kinds[i] === 'image' ? 'an image' : 'not a timed file'}; it gets ${each} frames.`);
        slots.push([t, len]);
        t += len;
      }
    } else if (!p.on) {
      items.forEach((_a, i) => slots.push([(at0 ?? 0) + i * each, each]));
    } else {
      let cuts: number[];
      if (p.on === 'markers') {
        const prefix = p.prefix ?? 'beat';
        cuts = (ctx.project.markers ?? []).filter((m) => m.comp === comp.id && m.id.startsWith(prefix)).map((m) => m.at);
        if (!cuts.length) fail('E_NO_BEATS', `comp "${comp.id}" has no markers whose id starts with "${prefix}".`, `add them with: mgl edit <file> marker.beats <music clip>${prefix !== 'beat' ? ` prefix=${prefix}` : ''}, or use on=beats clip=<music clip>.`);
      } else {
        const music = ctx.clip(p.clip!);
        if (ctx.compOfClip(music).id !== comp.id) fail('E_ARG', `clip "${music.id}" is in comp "${ctx.compOfClip(music).id}", not "${comp.id}" where the sequence goes.`, 'use a track of the music clip\'s comp.');
        cuts = (await beatFrames(ctx, music)).frames;
        if (!cuts.length) fail('E_NO_BEATS', `found no beats in clip "${music.id}".`, 'use a clip with a clear rhythm (music), or cut on markers (on=markers).');
      }
      cuts = [...new Set(cuts)].sort((a, b) => a - b);
      const intervals = cuts.slice(1).map((c, i) => c - cuts[i]!);
      const med = median(intervals) ?? each;
      if (at0 !== undefined) cuts = cuts.filter((c) => c >= at0);
      if (!cuts.length) fail('E_NO_BEATS', `no ${p.on === 'markers' ? 'markers' : 'beats'} at or after at=${at0}.`, 'choose an earlier at=, or omit it.');
      for (let i = 0; i < items.length; i++) {
        const start = i < cuts.length ? cuts[i]! : slots[i - 1]![0] + slots[i - 1]![1];
        const end = i + 1 < cuts.length ? cuts[i + 1]! : start + med;
        slots.push([start, end - start]);
      }
      if (items.length > cuts.length) ctx.note(`${items.length - cuts.length} item(s) after the last ${p.on === 'markers' ? 'marker' : 'beat'} last the median interval (${med} frames).`);
    }

    // refuse overlaps with what is already on the track
    const first = slots[0]![0], last = slots[slots.length - 1]![0] + slots[slots.length - 1]![1];
    const hit = (ctx.project.clips ?? []).filter((c) => c.track === track.id).sort((a, b) => a.at - b.at).find((c) => slots.some(([s, l]) => c.at < s + l && s < clipEnd(c)));
    if (hit) {
      const free = (ctx.project.clips ?? []).filter((c) => c.track === track.id).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
      fail('E_OVERLAP', `the sequence (${first}–${last}) would overlap "${hit.id}" (${hit.at}–${clipEnd(hit)}) on track ${track.id}.`,
        p.on ? 'put it on another track (track=...), or move/remove the clips in the way first.' : `use at=${free} (after the last clip), another track (track=...), or remove "${hit.id}" first.`);
    }
    if (p.transition) checkType(ctx, 'transitions', p.transition.type);
    const tlen = p.transition ? ctx.time(p.transition.len, comp, 'transition.len') : 0;

    const ids: string[] = [];
    for (const [i, a] of items.entries()) {
      const [at, len] = slots[i]!;
      const c: Clip = { id: ctx.newId(a.id), track: track.id, at, len, asset: a.id };
      if (p.fit && !audio) c.fit = p.fit;
      if (p.transition && i > 0) {
        if (tlen < 1 || tlen > len) fail('E_RANGE', `transition length ${tlen} does not fit item ${i + 1} ("${c.id}", ${len} frames).`, `use transition.len between 1 and ${len}.`);
        c.transition = { in: { type: p.transition.type, len: tlen } };
      }
      if (ctx.services.probe && (kinds[i] === 'video' || kinds[i] === 'audio')) {
        const info = await ctx.services.probe(a.src);
        if (info.duration !== undefined && secondsToNearestFrame(info.duration, ctx.rate(comp)) < len) ctx.note(`"${a.src}" is shorter than its ${len}-frame slot; its last frame holds.`);
      }
      (ctx.project.clips ??= []).push(c);
      ids.push(c.id);
    }
    if (p.transition && !audio && ids.length > 1) {
      // every item starts at in=0, so a centred transition has no in-handle on the incoming clip;
      // with full=true each item also ends at its source end, so the outgoing clip has no out-handle either
      const headIn = Math.ceil(tlen / 2), tailOut = tlen - headIn;
      const timed = (i: number) => kinds[i] === 'video';
      const incoming = ids.filter((_id, i) => i > 0 && timed(i));
      const outgoing = p.full ? ids.filter((_id, i) => i < ids.length - 1 && timed(i)) : [];
      if (incoming.length && headIn > 0) {
        ctx.note(`each transition is centred on the cut, but the clips start at the first frame of their media (in=0), so the first frame of ${incoming.map((x) => `"${x}"`).join(', ')} is held for ${headIn} frame(s) while the transition plays (add a handle with clip.slip <id> by=${headIn}, or transition.set <id> type=${p.transition.type} align=start).`);
      }
      if (outgoing.length && tailOut > 0) {
        ctx.note(`with full=true each clip runs to the end of its media, so the last frame of ${outgoing.map((x) => `"${x}"`).join(', ')} is held for ${tailOut} frame(s) under the transition (the outgoing clip has no media after its source end; shorten it with clip.trim <id> len=<frames> ripple=true to leave a handle; align=start would move the whole transition after the cut and hold all ${tlen} frames there instead).`);
      }
    }
    ctx.out.ids = ids;
    ctx.out.id = ids[0];
    ctx.summary(`sequenced ${ids.length} clip(s) on ${track.id} from ${first} to ${last}${p.on ? ` on ${p.on}` : ''}: ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', ...' : ''}.`);
  },
});
