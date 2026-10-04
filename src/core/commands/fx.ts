/** Effect and transition commands: fx.add, fx.set, fx.remove, fx.move (on a clip, or bus= for a bus mix), transition.set. */
import { z } from 'zod';
import { fail } from '../errors.js';
import { defineCommand, TimeArg, type CommandContext } from './registry.js';
import { Id, clipKind, type Clip, type EffectInstance, type TransitionInstance } from '../schema/index.js';
import { kindFromExtension } from './structure.js';
import { busEntry } from './audio.js';
import { isKeyframes } from '../load.js';
import { checkParam, checkType, fxIndex, paramShape } from './keys.js';

const FxSel = z.union([z.number().int().min(0), z.string().min(1)]);

/** Validate effect params (unknown names → error with the allowed list). */
function checkEffectParams(ctx: CommandContext, type: string, params: Record<string, unknown>) {
  const shape = paramShape(ctx, 'effects', type);
  for (const [k, v] of Object.entries(params)) {
    if (k === 'enabled') { if (v !== null && typeof v !== 'boolean') fail('E_PARAMS', `effect "${type}": "enabled" is true or false.`, 'e.g. enabled=false'); continue; }
    checkParam(shape, `effect "${type}"`, k, v ?? undefined);
  }
}

/**
 * Effects live on a clip (id=) or on a bus (bus=: audio effects on the bus mix). The target's `fx` array is the
 * same shape in both places; a built-in bus without an entry gets one.
 */
interface FxTarget { id: string; fx?: EffectInstance[]; label: string; bus: boolean; clip?: Clip }

function target(ctx: CommandContext, op: string, p: { id?: string; bus?: string }, create = false): FxTarget {
  if ((p.id === undefined) === (p.bus === undefined)) fail('E_ARG', `${op} needs id=<clip> or bus=<bus> (one of them).`, `example: mgl edit <file> ${op} shot1 ... (a clip), or ${op} bus=music ... (a bus)`);
  if (p.bus !== undefined) {
    const b = create ? busEntry(ctx, p.bus) : (ctx.project.buses ?? []).find((x) => x.id === p.bus);
    if (!b) fail('E_NO_FX', `bus "${p.bus}" has no effects.`, `add one with: mgl edit <file> fx.add bus=${p.bus} type=<audio effect>`);
    return { id: b.id, get fx() { return b.fx; }, set fx(v) { if (v === undefined || !v.length) delete b.fx; else b.fx = v; }, label: `bus "${b.id}"`, bus: true };
  }
  const c = ctx.clip(p.id!);
  return { id: c.id, get fx() { return c.fx; }, set fx(v) { if (v === undefined || !v.length) delete c.fx; else c.fx = v; }, label: `clip "${c.id}"`, bus: false, clip: c };
}

/** Whether a clip plays sound: an audio asset, or a video asset (unless the probe says it has no audio stream). */
async function clipSound(ctx: CommandContext, c: Clip): Promise<{ sound: boolean; why: string; audioClip: boolean }> {
  const onAudioTrack = !!(ctx.project.tracks ?? []).find((t) => t.id === c.track)?.audio;
  if (c.asset === undefined) return { sound: false, why: `it is a ${clipKind(c)} clip (no media)`, audioClip: false };
  const a = (ctx.project.assets ?? []).find((x) => x.id === c.asset);
  const kind = a ? a.kind ?? kindFromExtension(a.src) : undefined;
  if (kind === 'audio' || onAudioTrack) return { sound: true, why: '', audioClip: true };
  if (kind !== 'video') return { sound: false, why: `its asset "${c.asset}" is ${kind === 'image' ? 'an image' : kind ? `a ${kind} file` : 'not audio or video'}`, audioClip: false };
  if (a && ctx.services.probe && !a.src.startsWith('lavfi:')) {
    try { if ((await ctx.services.probe(a.src)).hasAudio === false) return { sound: false, why: `"${a.src}" has no audio stream`, audioClip: false }; } catch { /* unknown: allow */ }
  }
  return { sound: true, why: '', audioClip: false };
}

/** Refuse an effect whose stages cannot act on the target (when the catalog says which stages it has). */
async function checkStages(ctx: CommandContext, type: string, t: FxTarget) {
  const st = ctx.services.catalog?.effects.get(type)?.stages;
  if (!st) return;
  const visual = !!(st.draw || st.source), audio = !!st.audio;
  if (t.bus) {
    if (!audio) fail('E_ARG', `effect "${type}" has no audio stage, so it can't process bus "${t.id}".`, `a bus takes audio effects (mgl docs effects lists them); put "${type}" on a visual clip: fx.add <clip> type=${type}`);
    return;
  }
  const c = t.clip!;
  const s = await clipSound(ctx, c);
  if (audio && !visual && !s.sound) {
    const bus = (ctx.project.tracks ?? []).find((x) => x.id === c.track)?.bus;
    fail('E_ARG', `effect "${type}" only processes sound, and clip "${c.id}" has none (${s.why}).`,
      `add it to a clip with sound (an audio clip, or a video with an audio track), or to a bus: mgl edit <file> fx.add bus=${bus ?? 'dialogue'} type=${type}`);
  }
  if (visual && !audio && s.audioClip) {
    fail('E_ARG', `effect "${type}" only changes pictures, and clip "${c.id}" is an audio clip.`, `put it on a visual clip (fx.add <clip> type=${type}); for sound use an audio effect (mgl docs effects).`);
  }
}

const TargetFields = { id: Id.optional(), bus: Id.optional() };

defineCommand({
  op: 'fx.add', group: 'effects', doc: 'Add an effect to a clip (id=), or an audio effect to a bus mix (bus=), at= its position in the stack (default last), with its parameters inline. Audio-only effects need a clip with sound; picture-only effects need a visual clip.',
  schema: z.looseObject({ ...TargetFields, type: z.string().min(1), at: z.number().int().min(0).optional() }),
  primary: 'id', example: { id: 'shot1', type: 'blur', radius: 8 },
  async apply(ctx, p) {
    const { id, bus, type, at, ...params } = p as { id?: string; bus?: string; type: string; at?: number } & Record<string, unknown>;
    if ((id === undefined) === (bus === undefined)) target(ctx, 'fx.add', { id, bus });
    checkType(ctx, 'effects', type);
    for (const [k, v] of Object.entries(params)) if (v === null) delete params[k];
    checkEffectParams(ctx, type, params);
    await checkStages(ctx, type, bus === undefined ? target(ctx, 'fx.add', { id }) : { id: bus, label: `bus "${bus}"`, bus: true });
    const t = target(ctx, 'fx.add', { id, bus }, true);
    const fx = [...(t.fx ?? [])];
    const idx = Math.min(at ?? fx.length, fx.length);
    fx.splice(idx, 0, { type, ...params } as EffectInstance);
    t.fx = fx;
    ctx.out.index = idx;
    ctx.summary(`${t.label}: added effect ${type} at fx.${idx}.`);
  },
});

defineCommand({
  op: 'fx.set', group: 'effects', doc: 'Change parameters of a clip\'s (id=) or bus\'s (bus=) effect, chosen by index or type (fx=0 or fx=blur); null removes a parameter (back to its default).',
  schema: z.looseObject({ ...TargetFields, fx: FxSel }),
  primary: 'id', example: { id: 'shot1', fx: 'blur', radius: 12 },
  apply(ctx, p) {
    const { id, bus, fx: sel, ...params } = p as { id?: string; bus?: string; fx: string | number } & Record<string, unknown>;
    const t = target(ctx, 'fx.set', { id, bus });
    const f = t.fx?.[fxIndex(t, sel)] as EffectInstance;
    const who = bus !== undefined ? `bus=${bus}` : id;
    if (!Object.keys(params).length) fail('E_ARG', 'fx.set needs at least one parameter.', `example: mgl edit <file> fx.set ${who} fx=${String(sel)} <param>=<value>`);
    if ('type' in params) fail('E_ARG', 'fx.set cannot change the effect type.', `remove it (fx.remove ${who} fx=${String(sel)}) and add the new one with fx.add.`);
    checkEffectParams(ctx, f.type, params);
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && isKeyframes(f[k]) && !isKeyframes(v)) fail('E_KEYFRAMED', `effect "${f.type}" ${k} is animated by keyframes; a constant would discard them.`, `clear them first: mgl edit <file> key.clear ${id} prop=fx.${String(sel)}.${k} value=${JSON.stringify(v)}`);
      if (v === null) delete f[k]; else f[k] = v;
    }
    ctx.summary(`${t.label}: effect ${f.type} set ${Object.keys(params).join(', ')}.`);
  },
});

defineCommand({
  op: 'fx.remove', group: 'effects', doc: 'Remove an effect from a clip (id=) or a bus (bus=), by index or type.',
  schema: z.strictObject({ ...TargetFields, fx: FxSel }),
  primary: 'id', example: { id: 'shot1', fx: 'blur' },
  apply(ctx, p) {
    const t = target(ctx, 'fx.remove', p);
    const fx = [...(t.fx ?? [])];
    const [f] = fx.splice(fxIndex(t, p.fx), 1);
    t.fx = fx;
    ctx.summary(`${t.label}: removed effect ${f!.type}.`);
  },
});

defineCommand({
  op: 'fx.move', group: 'effects', doc: 'Move an effect to another position in a clip\'s (id=) or bus\'s (bus=) effect stack (0 = applied first).',
  schema: z.strictObject({ ...TargetFields, fx: FxSel, to: z.number().int().min(0) }),
  primary: 'id', example: { id: 'shot1', fx: 'blur', to: 0 },
  apply(ctx, p) {
    const t = target(ctx, 'fx.move', p);
    const fx = [...(t.fx ?? [])];
    const i = fxIndex(t, p.fx);
    if (p.to >= fx.length) fail('E_RANGE', `position ${p.to} is past the end of the effect stack (${fx.length} effects).`, `use to=0..${fx.length - 1}.`);
    const [f] = fx.splice(i, 1);
    fx.splice(p.to, 0, f!);
    t.fx = fx;
    ctx.summary(`${t.label}: moved effect ${f!.type} from ${i} to ${p.to}.`);
  },
});

function neighbour(ctx: CommandContext, c: Clip, side: 'in' | 'out'): Clip | undefined {
  return (ctx.project.clips ?? []).find((x) => x.track === c.track && x.id !== c.id && (side === 'in' ? x.at + x.len === c.at : x.at === c.at + c.len));
}

defineCommand({
  op: 'transition.set', group: 'effects', doc: 'Set the in (from the previous clip, centred on the cut) or out transition of a clip; type=none removes it.',
  schema: z.looseObject({ id: Id, side: z.enum(['in', 'out']).optional(), type: z.string().min(1), len: TimeArg.optional(), align: z.enum(['center', 'start', 'end']).optional() }),
  primary: 'id', example: { id: 'shot2', type: 'crossfade', len: '0.5s' },
  apply(ctx, p) {
    const { id, side = 'in', type, len, align, ...params } = p as { id: string; side?: 'in' | 'out'; type: string; len?: string | number; align?: 'center' | 'start' | 'end' } & Record<string, unknown>;
    const c = ctx.clip(id);
    if (type === 'none') {
      if (!c.transition?.[side]) { ctx.summary(`clip "${c.id}" has no ${side} transition.`); return; }
      delete c.transition[side];
      if (!c.transition.in && !c.transition.out) delete c.transition;
      ctx.summary(`clip "${c.id}": removed the ${side} transition.`);
      return;
    }
    checkType(ctx, 'transitions', type);
    const shape = paramShape(ctx, 'transitions', type);
    const prev = c.transition?.[side];
    const t: TransitionInstance = prev && prev.type === type ? { ...prev } : { type, len: 0 };
    for (const [k, v] of Object.entries(params)) {
      checkParam(shape, `transition "${type}"`, k, v ?? undefined);
      if (v === null) delete t[k]; else t[k] = v;
    }
    if (len !== undefined) t.len = ctx.time(len, ctx.compOfClip(c), 'len');
    else if (prev) t.len = prev.len;
    else fail('E_ARG', 'transition.set needs len= for a new transition.', `example: mgl edit <file> transition.set ${id} type=${type} len=0.5s`);
    if (t.len < 1) fail('E_RANGE', `transition length ${t.len} is not positive.`, 'give len ≥ 1 frame, e.g. len=0.5s.');
    if (t.len > c.len) fail('E_RANGE', `transition length ${t.len} is longer than clip "${c.id}" (${c.len} frames).`, `use len ≤ ${c.len}.`);
    if (align !== undefined) { if (align === 'center') delete t.align; else t.align = align; }
    (c.transition ??= {})[side] = t;
    const nb = neighbour(ctx, c, side);
    if (side === 'in' && !nb) ctx.note(`clip "${c.id}" has no clip ending right at its start on ${c.track}, so the in transition comes from nothing (transparent).`);
    if (side === 'in' && nb && c.asset !== undefined) {
      const need = t.align === 'start' ? 0 : t.align === 'end' ? t.len : Math.ceil(t.len / 2);
      if ((c.in ?? 0) < need) ctx.note(`clip "${c.id}" has ${c.in ?? 0} frames of media before its in-point but the transition needs ${need}; its first frame is held (slip it later with clip.slip ${c.id} by=${need - (c.in ?? 0)} to add a handle).`);
    }
    ctx.summary(`clip "${c.id}": ${side} transition ${type} (${t.len} frames${t.align ? `, ${t.align}` : ''}).`);
  },
});
