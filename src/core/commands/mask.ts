/** Mask and matte commands: mask.add, mask.set, mask.remove, matte.set. */
import { z } from 'zod';
import { fail } from '../errors.js';
import { defineCommand } from './registry.js';
import { Id, canonicalSchemas, type Clip, type Mask } from '../schema/index.js';

const M = canonicalSchemas.Mask.shape;
const nullable = <T extends z.ZodType>(t: T) => t.nullable().optional();
const MaskFields = {
  box: nullable(M.box.unwrap()), d: nullable(M.d.unwrap()), space: nullable(M.space.unwrap()), feather: nullable(M.feather.unwrap()),
  radius: nullable(M.radius.unwrap()), invert: nullable(M.invert.unwrap()), mode: nullable(M.mode.unwrap()), opacity: nullable(M.opacity.unwrap()),
};

function maskIndex(c: Clip, i: number): number {
  const n = c.masks?.length ?? 0;
  if (i >= n) fail('E_NO_MASK', `clip "${c.id}" has no mask ${i}.`, n ? `masks are 0..${n - 1}.` : 'add one with mask.add.');
  return i;
}

function checkMask(m: Mask, c: Clip) {
  if (m.shape === 'path' && !m.d) fail('E_MASK', `a path mask on "${c.id}" needs d (SVG path data).`, 'e.g. d="M0 0 L500 0 L250 400 Z"');
  if (m.shape !== 'path' && !m.box) fail('E_MASK', `a ${m.shape} mask on "${c.id}" needs box=[x, y, w, h].`, 'e.g. box=[100,200,600,400] (comp px), or space=clip box=[0,0,1,0.5] (fractions of the clip).');
  if (m.box && (m.box[2] <= 0 || m.box[3] <= 0)) fail('E_MASK', `mask box ${JSON.stringify(m.box)} has no area.`, 'give a positive width and height: [x, y, w, h].');
}

function assign(m: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) { if (v === null) delete m[k]; else m[k] = v; }
}

defineCommand({
  op: 'mask.add', group: 'masks', doc: 'Add a mask (rect, ellipse or SVG path) that cuts a clip; box is [x, y, w, h] in comp px, or clip fractions with space=clip.',
  schema: z.strictObject({ id: Id, shape: M.shape, ...MaskFields }),
  primary: 'id', example: { id: 'shot1', shape: 'ellipse', box: [140, 560, 800, 800], feather: 40 },
  apply(ctx, p) {
    const { id, ...fields } = p;
    const c = ctx.clip(id);
    const m = {} as Mask;
    assign(m as Record<string, unknown>, fields);
    checkMask(m, c);
    (c.masks ??= []).push(m);
    ctx.out.index = c.masks.length - 1;
    ctx.summary(`clip "${c.id}": added ${m.shape} mask ${c.masks.length - 1}.`);
  },
});

defineCommand({
  op: 'mask.set', group: 'masks', doc: 'Change a clip\'s mask (by index); null removes a field.',
  schema: z.strictObject({ id: Id, mask: z.number().int().min(0), shape: M.shape.optional(), ...MaskFields }),
  primary: 'id', example: { id: 'shot1', mask: 0, feather: 80, invert: true },
  apply(ctx, p) {
    const { id, mask, ...fields } = p;
    const c = ctx.clip(id);
    const m = c.masks![maskIndex(c, mask)]!;
    assign(m as Record<string, unknown>, fields);
    checkMask(m, c);
    ctx.summary(`clip "${c.id}": mask ${mask} updated.`);
  },
});

defineCommand({
  op: 'mask.remove', group: 'masks', doc: 'Remove a clip\'s mask (by index).',
  schema: z.strictObject({ id: Id, mask: z.number().int().min(0) }),
  primary: 'id', example: { id: 'shot1', mask: 0 },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    c.masks!.splice(maskIndex(c, p.mask), 1);
    if (!c.masks!.length) delete c.masks;
    ctx.summary(`clip "${c.id}": removed mask ${p.mask}.`);
  },
});

defineCommand({
  op: 'matte.set', group: 'masks', doc: 'Show a clip only through another clip\'s alpha or luma (track matte); clip=null removes it. The matte clip is hidden unless keep=true.',
  schema: z.strictObject({ id: Id, clip: Id.nullable(), mode: z.enum(['alpha', 'luma', 'alpha-inverted', 'luma-inverted']).optional(), keep: z.boolean().optional() }),
  primary: 'id', example: { id: 'shot1', clip: 'title', mode: 'alpha' },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    if (p.clip === null) { delete c.matte; ctx.summary(`clip "${c.id}": matte removed.`); return; }
    const m = ctx.clip(p.clip);
    if (m.id === c.id) fail('E_MATTE', `clip "${c.id}" cannot be its own matte.`, 'use another clip of the same comp as the matte.');
    if (ctx.compOfClip(m).id !== ctx.compOfClip(c).id) fail('E_MATTE', `matte clip "${m.id}" is in another comp.`, 'use a clip of the same comp (or nest both into one comp).');
    const matte: NonNullable<Clip['matte']> = { clip: m.id };
    const mode = p.mode ?? c.matte?.mode;
    if (mode && mode !== 'alpha') matte.mode = mode;
    const keep = p.keep ?? c.matte?.keep;
    if (keep) matte.keep = true;
    c.matte = matte;
    if (m.at > c.at || m.at + m.len < c.at + c.len) ctx.note(`matte clip "${m.id}" (${m.at}–${m.at + m.len}) does not cover all of "${c.id}" (${c.at}–${c.at + c.len}); outside it ${mode?.endsWith('inverted') ? 'the clip shows fully' : 'nothing shows'}.`);
    ctx.summary(`clip "${c.id}": matte ${m.id} (${mode ?? 'alpha'}).`);
  },
});
