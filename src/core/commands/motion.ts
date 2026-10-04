/**
 * Motion commands: motion.apply expands motion presets (in / out / emphasis / loop, from the plugin registry) into
 * plain keyframes on x, y, scale, rotate and opacity, merged with the clip's existing keys; motion.clear removes them.
 *
 * Preset values are relative to the layer's rest state (x/y add px, scale and opacity multiply, rotate adds
 * degrees). Each application is recorded as a clip tag `motion:<phase>=<preset>@<from>-<to>:<props>` (clip-local
 * frames), so re-applying a phase replaces it and motion.clear knows which keys to remove.
 */
import { z } from 'zod';
import { fail, suggest } from '../errors.js';
import { defineCommand, TimeArg, type CommandContext } from './registry.js';
import { EasingName, Id, type Clip } from '../schema/index.js';
import { isKeyframes } from '../load.js';
import { interpolate } from '../../render/keyframes.js';
import { defaultY } from '../../render/evaluate.js';
import { layerBox } from './clip.js';
import { motionPresets as BUILTIN_MOTION } from '../../builtin/motion/presets.js';
import type { MotionPresetDef } from '../../plugin/api.js';

type Prop = 'x' | 'y' | 'scale' | 'rotate' | 'opacity';
type Phase = MotionPresetDef['phase'];
type Val = number | [number, number];
type Key = [number, Val] | [number, Val, string];
const PROPS: readonly Prop[] = ['x', 'y', 'scale', 'rotate', 'opacity'];
const PHASES: readonly Phase[] = ['in', 'out', 'emphasis', 'loop'];
const TAG_RE = /^motion:(in|out|emphasis|loop)=([^@]+)@(\d+)-(\d+):([a-z,]+)$/;

/** Motion presets known here: the built-ins plus any a plugin catalog lists (plugins win on the same id). */
export function motionPresetMap(ctx: CommandContext): Map<string, MotionPresetDef> {
  const m = new Map<string, MotionPresetDef>(BUILTIN_MOTION.map((p) => [p.id, p]));
  const extra = ctx.services.catalog?.motionPresets;
  for (const [k, v] of extra ?? []) m.set(k, v);
  return m;
}

/** A preset by name for a phase: the exact id, or `<name>-in` / `<name>-out` (so in=pop finds "pop-in"). */
export function resolvePreset(m: Map<string, MotionPresetDef>, name: string, phase: Phase): MotionPresetDef {
  const exact = m.get(name);
  if (exact && exact.phase === phase) return exact;
  const suffixed = phase === 'in' || phase === 'out' ? m.get(`${name}-${phase}`) : undefined;
  if (suffixed && suffixed.phase === phase) return suffixed;
  const ofPhase = [...m.values()].filter((p) => p.phase === phase).map((p) => p.id);
  const short = ofPhase.map((id) => (phase === 'in' || phase === 'out') && id.endsWith(`-${phase}`) ? id.slice(0, -phase.length - 1) : id);
  if (exact) fail('E_UNKNOWN_MOTION', `motion preset "${name}" is ${exact.phase === 'emphasis' ? 'an' : exact.phase === 'in' ? 'an' : 'a'} ${exact.phase} preset, not ${phase === 'in' || phase === 'emphasis' ? 'an' : 'a'} ${phase} preset.`,
    `use ${exact.phase}=${name}${phase === 'in' || phase === 'out' ? `, or for ${phase}= one of: ${short.join(', ')}` : ''}`);
  const d = suggest(name, [...short, ...ofPhase]);
  fail('E_UNKNOWN_MOTION', `"${name}" is not a ${phase} motion preset.`, `${d.length ? `did you mean "${d[0]}"? ` : ''}${phase} presets: ${short.join(', ')} (mgl docs motion.apply)`, { didYouMean: d });
}

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const DIGITS: Record<Prop, number> = { x: 2, y: 2, scale: 4, rotate: 2, opacity: 4 };

/** Absolute value of a prop from its rest value and a preset's relative value. */
function compose(prop: Prop, rest: Val, rel: number): Val {
  const d = DIGITS[prop];
  if (prop === 'scale') return Array.isArray(rest) ? [r(rest[0] * rel, d), r(rest[1] * rel, d)] : r(rest * rel, d);
  const b = rest as number;
  if (prop === 'opacity') return r(Math.min(1, Math.max(0, b * rel)), d);
  return r(b + rel, d);
}

const sameVal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Plan { phase: Phase; preset: MotionPresetDef; from: number; to: number; keys: Partial<Record<Prop, [number, number, string?][]>> }
interface Tag { tag: string; phase: Phase; preset: string; from: number; to: number; props: Prop[] }

function motionTags(c: Clip): Tag[] {
  return (c.tags ?? []).flatMap((t) => {
    const m = TAG_RE.exec(t);
    return m ? [{ tag: t, phase: m[1] as Phase, preset: m[2]!, from: Number(m[3]), to: Number(m[4]), props: m[5]!.split(',').filter((p): p is Prop => (PROPS as readonly string[]).includes(p)) }] : [];
  });
}

/** Validate and normalise a preset's output: integer, strictly increasing frames within 0..len, known easings. */
function checkKeys(p: MotionPresetDef, out: ReturnType<MotionPresetDef['keys']>, len: number): Plan['keys'] {
  const bad = (why: string): never => fail('E_MOTION_PRESET', `motion preset "${p.id}" returned invalid keys: ${why}.`, 'fix the preset (keys(len) must return [frame, value, easing?] lists with integer frames rising from 0 to len), or use another preset.');
  const res: Plan['keys'] = {};
  for (const [prop, ks] of Object.entries(out ?? {})) {
    if (!(PROPS as readonly string[]).includes(prop)) bad(`"${prop}" is not one of ${PROPS.join(', ')}`);
    if (!Array.isArray(ks) || !ks.length) bad(`"${prop}" has no keys`);
    let prev = -1;
    for (const k of ks!) {
      const [f, v, e] = k;
      if (!Number.isInteger(f) || f <= prev || f < 0 || f > len) bad(`${prop} frame ${String(f)} (frames must be integers rising within 0..${len})`);
      if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${prop} value ${JSON.stringify(v)}`);
      if (e !== undefined && !EasingName.safeParse(e).success) bad(`${prop} easing ${JSON.stringify(e)}`);
      prev = f;
    }
    res[prop as Prop] = ks!;
  }
  if (!Object.keys(res).length) bad('no properties');
  return res;
}

/** The value a property rests at: its constant, the comp default, or (keyframed) its value at a frame. */
function restOf(c: Clip, prop: Prop, frame: number, W: number, H: number): Val {
  const v = (c as Record<string, unknown>)[prop];
  if (v === undefined) return prop === 'x' ? W / 2 : prop === 'y' ? defaultY(c, W, H) : prop === 'rotate' ? 0 : 1;
  if (isKeyframes(v)) return interpolate(v as never, frame) as Val;
  return v as Val;
}

/**
 * Merge new absolute keys (frames a..b) into a property. Refused (with a fix) when an existing key lies strictly inside
 * a..b, when an existing key at a or b holds another value, or when existing keys animate across a..b; keys that only
 * touch at a or b with the same value are shared (so a loop fits between an in and an out on the same property).
 */
function mergeKeys(c: Clip, prop: Prop, add: Key[], plan: Plan, tags: Tag[]) {
  const rec = c as Record<string, unknown>;
  const cur = rec[prop];
  if (!isKeyframes(cur)) { rec[prop] = add; return; }
  const ex = (cur as Key[]).map((k) => [...k] as Key);
  const a = add[0]![0], b = add[add.length - 1]![0];
  const atA = ex.find((k) => k[0] === a), atB = ex.find((k) => k[0] === b);
  const prev = [...ex].reverse().find((k) => k[0] <= a), next = ex.find((k) => k[0] >= b);
  const overlap = ex.some((k) => k[0] > a && k[0] < b)
    || (atA !== undefined && !sameVal(atA[1], add[0]![1]))
    || (atB !== undefined && !sameVal(atB[1], add[add.length - 1]![1]))
    // existing keys on both sides: their segment must hold still across a..b
    || (prev !== undefined && next !== undefined && prev !== next && !sameVal(prev[1], next[1]) && prev[2] !== 'hold');
  if (overlap) {
    const e0 = ex[0]![0], e1 = ex[ex.length - 1]![0];
    const owner = tags.find((t) => t.props.includes(prop) && t.from < b && t.to > a) ?? tags.find((t) => t.props.includes(prop));
    const fix = owner
      ? `the ${owner.phase} motion "${owner.preset}" (frames ${owner.from}-${owner.to}) already animates ${prop}: clear it (mgl edit <file> motion.clear ${c.id} phase=${owner.phase}), or pick a ${plan.phase} preset on other properties`
      : `remove those keys first (mgl edit <file> key.clear ${c.id} prop=${prop}), or move this motion with @<time>`;
    fail('E_KEYFRAMED', `clip "${c.id}" ${prop} is already keyframed over frames ${e0}-${e1}; ${plan.phase} "${plan.preset.id}" would animate it over ${a}-${b}.`, fix);
  }
  // the shared key at b keeps the existing easing (it shapes the segment after b)
  const tail = atB !== undefined ? [atB[2] !== undefined ? [b, add[add.length - 1]![1], atB[2]] as Key : [b, add[add.length - 1]![1]] as Key] : [add[add.length - 1]!];
  rec[prop] = [...ex.filter((k) => k[0] < a), ...add.slice(0, -1), ...tail, ...ex.filter((k) => k[0] > b)];
}

/** Expand a plan's relative keys into absolute keys at the clip's rest values and merge them. */
function applyPlan(c: Clip, plan: Plan, W: number, H: number, tags: Tag[]): Prop[] {
  const props = Object.keys(plan.keys) as Prop[];
  for (const prop of props) {
    const rest = restOf(c, prop, plan.phase === 'in' ? plan.to : plan.from, W, H);
    if (prop === 'scale' && typeof rest !== 'number' && !Array.isArray(rest)) fail('E_VALUE', `clip "${c.id}" scale is not a number.`, `set one: mgl edit <file> clip.set ${c.id} scale=1`);
    const keys: Key[] = plan.keys[prop]!.map(([f, v, e]) => {
      const val = compose(prop, rest, v);
      return e !== undefined ? [plan.from + f, val, e] : [plan.from + f, val];
    });
    mergeKeys(c, prop, keys, plan, tags);
  }
  return props;
}

/** Remove the keys a motion tag wrote (sparing frames another remaining tag on the same property uses). */
function clearTag(c: Clip, t: Tag, remaining: Tag[], W: number, H: number) {
  const rec = c as Record<string, unknown>;
  for (const prop of t.props) {
    const cur = rec[prop];
    if (!isKeyframes(cur)) continue;
    const rest = restOf(c, prop, t.phase === 'in' ? t.to : t.from, W, H);
    const keep = (f: number) => remaining.some((o) => o.props.includes(prop) && f >= o.from && f <= o.to);
    const left = (cur as Key[]).filter((k) => k[0] < t.from || k[0] > t.to || keep(k[0]));
    const others = remaining.some((o) => o.props.includes(prop));
    if (!left.length) rec[prop] = rest;
    else if (left.length === 1 || (!others && left.every((k) => sameVal(k[1], left[0]![1])))) rec[prop] = left[0]![1];
    else rec[prop] = left;
    // a property back at its default needs no value
    if (!isKeyframes(rec[prop]) && sameVal(rec[prop], restOf({ ...c, [prop]: undefined } as Clip, prop, 0, W, H)) && (prop === 'scale' || prop === 'rotate' || prop === 'opacity')) delete rec[prop];
  }
  c.tags = (c.tags ?? []).filter((x) => x !== t.tag);
  if (!c.tags.length) delete c.tags;
}

function assertVisual(ctx: CommandContext, c: Clip) {
  if (c.locked) fail('E_LOCKED', `clip "${c.id}" is locked.`, `unlock it: mgl edit <file> clip.set ${c.id} locked=false`);
  const t = ctx.track(c.track);
  if (t.locked) fail('E_LOCKED', `track "${t.id}" is locked.`, `unlock it: mgl edit <file> track.set ${t.id} locked=false`);
  if (t.audio) fail('E_ARG', `"${c.id}" is an audio clip; motion presets move visual layers.`, 'apply motion to a visual clip (text, media, shape, solid, nested comp).');
}

/** "pop@0.5s" → { name: "pop", at: "0.5s" } */
function splitAt(s: string): { name: string; at?: string } {
  const i = s.indexOf('@');
  return i < 0 ? { name: s.trim() } : { name: s.slice(0, i).trim(), at: s.slice(i + 1).trim() };
}

/** The built-in preset names by phase, for the command doc (in/out names without their -in/-out suffix). */
const PRESET_LIST = PHASES.map((ph) => `${ph}= ${BUILTIN_MOTION.filter((m) => m.phase === ph).map((m) => (ph === 'in' || ph === 'out') && m.id.endsWith(`-${ph}`) ? m.id.slice(0, -ph.length - 1) : m.id).join('|')}`).join('; ');

const ParamValue = z.union([z.number(), z.string(), z.boolean()]);

defineCommand({
  op: 'motion.apply', group: 'motion',
  doc: `Animate clips with motion presets: in= (from the clip start), out= (ending on its last frame), emphasis= (one or a list, "pulse@2s" = clip-local start; default mid-clip), loop= (repeats seamlessly between the in and out on the same properties; ken-burns-* run once across it). len= sets in/out/emphasis length, period= a loop cycle, stagger= the delay between ids= (in and emphasis), params= preset params ({amount: 1.5, offscreen: true, "in.distance": 300}). Writes plain keyframes relative to the rest values, merged with existing keys; re-applying a phase replaces it. Presets: ${PRESET_LIST}.`,
  schema: z.strictObject({
    id: Id.optional(), ids: z.array(Id).min(1).optional(),
    in: z.string().min(1).optional(), out: z.string().min(1).optional(),
    emphasis: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    loop: z.string().min(1).optional(),
    len: TimeArg.optional(), period: TimeArg.optional(), stagger: TimeArg.optional(),
    params: z.record(z.string(), ParamValue).optional(),
  }),
  primary: 'id', example: { id: 'title', in: 'pop', out: 'fade', emphasis: 'pulse@1.5s', loop: 'float' },
  async apply(ctx, p) {
    if (p.id !== undefined && p.ids !== undefined) fail('E_ARG', 'give id= or ids=, not both.', 'use ids=[a,b,c] to animate several clips (with stagger=).');
    const ids = p.ids ?? (p.id !== undefined ? [p.id] : []);
    if (!ids.length) fail('E_ARG', 'motion.apply needs id= (or ids=).', 'e.g. mgl edit <file> motion.apply title in=pop out=fade');
    if (!p.in && !p.out && !p.emphasis && !p.loop) fail('E_ARG', 'motion.apply needs at least one of in=, out=, emphasis=, loop=.', `e.g. mgl edit <file> motion.apply ${ids[0]} in=pop loop=float`);
    const presets = motionPresetMap(ctx);
    const wanted: { phase: Phase; name: string; at?: string }[] = [];
    if (p.in) wanted.push({ phase: 'in', ...splitAt(p.in) });
    if (p.out) wanted.push({ phase: 'out', ...splitAt(p.out) });
    for (const e of p.emphasis === undefined ? [] : Array.isArray(p.emphasis) ? p.emphasis : [p.emphasis]) wanted.push({ phase: 'emphasis', ...splitAt(e) });
    if (p.loop) {
      const l = splitAt(p.loop);
      if (l.at) fail('E_ARG', `loop= takes no @time ("${p.loop}"); a loop fills the clip between its in and out.`, `write loop=${l.name}`);
      wanted.push({ phase: 'loop', name: l.name });
    }
    const chosen = wanted.map((w) => ({ ...w, preset: resolvePreset(presets, w.name, w.phase) }));

    // params: "k" applies to every chosen preset that has it, "<phase>.k" to that phase only
    const given = p.params ?? {};
    const shapeOf = (d: MotionPresetDef) => (d.params as { shape?: Record<string, unknown> } | undefined)?.shape ?? {};
    for (const k of Object.keys(given)) {
      const [ph, key] = k.includes('.') ? [k.slice(0, k.indexOf('.')), k.slice(k.indexOf('.') + 1)] : [undefined, k];
      if (ph !== undefined && !(PHASES as readonly string[]).includes(ph)) fail('E_PARAMS', `params: "${k}" has an unknown phase prefix "${ph}".`, `prefix with one of ${PHASES.join(', ')} (e.g. "in.distance"), or none.`);
      const targets = chosen.filter((c) => ph === undefined || c.phase === ph);
      if (!targets.some((c) => key in shapeOf(c.preset))) {
        const all = [...new Set(chosen.flatMap((c) => Object.keys(shapeOf(c.preset))))];
        const d = suggest(key, all);
        fail('E_PARAMS', `params: "${key}" is not a parameter of ${targets.map((c) => `"${c.preset.id}"`).join(', ') || `any ${ph} preset given`}.`, `${d.length ? `did you mean "${d[0]}"? ` : ''}parameters: ${all.join(', ') || '(none)'}`, { didYouMean: d });
      }
    }
    const paramsFor = (d: MotionPresetDef, phase: Phase): Record<string, unknown> => {
      const shape = shapeOf(d);
      const picked: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(given)) if (k in shape) picked[k] = v;
      for (const [k, v] of Object.entries(given)) if (k.startsWith(`${phase}.`) && k.slice(phase.length + 1) in shape) picked[k.slice(phase.length + 1)] = v;
      if (!d.params) return picked;
      const res = d.params.safeParse(picked);
      if (!res.success) {
        const iss = res.error.issues[0]!;
        fail('E_PARAMS', `motion preset "${d.id}": params.${iss.path.join('.')} ${iss.message}.`, `give a valid value (parameters: ${Object.keys(shape).join(', ')})`);
      }
      return res.data as Record<string, unknown>;
    };

    // stagger in frames at the first clip's comp rate (one rounding note, not one per clip)
    const staggerStep = p.stagger === undefined ? 0 : ctx.time(p.stagger, ctx.compOfClip(ctx.clip(ids[0]!)), 'stagger');
    const report: string[] = [];
    const out: Record<string, string[]> = {};
    for (const [i, id] of ids.entries()) {
      const c = ctx.clip(id);
      assertVisual(ctx, c);
      const comp = ctx.compOfClip(c);
      const [W, H] = comp.size;
      const fps = ctx.rate(comp).num / ctx.rate(comp).den;
      const last = c.len - 1;
      if (last < 1) fail('E_RANGE', `clip "${c.id}" is ${c.len} frame(s) long; too short to animate.`, 'lengthen the clip first.');
      const box = await layerBox(ctx, c);
      const size = c.text !== undefined && !c.shape ? { w: Math.round(W * 0.8), h: Math.round(H * 0.1) } : { w: box.w, h: box.h };
      const seed = seedOf(c.id);
      const stagger = staggerStep * i;
      const lenOf = (d: MotionPresetDef) => Math.max(1, p.len !== undefined ? ctx.time(p.len, comp, 'len') : Math.round((d.seconds ?? 0.5) * fps));
      const gen = (d: MotionPresetDef, phase: Phase, len: number) => checkKeys(d, d.keys({ len, fps, seed, params: paramsFor(d, phase), size, comp: { width: W, height: H } }), len);

      // re-applying a phase replaces it
      const replaced = new Set(chosen.map((w) => w.phase));
      let tags = motionTags(c);
      for (const t of tags.filter((t) => replaced.has(t.phase))) {
        tags = tags.filter((x) => x !== t);
        clearTag(c, t, tags, W, H);
        ctx.note(`clip "${c.id}": replaced its ${t.phase} motion "${t.preset}".`);
      }

      const plans: Plan[] = [];
      const fit = (phase: Phase, d: MotionPresetDef, from: number, len: number): { from: number; len: number } => {
        if (from < 0 || from >= last) fail('E_RANGE', `${phase} "${d.id}" would start at clip frame ${from}, outside "${c.id}" (0..${last - 1}).`, '@time is clip-local; use a time inside the clip.');
        if (from + len > last) { ctx.note(`clip "${c.id}": shortened ${phase} "${d.id}" to ${last - from} frames to fit the clip.`); len = last - from; }
        return { from, len };
      };
      for (const w of chosen.filter((x) => x.phase !== 'loop')) {
        const L = lenOf(w.preset);
        let from: number;
        if (w.phase === 'in') from = (w.at ? ctx.time(w.at, comp, 'in') : 0) + stagger;
        else if (w.phase === 'out') from = w.at ? ctx.time(w.at, comp, 'out') : Math.max(0, last - L);
        else {
          const inEnd = plans.find((q) => q.phase === 'in')?.to ?? 0;
          const outStart = c.len - 1 - (chosen.some((q) => q.phase === 'out') ? lenOf(chosen.find((q) => q.phase === 'out')!.preset) : 0);
          from = (w.at ? ctx.time(w.at, comp, 'emphasis') : Math.max(inEnd, Math.round((inEnd + outStart - L) / 2))) + stagger;
        }
        const f = fit(w.phase, w.preset, from, L);
        plans.push({ phase: w.phase, preset: w.preset, from: f.from, to: f.from + f.len, keys: gen(w.preset, w.phase, f.len) });
      }
      const lw = chosen.find((x) => x.phase === 'loop');
      if (lw) {
        const d = lw.preset;
        const P0 = Math.max(2, p.period !== undefined ? ctx.time(p.period, comp, 'period') : Math.round((d.seconds ?? 2) * fps));
        const probe = gen(d, 'loop', P0);
        const props = Object.keys(probe) as Prop[];
        const shares = (q: Plan | Tag) => ('keys' in q ? Object.keys(q.keys) : q.props).some((x) => props.includes(x as Prop));
        const before = [...plans.filter((q) => q.phase === 'in'), ...tags.filter((t) => t.phase === 'in')].filter(shares);
        const after = [...plans.filter((q) => q.phase === 'out'), ...tags.filter((t) => t.phase === 'out')].filter(shares);
        const from = Math.max(0, ...before.map((q) => q.to));
        const to = Math.min(last, ...after.map((q) => q.from));
        const clash = [...plans, ...tags].find((q) => q.phase === 'emphasis' && shares(q));
        if (clash) fail('E_KEYFRAMED', `loop "${d.id}" and emphasis "${typeof clash.preset === 'string' ? clash.preset : clash.preset.id}" both animate ${props.join('/')} of "${c.id}".`,
          `pick a loop on other properties (float/drift move, breathe scales, sway/spin rotate) or another emphasis${'tag' in clash ? `, or clear it: mgl edit <file> motion.clear ${c.id} phase=emphasis` : ''}`);
        const span = to - from;
        if (span < 2) fail('E_RANGE', `no room for loop "${d.id}" on "${c.id}": its in/out leave ${Math.max(0, span)} frame(s).`, 'shorten the in/out (len=) or lengthen the clip.');
        // cycling (ends where it starts; rotate may end whole turns on) or sustained (stretched once)
        const cyc = props.every((pr) => { const ks = probe[pr]!; const dv = ks[ks.length - 1]![1] - ks[0]![1]; return pr === 'rotate' ? Math.abs(dv % 360) < 1e-9 : Math.abs(dv) < 1e-9; });
        const keys: Plan['keys'] = {};
        if (!cyc) Object.assign(keys, gen(d, 'loop', span));
        else if (span < P0 * 0.75 && !after.length) {
          // much shorter than one cycle with nothing after it on these properties: play the start of a true-speed cycle
          // rather than rushing a whole one (an out on the same properties needs the loop back at rest: see below)
          for (const [pr, ks] of Object.entries(gen(d, 'loop', P0)) as [Prop, [number, number, string?][]][]) {
            const cut = ks.filter((k) => k[0] < span);
            const v = r(interpolate(ks as never, span) as number, 4);
            keys[pr] = [...cut, [span, v]];
          }
          ctx.note(`clip "${c.id}": loop "${d.id}" has ${r(span / fps, 2)}s between its in and out, less than one ${r(P0 / fps, 2)}s cycle; it plays part of a cycle.`);
        } else {
          const n = Math.max(1, Math.round(span / P0));
          if (span < P0 * 0.75) ctx.note(`clip "${c.id}": loop "${d.id}" plays one quicker ${r(span / fps, 2)}s cycle to be back at rest for the out.`);
          const cache = new Map<number, Plan['keys']>();
          for (let k = 0; k < n; k++) {
            const s = Math.round((k * span) / n), e = Math.round(((k + 1) * span) / n);
            if (!cache.has(e - s)) cache.set(e - s, gen(d, 'loop', e - s));
            for (const [pr, ks] of Object.entries(cache.get(e - s)!) as [Prop, [number, number, string?][]][]) {
              const turn = pr === 'rotate' ? (ks[ks.length - 1]![1] - ks[0]![1]) * k : 0;
              const list = (keys[pr] ??= []);
              for (const [f, v, ea] of ks) {
                if (list.length && list[list.length - 1]![0] === s + f) list.pop();
                list.push(ea !== undefined ? [s + f, v + turn, ea] : [s + f, v + turn]);
              }
            }
          }
          if (n !== span / P0 && span >= P0 * 0.75) ctx.note(`clip "${c.id}": loop "${d.id}" runs ${n} cycle(s) of ${r(span / n / fps, 2)}s to fill frames ${from}-${to} seamlessly.`);
        }
        plans.push({ phase: 'loop', preset: d, from, to, keys });
      }

      // in, out, emphasis, then the loop; each merges into what is there (so conflicts within the call are caught too)
      const done: string[] = [];
      for (const plan of plans) {
        const props = applyPlan(c, plan, W, H, tags);
        const tag = `motion:${plan.phase}=${plan.preset.id}@${plan.from}-${plan.to}:${props.join(',')}`;
        c.tags = [...(c.tags ?? []), tag];
        tags.push({ tag, phase: plan.phase, preset: plan.preset.id, from: plan.from, to: plan.to, props });
        done.push(`${plan.phase} ${plan.preset.id} (${plan.from}-${plan.to}: ${props.join('/')})`);
        if (plan.phase !== 'loop' && props.includes('opacity') && c.fade && (plan.phase === 'in' ? c.fade[0] : c.fade[1])) ctx.note(`clip "${c.id}" also has fade=${JSON.stringify(c.fade)}; both dim it.`);
        if (plan.phase === 'in' && c.animate) ctx.note(`clip "${c.id}" also has a text animation (animate); both play at the start.`);
      }
      out[c.id] = done;
      report.push(`"${c.id}": ${done.join(', ')}`);
    }
    ctx.out.motion = out;
    ctx.summary(`motion on ${report.join('; ')}.`);
  },
});

defineCommand({
  op: 'motion.clear', group: 'motion',
  doc: 'Remove the keyframes motion.apply wrote on a clip: every phase, or phase=in|out|emphasis|loop; properties go back to their rest values (other keys are kept).',
  schema: z.strictObject({ id: Id, phase: z.enum(['in', 'out', 'emphasis', 'loop', 'all']).optional() }),
  primary: 'id', example: { id: 'title', phase: 'loop' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    assertVisual(ctx, c);
    const [W, H] = ctx.compOfClip(c).size;
    let tags = motionTags(c);
    const hit = tags.filter((t) => !p.phase || p.phase === 'all' || t.phase === p.phase);
    if (!hit.length) {
      fail('E_NO_MOTION', `clip "${c.id}" has no ${p.phase && p.phase !== 'all' ? `${p.phase} ` : ''}motion from motion.apply.`,
        tags.length ? `its motion: ${tags.map((t) => `${t.phase}=${t.preset}`).join(', ')}` : `keyframes set by hand are removed with: mgl edit <file> key.clear ${c.id} prop=<prop>`);
    }
    // later phases first, so shared boundary frames are resolved against what remains
    for (const t of [...hit].reverse()) {
      tags = tags.filter((x) => x !== t);
      clearTag(c, t, tags, W, H);
    }
    ctx.out.cleared = hit.map((t) => `${t.phase}=${t.preset}`);
    ctx.summary(`clip "${c.id}": removed ${hit.map((t) => `${t.phase} "${t.preset}"`).join(', ')}.`);
  },
});
