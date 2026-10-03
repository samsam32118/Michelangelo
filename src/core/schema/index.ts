/**
 * The Michelangelo project model, defined once with zod.
 *
 * `makeSchemas(time)` builds the schemas for a given time representation:
 * - `inputSchemas` accept the edge forms (frames, "2.5s", "1:02.5", "00:01:02:15") as written by hand;
 * - `canonicalSchemas` accept only integer frames (what the loader produces after normalising).
 * The TypeScript types are inferred from the canonical schemas. The published JSON Schema comes from the
 * input schemas.
 *
 * Rule: additive changes only. Never rename or change the meaning of a field.
 */
import { z } from 'zod';

export const FORMAT_VERSION = 1;

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const Id = z.string().regex(ID_RE, 'ids use letters, digits, "_", "-" and "." and start with a letter or digit');
export const Color = z.string().regex(/^(#[0-9a-fA-F]{3,8}|transparent|[a-z]+|rgba?\([^)]*\))$/, 'a colour is "#rrggbb", "#rrggbbaa", a CSS name, or rgba(...)');

export const EASINGS = [
  'linear', 'hold',
  'inSine', 'outSine', 'inOutSine', 'inQuad', 'outQuad', 'inOutQuad', 'inCubic', 'outCubic', 'inOutCubic',
  'inQuart', 'outQuart', 'inOutQuart', 'inExpo', 'outExpo', 'inOutExpo', 'inBack', 'outBack', 'inOutBack',
  'inElastic', 'outElastic', 'inOutElastic', 'inBounce', 'outBounce', 'inOutBounce',
] as const;
export const EasingName = z.enum(EASINGS);
export const Easing = z.union([EasingName, z.tuple([z.number(), z.number(), z.number(), z.number()])]);

export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'add', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'] as const;
export const BlendMode = z.enum(BLEND_MODES);

export const FITS = ['contain', 'cover', 'fill', 'none'] as const;
export const PLATFORMS = ['shorts', 'tiktok', 'reels', 'youtube', 'none'] as const;

type TimeSchema = z.ZodType<number> | z.ZodType<number | string>;

export function makeSchemas<T extends TimeSchema>(Time: T) {
  /** A property value or a keyframe list [[frame, value, easing?], ...] (frames are clip-local). */
  const animatable = <V extends z.ZodType>(v: V) =>
    z.union([v, z.array(z.union([z.tuple([Time, v]), z.tuple([Time, v, Easing])])).min(1)]);

  const Num = animatable(z.number());
  const Vec2 = z.tuple([z.number(), z.number()]);
  const ScaleValue = z.union([z.number(), Vec2]);

  const Project = z.strictObject({
    name: z.string().optional(),
    /** plugin name → semver range; only these plugins load */
    plugins: z.record(z.string(), z.string()).optional(),
    /** delivery platform: sets safe zones and the default loudness target */
    platform: z.enum(PLATFORMS).optional(),
    /** the comp `render` and `look` use when none is given (default: "main", else the first comp) */
    main: Id.optional(),
  });

  const Asset = z.strictObject({
    id: Id,
    /** path relative to the project file, or a URL-like generator ("lavfi:testsrc2") */
    src: z.string().min(1),
    /** override of the kind inferred from the file */
    kind: z.enum(['video', 'audio', 'image', 'font', 'lut', 'subtitles', 'data']).optional(),
    note: z.string().optional(),
  });

  const Comp = z.strictObject({
    id: Id,
    size: z.tuple([z.number().int().min(2).max(8192), z.number().int().min(2).max(8192)]),
    fps: z.union([z.number().positive(), z.string()]),
    /** length in frames (or an edge time), or "auto" = the end of the last clip */
    length: z.union([Time, z.literal('auto')]).optional(),
    bg: Color.optional(),
    note: z.string().optional(),
  });

  const Track = z.strictObject({
    id: Id,
    comp: Id,
    /** an audio track (mixes into `bus`); otherwise visual, stacked in table order (later = on top) */
    audio: z.boolean().optional(),
    bus: Id.optional(),
    hidden: z.boolean().optional(),
    muted: z.boolean().optional(),
    locked: z.boolean().optional(),
    note: z.string().optional(),
  });

  const styleFields = {
    font: z.string().optional(),
    size: z.number().positive().optional(),
    weight: z.union([z.number(), z.enum(['normal', 'bold'])]).optional(),
    italic: z.boolean().optional(),
    color: Color.optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    lineHeight: z.number().positive().optional(),
    letterSpacing: z.number().optional(),
    stroke: Color.optional(),
    strokeWidth: z.number().min(0).optional(),
    shadow: Color.optional(),
    shadowBlur: z.number().min(0).optional(),
    shadowOffset: Vec2.optional(),
    bg: Color.optional(),
    bgPadding: z.union([z.number(), Vec2]).optional(),
    bgRadius: z.number().min(0).optional(),
    /** wrap width in comp px */
    maxWidth: z.number().positive().optional(),
    uppercase: z.boolean().optional(),
    /** captions: colour of the word being spoken */
    highlight: Color.optional(),
    /** captions: max words shown at once (pages of words) */
    maxWords: z.number().int().positive().optional(),
    /** at most this many lines; longer text shrinks to fit */
    maxLines: z.number().int().positive().optional(),
    /** a fixed text box [w, h] in comp px; text wraps and shrinks to fit inside */
    box: Vec2.optional(),
    /** inherit from another style (a styles-table id or a built-in style) */
    base: z.string().optional(),
  };
  const TextStyle = z.strictObject(styleFields);
  const Style = z.strictObject({ id: Id, ...styleFields });

  const TextAnimate = z.strictObject({
    in: z.string().optional(),
    out: z.string().optional(),
    by: z.enum(['char', 'word', 'line', 'all']).optional(),
    /** frames between units */
    stagger: z.optional(Time),
    /** frames each unit's animation lasts */
    len: z.optional(Time),
  });

  const ShapeSpec = z.strictObject({
    type: z.enum(['rect', 'ellipse', 'line', 'polygon', 'star', 'path']),
    size: Vec2.optional(),
    radius: z.number().min(0).optional(),
    sides: z.number().int().min(3).optional(),
    /** path: SVG path data in shape-local px; polygon/line: points */
    d: z.string().optional(),
    points: z.array(Vec2).optional(),
    fill: z.union([Color, z.literal('none')]).optional(),
    stroke: Color.optional(),
    strokeWidth: z.number().min(0).optional(),
    /** draw only part of the outline, 0..1 (animatable via clip keys "shape.trim") */
    trim: Num.optional(),
    gradient: z.strictObject({ type: z.enum(['linear', 'radial']), stops: z.array(z.tuple([z.number(), Color])).min(2), angle: z.number().optional() }).optional(),
  });

  /** An effect instance: `type` plus its parameters inline. Parameters are validated by the effect type. */
  const Effect = z.looseObject({ type: z.string().min(1), id: Id.optional(), enabled: z.boolean().optional() });
  const Transition = z.looseObject({ type: z.string().min(1), len: Time, align: z.enum(['center', 'start', 'end']).optional() });
  const Generator = z.looseObject({ type: z.string().min(1) });

  const Mask = z.strictObject({
    shape: z.enum(['rect', 'ellipse', 'path']),
    /** rect/ellipse box in comp px [x, y, w, h] (x, y = top-left), or in clip-box fractions with space "clip" */
    box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    d: z.string().optional(),
    space: z.enum(['comp', 'clip']).optional(),
    feather: z.number().min(0).optional(),
    radius: z.number().min(0).optional(),
    invert: z.boolean().optional(),
    mode: z.enum(['add', 'subtract', 'intersect']).optional(),
    opacity: z.number().min(0).max(1).optional(),
  });

  const Clip = z.strictObject({
    id: Id,
    track: Id,
    /** start on the timeline (comp frames) */
    at: Time,
    /** length on the timeline (frames) */
    len: Time,

    // --- source: exactly one of these ---
    asset: Id.optional(),
    text: z.string().optional(),
    shape: ShapeSpec.optional(),
    color: Color.optional(),
    comp: Id.optional(),
    captions: z.literal(true).optional(),
    adjustment: z.literal(true).optional(),
    gen: Generator.optional(),

    // --- media ---
    /** source offset in frames at the comp rate (speed 1) */
    in: z.optional(Time),
    /** playback speed factor (2 = twice as fast, "3/2", 0 = freeze at `in`) */
    speed: z.union([z.number().min(0), z.string()]).optional(),
    /** audio gain in dB (animatable) */
    gain: Num.optional(),
    /** fade in/out lengths in frames (audio and opacity of visuals) */
    fade: z.tuple([Time, Time]).optional(),
    muted: z.boolean().optional(),
    loop: z.boolean().optional(),
    fit: z.enum(FITS).optional(),
    /** crop in source px [left, top, right, bottom] */
    crop: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),

    // --- text ---
    style: z.union([z.string(), TextStyle]).optional(),
    animate: TextAnimate.optional(),

    // --- transform (comp px; x,y = where the anchor sits; default = comp centre) ---
    x: Num.optional(),
    y: Num.optional(),
    anchor: Vec2.optional(),
    scale: animatable(ScaleValue).optional(),
    rotate: Num.optional(),
    opacity: Num.optional(),
    blend: BlendMode.optional(),
    parent: Id.optional(),
    /** show this clip only through another clip's alpha or luma (track matte) */
    matte: z.strictObject({ clip: Id, mode: z.enum(['alpha', 'luma', 'alpha-inverted', 'luma-inverted']).optional(), keep: z.boolean().optional() }).optional(),
    /** time remap: source frame by clip frame, keyframed (speed ramps) */
    remap: Num.optional(),
    /** link group: edits apply to every clip with the same link (video + its audio) */
    link: z.string().optional(),

    fx: z.array(Effect).optional(),
    masks: z.array(Mask).optional(),
    transition: z.strictObject({ in: Transition.optional(), out: Transition.optional() }).optional(),

    /** animation clock offset in frames (set by split so a cut never restarts an animation) */
    clock: z.optional(Time),
    hidden: z.boolean().optional(),
    locked: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    note: z.string().optional(),
  });

  const Cue = z.strictObject({
    id: Id,
    clip: Id,
    /** start, frames from the captions clip's start */
    at: Time,
    len: Time,
    text: z.string(),
    /** word start offsets (frames from `at`), one per word of `text` */
    words: z.array(Time).optional(),
    speaker: z.string().optional(),
  });

  const Bus = z.strictObject({
    id: Id,
    gain: z.number().optional(),
    muted: z.boolean().optional(),
    /** duck this bus while bus `by` has signal */
    duck: z.strictObject({ by: Id, db: z.number().positive(), attack: z.number().positive().optional(), release: z.number().positive().optional() }).optional(),
    /** loudness target (master bus): integrated LUFS and true-peak ceiling */
    loudness: z.strictObject({ lufs: z.number(), peak: z.number().optional() }).optional(),
    /** the bus this one feeds (default master) */
    to: Id.optional(),
  });

  const Marker = z.strictObject({
    id: Id,
    comp: Id,
    at: Time,
    len: z.optional(Time),
    note: z.string().optional(),
  });

  const File = z.strictObject({
    michelangelo: z.literal(FORMAT_VERSION),
    $schema: z.string().optional(),
    project: Project.optional(),
    assets: z.array(Asset).optional(),
    comps: z.array(Comp).min(1),
    tracks: z.array(Track).optional(),
    clips: z.array(Clip).optional(),
    cues: z.array(Cue).optional(),
    styles: z.array(Style).optional(),
    buses: z.array(Bus).optional(),
    markers: z.array(Marker).optional(),
  });

  return { Project, Asset, Comp, Track, Clip, Cue, Bus, Marker, Style, File, TextStyle, TextAnimate, ShapeSpec, Effect, Transition, Mask, Generator };
}

export const canonicalSchemas = makeSchemas(z.number().int());
export const inputSchemas = makeSchemas(z.union([z.number().int(), z.string()]));

export type ProjectFile = z.infer<typeof canonicalSchemas.File>;
export type ProjectSettings = z.infer<typeof canonicalSchemas.Project>;
export type Asset = z.infer<typeof canonicalSchemas.Asset>;
export type Comp = z.infer<typeof canonicalSchemas.Comp>;
export type Track = z.infer<typeof canonicalSchemas.Track>;
export type Clip = z.infer<typeof canonicalSchemas.Clip>;
export type Cue = z.infer<typeof canonicalSchemas.Cue>;
export type Bus = z.infer<typeof canonicalSchemas.Bus>;
export type Marker = z.infer<typeof canonicalSchemas.Marker>;
export type Style = z.infer<typeof canonicalSchemas.Style>;
export type TextStyle = z.infer<typeof canonicalSchemas.TextStyle>;
export type TextAnimate = z.infer<typeof canonicalSchemas.TextAnimate>;
export type ShapeSpec = z.infer<typeof canonicalSchemas.ShapeSpec>;
export type EffectInstance = z.infer<typeof canonicalSchemas.Effect>;
export type TransitionInstance = z.infer<typeof canonicalSchemas.Transition>;
export type Mask = z.infer<typeof canonicalSchemas.Mask>;
export type GeneratorInstance = z.infer<typeof canonicalSchemas.Generator>;
export type Easing = z.infer<typeof Easing>;
export type Keyframe<V> = [number, V] | [number, V, Easing];
export type Animatable<V> = V | Keyframe<V>[];

/** The tables of a project file, in file order. */
export const TABLES = ['assets', 'styles', 'comps', 'tracks', 'clips', 'cues', 'buses', 'markers'] as const;
export type TableName = (typeof TABLES)[number];
export type Entity = Asset | Style | Comp | Track | Clip | Cue | Bus | Marker;

/** Clip source keys: exactly one must be present. */
export const CLIP_SOURCES = ['asset', 'text', 'shape', 'color', 'comp', 'captions', 'adjustment', 'gen'] as const;
export type ClipKind = 'media' | 'text' | 'shape' | 'solid' | 'comp' | 'captions' | 'adjustment' | 'gen';
export function clipKind(c: Clip): ClipKind {
  if (c.asset !== undefined) return 'media';
  if (c.text !== undefined) return 'text';
  if (c.shape !== undefined) return 'shape';
  if (c.color !== undefined) return 'solid';
  if (c.comp !== undefined) return 'comp';
  if (c.captions) return 'captions';
  if (c.adjustment) return 'adjustment';
  return 'gen';
}

/** Time-valued fields per table (normalised from edge forms to frames on load). */
export const TIME_FIELDS: Record<TableName, string[]> = {
  assets: [],
  styles: [],
  comps: ['length'],
  tracks: [],
  clips: ['at', 'len', 'in', 'clock'],
  cues: ['at', 'len'],
  buses: [],
  markers: ['at', 'len'],
};

/** Key order per table when writing (keys not listed follow in schema order, then alphabetically). */
export const KEY_ORDER: Record<TableName, string[]> = {
  assets: ['id', 'src', 'kind', 'note'],
  styles: ['id', 'base', 'font', 'size', 'weight', 'italic', 'color', 'align', 'lineHeight', 'letterSpacing', 'stroke', 'strokeWidth', 'shadow', 'shadowBlur', 'shadowOffset', 'bg', 'bgPadding', 'bgRadius', 'maxWidth', 'maxLines', 'box', 'uppercase', 'highlight', 'maxWords'],
  comps: ['id', 'size', 'fps', 'length', 'bg', 'note'],
  tracks: ['id', 'comp', 'audio', 'bus', 'hidden', 'muted', 'locked', 'note'],
  clips: ['id', 'track', 'at', 'len', ...CLIP_SOURCES, 'in', 'speed', 'loop', 'fit', 'crop', 'style', 'animate', 'x', 'y', 'anchor', 'scale', 'rotate', 'opacity',
    'blend', 'parent', 'matte', 'remap', 'link', 'gain', 'fade', 'muted', 'fx', 'masks', 'transition', 'clock', 'hidden', 'locked', 'tags', 'note'],
  cues: ['id', 'clip', 'at', 'len', 'text', 'words', 'speaker'],
  buses: ['id', 'to', 'gain', 'muted', 'duck', 'loudness'],
  markers: ['id', 'comp', 'at', 'len', 'note'],
};
