/** The native-ffmpeg media backend. */
import { analyzeAudio } from './analysis.js';
import { analyzeLevels } from './levels.js';
import { renderAudio } from './audio-render.js';
import { decodeImage, grab, openVideo } from './decode.js';
import { concat, encode, transcodeAudio } from './encode.js';
import { getFfmpeg } from './ffmpeg.js';
import { probe } from './probe.js';
import type { MediaBackend } from './types.js';

export interface MediaBackendOptions {
  /** probe / frame-index cache directory (default ~/.cache/michelangelo/probe) */
  cacheDir?: string;
  /** directory relative paths resolve against (LUT files, audio plan sources) */
  baseDir?: string;
  /** let getFfmpeg download the pinned build when none is installed */
  allowDownload?: boolean;
}

export function getMediaBackend(opts: MediaBackendOptions = {}): MediaBackend {
  const c = opts.cacheDir ? { cacheDir: opts.cacheDir } : {};
  const b = opts.baseDir ? { baseDir: opts.baseDir } : {};
  return {
    info: () => getFfmpeg({ allowDownload: opts.allowDownload ?? false }),
    probe: (file) => probe(file, c),
    grab: (file, sourceFrame, rate, o = {}) => grab(file, sourceFrame, rate, { ...c, ...b, ...o }),
    openVideo: (file, o) => openVideo(file, { ...c, ...b, ...o }),
    decodeImage: (file, maxSize) => decodeImage(file, maxSize, c),
    renderAudio: (plan, out, o = {}) => renderAudio(plan, out, { ...c, ...b, ...o }),
    encode: (o) => encode(o),
    transcodeAudio: (wav, out, o) => transcodeAudio(wav, out, o),
    analyzeAudio: (file, o) => analyzeAudio(file, o),
    concat: (parts, out) => concat(parts, out),
    analyzeLevels: (file, rate) => analyzeLevels(file, rate, opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
  };
}

export { planAudio, sampleOf, SAMPLE_RATE, type PlanAudioOptions } from './audio-plan.js';
export { trackMotion, type TrackOptions, type TrackPoint } from './track.js';
export { getFfmpeg, ffmpegInfo, resetFfmpeg, cacheRoot, loadManifest, platformKey } from './ffmpeg.js';
export { probe, frameIndex, sourceFrameAt, type MediaInfoExt, type FrameIndex } from './probe.js';
export { grab, openVideo, decodeImage } from './decode.js';
export { encode, transcodeAudio, concat, encodeArgs } from './encode.js';
export { renderAudio, buildMixGraph, duckParams } from './audio-render.js';
export { analyzeAudio } from './analysis.js';
export { analyzeLevels, computeLevels, bandEdges, LEVEL_BANDS, type AudioLevelsData } from './levels.js';
export { filterToString, filtersToString, ALLOWED_VIDEO_FILTERS, ALLOWED_AUDIO_FILTERS } from './filters.js';
export type * from './types.js';
