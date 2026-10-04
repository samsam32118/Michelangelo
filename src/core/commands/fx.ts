/** Effect and transition commands: fx.add, fx.set, fx.remove, fx.move, transition.set. */
import { z } from 'zod';
import { fail } from '../errors.js';
import { defineCommand, TimeArg, type CommandContext } from './registry.js';
import { Id, type Clip, type EffectInstance, type TransitionInstance } from '../schema/index.js';
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

defineCommand({
  op: 'fx.add', group: 'effects', doc: 'Add an effect to a clip (at= its position in the stack, default last) with its parameters inline.',
  schema: z.looseObject({ id: Id, type: z.string().min(1), at: z.number().int().min(0).optional() }),
  primary: 'id', example: { id: 'shot1', type: 'blur', radius: 8 },
  apply(ctx, p) {
    const { id, type, at, ...params } = p as { id: string; type: string; at?: number } & Record<string, unknown>;
    const c = ctx.clip(id);
    checkType(ctx, 'effects', type);
    for (const [k, v] of Object.entries(params)) if (v === null) delete params[k];
    checkEffectParams(ctx, type, params);
    const fx = (c.fx ??= []);
    const idx = Math.min(at ?? fx.length, fx.length);
    fx.splice(idx, 0, { type, ...params } as EffectInstance);
    ctx.out.index = idx;
    ctx.summary(`clip "${c.id}": added effect ${type} at fx.${idx}.`);
  },
});

defineCommand({
  op: 'fx.set', group: 'effects', doc: 'Change parameters of a clip\'s effect, chosen by index or type (fx=0 or fx=blur); null removes a parameter (back to its default).',
  schema: z.looseObject({ id: Id, fx: FxSel }),
  primary: 'id', example: { id: 'shot1', fx: 'blur', radius: 12 },
  apply(ctx, p) {
    const { id, fx: sel, ...params } = p as { id: string; fx: string | number } & Record<string, unknown>;
    const c = ctx.clip(id);
    const f = c.fx?.[fxIndex(c, sel)] as EffectInstance;
    if (!Object.keys(params).length) fail('E_ARG', 'fx.set needs at least one parameter.', `example: mgl edit <file> fx.set ${id} fx=${String(sel)} <param>=<value>`);
    if ('type' in params) fail('E_ARG', 'fx.set cannot change the effect type.', `remove it (fx.remove ${id} fx=${String(sel)}) and add the new one with fx.add.`);
    checkEffectParams(ctx, f.type, params);
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && isKeyframes(f[k]) && !isKeyframes(v)) fail('E_KEYFRAMED', `effect "${f.type}" ${k} is animated by keyframes; a constant would discard them.`, `clear them first: mgl edit <file> key.clear ${id} prop=fx.${String(sel)}.${k} value=${JSON.stringify(v)}`);
      if (v === null) delete f[k]; else f[k] = v;
    }
    ctx.summary(`clip "${c.id}": effect ${f.type} set ${Object.keys(params).join(', ')}.`);
  },
});

defineCommand({
  op: 'fx.remove', group: 'effects', doc: 'Remove an effect from a clip, by index or type.',
  schema: z.strictObject({ id: Id, fx: FxSel }),
  primary: 'id', example: { id: 'shot1', fx: 'blur' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const [f] = c.fx!.splice(fxIndex(c, p.fx), 1);
    if (!c.fx!.length) delete c.fx;
    ctx.summary(`clip "${c.id}": removed effect ${f!.type}.`);
  },
});

defineCommand({
  op: 'fx.move', group: 'effects', doc: 'Move an effect to another position in the clip\'s effect stack (0 = applied first).',
  schema: z.strictObject({ id: Id, fx: FxSel, to: z.number().int().min(0) }),
  primary: 'id', example: { id: 'shot1', fx: 'blur', to: 0 },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const fx = c.fx!;
    const i = fxIndex(c, p.fx);
    if (p.to >= fx.length) fail('E_RANGE', `position ${p.to} is past the end of the effect stack (${fx.length} effects).`, `use to=0..${fx.length - 1}.`);
    const [f] = fx.splice(i, 1);
    fx.splice(p.to, 0, f!);
    ctx.summary(`clip "${c.id}": moved effect ${f!.type} from ${i} to ${p.to}.`);
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
