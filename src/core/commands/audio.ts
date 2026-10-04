/** Audio commands: bus.add, bus.set, audio.duck, audio.normalize, audio.fade, audio.gain, audio.cut-silences. */
import { z } from 'zod';
import { fail, suggest } from '../errors.js';
import { defineCommand, getCommand, TimeArg, type CommandContext } from './registry.js';
import { Easing, Id, TABLES, type Bus } from '../schema/index.js';
import { framesToSeconds, secondsToNearestFrame } from '../time.js';
import { isKeyframes } from '../load.js';
import { clipEnd, linked, speedOf } from './clip.js';
import { propRef, setKey } from './keys.js';

export const BUILTIN_BUSES = ['master', 'dialogue', 'music', 'sfx'];
const Duck = z.strictObject({ by: Id, db: z.number().positive(), attack: z.number().positive().optional(), release: z.number().positive().optional() });
const Loudness = z.strictObject({ lufs: z.number().max(0), peak: z.number().max(0).optional() });

function busIds(ctx: CommandContext): string[] {
  return [...new Set([...BUILTIN_BUSES, ...(ctx.project.buses ?? []).map((b) => b.id)])];
}

function checkBusRef(ctx: CommandContext, id: string, what: string) {
  const all = busIds(ctx);
  if (all.includes(id)) return;
  const d = suggest(id, all);
  fail('E_REF', `${what} "${id}" is not a bus.`, `${d.length ? `did you mean "${d[0]}"? ` : ''}buses: ${all.join(', ')} (add one with bus.add)`, { didYouMean: d });
}

/** Ids are unique across the project: a bus entry cannot share its id with a clip, track, ... */
function checkFreeId(ctx: CommandContext, id: string) {
  for (const t of TABLES) if (t !== 'buses' && ((ctx.project[t] as { id: string }[] | undefined) ?? []).some((e) => e.id === id))
    fail('E_DUPLICATE_ID', `id "${id}" is already used by a ${t.replace(/s$/, '')}, so bus "${id}" cannot get an entry.`, `rename that ${t.replace(/s$/, '')}: mgl edit <file> id.rename ${id} to=${id}-1`);
}

/** The bus entry, created for a built-in bus that has none yet. */
function busEntry(ctx: CommandContext, id: string): Bus {
  const buses = (ctx.project.buses ??= []);
  let b = buses.find((x) => x.id === id);
  if (!b) {
    checkBusRef(ctx, id, 'bus');
    checkFreeId(ctx, id);
    b = { id };
    buses.push(b);
  }
  return b;
}

function setDuck(ctx: CommandContext, b: Bus, duck: z.infer<typeof Duck>) {
  checkBusRef(ctx, duck.by, 'duck by');
  if (duck.by === b.id) fail('E_ARG', `bus "${b.id}" cannot duck under itself.`, 'duck by another bus, e.g. by=dialogue.');
  b.duck = duck;
}

defineCommand({
  op: 'bus.add', group: 'audio', doc: 'Add an audio bus (dialogue, music, sfx and master exist without an entry); it feeds master unless to= says otherwise.',
  schema: z.strictObject({ id: Id, to: Id.optional(), gain: z.number().optional(), duck: Duck.optional() }),
  primary: 'id', example: { id: 'vo2', to: 'dialogue', gain: -3 },
  apply(ctx, p) {
    if ((ctx.project.buses ?? []).some((b) => b.id === p.id)) fail('E_DUPLICATE_ID', `bus "${p.id}" already exists.`, `change it with: mgl edit <file> bus.set ${p.id} ...`);
    checkFreeId(ctx, p.id);
    const b: Bus = { id: p.id };
    if (p.to) { checkBusRef(ctx, p.to, 'to'); if (p.to === p.id) fail('E_ARG', 'a bus cannot feed itself.', 'use to=master or another bus.'); if (p.to !== 'master') b.to = p.to; }
    if (p.gain !== undefined) b.gain = p.gain;
    (ctx.project.buses ??= []).push(b);
    if (p.duck) setDuck(ctx, b, p.duck);
    ctx.summary(`added bus "${b.id}".`);
  },
});

defineCommand({
  op: 'bus.set', group: 'audio', doc: 'Change a bus: gain (dB), muted, to, duck, loudness (master: {lufs, peak}); null removes a setting.',
  schema: z.strictObject({ id: Id, gain: z.number().nullable().optional(), muted: z.boolean().optional(), to: Id.nullable().optional(), duck: Duck.nullable().optional(), loudness: Loudness.nullable().optional() }),
  primary: 'id', example: { id: 'music', gain: -8 },
  apply(ctx, p) {
    const b = busEntry(ctx, p.id);
    if (p.gain !== undefined) { if (p.gain === null) delete b.gain; else b.gain = p.gain; }
    if (p.muted !== undefined) { if (p.muted) b.muted = true; else delete b.muted; }
    if (p.to !== undefined) {
      if (p.to === null || p.to === 'master') delete b.to;
      else { checkBusRef(ctx, p.to, 'to'); if (p.to === b.id) fail('E_ARG', 'a bus cannot feed itself.', 'use to=master or another bus.'); b.to = p.to; }
    }
    if (p.duck !== undefined) { if (p.duck === null) delete b.duck; else setDuck(ctx, b, p.duck); }
    if (p.loudness !== undefined) { if (p.loudness === null) delete b.loudness; else b.loudness = p.loudness; }
    ctx.summary(`bus "${b.id}" updated.`);
  },
});

defineCommand({
  op: 'audio.duck', group: 'audio', doc: 'Duck one bus (default music) by db dB while another (default dialogue) has signal.',
  schema: z.strictObject({ bus: Id.optional(), by: Id.optional(), db: z.number().positive().optional(), attack: z.number().positive().optional(), release: z.number().positive().optional() }),
  example: { bus: 'music', by: 'dialogue', db: 9 },
  apply(ctx, p) {
    const b = busEntry(ctx, p.bus ?? 'music');
    const duck: z.infer<typeof Duck> = { by: p.by ?? 'dialogue', db: p.db ?? 9 };
    if (p.attack !== undefined) duck.attack = p.attack;
    if (p.release !== undefined) duck.release = p.release;
    setDuck(ctx, b, duck);
    ctx.summary(`bus "${b.id}" ducks ${duck.db} dB under "${duck.by}".`);
  },
});

defineCommand({
  op: 'audio.normalize', group: 'audio', doc: 'Set the loudness target of the mix (master bus), applied at render: lufs (default from the platform: -14 for shorts/tiktok/reels/youtube, else -16) and true-peak ceiling (default -1).',
  schema: z.strictObject({ lufs: z.number().max(0).optional(), peak: z.number().max(0).optional() }),
  example: { lufs: -14 },
  apply(ctx, p) {
    const platform = ctx.project.project?.platform;
    const lufs = p.lufs ?? (platform && platform !== 'none' ? -14 : -16);
    const b = busEntry(ctx, 'master');
    b.loudness = { lufs, peak: p.peak ?? -1 };
    ctx.summary(`mix loudness target ${lufs} LUFS, peak ${b.loudness.peak} dBTP${p.lufs === undefined ? ` (default for ${platform ?? 'no platform'})` : ''}.`);
  },
});

defineCommand({
  op: 'audio.fade', group: 'audio', doc: 'Fade a clip in and/or out (audio, and opacity for visuals); 0 removes a fade.',
  schema: z.strictObject({ id: Id, in: TimeArg.optional(), out: TimeArg.optional() }),
  primary: 'id', example: { id: 'bed', in: '1s', out: '2s' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    if (p.in === undefined && p.out === undefined) fail('E_ARG', 'audio.fade needs in= and/or out=.', `example: mgl edit <file> audio.fade ${p.id} in=1s out=2s`);
    const comp = ctx.compOfClip(c);
    const fi = p.in !== undefined ? ctx.time(p.in, comp, 'in') : c.fade?.[0] ?? 0;
    const fo = p.out !== undefined ? ctx.time(p.out, comp, 'out') : c.fade?.[1] ?? 0;
    if (fi < 0 || fo < 0) fail('E_RANGE', 'fade lengths cannot be negative.', 'use 0 to remove a fade.');
    if (fi + fo > c.len) fail('E_RANGE', `fades of ${fi} + ${fo} frames are longer than clip "${c.id}" (${c.len} frames).`, `keep in + out ≤ ${c.len}.`);
    if (fi || fo) c.fade = [fi, fo]; else delete c.fade;
    ctx.summary(`clip "${c.id}": fade in ${fi}, out ${fo} frames.`);
  },
});

defineCommand({
  op: 'audio.gain', group: 'audio', doc: 'Set a clip\'s gain in dB: a constant, or with at= a keyframe (clip-local time; abs=true: comp time).',
  schema: z.strictObject({ id: Id, db: z.number().min(-120).max(48), at: TimeArg.optional(), abs: z.boolean().optional(), ease: Easing.optional() }),
  primary: 'id', example: { id: 'bed', db: -6 },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    if (c.asset === undefined && c.comp === undefined) fail('E_NOT_AUDIO', `clip "${c.id}" has no audio.`, 'set gain on a media or nested comp clip.');
    if (p.at === undefined) {
      if (isKeyframes(c.gain)) fail('E_KEYFRAMED', `clip "${c.id}" gain is animated by keyframes; a constant would discard them.`, `clear them first: mgl edit <file> key.clear ${c.id} prop=gain value=${p.db} (or pass at= to set a keyframe).`);
      if (p.db === 0) delete c.gain; else c.gain = p.db;
      ctx.summary(`clip "${c.id}": gain ${p.db} dB.`);
      return;
    }
    const f = ctx.time(p.at, ctx.compOfClip(c), 'at') - (p.abs ? c.at : 0);
    setKey(propRef(ctx, c, 'gain'), f, p.db, p.ease);
    ctx.summary(`clip "${c.id}": gain key ${p.db} dB at frame ${f}.`);
  },
});

/** Remove comp range [a, b) from every clip of a link group and close the gap on their tracks. */
function cutRange(ctx: CommandContext, group: Set<string>, a: number, b: number) {
  const quiet = { ...ctx, out: {} as Record<string, unknown>, summary: () => {}, note: () => {} };
  const split = getCommand('clip.split');
  const tracks = new Set<string>();
  for (const id of [...group]) {
    const g = ctx.clip(id);
    tracks.add(g.track);
    if (clipEnd(g) <= a || g.at >= b) continue;
    let mid = g;
    if (a > g.at) {
      quiet.out = {};
      split.apply(quiet, { id: g.id, at: a, unlinked: true });
      mid = ctx.clip(quiet.out.id as string);
      group.add(mid.id);
    }
    if (b < clipEnd(mid)) {
      quiet.out = {};
      split.apply(quiet, { id: mid.id, at: b, unlinked: true });
      group.add(quiet.out.id as string);
    }
    ctx.project.clips = ctx.project.clips!.filter((x) => x.id !== mid.id);
    ctx.project.cues = (ctx.project.cues ?? []).filter((q) => q.clip !== mid.id);
    group.delete(mid.id);
  }
  for (const c of ctx.project.clips ?? []) if (tracks.has(c.track) && c.at >= b) c.at -= b - a;
}

defineCommand({
  op: 'audio.cut-silences', group: 'audio', doc: 'Find silences in a clip\'s audio (analysis) and ripple-remove them, keeping pad on each side; linked clips are cut together.',
  schema: z.strictObject({ id: Id, min: TimeArg.optional(), pad: TimeArg.optional(), db: z.number().max(0).optional() }),
  primary: 'id', example: { id: 'vo', min: '0.6s', pad: '0.15s', db: -40 },
  async apply(ctx, p) {
    const c = ctx.clip(p.id);
    const comp = ctx.compOfClip(c);
    const rate = ctx.rate(comp);
    const asset = c.asset !== undefined ? (ctx.project.assets ?? []).find((a) => a.id === c.asset) : undefined;
    if (!asset) fail('E_NOT_AUDIO', `clip "${c.id}" is not a media clip.`, 'cut silences of an audio or video clip (one with "asset").');
    if (c.remap !== undefined) fail('E_ARG', `clip "${c.id}" is time-remapped; silences cannot be mapped to the timeline.`, `remove the remap first: mgl edit <file> clip.set ${c.id} remap=null`);
    const sp = speedOf(c);
    if (sp.num === 0) fail('E_ARG', `clip "${c.id}" is a freeze frame (speed 0) and has no audio to cut.`, 'cut silences of a playing clip.');
    if (!ctx.services.analyzeAudio) fail('E_NO_SERVICE', 'audio analysis is not available here.', 'run through the CLI or the SDK (Project.open), which provide media services.');
    const min = ctx.time(p.min ?? '0.6s', comp, 'min'), pad = ctx.time(p.pad ?? '0.15s', comp, 'pad');
    const an = await ctx.services.analyzeAudio(asset.src, { silenceDb: p.db ?? -40, minSilence: framesToSeconds(min, rate) });
    // source frames → clip-local frames at the clip's speed
    const inF = c.in ?? 0;
    const local = (src: number) => Math.round(((src - inF) * sp.den) / sp.num);
    const ranges: [number, number][] = [];
    for (const s of an.silences) {
      const s0 = secondsToNearestFrame(s.start, rate), s1 = secondsToNearestFrame(s.end, rate);
      if (s1 - s0 < min) continue;
      const l0 = Math.max(0, local(s0 + pad)), l1 = Math.min(c.len, local(s1 - pad));
      if (l1 - l0 >= 1) ranges.push([c.at + l0, c.at + l1]);
    }
    ranges.sort((x, y) => x[0] - y[0]);
    const merged = ranges.reduce<[number, number][]>((m, r) => { const last = m[m.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else m.push([...r]); return m; }, []);
    const group = new Set(linked(ctx, c).map((g) => g.id));
    const nLinked = group.size - 1;
    for (const [a, b] of [...merged].reverse()) cutRange(ctx, group, a, b);
    const total = merged.reduce((n, [a, b]) => n + b - a, 0);
    ctx.out.removed = merged;
    ctx.out.seconds = Number(framesToSeconds(total, rate).toFixed(3));
    ctx.summary(merged.length
      ? `cut ${merged.length} silence(s) from "${c.id}"${nLinked ? ` and ${nLinked} linked clip(s)` : ''}: removed ${framesToSeconds(total, rate).toFixed(2)}s.`
      : `no silences of ${framesToSeconds(min, rate).toFixed(2)}s or more below ${p.db ?? -40} dB in "${c.id}".`);
  },
});
