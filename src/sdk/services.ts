/** The services commands use (probe, audio analysis, file reads, motion tracking, catalog, text metrics), bound to a project directory. */
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fail } from '../core/errors.js';
import type { CommandServices, ProbeInfo } from '../core/commands/registry.js';
import { kindFromExtension } from '../core/commands/structure.js';
import type { PluginRegistry } from '../plugin/registry.js';
import type { MediaBackend } from '../media/types.js';
import type { ResolvedTextStyle, TextLayouter } from '../render/types.js';
import { createTextLayouter } from '../render/text.js';

/** Resolve a path relative to the project directory, refusing paths that leave it. */
export function confined(projectDir: string, p: string): string {
  const abs = resolve(projectDir, p);
  const rel = relative(resolve(projectDir), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) fail('E_PATH', `"${p}" is outside the project folder.`, 'give a path relative to the project file, inside its folder (copy the file there first).');
  return abs;
}

export interface ServiceOptions {
  /** a media backend (default: native ffmpeg, loaded on first use) */
  backend?: MediaBackend;
}

export function makeServices(projectDir: string, registry?: PluginRegistry, opts: ServiceOptions = {}): CommandServices {
  let backend: Promise<MediaBackend> | undefined = opts.backend ? Promise.resolve(opts.backend) : undefined;
  const media = () => (backend ??= import('../media/index.js').then((m) => m.getMediaBackend({ baseDir: projectDir })));
  let layouter: TextLayouter | undefined;
  const services: CommandServices = {
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
      return { silences: r.silences, duration: r.duration };
    },
    async trackMotion(src, o) {
      const { trackMotion } = await import('../media/index.js');
      return trackMotion(confined(projectDir, src), { fps: o.fps, inFrames: o.inFrames, lenFrames: o.lenFrames, rate: o.rate });
    },
    async readText(p) {
      const abs = confined(projectDir, p);
      try { return await readFile(abs, 'utf8'); } catch { return fail('E_NO_FILE', `cannot read ${p} (looked in ${abs}).`, 'give the path relative to the project file.'); }
    },
    measureText(text, style) {
      layouter ??= createTextLayouter();
      const st = { font: 'Inter', size: 72, color: '#ffffff', align: 'center', lineHeight: 1.2, letterSpacing: 0, weight: 700, ...style } as ResolvedTextStyle;
      const l = layouter.layout(text, st);
      return { width: l.w, height: l.h };
    },
  };
  if (registry) services.catalog = registry.catalog();
  return services;
}
