/** Keyframe commands: key.set, key.remove, key.clear, key.shift. Also the property / effect-parameter helpers fx and audio commands share. */
import { z } from 'zod';
import { fail, suggest } from '../errors.js';
import { defineCommand, TimeArg, type CommandContext } from './registry.js';
import { Easing, Id, type Clip, type Easing as EasingT } from '../schema/index.js';
import { isKeyframes } from '../load.js';
import { interpolate } from '../../render/keyframes.js';

export type Key = [number, unknown] | [number, unknown, EasingT];
type Shape = Record<string, z.ZodType>;

export const KEY_PROPS = ['x', 'y', 'scale', 'rotate', 'opacity', 'gain', 'remap', 'shape.trim'] as const;
export const KeyValue = z.union([z.number(), z.tuple([z.number(), z.number()]), z.string(), z.boolean()]);

/** The parameter shape of an effect / transition type from the catalog (undefined when unknown). */
export function paramShape(ctx: CommandContext, kind: 'effects' | 'transitions', type: string): Shape | undefined {
  const params = ctx.services.catalog?.[kind].get(type)?.params as { shape?: Shape } | undefined;
  return params?.shape;
}

/** Validate a type against the catalog (when there is one), with did-you-mean. */
export function checkType(ctx: CommandContext, kind: 'effects' | 'transitions', type: string) {
  const m = ctx.services.catalog?.[kind];
  if (!m || m.has(type)) return;
  const what = kind === 'effects' ? 'effect' : 'transition';
  const d = suggest(type, m.keys());
  fail(kind === 'effects' ? 'E_UNKNOWN_EFFECT' : 'E_UNKNOWN_TRANSITION', `"${type}" is not a known ${what}.`,
    d.length ? `did you mean "${d[0]}"? (all: mgl docs ${kind})` : `use one of: ${[...m.keys()].join(', ')}`, { didYouMean: d });
}

/** Validate one parameter value (a constant or a keyframe list) against an effect / transition schema. */
export function checkParam(shape: Shape | undefined, what: string, key: string, value: unknown) {
  if (!shape) return;
  const s = shape[key];
  if (!s) {
    const d = suggest(key, Object.keys(shape));
    fail('E_PARAMS', `${what}: "${key}" is not a parameter.`, `${d.length ? `did you mean "${d[0]}"? ` : ''}parameters: ${Object.keys(shape).join(', ') || '(none)'}`, { didYouMean: d });
  }
  if (value === undefined) return;
  for (const v of isKeyframes(value) ? value.map((k) => k[1]) : [value]) {
    const r = s.safeParse(v);
    if (!r.success) fail('E_PARAMS', `${what}: "${key}" ${r.error.issues[0]!.message}.`, `give a valid value for "${key}" (see: mgl docs ${what.split(' ')[0]})`);
  }
}

/** Index of an effect on a clip, by index or by type (the first of that type). */
export function fxIndex(c: Clip, sel: string | number): number {
  const fx = c.fx ?? [];
  const i = typeof sel === 'number' || /^\d+$/.test(sel) ? Number(sel) : fx.findIndex((f) => f.type === sel);
  if (i < 0 || i >= fx.length) fail('E_NO_FX', `clip "${c.id}" has no effect ${JSON.stringify(sel)}.`, `effects: ${fx.map((f, j) => `${j}:${f.type}`).join(', ') || '(none; add one with fx.add)'}`);
  return i;
}

interface PropRef { label: string; get(): unknown; set(v: unknown): void; def(): unknown; check(v: unknown): void }

const num = (label: string) => (v: unknown) => { if (typeof v !== 'number' || !Number.isFinite(v)) fail('E_VALUE', `${label} takes a number, not ${JSON.stringify(v)}.`, `e.g. value=1`); };

/** A keyframeable property of a clip: x, y, scale, rotate, opacity, gain, remap, shape.trim or fx.<index|type>.<param>. */
export function propRef(ctx: CommandContext, c: Clip, prop: string): PropRef {
  const rec = c as Record<string, unknown>;
  const label = `clip "${c.id}" ${prop}`;
  if (prop.startsWith('fx.')) {
    const [, sel, param, ...rest] = prop.split('.');
    if (!sel || !param || rest.length) fail('E_PROP', `"${prop}" is not an effect parameter path.`, 'write fx.<index or type>.<param>, e.g. fx.blur.radius or fx.0.radius');
    const fx = c.fx![fxIndex(c, sel)]!;
    if (['type', 'id', 'enabled'].includes(param)) fail('E_PROP', `"${param}" is not animatable.`, 'animate a numeric effect parameter, e.g. fx.blur.radius');
    const shape = paramShape(ctx, 'effects', fx.type);
    checkParam(shape, `effect "${fx.type}"`, param, undefined);
    return {
      label, get: () => fx[param], set: (v) => { if (v === undefined) delete fx[param]; else fx[param] = v; },
      def: () => { const r = shape?.[param]?.safeParse(undefined); return r?.success ? r.data : undefined; },
      check: (v) => checkParam(shape, `effect "${fx.type}"`, param, v),
    };
  }
  if (prop === 'shape.trim') {
    if (!c.shape) fail('E_PROP', `clip "${c.id}" is not a shape clip; shape.trim needs one.`, 'use a clip with "shape", or animate opacity/scale instead.');
    const sh = c.shape as Record<string, unknown>;
    return {
      label, get: () => sh.trim, set: (v) => { if (v === undefined) delete sh.trim; else sh.trim = v; }, def: () => 1,
      check: (v) => { num(label)(v); if ((v as number) < 0 || (v as number) > 1) fail('E_VALUE', `${label} ${String(v)} is outside 0..1.`, 'use a fraction of the outline between 0 and 1.'); },
    };
  }
  if (!(KEY_PROPS as readonly string[]).includes(prop)) {
    const d = suggest(prop, KEY_PROPS);
    fail('E_PROP', `"${prop}" is not a keyframeable property.`, `${d.length ? `did you mean "${d[0]}"? ` : ''}properties: ${KEY_PROPS.join(', ')}, fx.<index|type>.<param>`, { didYouMean: d });
  }
  const comp = ctx.compOfClip(c);
  const defaults: Record<string, () => unknown> = { x: () => comp.size[0] / 2, y: () => comp.size[1] / 2, scale: () => 1, rotate: () => 0, opacity: () => 1, gain: () => 0, remap: () => c.in ?? 0 };
  return {
    label, get: () => rec[prop], set: (v) => { if (v === undefined) delete rec[prop]; else rec[prop] = v; }, def: defaults[prop]!,
    check: prop === 'scale'
      ? (v) => { if (!(typeof v === 'number' || (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number')))) fail('E_VALUE', `${label} takes a number or [sx, sy].`, 'e.g. value=1.2 or value=[1.2,1]'); }
      : num(label),
  };
}

/** Set (or replace) the key at a clip-local frame; a constant becomes a keyframe list that keeps the old value at frame 0. */
export function setKey(ref: PropRef, frame: number, value: unknown, ease?: EasingT) {
  ref.check(value);
  const cur = ref.get();
  let keys: Key[];
  if (isKeyframes(cur)) keys = (cur as Key[]).map((k) => [...k] as Key);
  else {
    const old = cur ?? ref.def();
    keys = frame !== 0 && old !== undefined ? [[0, old]] : [];
  }
  const i = keys.findIndex((k) => k[0] === frame);
  const e = ease ?? (i >= 0 ? keys[i]![2] : undefined);
  const key: Key = e !== undefined ? [frame, value, e] : [frame, value];
  if (i >= 0) keys[i] = key; else keys.push(key);
  keys.sort((a, b) => a[0] - b[0]);
  ref.set(keys);
}

/** Clip-local frame from an `at` argument (clip-local, or comp time with abs). */
function localFrame(ctx: CommandContext, c: Clip, at: string | number, abs?: boolean): number {
  const f = ctx.time(at, ctx.compOfClip(c), 'at') - (abs ? c.at : 0);
  if (f < 0 || f >= c.len) ctx.note(`frame ${f} is outside clip "${c.id}" (clip-local 0..${c.len - 1}); keyframe frames count from the clip start${abs ? '' : ' (pass abs=true for comp time)'}.`);
  return f;
}

function keysOf(ref: PropRef): Key[] {
  const v = ref.get();
  if (!isKeyframes(v)) fail('E_NOT_KEYFRAMED', `${ref.label} has no keyframes.`, `add one with: mgl edit <file> key.set <id> prop=<prop> at=<frame> value=<v>`);
  return v as Key[];
}

defineCommand({
  op: 'key.set', group: 'keyframes', doc: 'Set a keyframe of a clip property (x, y, scale, rotate, opacity, gain, remap, shape.trim, fx.<index|type>.<param>) at a clip-local time (abs=true: comp time); a constant becomes keyframes.',
  schema: z.strictObject({ id: Id, prop: z.string().min(1), at: TimeArg, value: KeyValue, ease: Easing.optional(), abs: z.boolean().optional() }),
  primary: 'id', example: { id: 'title', prop: 'y', at: '0.5s', value: 420, ease: 'outCubic' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const ref = propRef(ctx, c, p.prop);
    const f = localFrame(ctx, c, p.at, p.abs);
    setKey(ref, f, p.value, p.ease);
    ctx.summary(`${ref.label}: key at frame ${f} = ${JSON.stringify(p.value)} (${(ref.get() as Key[]).length} keys).`);
  },
});

defineCommand({
  op: 'key.remove', group: 'keyframes', doc: 'Remove the keyframe at a clip-local time (abs=true: comp time); one remaining key becomes a constant.',
  schema: z.strictObject({ id: Id, prop: z.string().min(1), at: TimeArg, abs: z.boolean().optional() }),
  primary: 'id', example: { id: 'title', prop: 'y', at: 15 },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const ref = propRef(ctx, c, p.prop);
    const keys = keysOf(ref);
    const f = ctx.time(p.at, ctx.compOfClip(c), 'at') - (p.abs ? c.at : 0);
    const rest = keys.filter((k) => k[0] !== f);
    if (rest.length === keys.length) fail('E_NO_KEY', `${ref.label} has no keyframe at frame ${f}.`, `keyframes are at frames ${keys.map((k) => k[0]).join(', ')} (clip-local).`);
    ref.set(rest.length === 0 ? undefined : rest.length === 1 ? rest[0]![1] : rest);
    ctx.summary(`${ref.label}: removed the key at frame ${f}${rest.length === 1 ? '; now a constant' : ''}.`);
  },
});

defineCommand({
  op: 'key.clear', group: 'keyframes', doc: 'Remove all keyframes of a property and set a constant: value=, or the value at frame 0.',
  schema: z.strictObject({ id: Id, prop: z.string().min(1), value: KeyValue.optional() }),
  primary: 'id', example: { id: 'title', prop: 'y', value: 420 },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const ref = propRef(ctx, c, p.prop);
    const cur = ref.get();
    const v = p.value ?? (isKeyframes(cur) ? interpolate(cur as never, 0) : cur);
    if (v !== undefined) ref.check(v);
    ref.set(v);
    ctx.summary(`${ref.label} = ${v === undefined ? 'default' : JSON.stringify(v)} (no keyframes).`);
  },
});

defineCommand({
  op: 'key.shift', group: 'keyframes', doc: 'Shift the keyframes of one property (prop=) or of every property of a clip by a time (negative = earlier).',
  schema: z.strictObject({ id: Id, prop: z.string().min(1).optional(), by: TimeArg }),
  primary: 'id', example: { id: 'title', by: '0.5s' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    const by = ctx.time(p.by, ctx.compOfClip(c), 'by');
    const props = p.prop ? [p.prop] : [...KEY_PROPS.filter((k) => k !== 'shape.trim' || c.shape), ...(c.fx ?? []).flatMap((fx, i) => Object.keys(fx).filter((k) => isKeyframes(fx[k])).map((k) => `fx.${i}.${k}`))];
    const shifted: string[] = [];
    for (const prop of props) {
      const ref = propRef(ctx, c, prop);
      const v = ref.get();
      if (!isKeyframes(v)) { if (p.prop) keysOf(ref); continue; }
      ref.set((v as Key[]).map((k) => [k[0] + by, ...k.slice(1)] as Key));
      shifted.push(prop);
    }
    if (!shifted.length) fail('E_NOT_KEYFRAMED', `clip "${c.id}" has no keyframes.`, 'add some with key.set first.');
    ctx.summary(`clip "${c.id}": shifted keys of ${shifted.join(', ')} by ${by} frames.`);
  },
});
