/**
 * The public plugin API (`michelangelo/plugin`), semver PLUGIN_API_VERSION. Minor versions only add.
 * Built-in effects, transitions, generators, templates and checks use exactly this API.
 *
 * Plugins are trusted code (no sandbox): they load only when the project names them and, for plugins
 * found next to a project, after `mgl plugin trust <path>`.
 */
import { z } from 'zod';
import type { SKRSContext2D, Canvas } from '@napi-rs/canvas';
import type { CommandDef, TemplateDef } from '../core/commands/registry.js';
import type { FilterSpec } from '../render/types.js';
import type { ProjectFile } from '../core/schema/index.js';

export { z };
export { defineCommand } from '../core/commands/registry.js';
export type { CommandDef, TemplateDef, TemplateOutput, CommandContext } from '../core/commands/registry.js';
export type { FilterSpec } from '../render/types.js';
export { LICENCE_CLASSES, licenceClass, canonicalLicence, licenceName, licenceUrl, creditLine, type LicenceClass } from '../core/licence.js';

export const PLUGIN_API_VERSION = '1.4.0';

/** A CanvasRenderingContext2D-compatible drawing context (Skia today; a GPU renderer provides the same contract). */
export type Canvas2D = SKRSContext2D;

/** A drawable RGBA surface. */
export interface Surface {
  readonly width: number;
  readonly height: number;
  readonly ctx: Canvas2D;
  /** the canvas, for ctx.drawImage(surface.canvas, ...) */
  readonly canvas: Canvas;
  /** RGBA pixels (unpremultiplied, row-major); call commit() after changing them */
  pixels(): Uint8ClampedArray;
  commit(): void;
  clear(): void;
  /** a scratch surface of the same (or given) size */
  scratch(w?: number, h?: number): Surface;
}

export interface FrameInfo {
  /** clip-local frame */
  frame: number;
  /** clip-local seconds (for time-based maths) */
  time: number;
  fps: number;
  /** deterministic per clip; use it for any randomness (draw must be a pure function of params, frame, seed) */
  seed: number;
  comp: { width: number; height: number };
}

type ParamsOf<S> = S extends z.ZodType ? z.infer<S> : Record<string, unknown>;

export interface EffectDef<S extends z.ZodObject = z.ZodObject> {
  type: string;
  describe: string;
  params: S;
  /** layer stage: draw `src` (the rendered layer) into `dst` (same size; dst starts empty) */
  draw?(args: { src: Surface; dst: Surface; params: ParamsOf<S> } & FrameInfo): void;
  /** source stage (media clips only): ffmpeg filters applied while decoding */
  source?(params: ParamsOf<S>): FilterSpec[];
  /** extra margin in px the effect draws outside the layer box (glow, shadow) */
  margin?(params: ParamsOf<S>): number;
  /**
   * audio stage (API 1.1): ffmpeg audio filters applied to the clip's sound (or a bus's mix when the effect is on a
   * bus). An effect with only `audio` is an audio effect: adding it to a clip without sound is an error.
   */
  audio?(params: ParamsOf<S>): FilterSpec[];
}

export interface TransitionDef<S extends z.ZodObject = z.ZodObject> {
  type: string;
  describe: string;
  params: S;
  /** draw the blend of `from` (outgoing) and `to` (incoming) at progress 0..1 into dst (comp-sized, empty) */
  draw(args: { from: Surface; to: Surface; dst: Surface; progress: number; params: ParamsOf<S> } & FrameInfo): void;
}

export interface GeneratorDef<S extends z.ZodObject = z.ZodObject> {
  type: string;
  describe: string;
  params: S;
  /** the layer box size (default: the comp size) */
  size?(params: ParamsOf<S>, comp: { width: number; height: number }): [number, number];
  draw(args: { dst: Surface; params: ParamsOf<S>; audio?: AudioLevels } & FrameInfo): void;
  /** (API 1.1) the asset id whose sound this generator visualises (waveforms, audiograms); the renderer then passes `audio` */
  audioSource?(params: ParamsOf<S>): string | undefined;
}

/** Sound levels for audio-reactive generators: per-frame RMS (0..1) and spectrum bands of the source asset. */
export interface AudioLevels {
  /** RMS level 0..1 per comp frame of the source, indexed by the clip's source frame */
  rms: Float32Array;
  /** `bands` values 0..1 per frame (low → high frequency), row-major: frame × bands */
  spectrum: Float32Array;
  bands: number;
  /** the source frame shown now (clip in + local frame × speed) */
  frame: number;
}

export interface Finding {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** comp frame where it happens */
  frame?: number;
  clip?: string;
  /** comp px box to zoom into for the crop image [x, y, w, h] */
  box?: [number, number, number, number];
  /** a ready-to-run fix: "mgl edit <file> clip.set logo y=120" (use <file> literally) */
  fix?: string;
  /** set by multi-platform runs (--platforms) on findings that only one platform raises */
  platform?: string;
}

export interface CheckContext {
  project: ProjectFile;
  compId: string;
  platform: string;
  /** frames rendered by look (comp frame → RGBA at `scale` of comp size), when stage is "frame" */
  frames?: Map<number, { width: number; height: number; data: Uint8Array | Buffer; scale: number }>;
  /** per-frame layer boxes (comp px, axis-aligned) and alpha masks from the renderer */
  layers?: Map<number, { clipId: string; kind: string; box: [number, number, number, number]; text?: string; fontPx?: number }[]>;
  audio?: import('../media/types.js').AudioAnalysisReport;
  /** layer boxes at sample frames across every visual clip (project stage too; since 1.1) */
  sampled?: Map<number, { clipId: string; kind: string; box: [number, number, number, number]; text?: string; fontPx?: number }[]>;
  /** probed source duration (s) of a media asset, when known (since 1.1) */
  sourceDuration?(assetId: string): number | undefined;
  /** whether a media asset's probed pixel format has an alpha channel (undefined when unknown; since 1.1) */
  sourceAlpha?(assetId: string): boolean | undefined;
  /** the render will use --alpha (since 1.1) */
  alpha?: boolean;
  safeArea(platform?: string): { x: number; y: number; w: number; h: number };
  /**
   * (API 1.4) the platform's interface overlays in comp px: header, action buttons, caption panel (none for youtube /
   * none). Lets a check say which panel a layer sits under.
   */
  uiZones?(platform?: string): { name: string; rect: { x: number; y: number; w: number; h: number } }[];
}

export interface CheckDef {
  id: string;
  describe: string;
  /** project: no pixels (runs in `check`); frame: needs rendered frames (look); audio: needs analysis (look) */
  stage: 'project' | 'frame' | 'audio';
  run(ctx: CheckContext): Finding[] | Promise<Finding[]>;
}

export interface ImporterDef {
  id: string;
  describe: string;
  extensions: string[];
  /** turn a file into commands that build it into the project */
  import(args: { file: string; text: () => Promise<string>; project: ProjectFile; options: Record<string, unknown> }): Promise<{ op: string; [k: string]: unknown }[]>;
}

export interface ExporterDef {
  id: string;
  describe: string;
  extensions: string[];
  export(args: { out: string; project: ProjectFile; compId: string; renderFrames(opts?: { scale?: number }): AsyncIterable<{ frame: number; width: number; height: number; data: Uint8Array | Buffer }>; renderAudio(out: string): Promise<void> }): Promise<void>;
}

export interface StyleDef { id: string; describe: string; style: Record<string, unknown> }

export interface PluginDef {
  name: string;
  version?: string;
  effects?: EffectDef[];
  transitions?: TransitionDef[];
  generators?: GeneratorDef[];
  templates?: TemplateDef[];
  commands?: CommandDef[];
  checks?: CheckDef[];
  importers?: ImporterDef[];
  exporters?: ExporterDef[];
  styles?: StyleDef[];
  /** text animation presets: per-unit state at progress 0..1 (in) */
  textAnimations?: TextAnimationDef[];
  /** (API 1.3) motion presets for any layer, expanded into keyframes by `motion.apply` */
  motionPresets?: MotionPresetDef[];
  /** (API 1.3) AI and media providers (text-to-speech, transcription, music, ...) behind stable interfaces */
  providers?: ProviderDef[];
}

/**
 * A motion preset (in / out / emphasis / loop) for any visual layer. `keys` returns keyframes for clip
 * properties over `len` frames starting at frame 0 (the command offsets them); values are relative to the
 * layer's rest state: `x`/`y` are px offsets added to rest, `scale` multiplies, `rotate` adds degrees,
 * `opacity` multiplies. Must be a pure function of (params, len, fps, seed).
 */
export interface MotionPresetDef {
  id: string;
  describe: string;
  phase: 'in' | 'out' | 'emphasis' | 'loop';
  params?: z.ZodObject;
  /** default length in seconds */
  seconds?: number;
  keys(args: { len: number; fps: number; seed: number; params: Record<string, unknown>; size: { w: number; h: number }; comp: { width: number; height: number } }): Partial<Record<'x' | 'y' | 'scale' | 'rotate' | 'opacity', [number, number, string?][]>>;
}

/** A provider of an AI or media capability. The library ships the interfaces; models come as plugins. */
export type ProviderDef = SpeakProvider | TranscribeProvider | StockProvider;

/** (API 1.4) Kinds of open media: pictures, footage, music beds and sound effects. */
export type StockKind = 'image' | 'video' | 'music' | 'sfx';
export const STOCK_KINDS: readonly StockKind[] = ['image', 'video', 'music', 'sfx'];

/** (API 1.4) One search result of a stock provider. */
export interface StockItem {
  /** provider-scoped and stable: "<provider>:<source id>" (media.fetch id=...) */
  id: string;
  kind: StockKind;
  title: string;
  /** the landing page (credits link here) */
  url: string;
  /** the direct download URL (full resolution when the source offers it) */
  file: string;
  /** file extension without the dot: jpg, png, mp3, webm ... */
  ext: string;
  /** canonical licence id ("cc0", "pdm", "pd-us-gov", "cc-by-4.0", ...; see canonicalLicence) and its URL */
  licence: { id: string; url?: string };
  author?: string;
  authorUrl?: string;
  /** where it comes from, for credits: "Freesound via Openverse", "Smithsonian National Portrait Gallery" */
  source: string;
  seconds?: number;
  width?: number;
  height?: number;
  bytes?: number;
  /** a small preview image (thumbnails in the search sheet) */
  preview?: string;
  tags?: string[];
  /** a year or date, when known */
  date?: string;
}

/** (API 1.4) What media.search asks a provider for. Providers filter what their API can; core filters the rest. */
export interface StockQuery {
  kind: StockKind;
  query: string;
  /** results wanted (core asks for a few more than it shows) */
  limit: number;
  /** 1-based page */
  page?: number;
  orientation?: 'portrait' | 'landscape' | 'square';
  minSeconds?: number;
  maxSeconds?: number;
  minWidth?: number;
  /** a provider with several sources may be narrowed to one ("openverse", "smithsonian", ...) */
  source?: string;
  /** licence classes the caller will accept (core filters anyway; a source may use it to ask its API for less) */
  licences?: string[];
}

/** (API 1.4) A search result with notes for the agent (a source that was skipped or failed, a missing key). */
export interface StockResults { items: StockItem[]; notes?: string[] }

/** (API 1.4) What core gives a stock provider: HTTP with a proper User-Agent and timeouts, environment keys, a cache folder. */
export interface StockContext {
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response>;
  /** an environment variable (API keys); undefined when unset */
  env(name: string): string | undefined;
  /** a folder for this provider's caches (indexes, downloaded metadata) */
  cacheDir: string;
}

/**
 * (API 1.4) A source of openly licensed media for media.search / media.fetch. Core owns paths, caching, licence rules,
 * sidecars and credits; a provider maps a source's API to StockItems with canonical licence ids, and drops any result
 * whose licence it cannot map.
 */
export interface StockProvider {
  kind: 'stock';
  id: string;
  describe: string;
  media: StockKind[];
  /** source names this provider can be narrowed to with media.search source=... */
  sources?: string[];
  search(q: StockQuery, ctx: StockContext): Promise<StockItem[] | StockResults>;
  /** look one item up by id (media.fetch of an id not seen in a search this session) */
  item?(id: string, ctx: StockContext): Promise<StockItem | undefined>;
  /** download `item` to the absolute path `out`; default: core downloads item.file */
  fetch?(args: { item: StockItem; out: string }, ctx: StockContext): Promise<void>;
}

export interface SpeakProvider {
  kind: 'speak';
  id: string;
  describe: string;
  voices(): Promise<{ id: string; describe?: string; lang?: string }[]>;
  /** synthesise `text` to a WAV at `out` (48 kHz preferred); word start times (s) when the engine knows them */
  speak(args: { text: string; voice?: string; speed?: number; out: string }): Promise<{ words?: { text: string; start: number; end?: number }[] }>;
}

export interface TranscribeProvider {
  kind: 'transcribe';
  id: string;
  describe: string;
  /** transcribe an audio/video file; word-level times in seconds */
  transcribe(args: { file: string; lang?: string }): Promise<{ text: string; words: { text: string; start: number; end: number; confidence?: number }[] }>;
}

export interface TextAnimationDef {
  id: string;
  describe: string;
  /** state of a unit at progress p (0 = start of its in-animation, 1 = at rest) */
  state(p: number): { opacity?: number; dx?: number; dy?: number; scale?: number; rotate?: number; blur?: number };
  /** default easing name for p */
  easing?: string;
}

export function definePlugin(def: PluginDef): PluginDef { return def; }
export function defineEffect<S extends z.ZodObject>(def: EffectDef<S>): EffectDef { return def as unknown as EffectDef; }
export function defineTransition<S extends z.ZodObject>(def: TransitionDef<S>): TransitionDef { return def as unknown as TransitionDef; }
export function defineGenerator<S extends z.ZodObject>(def: GeneratorDef<S>): GeneratorDef { return def as unknown as GeneratorDef; }
export function defineCheck(def: CheckDef): CheckDef { return def; }
export function defineTemplate(def: TemplateDef): TemplateDef { return def; }
export function defineImporter(def: ImporterDef): ImporterDef { return def; }
export function defineExporter(def: ExporterDef): ExporterDef { return def; }
export function defineTextAnimation(def: TextAnimationDef): TextAnimationDef { return def; }
export function defineMotionPreset(def: MotionPresetDef): MotionPresetDef { return def; }
export function defineProvider<P extends ProviderDef>(def: P): P { return def; }
