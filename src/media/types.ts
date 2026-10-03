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
  /** render the audio plan to a 48 kHz stereo WAV */
  renderAudio(plan: AudioPlan, out: string, opts?: { baseDir?: string }): Promise<void>;
  encode(opts: EncodeOptions): Promise<FrameSink>;
  /** encode an existing WAV to another audio format (mp3, aac/m4a, opus, flac) */
  transcodeAudio(wav: string, out: string): Promise<void>;
  analyzeAudio(file: string, opts?: { silenceDb?: number; minSilence?: number }): Promise<AudioAnalysisReport>;
  /** join segment files without re-encoding */
  concat(parts: string[], out: string): Promise<void>;
}
