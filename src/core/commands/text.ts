/** Text commands: text.set, text.animate, and the project styles table (style.add / style.set / style.remove). */
import { z } from 'zod';
import { fail, suggest } from '../errors.js';
import { defineCommand, TimeArg, type CommandContext } from './registry.js';
import { Id, inputSchemas, TABLES, type Style, type TextAnimate } from '../schema/index.js';
import { BUILTIN_STYLES } from '../load.js';
import { estimateWordTimes, wordsOf } from '../captions.js';
import { TEXT_ANIMATION_IDS } from '../../builtin/text/animations.js';

/** Text animation ids known here: the built-ins plus any a plugin catalog lists. */
export function textAnimationIds(ctx: CommandContext): string[] {
  const extra = (ctx.services.catalog as { textAnimations?: Map<string, unknown> } | undefined)?.textAnimations;
  return [...new Set([...TEXT_ANIMATION_IDS, ...(extra?.keys() ?? [])])];
}

defineCommand({
  op: 'text.set', group: 'text', doc: 'Change the text of a text clip or a caption cue; a cue\'s word times are re-estimated unless keepWords=true and the word count is unchanged.',
  schema: z.strictObject({ id: Id, text: z.string().min(1), keepWords: z.boolean().optional() }),
  primary: 'id', example: { id: 'title', text: 'Three tips to focus' },
  apply(ctx, p) {
    const q = (ctx.project.cues ?? []).find((x) => x.id === p.id);
    if (q) {
      const before = q.text;
      q.text = p.text;
      if (q.words) {
        const n = wordsOf(p.text).length;
        if (!(p.keepWords && n === q.words.length)) {
          q.words = estimateWordTimes(p.text, q.len, true);
          if (p.keepWords) ctx.note(`the word count changed (${wordsOf(before).length} → ${n}); word times were re-estimated.`);
        }
      }
      ctx.summary(`cue "${q.id}" text set.`);
      return;
    }
    const c = (ctx.project.clips ?? []).find((x) => x.id === p.id);
    if (!c) {
      const all = [...(ctx.project.clips ?? []).filter((x) => x.text !== undefined).map((x) => x.id), ...(ctx.project.cues ?? []).map((x) => x.id)];
      const d = suggest(p.id, all);
      fail('E_REF', `no text clip or cue has id "${p.id}".`, d.length ? `did you mean "${d[0]}"?` : 'list them with: mgl show <file>');
    }
    if (c.text === undefined) fail('E_NOT_TEXT', `clip "${c.id}" is not a text clip.`, c.captions ? `edit its cues with cue.set or text.set <cue id>.` : 'use the id of a clip with "text".');
    c.text = p.text;
    ctx.summary(`clip "${c.id}" text set.`);
  },
});

const Nullable = <T extends z.ZodType>(t: T) => t.nullable().optional();

defineCommand({
  op: 'text.animate', group: 'text', doc: 'Animate a text clip per char / word / line / all with in and out presets (fade, pop, slide-up, slide-down, slide-left, typewriter, blur-in, bounce, scale-in, drop, wave, none); stagger and len are frames per unit; null removes a field.',
  schema: z.strictObject({ id: Id, in: Nullable(z.string().min(1)), out: Nullable(z.string().min(1)), by: Nullable(z.enum(['char', 'word', 'line', 'all'])), stagger: Nullable(TimeArg), len: Nullable(TimeArg) }),
  primary: 'id', example: { id: 'title', in: 'pop', by: 'word', stagger: 3 },
  apply(ctx, p) {
    const c = ctx.clip(p.id);
    if (c.text === undefined) fail('E_NOT_TEXT', `clip "${c.id}" is not a text clip; text animations apply to text clips.`, c.captions ? 'captions animate their words through the style (highlight, maxWords).' : 'use the id of a clip with "text".');
    const known = textAnimationIds(ctx);
    for (const k of ['in', 'out'] as const) {
      const v = p[k];
      if (typeof v === 'string' && !known.includes(v)) {
        const d = suggest(v, known);
        fail('E_UNKNOWN_ANIMATION', `text animation "${v}" does not exist.`, d.length ? `did you mean "${d[0]}"? (presets: ${known.join(', ')})` : `presets: ${known.join(', ')}`, { didYouMean: d });
      }
    }
    const a: Record<string, unknown> = { ...(c.animate ?? {}) };
    const comp = ctx.compOfClip(c);
    for (const k of ['in', 'out', 'by', 'stagger', 'len'] as const) {
      const v = p[k];
      if (v === undefined) continue;
      if (v === null) { delete a[k]; continue; }
      a[k] = k === 'stagger' || k === 'len' ? ctx.time(v as string | number, comp, k) : v;
    }
    if (typeof a.len === 'number' && a.len < 1) fail('E_RANGE', 'len must be at least 1 frame.', 'e.g. len=12');
    if (typeof a.stagger === 'number' && a.stagger < 0) fail('E_RANGE', 'stagger cannot be negative.', 'e.g. stagger=3');
    if (Object.keys(a).length && !a.in && !a.out) ctx.note('no "in" or "out" preset is set, so the text does not animate.');
    if (Object.keys(a).length) c.animate = a as TextAnimate; else delete c.animate;
    ctx.summary(`clip "${c.id}" animation: ${c.animate ? Object.entries(c.animate).map(([k, v]) => `${k}=${v}`).join(' ') : 'none'}.`);
  },
});

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------

const styleShape = inputSchemas.TextStyle.shape;
const NullableStyleFields = z.strictObject(Object.fromEntries(Object.entries(styleShape).map(([k, v]) => [k, (v as z.ZodType).nullable()])) as Record<string, z.ZodType>);

function styleIds(ctx: CommandContext): string[] {
  return [...(ctx.project.styles ?? []).map((s) => s.id), ...BUILTIN_STYLES];
}

function checkBase(ctx: CommandContext, id: string, base: unknown) {
  if (typeof base !== 'string') return;
  if (!styleIds(ctx).includes(base)) {
    const d = suggest(base, styleIds(ctx));
    fail('E_REF', `base style "${base}" does not exist.`, d.length ? `did you mean "${d[0]}"?` : `use one of ${styleIds(ctx).join(', ')}.`);
  }
  // cycles through project styles
  const seen = new Set([id]);
  for (let cur: string | undefined = base; cur; cur = (ctx.project.styles ?? []).find((s) => s.id === cur)?.base) {
    if (seen.has(cur)) fail('E_CYCLE', `style "${id}" would inherit from itself (via "${cur}").`, 'choose another base.');
    seen.add(cur);
  }
}

defineCommand({
  op: 'style.add', group: 'text', doc: 'Add a named text style to the project (any TextStyle field; base inherits from another style, e.g. base=caption). Clips use it with style=<id>.',
  schema: inputSchemas.Style,
  primary: 'id', example: { id: 'brand', base: 'caption', color: '#00e5ff', font: 'Inter', size: 70 },
  apply(ctx, p) {
    const styles = (ctx.project.styles ??= []);
    if (styles.some((s) => s.id === p.id)) fail('E_DUPLICATE_ID', `style "${p.id}" already exists.`, `change it with style.set ${p.id} ..., or choose another id.`);
    if (TABLES.some((t) => ((ctx.project[t] as { id: string }[] | undefined) ?? []).some((e) => e.id === p.id))) fail('E_DUPLICATE_ID', `id "${p.id}" is already used by another entity.`, 'choose another style id.');
    checkBase(ctx, p.id, p.base);
    if (BUILTIN_STYLES.includes(p.id)) ctx.note(`style "${p.id}" overrides the built-in style of that name in this project.`);
    styles.push(p as Style);
    ctx.out.id = p.id;
    ctx.summary(`added style "${p.id}".`);
  },
});

defineCommand({
  op: 'style.set', group: 'text', doc: 'Change fields of a project style; null removes a field (it then inherits from base or the defaults).',
  schema: NullableStyleFields.extend({ id: Id }),
  primary: 'id', example: { id: 'brand', color: '#ffcc00', stroke: null },
  apply(ctx, p) {
    const { id, ...fields } = p as { id: string } & Record<string, unknown>;
    const st = (ctx.project.styles ?? []).find((s) => s.id === id) as Record<string, unknown> | undefined;
    if (!st) {
      if (BUILTIN_STYLES.includes(id)) fail('E_REF', `"${id}" is a built-in style, not a project style.`, `add an override: mgl edit <file> style.add ${id} base=... (or make your own: style.add my-${id} base=${id} ...)`);
      fail('E_REF', `style "${id}" does not exist.`, `add it with style.add ${id} ...`);
    }
    if (!Object.keys(fields).length) fail('E_ARG', 'style.set needs at least one field.', 'example: mgl edit <file> style.set brand color=#ffcc00');
    if (fields.base !== undefined && fields.base !== null) checkBase(ctx, id, fields.base);
    for (const [k, v] of Object.entries(fields)) { if (v === null) delete st[k]; else st[k] = v; }
    ctx.summary(`style "${id}": set ${Object.keys(fields).join(', ')}.`);
  },
});

defineCommand({
  op: 'style.remove', group: 'text', doc: 'Remove a project style; refuses while a clip or another style uses it.',
  schema: z.strictObject({ id: Id }), primary: 'id', example: { id: 'brand' },
  apply(ctx, p) {
    const styles = ctx.project.styles ?? [];
    if (!styles.some((s) => s.id === p.id)) fail('E_REF', `style "${p.id}" does not exist.`, `styles: ${styles.map((s) => s.id).join(', ') || '(none)'}`);
    const users = [
      ...(ctx.project.clips ?? []).filter((c) => c.style === p.id || (typeof c.style === 'object' && c.style.base === p.id)).map((c) => `clip ${c.id}`),
      ...styles.filter((s) => s.base === p.id).map((s) => `style ${s.id}`),
    ];
    const builtin = BUILTIN_STYLES.includes(p.id);
    if (users.length && !builtin) fail('E_IN_USE', `style "${p.id}" is used by ${users.slice(0, 5).join(', ')}${users.length > 5 ? ` and ${users.length - 5} more` : ''}.`, 'point them at another style first (clip.set <id> style=<other>), then remove it.');
    ctx.project.styles = styles.filter((s) => s.id !== p.id);
    if (!ctx.project.styles.length) delete ctx.project.styles;
    ctx.summary(`removed style "${p.id}"${builtin && users.length ? ` (its ${users.length} user(s) now get the built-in "${p.id}")` : ''}.`);
  },
});
