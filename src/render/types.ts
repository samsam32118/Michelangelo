/**
 * Contracts between evaluate (pure TS), the renderer (Skia), and the media backend (ffmpeg).
 * Owned by the core; extend additively.
 */
import type { BlendMode, ShapeSpec, TextStyle, TextAnimate, Mask, EffectInstance, TransitionInstance, GeneratorInstance } from '../core/schema/index.js';
import type { Rate } from '../core/time.js';

/** 2D affine matrix [a, b, c, d, e, f] (canvas setTransform order): layer px → comp px. */
export type Matrix = [number, number, number, number, number, number];

export interface DisplayList {
  compId: string;
  width: number;
  height: number;
  /** frame number in this comp */
  frame: number;
  rate: Rate;
  bg?: string;
  /** bottom → top */
  nodes: DisplayNode[];
}

export type DisplayNode = LayerNode | TransitionNode | AdjustmentNode;

export interface LayerBase {
  clipId: string;
  /** the layer's own box in layer px (before the matrix) */
  box: { w: number; h: number };
  matrix: Matrix;
  opacity: number;
  blend: BlendMode;
  /** layer effects (stage "layer"), in order, with numeric params resolved at this frame */
  fx: ResolvedEffect[];
  masks: ResolvedMask[];
  /** this layer shows only through `matte`'s alpha or luma */
  matte?: { node: LayerNode; mode: 'alpha' | 'luma' | 'alpha-inverted' | 'luma-inverted' };
  /** clip-local frame (after clock offset) for animations */
  localFrame: number;
  /** a deterministic seed for this clip (hash of its id) */
  seed: number;
}

export interface LayerNode extends LayerBase {
  type: 'layer';
  source: LayerSource;
}

/** Two layers (or stacks) blended by a transition at `progress` (0..1). */
export interface TransitionNode {
  type: 'transition';
  clipId: string;
  transition: { type: string; params: Record<string, unknown> };
  progress: number;
  from: DisplayNode[];
  to: DisplayNode[];
}

/** Applies its effects to everything drawn below it (within its masks), mixed by opacity. */
export interface AdjustmentNode extends LayerBase {
  type: 'adjustment';
}

export type LayerSource =
  | MediaSource
  | { type: 'text'; text: string; style: ResolvedTextStyle; animate?: TextAnimationState }
  | { type: 'shape'; shape: ShapeSpec; trim?: number; /** start of the drawn outline 0..1 */ trimStart?: number; /** shifts the drawn window along the outline (fraction, wraps) */ trimOffset?: number }
  | { type: 'solid'; color: string }
  | { type: 'comp'; list: DisplayList | null }
  | { type: 'gen'; gen: GeneratorInstance; params: Record<string, unknown>; frame: number; time: number; /** audio-reactive generators: the asset followed and its source frame now */ audio?: { assetId: string; frame: number } }
  | { type: 'captions'; text: string; style: ResolvedTextStyle; words: CaptionWord[]; cueId: string };

export interface MediaSource {
  type: 'media';
  assetId: string;
  src: string;
  kind: 'video' | 'image';
  /** source time in seconds as an exact rational: frames at `rate` (in + local × speed), for the decoder */
  sourceFrame: number;
  rate: Rate;
  /** source-stage effects (ffmpeg filters), structured */
  filters: FilterSpec[];
  fit: 'contain' | 'cover' | 'fill' | 'none';
  crop?: [number, number, number, number];
  /** the source's pixel size, when known (crop is in these px) */
  size?: { w: number; h: number };
}

export interface CaptionWord { text: string; state: 'past' | 'active' | 'future'; /** 0..1 progress of the active word */ progress: number }

export interface TextAnimationState {
  by: 'char' | 'word' | 'line' | 'all';
  /** per unit (in reading order): the transform to apply around the unit's centre */
  units: UnitState[];
}
export interface UnitState { opacity: number; dx: number; dy: number; scale: number; rotate: number; blur?: number; color?: string }

export type ResolvedTextStyle = Required<Pick<TextStyle, 'font' | 'size' | 'color' | 'align' | 'lineHeight' | 'letterSpacing' | 'weight'>> & TextStyle;

export interface ResolvedEffect { type: string; params: Record<string, unknown>; id?: string }
/** A mask with its box in px: comp px for space "comp" (default), layer px for space "clip" (fractions resolved). */
export type ResolvedMask = Mask & { box?: [number, number, number, number] };

/** An ffmpeg filter as data; the core escapes args and checks the allowlist. */
export interface FilterSpec {
  filter: string;
  args?: Record<string, string | number | boolean>;
  /**
   * Audio stage only: samples (at 48 kHz) by which this filter delays its output (lookahead). The mixer pads the
   * input and drops that many samples from the output, so the sound stays in sync. Known ffmpeg filters (afftdn,
   * anlmdn, superequalizer) are compensated without it; alimiter always runs with latency compensation on.
   */
  latency?: number;
}

/** Lays out text with the renderer's fonts; injected into evaluate so it stays pure. */
export interface TextLayouter {
  layout(text: string, style: ResolvedTextStyle): TextLayout;
}
export interface TextLayout {
  /** the text box (layer px) */
  w: number;
  h: number;
  lines: { text: string; x: number; y: number; w: number; baseline: number }[];
  /** units for animation: chars or words, with boxes in layer px */
  words: { text: string; x: number; y: number; w: number; h: number; line: number }[];
  /** the font size actually used (after shrink-to-fit) */
  size: number;
}

/** Evaluated audio for a comp: every audible span flattened to absolute samples (48 kHz). */
export interface AudioPlan {
  sampleRate: 48000;
  /** total samples */
  length: number;
  segments: AudioSegment[];
  buses: { id: string; gainDb: number; muted: boolean; to: string; duck?: { by: string; db: number; attack: number; release: number }; loudness?: { lufs: number; peak: number }; filters?: FilterSpec[] }[];
}

export interface AudioSegment {
  clipId: string;
  src: string;
  /** output span [start, end) in samples */
  start: number;
  end: number;
  /** source position at `start`, in seconds as exact frames/rate */
  sourceFrame: number;
  rate: Rate;
  speed: Rate;
  bus: string;
  /** gain envelope: [sample offset from start, dB] points (linear between); a constant is one point */
  gain: [number, number][];
  /** fade in/out lengths in samples */
  fadeIn: number;
  fadeOut: number;
  /**
   * audio-stage effect filters of the clip, in order: they run once over the clip's continuous sound (all of its
   * segments laid end to end), after the clip gain (pre-insert) and before the fades
   */
  filters?: FilterSpec[];
}

/** Per-frame sound levels of an asset (see plugin AudioLevels): RMS and spectrum rows, indexed by source frame. */
export interface AudioLevelsTable { rms: Float32Array; spectrum: Float32Array; bands: number }

/** Rendering pipeline interface: a GPU renderer can be added as a plugin implementing this. */
export interface Renderer {
  id: string;
  open(opts: { width: number; height: number; fontsDir?: string; registry?: RendererRegistry; fontAssets?: { id: string; path: string }[]; /** per-frame sound levels of an asset at a comp rate (audio-reactive generators) */ audioLevels?: (assetId: string, rate: Rate) => AudioLevelsTable | undefined }): Promise<RenderSession>;
}

/** The part of the plugin registry a renderer draws with (effects, transitions, generators). */
export type RendererRegistry = Pick<import('../plugin/registry.js').PluginRegistry, 'effects' | 'transitions' | 'generators'>;

export interface RenderSession {
  /** draw one display list; media frames come from `frames` (decoded RGBA by asset + source frame) */
  drawFrame(list: DisplayList, frames: FrameProvider): Promise<RGBAFrame>;
  layouter: TextLayouter;
  close(): Promise<void>;
}

export interface RGBAFrame { width: number; height: number; data: Uint8Array | Buffer }

export interface FrameProvider {
  /** a decoded frame of a media source, already scaled to at most `maxSize` */
  get(src: MediaSource, maxSize: { w: number; h: number }): Promise<RGBAFrame>;
}
