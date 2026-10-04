/**
 * Recipes: one call that composes existing commands into a finished piece.
 *
 * recipe.short builds a vertical Short from a script (plus optional voice-over, b-roll and music): moving
 * backgrounds that change per sentence (media with ken-burns / punch-ins, or animated generators), a hook title,
 * word-highlighted captions timed to the voice (or to reading speed), a progress bar, a CTA, music with ducking,
 * loudness for the platform and rotating transitions. Every step is an ordinary command run on the same draft, so
 * the result is one undoable edit, deterministic for the same inputs, and the project stays editable line by line.
 */
import { z } from 'zod';
import { MglError, fail } from '../errors.js';
import { defineCommand, getCommand, listCommands, TimeArg, type Command, type CommandContext, type CommandDef } from './registry.js';
import { Id, type Clip, type Comp, type ProjectFile } from '../schema/index.js';
import { kindFromExtension } from './structure.js';
import { emphasisWords, stripEmphasis } from '../captions.js';

/** Reading speed used to time captions when there is no voice-over (words per second). */
export const READING_WPS = 2.6;

/** Inner margins (left, top, right, bottom) that keep text clear of the UI of every vertical platform. */
const VERTICAL_MARGINS: [number, number, number, number] = [0.05, 0.1, 0.14, 0.21];
const OTHER_MARGINS: [number, number, number, number] = [0.05, 0.05, 0.05, 0.05];

export const SHORT_STYLES = ['clean', 'bold', 'viral'] as const;
export type ShortStyle = (typeof SHORT_STYLES)[number];

type Palette = [string, string];
type Look = {
  accent: string;
  /** hook title style (sizes for a 1080 px wide frame) */
  hook: Record<string, unknown>;
  caption: Record<string, unknown>;
  maxWords: number;
  /** caption pages pop in (a short scale bump at every cue) */
  pop: boolean;
  palettes: Palette[];
  /** background generator per sentence, cycled */
  gens: ('linear' | 'dots' | 'stripes' | 'noise')[];
  transitions: { type: string; params?: Record<string, unknown> }[];
  /** transition length in seconds */
  tr: number;
  particles: boolean;
  ctaColor: string;
  music: string;
};

/** The three looks. Dark, saturated backgrounds keep white captions and the highlight colour readable. */
export const LOOKS: Record<ShortStyle, Look> = {
  viral: {
    accent: '#ffe14d',
    hook: { font: 'Anton', size: 112, color: '#ffffff', bg: '#ff2d55', bgPadding: [34, 14], bgRadius: 22, uppercase: true, align: 'center', lineHeight: 1.14, maxLines: 3 },
    caption: { font: 'Inter', weight: 900, size: 84, color: '#ffffff', stroke: '#000000', strokeWidth: 12, uppercase: true, highlight: '#ffe14d', emphasisColor: '#4ade80', align: 'center', lineHeight: 1.08, maxLines: 2, shadow: '#000000b3', shadowBlur: 18, shadowOffset: [0, 6] },
    maxWords: 3, pop: true,
    palettes: [['#2b0a3d', '#b5179e'], ['#03045e', '#0096c7'], ['#3d0c02', '#e85d04'], ['#10002b', '#7b2cbf'], ['#002b36', '#00a896'], ['#370617', '#d00000']],
    gens: ['linear', 'noise', 'linear', 'linear', 'noise', 'linear'],
    transitions: [{ type: 'zoom', params: { scale: 1.35 } }, { type: 'push', params: { direction: 'up' } }, { type: 'slide', params: { direction: 'left' } }, { type: 'blur' }, { type: 'wipe', params: { direction: 'up', softness: 0.12 } }, { type: 'crossfade' }],
    tr: 0.35, particles: true, ctaColor: '#ff2d55', music: 'energetic',
  },
  bold: {
    accent: '#ffd400',
    hook: { font: 'Anton', size: 120, color: '#111111', bg: '#ffd400', bgPadding: [34, 14], bgRadius: 10, uppercase: true, align: 'center', lineHeight: 1.14, maxLines: 3 },
    caption: { font: 'Anton', size: 96, color: '#ffffff', stroke: '#000000', strokeWidth: 10, uppercase: true, highlight: '#ffd400', emphasisColor: '#ff5a4e', align: 'center', lineHeight: 1.05, maxLines: 2, shadow: '#000000aa', shadowBlur: 12, shadowOffset: [0, 5] },
    maxWords: 3, pop: true,
    palettes: [['#111111', '#3a3a3a'], ['#1b1b1b', '#5c4a00'], ['#0d0d0d', '#2e2e2e'], ['#1a1300', '#6b5600']],
    gens: ['linear', 'stripes', 'linear', 'noise'],
    transitions: [{ type: 'push', params: { direction: 'left' } }, { type: 'slide', params: { direction: 'up' } }, { type: 'wipe', params: { direction: 'left', softness: 0.05 } }, { type: 'zoom', params: { scale: 1.25 } }],
    tr: 0.3, particles: false, ctaColor: '#ffd400', music: 'driving',
  },
  clean: {
    accent: '#7dd3fc',
    hook: { font: 'Inter', weight: 800, size: 96, color: '#ffffff', shadow: '#00000099', shadowBlur: 16, shadowOffset: [0, 4], align: 'center', lineHeight: 1.12, maxLines: 3 },
    caption: { font: 'Inter', weight: 700, size: 64, color: '#ffffff', highlight: '#7dd3fc', emphasisColor: '#fcd34d', align: 'center', lineHeight: 1.18, maxLines: 2, shadow: '#000000cc', shadowBlur: 14, shadowOffset: [0, 3] },
    maxWords: 4, pop: false,
    palettes: [['#0f172a', '#1e3a5f'], ['#13293d', '#006494'], ['#1b263b', '#415a77'], ['#102a2a', '#1f6f6f']],
    gens: ['linear', 'noise', 'linear', 'linear'],
    transitions: [{ type: 'crossfade' }, { type: 'blur' }, { type: 'crossfade' }, { type: 'zoom', params: { scale: 1.15 } }],
    tr: 0.5, particles: false, ctaColor: '#0369a1', music: 'calm',
  },
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Run another command on the same draft. Its summary is dropped; its notes are kept (minus routine ones). */
async function step(ctx: CommandContext, notes: string[], cmd: Command): Promise<Record<string, unknown>> {
  const def = getCommand(cmd.op);
  const { op: _op, ...payload } = cmd;
  const r = def.schema.safeParse(payload);
  if (!r.success) {
    const i = r.error.issues[0]!;
    fail('E_RECIPE', `recipe.short: the ${cmd.op} step was refused (${i.path.join('.') || 'payload'}: ${i.message}).`, 'this is a bug in the recipe; build the short step by step meanwhile (mgl docs recipes).');
  }
  const sub: CommandContext = { ...ctx, out: {}, summary: () => {}, note: (m) => notes.push(m) };
  await def.apply(sub, r.data as never);
  return sub.out;
}

/** The project's tables and settings, to undo an optional step that failed half way. */
function snapshot(p: ProjectFile): ProjectFile { return structuredClone(p); }
function restore(p: ProjectFile, s: ProjectFile) {
  for (const k of Object.keys(p)) if (!(k in s)) delete (p as Record<string, unknown>)[k];
  Object.assign(p, structuredClone(s));
}

/**
 * Run a command that a plugin may provide (audio.music, audio.auto-sfx), with whichever of `want`'s fields its
 * schema accepts. Returns why it was skipped, or undefined when it ran. Never leaves a half-applied step.
 */
async function optional(ctx: CommandContext, notes: string[], op: string, want: Record<string, unknown>): Promise<string | undefined> {
  const def: CommandDef | undefined = listCommands().find((c) => c.op === op);
  if (!def) return 'not installed';
  const shape = def.schema.shape as Record<string, unknown>;
  let payload = Object.fromEntries(Object.entries(want).filter(([k, v]) => k in shape && v !== undefined));
  let parsed = def.schema.safeParse(payload);
  for (let n = 0; n < 8 && !parsed.success; n++) {
    // drop the fields this command reads differently; a required field we cannot fill skips the step
    const bad = new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '')).filter((k) => k in payload));
    if (!bad.size) break;
    payload = Object.fromEntries(Object.entries(payload).filter(([k]) => !bad.has(k)));
    parsed = def.schema.safeParse(payload);
  }
  if (!parsed.success) return `its fields did not fit (${parsed.error.issues[0]!.message})`;
  const before = snapshot(ctx.project);
  try {
    const sub: CommandContext = { ...ctx, out: {}, summary: () => {}, note: (m) => notes.push(m) };
    await def.apply(sub, parsed.data as never);
    return undefined;
  } catch (e) {
    restore(ctx.project, before);
    if (e instanceof MglError) return e.message;
    throw e;
  }
}

/** Sentences of a script (keeps their punctuation). */
export function sentences(script: string): string[] {
  return script.replace(/\r/g, '').split(/(?<=[.!?…]\*?)\s+|\n+/).map((s) => s.trim()).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

const NUMBER_WORDS = new Set(['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'fifteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'billion', 'first', 'second', 'third', 'fourth', 'fifth', 'half', 'double', 'twice', 'percent']);

/** ("one" is left out: "the one task" is not a count) */
/**
 * Caption keywords: words the script marks *like this* are kept as they are; a script with no marks gets its
 * numbers emphasised (digits, number words, ordinals: "three habits", "10x", "First,"), the words viewers scan for.
 */
export function markKeywords(script: string): string {
  if (/\*\S/.test(script)) return script;
  return script.replace(/[^\s]+/g, (t) => {
    const core = t.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, '');
    if (!core || !(/\d/.test(core) || NUMBER_WORDS.has(core.toLowerCase()))) return t;
    const i = t.indexOf(core);
    return `${t.slice(0, i)}*${core}*${t.slice(i + core.length)}`;
  });
}

/** Words a caption page should not end on (articles, prepositions, conjunctions). */
const WEAK = new Set(['a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'and', 'or', 'but', 'with', 'from', 'my', 'your', 'our', 'is', 'are', 'it', 'that', 'this']);

/**
 * The script as caption lines: each sentence split into balanced pages of at most `max` words (7 words at 3 →
 * 3 + 2 + 2, never 3 + 3 + 1), moving a break so a page does not end on a weak word when the sizes allow it.
 */
export function captionLines(script: string, max: number): string {
  return sentences(script).map((s) => {
    const w = s.split(/\s+/).filter(Boolean);
    const parts = Math.ceil(w.length / max);
    if (parts <= 1) return w.join(' ');
    const sizes = Array.from({ length: parts }, (_, i) => Math.floor(w.length / parts) + (i < w.length % parts ? 1 : 0));
    for (let i = 0; i < parts - 1; i++) {
      const end = sizes.slice(0, i + 1).reduce((a, b) => a + b, 0);
      const weak = (k: number) => WEAK.has(w[k - 1]!.toLowerCase().replace(/[^a-z']/g, ''));
      if (!weak(end)) continue;
      // never leave a one-word page behind
      if (sizes[i]! < max && sizes[i + 1]! > 2 && !weak(end + 1)) { sizes[i]!++; sizes[i + 1]!--; }
      else if (sizes[i]! > 2 && sizes[i + 1]! < max && !weak(end - 1)) { sizes[i]!--; sizes[i + 1]!++; }
    }
    const out: string[] = [];
    let k = 0;
    for (const n of sizes) { out.push(w.slice(k, k + n).join(' ')); k += n; }
    return out.join('\n');
  }).join('\n');
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** The hook line: the first sentence, shortened to a clause or 8 words when it is long. */
export function hookText(first: string): { text: string; whole: boolean } {
  const words = first.split(/\s+/).filter(Boolean);
  const strip = (s: string) => s.replace(/[.,;:]+$/, '');
  if (words.length <= 9) return { text: strip(first), whole: true };
  const comma = words.findIndex((w, i) => i >= 1 && i < 9 && /[,;:—]$/.test(w));
  if (comma >= 0) return { text: strip(words.slice(0, comma + 1).join(' ')), whole: false };
  return { text: words.slice(0, 8).join(' ').replace(/[.,;:]+$/, '') + '…', whole: false };
}

/** Background segments: [start, end) frames that change at sentence ends, merged when short, split when long. */
export function segmentTimes(bounds: number[], total: number, minLen: number, maxLen: number): [number, number][] {
  const cuts = [...new Set(bounds.filter((b) => b > 0 && b < total))].sort((a, b) => a - b);
  const raw: [number, number][] = [];
  let prev = 0;
  for (const c of [...cuts, total]) { if (c > prev) raw.push([prev, c]); prev = c; }
  const merged: [number, number][] = [];
  for (const s of raw) {
    const last = merged[merged.length - 1];
    if (last && (s[1] - s[0] < minLen || last[1] - last[0] < minLen)) last[1] = s[1];
    else merged.push([...s]);
  }
  const out: [number, number][] = [];
  for (const [a, b] of merged) {
    const n = Math.max(1, Math.ceil((b - a) / maxLen));
    for (let i = 0; i < n; i++) out.push([a + Math.round(((b - a) * i) / n), a + Math.round(((b - a) * (i + 1)) / n)]);
  }
  return out;
}

const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
/** Scale a 1080-wide style to the frame (sizes, stroke, padding, shadow), with a minimum readable size. */
function scaled(style: Record<string, unknown>, u: number, minSize: number): Record<string, unknown> {
  const s = { ...style };
  if (typeof s.size === 'number') s.size = Math.max(minSize, Math.round(s.size * u));
  for (const k of ['strokeWidth', 'shadowBlur', 'bgRadius'] as const) if (typeof s[k] === 'number') s[k] = round((s[k] as number) * u, 1);
  for (const k of ['bgPadding', 'shadowOffset'] as const) if (Array.isArray(s[k])) s[k] = (s[k] as number[]).map((v) => round(v * u, 1));
  return s;
}

function mainComp(ctx: CommandContext): Comp {
  const id = ctx.project.project?.main ?? (ctx.project.comps.find((c) => c.id === 'main') ?? ctx.project.comps[0]!).id;
  return ctx.comp(id);
}

/** A track of the comp: the existing one with that id, else the first matching one, else a new one. */
async function ensureTrack(ctx: CommandContext, notes: string[], comp: Comp, want: { id: string; audio?: boolean; bus?: string; above?: string }): Promise<string> {
  const tracks = (ctx.project.tracks ?? []).filter((t) => t.comp === comp.id);
  const same = tracks.find((t) => t.id === want.id && !!t.audio === !!want.audio);
  if (same) return same.id;
  if (want.audio) {
    const byBus = tracks.find((t) => t.audio && (t.bus ?? 'dialogue') === want.bus);
    if (byBus) return byBus.id;
  }
  const taken = (id: string) => (ctx.project.tracks ?? []).some((t) => t.id === id) || (ctx.project.clips ?? []).some((c) => c.id === id) || ctx.project.comps.some((c) => c.id === id);
  let id = want.id;
  for (let n = 2; taken(id); n++) id = `${want.id}-${n}`;
  const above = want.above && tracks.some((t) => t.id === want.above) ? want.above : undefined;
  await step(ctx, notes, { op: 'track.add', id, comp: comp.id, ...(want.audio ? { audio: true } : {}), ...(want.bus ? { bus: want.bus } : {}), ...(above ? { above } : {}) });
  return id;
}

// ---------------------------------------------------------------------------
// recipe.short
// ---------------------------------------------------------------------------

const ShortSchema = z.strictObject({
  script: z.string().min(1).describe('the narration: text, or a path to a .txt/.md file (relative to the project)'),
  vo: z.string().min(1).optional().describe('voice-over: a clip id, an asset id or a file path; captions follow its speech'),
  voice: z.union([z.literal(true), z.string().min(1)]).optional().describe('speak the script with the project\'s speak provider (a plugin, e.g. flite-voice): true = its default voice, or a voice id; captions follow the word timings'),
  media: z.array(z.string().min(1)).optional().describe('b-roll videos/images, cycled every ~2-3 s with ken-burns and punch-ins'),
  style: z.enum(SHORT_STYLES).optional().describe('clean | bold | viral (default viral)'),
  len: TimeArg.optional().describe('total length (default: the voice-over, or the script at reading speed, plus the CTA)'),
  music: z.union([z.boolean(), z.string().min(1)]).optional().describe('true (default): a generated bed when the audio.music command exists; a path: that file; false: none'),
  captions: z.boolean().optional(),
  hook: z.boolean().optional(),
  cta: z.union([z.string().min(1), z.literal(false)]).optional().describe('the end call-to-action label (default "Follow for more"); false: none'),
  platform: z.enum(['shorts', 'tiktok', 'reels', 'youtube', 'none']).optional(),
  seed: z.number().int().min(0).optional().describe('varies palettes, transitions and media order (default 0)'),
  comp: Id.optional(),
});

export type ShortArgs = z.infer<typeof ShortSchema>;

defineCommand({
  op: 'recipe.short', group: 'recipes',
  doc: 'Build a finished vertical Short in one call from a script (text or file): moving backgrounds per sentence (b-roll with ken-burns and punch-ins, or animated generators), a hook title, word-highlighted captions timed to the voice-over (a recording via vo=, or speech made from the script via voice= with a speak plugin; else reading speed), a progress bar, a CTA, music with ducking, platform loudness and rotating transitions. Needs an empty comp (mgl new shorts --script s.txt runs it).',
  schema: ShortSchema,
  primary: 'script',
  example: { script: 'Most people waste their mornings. Here are three habits that changed mine. Try them for a week.', style: 'viral', cta: 'Follow for more' },
  async apply(ctx, p) {
    const notes: string[] = [];
    if (p.vo && p.voice !== undefined) fail('E_ARG', 'recipe.short takes vo= (a recording) or voice= (speech made from the script), not both.', 'drop voice= to use the recording, or drop vo= to speak the script.');
    const comp = p.comp ? ctx.comp(p.comp) : mainComp(ctx);
    const compTracks = new Set((ctx.project.tracks ?? []).filter((t) => t.comp === comp.id).map((t) => t.id));
    // the voice-over clip named by vo= (made first, e.g. by audio.speak) is the one clip allowed in the comp
    const existing = (ctx.project.clips ?? []).filter((c) => compTracks.has(c.track) && c.id !== p.vo);
    if (existing.length) fail('E_NOT_EMPTY', `comp "${comp.id}" already has ${existing.length} clip(s); recipe.short builds a whole Short into an empty comp.`, 'start a new project: mgl new shorts -o short.mgl.json --script script.txt (or pass comp=<an empty comp>).');
    const style: ShortStyle = p.style ?? 'viral';
    const look = LOOKS[style];
    const seed = p.seed ?? 0;
    const rate = ctx.rate(comp);
    const fr = (sec: number) => Math.round((sec * rate.num) / rate.den);
    const sec = (f: number) => (f * rate.den) / rate.num;
    const [W, H] = comp.size;
    const vertical = H / W > 1.3;
    const u = Math.min(W, H) / 1080;
    const catalog = ctx.services.catalog;

    // platform: given, else keep the project's, else shorts for a vertical frame
    if (p.platform) await step(ctx, notes, { op: 'project.set', platform: p.platform });
    else if (!ctx.project.project?.platform && vertical) await step(ctx, notes, { op: 'project.set', platform: 'shorts' });

    // the script: inline text, or a file when it is a single path-like word
    let script = p.script;
    if (!/\s/.test(script.trim()) && /\.(txt|md|text)$/i.test(script.trim())) {
      if (!ctx.services.readText) fail('E_NO_SERVICE', 'reading files is not available here.', 'pass the script text itself as script="...".');
      try { script = await ctx.services.readText(script.trim()); } catch (e) { fail('E_NO_FILE', `cannot read ${p.script}: ${(e as Error).message}`, 'give the script path relative to the project file, or the text itself.'); }
    }
    script = script.replace(/\r/g, '').trim();
    const sents = sentences(script);
    if (!sents.length) fail('E_ARG', 'the script has no words.', 'write the narration as plain sentences.');
    const words = wordCount(script);

    // layout: a centred column clear of every vertical platform's UI
    const [ml, mt, mr, mb] = vertical ? VERTICAL_MARGINS : OTHER_MARGINS;
    const half = Math.min(W / 2 - W * ml, W * (1 - mr) - W / 2);
    const colW = Math.round(2 * half - 40 * u);
    const safeTop = H * mt, safeBottom = H * (1 - mb);
    const minText = Math.ceil(0.03 * H);

    // tracks: backgrounds, decoration, captions, hook (templates stack above on their own)
    const tBg = await ensureTrack(ctx, notes, comp, { id: 'V1' });
    const tDecor = await ensureTrack(ctx, notes, comp, { id: 'V2', above: tBg });
    const tCap = await ensureTrack(ctx, notes, comp, { id: 'T1', above: tDecor });
    const tHook = await ensureTrack(ctx, notes, comp, { id: 'T2', above: tCap });

    // voice-over: a clip, an asset or a file; or speech made from the script (voice=)
    let vo: Clip | undefined;
    let spoken = false;
    if (p.voice !== undefined) {
      const tVo = await ensureTrack(ctx, notes, comp, { id: 'A1', audio: true, bus: 'dialogue' });
      const out = await step(ctx, notes, { op: 'audio.speak', text: stripEmphasis(script).replace(/\s+/g, ' '), id: 'vo', track: tVo, at: 0, ...(typeof p.voice === 'string' ? { voice: p.voice } : {}) });
      vo = ctx.clip(out.id as string);
      spoken = true;
    } else if (p.vo) {
      const tVo = await ensureTrack(ctx, notes, comp, { id: 'A1', audio: true, bus: 'dialogue' });
      const clip = (ctx.project.clips ?? []).find((c) => c.id === p.vo);
      if (clip) {
        vo = clip;
        // a line made by audio.speak carries word timings: caption from them
        spoken = /^media\/generated\/vo-/.test((ctx.project.assets ?? []).find((a) => a.id === clip.asset)?.src ?? '');
      }
      else {
        const asset = (ctx.project.assets ?? []).find((a) => a.id === p.vo);
        const kind = asset ? asset.kind ?? kindFromExtension(asset.src) : kindFromExtension(p.vo);
        if (kind !== 'audio' && kind !== 'video') fail('E_ARG', `vo "${p.vo}" is not an audio or video file, clip or asset.`, 'give the voice-over as a path like vo.wav (relative to the project), or the id of its clip/asset.');
        const out = await step(ctx, notes, { op: 'clip.add', id: 'vo', track: tVo, at: 0, ...(asset ? { asset: asset.id } : { src: p.vo }) });
        vo = ctx.clip(out.id as string);
      }
    }

    // timing
    const reading = Math.max(fr(2), fr(words / READING_WPS));
    const speechEnd = vo ? vo.at + vo.len : reading;
    const ctaOn = p.cta !== false;
    const ctaLen = ctaOn ? fr(2.5) : 0;
    // the CTA comes in during the last second of speech and holds a moment after it
    let total = Math.max(speechEnd + fr(0.5), speechEnd - fr(1) + ctaLen);
    if (p.len !== undefined) {
      const want = ctx.time(p.len, comp, 'len');
      if (vo && want < speechEnd) fail('E_RANGE', `len ${want} is shorter than the voice-over (${speechEnd} frames).`, `use len ≥ ${speechEnd} (${sec(speechEnd).toFixed(2)}s), or trim the voice-over first.`);
      if (want < fr(3)) fail('E_RANGE', `len ${want} is too short for a Short.`, 'give at least 3s.');
      total = want;
    }
    const ctaAt = Math.max(0, total - ctaLen);
    const capEnd = vo ? speechEnd : Math.max(fr(1), Math.min(reading, total - fr(0.5)));
    if (typeof comp.length === 'number') comp.length = total;

    // styles in the project, so the agent can retune them with one style.set
    const styleId = async (base: string, s: Record<string, unknown>) => {
      let id = base;
      for (let n = 2; (ctx.project.styles ?? []).some((x) => x.id === id); n++) id = `${base}${n}`;
      await step(ctx, notes, { op: 'style.add', id, ...s });
      return id;
    };
    const capOn = p.captions !== false;
    const capStyle = capOn ? await styleId(`${style}-caption`, { ...scaled(look.caption, u, minText), maxWidth: colW, maxWords: look.maxWords }) : 'caption';
    const hookBase = scaled(look.hook, u, minText);
    const padX = Array.isArray(hookBase.bgPadding) ? (hookBase.bgPadding as number[])[0]! : 0;
    // the box (plus its padding) stays inside the column while the hook slowly pushes in (scale 1.04)
    const hookStyle = await styleId(`${style}-hook`, { ...hookBase, maxWidth: Math.round((colW - 2 * padX) / 1.05) });

    // captions (all sentences; the hook sentence's cues are dropped later when the hook shows it)
    let capId: string | undefined;
    let cueEnds: { end: number; text: string }[] = [];
    if (capOn || p.hook !== false) {
      // speech made here carries word timings: captions follow them word by word
      const marked = markKeywords(script);
      const out = spoken
        ? await step(ctx, notes, { op: 'captions.from-speech', clip: vo!.id, id: 'captions', track: tCap, style: capStyle, maxWords: look.maxWords })
        : await step(ctx, notes, { op: 'captions.from-text', text: captionLines(marked, look.maxWords), id: 'captions', track: tCap, style: capStyle, maxWords: look.maxWords,
          ...(vo ? { voice: vo.id } : { at: 0, len: capEnd }) });
      capId = out.clip as string;
      // spoken cues hold the plain words in script order: put the keyword marks back
      if (spoken) {
        // (the voice must speak this script for the marks to line up; the word counts are checked)
        const tokens = marked.split(/\s+/).filter(Boolean);
        const cues = (ctx.project.cues ?? []).filter((q) => q.clip === capId).sort((a, b) => a.at - b.at);
        if (cues.reduce((n, q) => n + emphasisWords(q.text).length, 0) === tokens.length) {
          let k = 0;
          for (const q of cues) { const n = emphasisWords(q.text).length; q.text = tokens.slice(k, k + n).join(' '); k += n; }
        }
      }
      const cap = ctx.clip(capId);
      cueEnds = (ctx.project.cues ?? []).filter((q) => q.clip === capId).map((q) => ({ end: cap.at + q.at + q.len, text: q.text }));
    }

    // hook: the first sentence, big, for as long as it is spoken / read (1.5–4 s)
    let hookEnd = 0;
    if (p.hook !== false) {
      const h = hookText(stripEmphasis(sents[0]!));
      const firstEnd = cueEnds.find((q) => /[.!?…]["')\]*]*$/.test(q.text))?.end;
      const dropCues = sents.length > 1 && h.whole && firstEnd !== undefined && firstEnd <= fr(4.5) && firstEnd >= fr(1);
      hookEnd = dropCues ? firstEnd! : Math.min(fr(2.2), total - 1);
      hookEnd = Math.max(fr(1.2), Math.min(hookEnd, ctaAt > fr(1.5) ? ctaAt : total));
      const hookY = Math.round(vertical ? H * 0.36 : H * 0.4);
      await step(ctx, notes, { op: 'clip.add', id: 'hook', track: tHook, at: 0, len: hookEnd, text: h.text, style: hookStyle, y: hookY,
        animate: { in: style === 'clean' ? 'slide-up' : 'pop', by: 'word' }, fade: [0, Math.min(fr(0.2), Math.floor(hookEnd / 4))],
        scale: style === 'clean' ? [[0, 1], [Math.max(1, hookEnd - 1), 1.04]] : [[0, 0.7, 'outBack'], [fr(0.2), 1], [Math.max(fr(0.2) + 1, hookEnd - 1), 1.04]] });
      if (capId && dropCues) {
        const cap = ctx.clip(capId);
        if (hookEnd > cap.at && hookEnd < cap.at + cap.len) {
          await step(ctx, notes, { op: 'clip.trim', id: capId, start: hookEnd });
          // cue times moved with the trim; the captions have no animation clock to keep
          delete ctx.clip(capId).clock;
        }
      }
      if (capId && !capOn) {
        await step(ctx, notes, { op: 'clip.remove', ids: [capId] });
        capId = undefined;
      }
    }

    // captions: lower middle, a pop at every page
    if (capId) {
      const cap = ctx.clip(capId);
      const capY = Math.round(vertical ? Math.min(safeBottom - 200 * u, H * 0.64) : H * 0.8);
      const sets: Command[] = [{ op: 'clip.set', id: capId, y: capY }];
      if (look.pop) {
        const cues = (ctx.project.cues ?? []).filter((q) => q.clip === capId);
        const starts = new Set(cues.map((q) => q.at));
        const keys: [number, number, string?][] = [];
        const b = Math.max(2, fr(0.12));
        for (const s of [...starts].sort((x, y) => x - y)) {
          if (s + b >= cap.len) continue;
          if (keys.length && keys[keys.length - 1]![0] >= s) continue;
          keys.push([s, 0.86, 'outBack'], [s + b, 1]);
        }
        if (keys.length >= 2) sets.push({ op: 'clip.set', id: capId, scale: keys });
      }
      for (const c of sets) await step(ctx, notes, c);
    }

    // backgrounds: change at the hook and at sentence ends, ~2–3 s each
    const bounds = [hookEnd, ...cueEnds.filter((q) => /[.!?…]["')\]*]*$/.test(q.text)).map((q) => q.end)];
    const trLen = fr(look.tr);
    const media = p.media ?? [];
    const segs = segmentTimes(bounds, total, fr(1.6), fr(media.length ? 2.6 : 3.4));
    const bgIds: string[] = [];
    if (media.length) {
      // b-roll: cycle the files; videos play a fresh part each time, with handles for the transitions
      const infos = await Promise.all(media.map(async (src) => {
        const kind = kindFromExtension(src);
        if (kind !== 'video' && kind !== 'image') fail('E_ARG', `media "${src}" is not a video or image.`, 'give b-roll as video (.mp4, .mov, .webm) or image (.jpg, .png) paths relative to the project.');
        let dur: number | undefined;
        if (kind === 'video' && ctx.services.probe) { try { dur = (await ctx.services.probe(src)).duration; } catch { dur = undefined; } }
        return { src, kind, frames: dur ? Math.floor((dur * rate.num) / rate.den) - 1 : undefined, used: 0 };
      }));
      const handle = Math.ceil(trLen / 2);
      // split segments that are longer than a short source allows
      const pieces: [number, number][] = [];
      const shortest = Math.min(...infos.map((m) => (m.frames === undefined ? Infinity : m.frames - handle)));
      const maxPiece = Math.max(fr(1), Number.isFinite(shortest) ? shortest : Infinity);
      for (const [a, b] of segs) {
        const n = Math.max(1, Math.ceil((b - a) / maxPiece));
        for (let i = 0; i < n; i++) pieces.push([a + Math.round(((b - a) * i) / n), a + Math.round(((b - a) * (i + 1)) / n)]);
      }
      for (const [i, [a, b]] of pieces.entries()) {
        const m = infos[(i + seed) % infos.length]!;
        const len = b - a;
        const id = `bg${i + 1}`;
        let inF: number | undefined;
        if (m.kind === 'video') {
          const avail = m.frames ?? Infinity;
          const start = Math.max(handle, m.used);
          inF = start + len <= avail ? start : Math.max(0, Math.min(handle, avail - len));
          m.used = inF + len;
        }
        await step(ctx, notes, { op: 'clip.add', id, track: tBg, at: a, len, src: m.src, fit: 'cover', ...(inF ? { in: inF } : {}), ...(m.kind === 'video' ? { muted: true } : {}) });
        // motion: ken-burns on even shots, a punch-in on odd ones
        if (i % 2 === 0 || len < fr(1.2)) {
          const dir = (i / 2) % 2 === 0 ? 1 : -1;
          await step(ctx, notes, { op: 'clip.set', id, scale: [[0, 1.02], [len - 1, 1.14, 'inOutSine']], x: [[0, W / 2], [len - 1, Math.round(W / 2 + dir * 0.035 * W), 'inOutSine']] });
        } else {
          const bw = Math.round(W * 0.72), bh = Math.round(H * 0.72);
          const bx = Math.round((W - bw) / 2 + ((i % 3) - 1) * 0.08 * W), by = Math.round((H - bh) / 2 - 0.04 * H);
          await step(ctx, notes, { op: 'clip.punch-in', id, box: [bx, by, bw, bh], at: a + Math.round(len * 0.35), len: Math.max(2, fr(0.25)), ease: 'outCubic' });
        }
        bgIds.push(id);
      }
      // a soft shade over the b-roll so white captions stay readable (translucent: not an overlap for QA)
      await step(ctx, notes, { op: 'clip.add', id: 'shade', track: tDecor, at: 0, len: total, gen: { type: 'gradient', colors: ['#00000000', '#000000'], angle: 90 }, opacity: 0.35, tags: ['role:watermark'] });
    } else {
      // generators: a new animated background per sentence
      const n = look.palettes.length;
      for (const [i, [a, b]] of segs.entries()) {
        const pal = look.palettes[(i + seed) % n]!;
        const kind = look.gens[(i + seed) % look.gens.length]!;
        const gen: Record<string, unknown> = kind === 'linear' ? { type: 'gradient', colors: i % 2 ? [pal[1], pal[0]] : pal, angle: (60 + 50 * i) % 360, animate: i % 2 ? -16 : 16 }
          : kind === 'noise' ? { type: 'noise', colors: [pal[0], pal[1]], scale: Math.round(380 * u), speed: 0.2, octaves: 2, seed: seed + i }
          : { type: 'pattern', kind, colors: [pal[0], `${pal[1]}${kind === 'dots' ? '66' : '4d'}`], size: Math.round((kind === 'dots' ? 54 : 96) * u), angle: kind === 'stripes' ? 45 : 0, speed: Math.round(30 * u) };
        await step(ctx, notes, { op: 'clip.add', id: `bg${i + 1}`, track: tBg, at: a, len: b - a, gen });
        bgIds.push(`bg${i + 1}`);
      }
      // depth and motion over the whole piece: a slow glow, plus drifting particles for the loud looks
      await step(ctx, notes, { op: 'clip.add', id: 'glow', track: tDecor, at: 0, len: total, shape: { type: 'ellipse', size: [Math.round(W * 0.9), Math.round(W * 0.9)], fill: look.accent }, opacity: 0.18, tags: ['role:watermark'],
        x: [[0, Math.round(W * 0.25)], [total - 1, Math.round(W * 0.75), 'inOutSine']], y: [[0, Math.round(H * 0.3)], [total - 1, Math.round(H * 0.62), 'inOutSine']], fx: [{ type: 'blur', radius: Math.round(160 * u), edges: 'transparent' }] });
      if (look.particles) {
        const tP = await ensureTrack(ctx, notes, comp, { id: 'V3', above: tDecor });
        await step(ctx, notes, { op: 'clip.add', id: 'particles', track: tP, at: 0, len: total, gen: { type: 'particles', count: 46, size: Math.round(7 * u), speed: Math.round(70 * u), color: '#ffffff', seed, twinkle: 0.6 }, opacity: 0.3, tags: ['role:watermark'] });
      }
    }

    // transitions at every background cut, rotating through the look's (never flash)
    if (catalog) {
      const kinds = look.transitions.filter((t) => catalog.transitions.has(t.type));
      for (let i = 1; i < bgIds.length && kinds.length; i++) {
        const c = ctx.clip(bgIds[i]!), prev = ctx.clip(bgIds[i - 1]!);
        const len = Math.min(trLen, Math.floor(c.len / 2), Math.floor(prev.len / 2));
        if (len < 2) continue;
        const t = kinds[(i - 1 + seed) % kinds.length]!;
        await step(ctx, notes, { op: 'transition.set', id: c.id, type: t.type, len, ...(t.params ?? {}) });
      }
    }

    // progress bar along the top, CTA at the end
    await step(ctx, notes, { op: 'template.apply', template: 'progress-bar', at: 0, len: total, prefix: 'progress', params: { color: look.accent, trackColor: '#ffffff2e', position: 'top', thickness: 12 } });
    if (ctaOn) {
      // above the captions when they still run (voice-over), centred otherwise
      const yFrac = capId && ctx.clip(capId).at + ctx.clip(capId).len > ctaAt ? 0.34 : 0.5;
      await step(ctx, notes, { op: 'template.apply', template: 'cta', at: ctaAt, len: ctaLen, prefix: 'cta', params: { label: typeof p.cta === 'string' ? p.cta : 'Follow for more', color: look.ctaColor, textColor: style === 'bold' ? '#111111' : '#ffffff', y: yFrac } });
    }

    // sound: music bed (a file, or the audio.music command when installed), SFX on cuts, ducking, loudness
    const skipped: string[] = [];
    let music = false;
    if (typeof p.music === 'string') {
      const tM = await ensureTrack(ctx, notes, comp, { id: 'A2', audio: true, bus: 'music' });
      let dur: number | undefined;
      if (ctx.services.probe) { try { dur = (await ctx.services.probe(p.music)).duration; } catch { dur = undefined; } }
      const srcLen = dur ? Math.floor((dur * rate.num) / rate.den) : total;
      // one clip; a bed shorter than the Short loops (no fade-out then: the mixer applies it to the first pass)
      const looped = srcLen < total;
      await step(ctx, notes, { op: 'clip.add', id: 'bed', track: tM, at: 0, len: total, src: p.music, ...(looped ? { loop: true } : {}), fade: [Math.min(fr(0.5), total - 1), looped ? 0 : Math.min(fr(1), Math.floor(total / 3))] });
      music = true;
    } else if (p.music !== false) {
      const why = await optional(ctx, notes, 'audio.music', { at: 0, len: total, mood: look.music, seed, id: 'bed', bus: 'music', style: look.music, energy: style === 'clean' ? 0.4 : 0.8 });
      if (why) skipped.push(`music (audio.music ${why})`); else music = true;
    }
    if (bgIds.length > 1) {
      // the per-kind SFX levels are tuned to sit over a -18 LUFS bed: no extra gain
      const why = await optional(ctx, notes, 'audio.auto-sfx', { seed, comp: comp.id, on: ['transitions', 'cuts', 'templates'] });
      if (why) skipped.push(`SFX on cuts (audio.auto-sfx ${why})`);
    }
    if (vo && music) await step(ctx, notes, { op: 'audio.duck', bus: 'music', by: 'dialogue', db: 10 });
    if (vo || music) await step(ctx, notes, { op: 'audio.normalize' });

    // report
    const shown = [...new Set(notes.filter((n) => !/^(created track|added asset|put the clip|clip "[^"]+" has no clip ending)/.test(n)))].slice(0, 4);
    for (const n of shown) ctx.note(n);
    if (skipped.length) ctx.note(`skipped ${skipped.join('; ')}.`);
    const cues = capId ? (ctx.project.cues ?? []).filter((q) => q.clip === capId).length : 0;
    ctx.out.length = total;
    ctx.out.seconds = round(sec(total), 2);
    ctx.out.backgrounds = bgIds.length;
    if (capId) ctx.out.captions = capId;
    ctx.out.cues = cues;
    ctx.out.styles = capOn ? [capStyle, hookStyle] : [hookStyle];
    ctx.out.next = ['mgl look <file>', 'mgl render <file> short.mp4'];
    ctx.summary(`built a ${style} Short of ${sec(total).toFixed(1)}s: ${bgIds.length} ${media.length ? 'b-roll shots' : 'animated backgrounds'}${p.hook !== false ? ', hook' : ''}${capId ? `, ${cues} caption cues${vo ? ' timed to the voice-over' : ''}` : ''}, progress bar${ctaOn ? ', CTA' : ''}${music ? ', music' : ''}${vo ? ', voice-over' : ''}.`);
    ctx.summary(`next: mgl look <file> · mgl render <file> short.mp4${capOn ? ` (retune: style.set ${capStyle} highlight=#00e5ff)` : ''}`);
  },
});
