/** Structured ffmpeg filters → filtergraph text, escaped and checked against an allowlist. */
import { existsSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { fail, suggest } from '../core/errors.js';
import type { FilterSpec } from '../render/types.js';

/** Video filters a source-stage effect may use. Anything that reads files, opens URLs or runs commands is absent. */
export const ALLOWED_VIDEO_FILTERS = new Set([
  'hue', 'eq', 'colorbalance', 'colorchannelmixer', 'colorcontrast', 'colorcorrect', 'colortemperature', 'colorize', 'colorlevels',
  'curves', 'vibrance', 'selectivecolor', 'lutrgb', 'lutyuv', 'lut', 'lut3d', 'negate', 'monochrome', 'grayworld',
  'normalize', 'histeq', 'exposure', 'tonemap', 'zscale', 'colorspace', 'colormatrix',
  'hqdn3d', 'nlmeans', 'atadenoise', 'bm3d', 'fftdnoiz', 'removegrain', 'deband', 'deflicker', 'dedot',
  'unsharp', 'cas', 'smartblur', 'gblur', 'boxblur', 'avgblur', 'sab', 'dblur',
  'scale', 'crop', 'pad', 'hflip', 'vflip', 'transpose', 'rotate', 'setsar', 'setdar', 'format',
  'chromakey', 'colorkey', 'hsvkey', 'lumakey', 'despill', 'noise', 'vignette', 'edgedetect', 'tmix', 'deshake',
  'lenscorrection', 'perspective', 'pixelize', 'chromashift', 'rgbashift', 'gradfun', 'yadif', 'bwdif', 'fade', 'geq',
]);

/**
 * Audio filters an audio-stage effect (clip sound or bus mix) may use. Filters that read files or load code
 * (amovie, afir with a file, ladspa, lv2, arnndn models, sofalizer, firequalizer dumps) and filters that change
 * the length of the sound (atempo, silenceremove, areverse) are absent.
 */
export const ALLOWED_AUDIO_FILTERS = new Set([
  'highpass', 'lowpass', 'bandpass', 'bandreject', 'allpass', 'equalizer', 'anequalizer', 'superequalizer', 'bass', 'treble',
  'lowshelf', 'highshelf', 'tiltshelf', 'afftdn', 'anlmdn', 'adeclick', 'adeclip', 'acompressor', 'alimiter', 'agate', 'compand',
  'mcompand', 'deesser', 'dynaudnorm', 'speechnorm', 'loudnorm', 'volume', 'aecho', 'chorus', 'flanger', 'aphaser', 'tremolo',
  'vibrato', 'stereotools', 'extrastereo', 'stereowiden', 'haas', 'pan', 'crystalizer', 'aexciter', 'asoftclip', 'acrusher',
  'aemphasis', 'acontrast', 'asubboost', 'asupercut', 'asubcut', 'adelay', 'dcshift', 'afade', 'aformat', 'aresample', 'channelmap',
]);

/** Options that name files; only lut3d `file` (a LUT, by extension) is permitted. */
const FILE_OPTIONS = new Set(['file', 'filename', 'textfile', 'fontfile', 'psfile', 'commands', 'map_file', 'stats_file', 'plot', 'stats', 'logfile', 'passlogfile', 'model', 'result']);

/**
 * Filters whose options are listed one by one: any other option name is refused (so an option that writes or
 * reads a file, present or added in a later ffmpeg, cannot slip through). Filters not listed here take any
 * option except FILE_OPTIONS.
 */
const FILTER_OPTIONS: Record<string, ReadonlySet<string>> = {
  curves: new Set(['preset', 'master', 'm', 'red', 'r', 'green', 'g', 'blue', 'b', 'all', 'interp']),
  lut3d: new Set(['file', 'clut', 'interp']),
  deshake: new Set(['x', 'y', 'w', 'h', 'rx', 'ry', 'edge', 'blocksize', 'contrast', 'search', 'opencl']),
  colorspace: new Set(['all', 'space', 'trc', 'primaries', 'range', 'format', 'fast', 'dither', 'wpadapt', 'iall', 'ispace', 'itrc', 'iprimaries', 'irange']),
};
const LUT_EXT = new Set(['.cube', '.3dl', '.dat', '.m3d', '.csp']);

/** Escape a value for an option inside a filter description and then for the filtergraph parser. */
export function escapeValue(v: string): string {
  const lvl1 = v.replace(/[\\':]/g, (c) => '\\' + c);
  return lvl1.replace(/[\\'\[\],;]/g, (c) => '\\' + c);
}

export interface FilterBuildOptions {
  /** resolve relative LUT paths against this directory */
  baseDir?: string;
  /** the stage the filter runs in: video (source-stage effects, default) or audio (audio-stage effects) */
  stage?: 'video' | 'audio';
}

/** One FilterSpec → "name=k=v:k=v". Throws E_FILTER for disallowed filters or options. */
export function filterToString(f: FilterSpec, opts: FilterBuildOptions = {}): string {
  const name = f.filter;
  const audio = opts.stage === 'audio';
  const allowed = audio ? ALLOWED_AUDIO_FILTERS : ALLOWED_VIDEO_FILTERS;
  if (!/^[a-z0-9_]+$/.test(name) || !allowed.has(name)) {
    const dym = suggest(name, allowed);
    const other = audio ? ALLOWED_VIDEO_FILTERS.has(name) : ALLOWED_AUDIO_FILTERS.has(name);
    fail('E_FILTER', `ffmpeg filter "${name}" is not allowed in ${audio ? 'an audio-stage' : 'a source-stage'} effect${other ? ` (it is ${audio ? 'a video' : 'an audio'} filter)` : ''}.`,
      other
        ? (audio ? 'return video filters from the effect\'s source() and audio filters from audio().' : 'return audio filters from the effect\'s audio() (plugin API 1.1), not source().')
        : `use an allowed filter${dym.length ? ` (did you mean "${dym[0]}"?)` : ''}; filters that read files, open URLs or run commands (movie, amovie, sendcmd, ...) are refused.`, { didYouMean: dym });
  }
  const parts: string[] = [];
  for (const [k, v0] of Object.entries(f.args ?? {})) {
    if (!/^[A-Za-z0-9_]+$/.test(k)) fail('E_FILTER', `filter ${name}: option name "${k}" is not valid.`, 'option names use letters, digits and "_".');
    let v = typeof v0 === 'boolean' ? (v0 ? '1' : '0') : String(v0);
    if (typeof v0 === 'number' && !Number.isFinite(v0)) fail('E_FILTER', `filter ${name}: option ${k} is ${v0}.`, 'give a finite number.');
    const only = FILTER_OPTIONS[name];
    if (only && !only.has(k)) fail('E_FILTER', `filter ${name}: option "${k}" is not allowed in a source-stage effect.`, `use one of: ${[...only].join(', ')}.`);
    if (FILE_OPTIONS.has(k)) {
      const isLut = name === 'lut3d' && k === 'file';
      if (!isLut || !LUT_EXT.has(extname(v).toLowerCase())) fail('E_FILTER', `filter ${name}: option "${k}" reads a file, which source-stage effects may not do.`, 'only lut3d file=<.cube|.3dl|.dat|.m3d|.csp> may name a file (use the lut effect).');
      const p = isAbsolute(v) ? v : resolve(opts.baseDir ?? '.', v);
      if (!existsSync(p)) fail('E_FILTER', `LUT file ${v} does not exist.`, 'add the .cube file as an asset and refer to it by a path relative to the project.');
      v = p;
    }
    parts.push(`${k}=${escapeValue(v)}`);
  }
  return parts.length ? `${name}=${parts.join(':')}` : name;
}

export function filtersToString(fs: FilterSpec[] | undefined, opts: FilterBuildOptions = {}): string {
  return (fs ?? []).map((f) => filterToString(f, opts)).join(',');
}
