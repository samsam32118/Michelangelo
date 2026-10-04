/**
 * The services commands use (probe, audio analysis, file reads, generated-file writes, motion tracking, catalog,
 * text metrics, and the plugin providers: speak / transcribe), bound to a project directory.
 */
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { MglError, fail } from '../core/errors.js';
import type { CommandServices, ProbeInfo, SpeakService, TranscribeService } from '../core/commands/registry.js';
import { kindFromExtension } from '../core/commands/structure.js';
import type { PluginRegistry } from '../plugin/registry.js';
import type { SpeakProvider, TranscribeProvider } from '../plugin/api.js';
import type { MediaBackend } from '../media/types.js';
import type { ResolvedTextStyle, TextLayouter } from '../render/types.js';
import { createTextLayouter } from '../render/text.js';
import { stockService } from './stock.js';
import type { Rate } from '../core/time.js';
import type { AudioLevelsData } from '../media/levels.js';

const outside = (rel: string) => rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);

/** realpath of `p`, or of its nearest existing ancestor with the rest appended (for paths not created yet). */
function realish(p: string): string {
  try { return realpathSync(p); } catch {
    const up = dirname(p);
    return up === p ? p : resolve(realish(up), relative(up, p));
  }
}

/** Resolve a path relative to the project directory, refusing paths that leave it (lexically or through symlinks). */
export function confined(projectDir: string, p: string): string {
  const root = resolve(projectDir);
  const abs = resolve(root, p);
  const why = () => fail('E_PATH', `"${p}" is outside the project folder.`, 'give a path relative to the project file, inside its folder (copy the file there first).');
  if (outside(relative(root, abs))) why();
  if (outside(relative(realish(root), realish(abs)))) why();
  return abs;
}

export interface ServiceOptions {
  /** a media backend (default: native ffmpeg, loaded on first use) */
  backend?: MediaBackend;
  /** the project's work folder .mgl/<name>/ (reports such as media.search's list and sheet) */
  workDir?: string;
  /** open media: HTTP, environment and cache folder for stock providers (tests inject recorded responses) */
  stock?: import('./stock.js').StockOptions;
}

/** CommandServices plus SDK extras: per-frame sound levels (RMS + spectrum) of a media file, for sync and audio-reactive work. */
export type MglServices = CommandServices & {
  analyzeLevels?(src: string, rate: Rate): Promise<AudioLevelsData>;
};

export function makeServices(projectDir: string, registry?: PluginRegistry, opts: ServiceOptions = {}): MglServices {
  let backend: Promise<MediaBackend> | undefined = opts.backend ? Promise.resolve(opts.backend) : undefined;
  const media = () => (backend ??= import('../media/index.js').then((m) => m.getMediaBackend({ baseDir: projectDir })));
  let layouter: TextLayouter | undefined;
  const services: MglServices = {
    async probe(src) {
      const kind = kindFromExtension(src);
      if (kind && !['video', 'audio', 'image'].includes(kind)) return { kind } as ProbeInfo;
      const info = await (await media()).probe(confined(projectDir, src));
      const out: ProbeInfo = { kind: info.kind, duration: info.duration, hasAudio: info.hasAudio, hasVideo: info.hasVideo };
      if (info.width) { out.width = info.width; out.height = info.height!; }
      if (info.fps) out.fps = info.fps;
      const codec = info.videoCodec ?? info.audioCodec;
      if (codec) out.codec = codec;
      return out;
    },
    async analyzeAudio(src, o) {
      const r = await (await media()).analyzeAudio(confined(projectDir, src), o);
      return { silences: r.silences, duration: r.duration, beats: r.beats, ...(r.bpm ? { bpm: r.bpm } : {}) };
    },
    async trackMotion(src, o) {
      const { trackMotion } = await import('../media/index.js');
      return trackMotion(confined(projectDir, src), { fps: o.fps, inFrames: o.inFrames, lenFrames: o.lenFrames, rate: o.rate });
    },
    async readText(p) {
      const abs = confined(projectDir, p);
      try { return await readFile(abs, 'utf8'); } catch { return fail('E_NO_FILE', `cannot read ${p} (looked in ${abs}).`, 'give the path relative to the project file.'); }
    },
    async analyzeLevels(src, rate) {
      const b = await media();
      if (!b.analyzeLevels) return fail('E_NATIVE', 'this media backend cannot measure sound levels.', 'use the default native-ffmpeg backend.');
      return b.analyzeLevels(confined(projectDir, src), rate);
    },
    measureText(text, style) {
      layouter ??= createTextLayouter();
      const st = { font: 'Inter', size: 72, color: '#ffffff', align: 'center', lineHeight: 1.2, letterSpacing: 0, weight: 700, ...style } as ResolvedTextStyle;
      const l = layouter.layout(text, st);
      return { width: l.w, height: l.h };
    },
  };
  // generated files (audio.music, audio.sfx, audio.speak): writes only directly inside media/generated/
  let gen: Promise<ReturnType<typeof import('../audiogen/node.js')['generatedFileServices']>> | undefined;
  const generated = () => (gen ??= import('../audiogen/node.js').then((m) => m.generatedFileServices(projectDir)));
  services.writeFile = async (rel, data) => (await generated()).writeFile(rel, data);
  services.fileExists = async (rel) => (await generated()).fileExists(rel);
  if (opts.workDir) {
    const wd = opts.workDir;
    services.writeWork = async (name, data) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) fail('E_PATH', `work files are plain names, not "${name}".`, 'use a name like search.json.');
      await mkdir(wd, { recursive: true });
      const abs = resolve(wd, name), tmp = `${abs}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, abs);
      const rel = relative(process.cwd(), abs);
      return outside(rel) ? abs : rel;
    };
  }
  services.writeProjectText = async (rel, text) => {
    if (!/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(txt|md)$/.test(rel)) fail('E_PATH', `"${rel}" is not a .txt or .md file name inside the project folder.`, 'use a name like credits.txt.');
    const abs = confined(projectDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    confined(projectDir, rel);
    const tmp = `${abs}.${process.pid}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, abs);
    return abs;
  };
  services.describeSound = async (src) => {
    const abs = confined(projectDir, src);
    const b = await media();
    const { describeSound } = await import('./sound.js');
    return describeSound(abs, b);
  };
  if (registry) {
    const speak = firstProvider<SpeakProvider>(registry, 'speak');
    if (speak) services.speak = speakService(projectDir, speak);
    const transcribe = firstProvider<TranscribeProvider>(registry, 'transcribe');
    if (transcribe) services.transcribe = transcribeService(projectDir, transcribe);
    const stock = stockService(projectDir, registry, opts.stock);
    if (stock) services.stock = stock;
    services.catalog = registry.catalog();
    // plugins that failed to load (a LoadedRegistry carries them), so a command can name the load error
    const problems = (registry as PluginRegistry & { problems?: CommandServices['pluginProblems'] }).problems;
    if (Array.isArray(problems)) services.pluginProblems = problems;
  }
  return services;
}

/** The first provider of a kind (registration order: built-ins, then the project's plugins in the order they load). */
export function firstProvider<P>(registry: PluginRegistry, kind: 'speak' | 'transcribe'): P | undefined {
  const m = registry.providers?.get(kind);
  return m ? (m.values().next().value as P | undefined) : undefined;
}

/** Providers by kind for `mgl doctor` and docs: [{kind, id, describe}]. */
export function listProviders(registry: PluginRegistry): { kind: string; id: string; describe: string }[] {
  const out: { kind: string; id: string; describe: string }[] = [];
  for (const [kind, m] of registry.providers ?? []) for (const [id, p] of m) out.push({ kind, id, describe: p.describe });
  return out;
}

const GENERATED = /^media\/generated\/[A-Za-z0-9][A-Za-z0-9._-]*\.wav$/;

/** A speak provider bound to the project folder: it writes only media/generated/<name>.wav (via a temp file, renamed on success). */
export function speakService(projectDir: string, p: SpeakProvider): SpeakService {
  return {
    id: p.id, describe: p.describe,
    voices: () => p.voices(),
    async speak(args) {
      if (!GENERATED.test(args.out)) fail('E_PATH', `speech goes directly in media/generated/, not "${args.out}".`, 'use a name like media/generated/vo-<hash>.wav.');
      const abs = confined(projectDir, args.out);
      await mkdir(dirname(abs), { recursive: true });
      confined(projectDir, args.out); // again, now the folder exists (a symlinked media/generated is refused)
      const tmp = `${abs.slice(0, -4)}.${process.pid}.tmp.wav`;
      try {
        const r = await p.speak({ text: args.text, ...(args.voice !== undefined ? { voice: args.voice } : {}), ...(args.speed !== undefined ? { speed: args.speed } : {}), out: tmp });
        const st = await stat(tmp).catch(() => undefined);
        if (!st?.isFile() || st.size < 44) fail('E_PROVIDER', `speak provider "${p.id}" wrote no audio.`, `check the provider (mgl doctor lists it), or use another voice.`);
        await rename(tmp, abs);
        return r ?? {};
      } catch (e) {
        await rm(tmp, { force: true });
        if (!(e instanceof MglError)) fail('E_PROVIDER', `speak provider "${p.id}" failed: ${String((e as Error)?.message ?? e).split('\n')[0]}`, 'check the provider (mgl doctor lists it); the offline fallback is a recorded voice file (asset.add) + captions.from-text.');
        throw e;
      }
    },
  };
}

/** A transcribe provider bound to the project folder (the file must be inside it). */
export function transcribeService(projectDir: string, p: TranscribeProvider): TranscribeService {
  return {
    id: p.id, describe: p.describe,
    async transcribe(args) {
      const file = confined(projectDir, args.file);
      try {
        return await p.transcribe({ file, ...(args.lang ? { lang: args.lang } : {}) });
      } catch (e) {
        if (!(e instanceof MglError)) fail('E_PROVIDER', `transcribe provider "${p.id}" failed: ${String((e as Error)?.message ?? e).split('\n')[0]}`, 'check the provider (mgl doctor lists it); the offline fallback is captions.from-text with the script.');
        throw e;
      }
    },
  };
}
