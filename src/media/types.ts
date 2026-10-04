/** The media backend contract (implemented with native ffmpeg in src/media). */
import type { Rate } from '../core/time.js';
import type { AudioPlan, FilterSpec, RGBAFrame } from '../render/types.js';

export interface FfmpegInfo {
  ffmpeg: string;
  ffprobe: string;
  version: string;
  source: 'env' | 'system' | 'cache' | 'download';
  encoders: string[];
  decoders: string[];
  filters: string[];
  licence: string;
}

export interface MediaInfo {
  kind: 'video' | 'audio' | 'image';
  /** seconds (float, from the container) */
  duration: number;
  width?: number;
  height?: number;
  /** display rotation in degrees (already applied to width/height) */
  rotation?: number;
  fps?: Rate;
  vfr?: boolean;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio: boolean;
  hasVideo: boolean;
  sampleRate?: number;
  channels?: number;
  pixFmt?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  colorSpace?: string;
  /** first video PTS (s), subtracted so source time 0 = first frame */
  startTime?: number;
  size: number;
}

/** Sequential reader of decoded frames for one media clip (render path). */
export interface VideoReader {
  /** frame at a source time given as frames at `rate` (monotonic calls are fast; backwards seeks reopen) */
  frame(sourceFrame: number, rate: Rate): Promise<RGBAFrame>;
  close(): Promise<void>;
}

export interface OpenVideoOptions {
  /** scale to this size (fit inside, keep aspect) in the decoder */
  maxSize?: { w: number; h: number };
  filters?: FilterSpec[];
  /** the comp rate frames are requested at */
  rate: Rate;
}

export interface EncodeOptions {
  out: string;
  width: number;
  height: number;
  rate: Rate;
  format: 'mp4' | 'webm' | 'mov' | 'gif' | 'png' | 'apng';
  quality: 'draft' | 'final' | 'hq';
  alpha?: boolean;
  /** a WAV/PCM file to mux as the audio track */
  audio?: string;
  /** GIF: frames per second and width */
  gif?: { fps: number; width: number; loop: boolean };
  /** delivery settings (codec-specific; see DeliveryOptions) */
  delivery?: DeliveryOptions;
}

/** Delivery settings for video outputs (all optional; defaults come from the quality preset). */
export interface DeliveryOptions {
  /** constant rate factor: x264 0–51 (mp4), VP9 0–63 (webm); lower = better */
  crf?: number;
  /** video bitrate, e.g. "8M" or "2500k" (mp4: a cap with crf, else the target; webm: the target, or the cap with crf) */
  bitrate?: string;
  /** audio bitrate for aac/opus, e.g. "320k" */
  audioBitrate?: string;
  /** PCM bit depth for WAV and mov audio */
  pcmDepth?: 16 | 24;
  /** ProRes profile (mov): proxy, lt, 422, hq (default), 4444 (default with alpha), 4444xq */
  prores?: 'proxy' | 'lt' | '422' | 'hq' | '4444' | '4444xq';
  /** start timecode "HH:MM:SS:FF" (";" before FF for drop-frame), written to mov/mp4 */
  timecode?: string;
  /** colour range flag of the encoded video: tv (limited, default) or pc (full) */
  colorRange?: 'tv' | 'pc';
}

export interface RenderAudioResult {
  /** clips whose sources had no audio stream */
  dropped: string[];
  /** facts to report (stems: gains applied, channel map) */
  notes: string[];
}

export interface RenderAudioOptions {
  baseDir?: string;
  /** render only this bus's contribution to the master (others muted, ducking kept); 'all' = one stereo pair per bus feeding master, in one multichannel WAV */
  bus?: string;
  /** PCM bit depth of the WAV (default 16) */
  pcmDepth?: 16 | 24;
}

export interface FrameSink {
  write(frame: RGBAFrame): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

export interface LoudnessReport {
  integrated: number; // LUFS
  truePeak: number; // dBTP
  lra: number; // LU
  /** momentary loudness per 100 ms window (for per-range checks) */
  momentary?: number[];
}

export interface AudioAnalysisReport {
  duration: number;
  loudness: LoudnessReport;
  silences: { start: number; end: number }[];
  /** onset/beat times (s) and a tempo estimate */
  beats: number[];
  bpm?: number;
  /** RMS dBFS per 100 ms window */
  rms: number[];
}

export interface MediaBackend {
  info(): Promise<FfmpegInfo>;
  probe(file: string): Promise<MediaInfo>;
  /** frame-accurate single frame (stills, look) */
  grab(file: string, sourceFrame: number, rate: Rate, opts?: { maxSize?: { w: number; h: number }; filters?: FilterSpec[] }): Promise<RGBAFrame>;
  openVideo(file: string, opts: OpenVideoOptions): Promise<VideoReader>;
  decodeImage(file: string, maxSize?: { w: number; h: number }): Promise<RGBAFrame>;
  /** render the audio plan to a 48 kHz stereo WAV (multichannel for bus "all") */
  renderAudio(plan: AudioPlan, out: string, opts?: RenderAudioOptions): Promise<void | RenderAudioResult>;
  encode(opts: EncodeOptions): Promise<FrameSink>;
  /** encode an existing WAV to another audio format (mp3, aac/m4a, opus, flac) */
  transcodeAudio(wav: string, out: string, opts?: { bitrate?: string; pcmDepth?: 16 | 24 }): Promise<void>;
  analyzeAudio(file: string, opts?: { silenceDb?: number; minSilence?: number }): Promise<AudioAnalysisReport>;
  /** join segment files without re-encoding */
  concat(parts: string[], out: string): Promise<void>;
  /** per-frame RMS + spectrum of a file's audio at `rate` (audio-reactive generators; cached) */
  analyzeLevels?(file: string, rate: Rate): Promise<import('./levels.js').AudioLevelsData>;
}
