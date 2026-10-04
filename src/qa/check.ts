/**
 * `mgl check`: QA without pixels. Runs every project-stage check in the registry (with layer boxes from
 * evaluate at rest frames), plus file existence of assets and plugin load problems.
 */
import { existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, extname } from 'node:path';
import type { CheckContext, Finding } from '../plugin/api.js';
import type { PluginRegistry } from '../plugin/registry.js';
import type { Problem } from '../core/load.js';
import type { ProjectFile } from '../core/schema/index.js';
import type { TextLayouter } from '../render/types.js';
import { safeArea } from './safezones.js';
import { ALPHA_PIX_FMT, ignores, ignoresExplicitly } from '../builtin/checks/index.js';

export type { Finding };
/** A finding from a multi-platform run: `platform` is set when it applies to that platform only. */
export type PlatformFinding = Finding & { platform?: string };
/** Probed facts of a media file (MediaBackend.probe is one). */
export type ProbeFn = (absPath: string) => Promise<{ duration?: number; width?: number; height?: number; pixFmt?: string }>;
/** `alpha`: the probed pixel format has an alpha channel (undefined when the probe gave no pixel format). */
export type MediaFacts = { duration?: number; width?: number; height?: number; alpha?: boolean };
export type Layers = NonNullable<CheckContext['layers']>;
export type Stage = 'project' | 'frame' | 'audio';

export interface CheckOptions {
  /** the project file's directory (assets and plugins resolve against it) */
  baseDir: string;
  /** default: the project's plugins loaded on top of the built-ins */
  registry?: PluginRegistry;
  /** text measurer for layer boxes (default: the Skia layouter) */
  layouter?: TextLayouter;
  comp?: string;
  /** override project.platform */
  platform?: string;
  /** check against several platforms at once: findings that differ per platform carry `platform` and a [name] prefix */
  platforms?: string[];
  /** the project file as the user named it: replaces "<file>" in fixes (default: fixes keep "<file>") */
  file?: string;
  /** probe media for sizes and durations (enables clip-past-source and exact media boxes); e.g. MediaBackend.probe */
  probe?: ProbeFn;
  /** the render will use --alpha (enables alpha-with-bg) */
  alpha?: boolean;
}

const SEVERITY = { error: 0, warning: 1, info: 2 } as const;
export const sortFindings = (fs: Finding[]) => fs.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || (a.frame ?? -1) - (b.frame ?? -1));

export function compIdOf(p: ProjectFile, id?: string): string {
  const want = id ?? p.project?.main;
  if (want && p.comps.some((c) => c.id === want)) return want;
  return p.comps.find((c) => c.id === 'main')?.id ?? p.comps[0]!.id;
}

/** The registry for a project: loadRegistry (plugins, with problems) or the built-ins. */
export async function projectRegistry(project: ProjectFile, baseDir: string): Promise<{ registry: PluginRegistry; problems: Problem[] }> {
  try {
    const { loadRegistry } = await import('../plugin/loader.js');
    const r = await loadRegistry(project, baseDir);
    return { registry: r.registry, problems: r.problems };
  } catch (e) {
    const { builtinRegistry } = await import('../builtin/index.js');
    return { registry: builtinRegistry(), problems: [{ code: 'E_PLUGIN_LOAD', severity: 'error', message: `plugins could not be loaded: ${(e as Error).message.split('\n')[0]}`, fix: 'run "mgl doctor" and "mgl plugin list" to see which plugin fails.' }] };
  }
}

export function makeContext(project: ProjectFile, compId: string, platform: string | undefined, extra: Partial<CheckContext> = {}): CheckContext {
  const comp = project.comps.find((c) => c.id === compId)!;
  const pf = platform ?? project.project?.platform ?? 'none';
  return { project, compId, platform: pf, safeArea: (p) => safeArea(p ?? pf, comp.size[0], comp.size[1]), ...extra };
}

/** Rules whose findings are about a stretch of the timeline: a tagged clip playing at that frame silences them. */
const FRAME_SCOPED = new Set(['black-frames', 'trailing-black', 'gaps', 'long-silence', 'luma-range']);

/**
 * Drop findings that clips opted out of with a "qa-ignore:<rule>" tag (or "qa-ignore:all"): the finding's clip (any
 * matching tag); for timeline rules another clip of the comp playing at the finding's frame, and for project-scoped
 * findings (no clip, no frame: loudness, clipping ...) any clip of the comp, but those only with a tag that names the
 * rule (or an alias): "qa-ignore:all" on one clip covers that clip, never the whole mix.
 */
export function applyIgnores(project: ProjectFile, compId: string, fs: Finding[]): Finding[] {
  const all = new Map((project.clips ?? []).map((c) => [c.id, c]));
  const tracks = new Set((project.tracks ?? []).filter((t) => t.comp === compId).map((t) => t.id));
  const inComp = (project.clips ?? []).filter((c) => tracks.has(c.track) && c.tags?.some((t) => t.startsWith('qa-ignore:')));
  if (!inComp.length && ![...all.values()].some((c) => c.tags?.length)) return fs;
  return fs.filter((f) => {
    if (f.clip && ignores(all.get(f.clip), f.rule)) return false;
    if (f.frame !== undefined && FRAME_SCOPED.has(f.rule) && inComp.some((c) => f.frame! >= c.at && f.frame! < c.at + c.len && ignoresExplicitly(c, f.rule))) return false;
    if (!f.clip && f.frame === undefined && inComp.some((c) => ignoresExplicitly(c, f.rule))) return false;
    return true;
  });
}

/** Run every check of a stage; a check that throws becomes an info finding instead of failing the run. Honours qa-ignore tags. */
export async function runStage(registry: PluginRegistry, stage: Stage, ctx: CheckContext): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const def of registry.checks.values()) {
    if (def.stage !== stage) continue;
    try { out.push(...(await def.run(ctx))); } catch (e) {
      out.push({ rule: def.id, severity: 'info', message: `check "${def.id}" failed: ${(e as Error).message.split('\n')[0]}`, fix: `mgl plugin list # report it to the plugin that provides "${def.id}"` });
    }
  }
  return applyIgnores(ctx.project, ctx.compId, out);
}

/**
 * Merge per-platform runs: a finding every platform shares is kept once; the rest are prefixed "[platform]" and carry
 * `platform`. One platform: its findings unchanged.
 */
export function mergePlatforms(runs: [string, Finding[]][]): PlatformFinding[] {
  if (runs.length === 1) return runs[0]![1];
  const key = (f: Finding) => `${f.rule}|${f.clip ?? ''}|${f.frame ?? ''}|${f.message}|${f.fix ?? ''}`;
  const count = new Map<string, number>();
  for (const [, fs] of runs) for (const k of new Set(fs.map(key))) count.set(k, (count.get(k) ?? 0) + 1);
  const common = (f: Finding) => count.get(key(f)) === runs.length;
  const out: PlatformFinding[] = runs[0]![1].filter(common);
  for (const [pf, fs] of runs) for (const f of fs) if (!common(f)) out.push({ ...f, message: `[${pf}] ${f.message}`, platform: pf });
  return out;
}

/** The platforms to check: opts.platforms (deduplicated), else the single override or the project's platform. */
export function platformsOf(project: ProjectFile, o: { platform?: string; platforms?: string[] }): string[] {
  const list = [...new Set((o.platforms ?? []).map((p) => p.trim()).filter(Boolean))];
  return list.length ? list : [o.platform ?? project.project?.platform ?? 'none'];
}

/** Replace "<file>" in fixes with the project file's name. */
export function withFile<F extends Finding>(fs: F[], file: string | undefined): F[] {
  if (!file) return fs;
  for (const f of fs) if (f.fix) f.fix = f.fix.replaceAll('<file>', /\s/.test(file) ? `'${file}'` : file);
  return fs;
}

/** Probe the media assets used by clips (no generators/URLs, existing files only): asset id → facts. */
export async function probeAssets(project: ProjectFile, baseDir: string, probe: ProbeFn | undefined): Promise<Map<string, MediaFacts>> {
  const out = new Map<string, MediaFacts>();
  if (!probe) return out;
  const used = new Set((project.clips ?? []).map((c) => c.asset).filter((a): a is string => a !== undefined));
  await Promise.all((project.assets ?? []).filter((a) => used.has(a.id) && a.kind !== 'font' && a.kind !== 'lut' && a.kind !== 'subtitles' && a.kind !== 'data').map(async (a) => {
    if (/^[a-z][a-z0-9+.-]+:/i.test(a.src) && !/^[a-z]:[\\/]/i.test(a.src)) return;
    const p = isAbsolute(a.src) ? a.src : resolve(baseDir, a.src);
    if (!existsSync(p)) return;
    try {
      const r = await probe(p);
      const facts: MediaFacts = {};
      if (typeof r.duration === 'number' && r.duration > 0 && !IMAGE.test(a.src) && a.kind !== 'image') facts.duration = r.duration;
      if (r.width) facts.width = r.width;
      if (r.height) facts.height = r.height;
      if (r.pixFmt) facts.alpha = ALPHA_PIX_FMT.test(r.pixFmt);
      out.set(a.id, facts);
    } catch { /* unreadable media is reported by missing-media / render */ }
  }));
  return out;
}

/** Frames across every visual clip (10%, 50% and 90% of its span), for coverage and position checks (at most 96). */
export function sampleFrames(project: ProjectFile, compId: string): number[] {
  const tracks = new Set((project.tracks ?? []).filter((t) => t.comp === compId && !t.audio && !t.hidden).map((t) => t.id));
  const set = new Set<number>();
  for (const c of project.clips ?? []) {
    if (!tracks.has(c.track) || c.hidden || c.len <= 0) continue;
    for (const k of [0.1, 0.5, 0.9]) set.add(c.at + Math.min(c.len - 1, Math.floor(c.len * k)));
  }
  const all = [...set].sort((a, b) => a - b);
  if (all.length <= 96) return all;
  return [...new Set(Array.from({ length: 96 }, (_, i) => all[Math.round((i * (all.length - 1)) / 95)]!))];
}

const IMAGE = /\.(png|jpe?g|webp|gif|bmp|svg|tiff?|avif)$/i;
const AUDIO = /\.(wav|mp3|m4a|aac|opus|ogg|flac)$/i;

/** Frames where text sits at rest: the middle of each text clip and of each caption cue (at most 64). */
export function restFrames(project: ProjectFile, compId: string): number[] {
  const tracks = new Map((project.tracks ?? []).filter((t) => t.comp === compId && !t.audio && !t.hidden).map((t) => [t.id, t]));
  const set = new Set<number>();
  for (const c of project.clips ?? []) {
    if (!tracks.has(c.track) || c.hidden) continue;
    if (c.text !== undefined) set.add(c.at + Math.floor(c.len / 2));
    if (c.captions) {
      const cues = (project.cues ?? []).filter((q) => q.clip === c.id && q.at < c.len);
      for (const q of cues) set.add(c.at + q.at + Math.floor(Math.min(q.len, c.len - q.at) / 2));
      if (!cues.length) set.add(c.at + Math.floor(c.len / 2));
    }
  }
  const all = [...set].sort((a, b) => a - b);
  if (all.length <= 64) return all;
  return Array.from({ length: 64 }, (_, i) => all[Math.round((i * (all.length - 1)) / 63)]!);
}

/** Layer boxes (comp px) at the given frames from evaluate, with no pixels. Frames that fail to evaluate are skipped. */
export async function projectLayers(project: ProjectFile, compId: string, frames: number[], opts: { baseDir: string; registry: PluginRegistry; layouter?: TextLayouter; media?: Map<string, MediaFacts> }): Promise<Layers> {
  const out: Layers = new Map();
  if (!frames.length) return out;
  const { evaluateLayers } = await import('../render/evaluate.js');
  const text = await import('../render/text.js');
  for (const a of project.assets ?? []) if (a.kind === 'font' || /\.(ttf|otf|woff2?|ttc)$/i.test(a.src)) {
    const p = isAbsolute(a.src) ? a.src : resolve(opts.baseDir, a.src);
    if (existsSync(p)) text.registerFontAsset(p, a.id);
  }
  const layouter = opts.layouter ?? text.createTextLayouter();
  const kinds = new Map((project.assets ?? []).map((a) => [a.id, a]));
  const media = opts.media;
  const eo = {
    layouter, registry: opts.registry,
    ...(media?.size ? { media: (id: string) => media.get(id) } : {}),
    assetKind: (id: string) => {
      const a = kinds.get(id);
      const k = a?.kind ?? (a && IMAGE.test(a.src) ? 'image' : a && AUDIO.test(a.src) ? 'audio' : 'video');
      return k === 'image' || k === 'audio' ? k : 'video';
    },
  };
  for (const f of frames) {
    try { out.set(f, evaluateLayers(project, compId, f, eo)); } catch { /* evaluation errors are reported by validation and render */ }
  }
  return out;
}

/** Look for a file with the same name under dir (3 levels), for relink suggestions. */
function findByName(dir: string, name: string, depth = 3): string | undefined {
  let entries: import('node:fs').Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
  for (const e of entries) if (e.isFile() && e.name === name) return join(dir, e.name);
  if (depth <= 0) return undefined;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const hit = findByName(join(dir, e.name), name, depth - 1);
    if (hit) return hit;
  }
  return undefined;
}

/** Assets whose file does not exist (generators like "lavfi:..." and URLs are skipped). */
export function missingMedia(project: ProjectFile, baseDir: string): Finding[] {
  const out: Finding[] = [];
  for (const a of project.assets ?? []) {
    if (/^[a-z][a-z0-9+.-]+:/i.test(a.src) && !/^[a-z]:[\\/]/i.test(a.src)) continue;
    const p = isAbsolute(a.src) ? a.src : resolve(baseDir, a.src);
    if (existsSync(p)) continue;
    const users = (project.clips ?? []).filter((c) => c.asset === a.id);
    const found = findByName(baseDir, basename(a.src));
    const f: Finding = {
      rule: 'missing-media', severity: users.length ? 'error' : 'warning',
      message: `asset "${a.id}" file ${a.src} does not exist${users.length ? ` (used by ${users.slice(0, 3).map((c) => c.id).join(', ')}${users.length > 3 ? ` +${users.length - 3}` : ''})` : ' (unused)'}`,
      fix: found ? `mgl edit <file> asset.relink ${a.id} src=${relative(baseDir, found)}`
        : users.length ? `mgl edit <file> asset.relink ${a.id} src=<path to the ${extname(a.src) || 'media'} file>` : `mgl edit <file> asset.remove ${a.id}`,
    };
    if (users[0]) { f.clip = users[0].id; f.frame = users[0].at; }
    out.push(f);
  }
  return out;
}

export function problemFindings(problems: Problem[]): Finding[] {
  return problems.map((p) => ({ rule: p.code.startsWith('E_PLUGIN') || p.code.startsWith('W_PLUGIN') ? 'plugin' : p.code.toLowerCase(), severity: p.severity, message: p.message, fix: p.fix }));
}

/** Project-stage QA (no pixels): plugin problems, missing media, and every project-stage check (per platform with `platforms`). Load problems are reported separately by the loader. */
export async function checkProject(project: ProjectFile, opts: CheckOptions): Promise<PlatformFinding[]> {
  const compId = compIdOf(project, opts.comp);
  let registry = opts.registry, problems: Problem[] = [];
  if (!registry) ({ registry, problems } = await projectRegistry(project, opts.baseDir));
  else if (Array.isArray((registry as { problems?: unknown }).problems)) problems = (registry as unknown as { problems: Problem[] }).problems;
  const facts = await probeAssets(project, opts.baseDir, opts.probe);
  const lo = { baseDir: opts.baseDir, registry, media: facts, ...(opts.layouter ? { layouter: opts.layouter } : {}) };
  const rest = restFrames(project, compId);
  const layers = await projectLayers(project, compId, rest, lo);
  const sampled = await projectLayers(project, compId, sampleFrames(project, compId).filter((f) => !layers.has(f)), lo);
  for (const [f, ls] of layers) sampled.set(f, ls);
  const extra = qaExtras(facts, opts.alpha, sampled, !!opts.probe);
  const runs: [string, Finding[]][] = [];
  for (const pf of platformsOf(project, opts)) runs.push([pf, await runStage(registry, 'project', makeContext(project, compId, pf, { layers, ...extra }))]);
  return withFile(sortFindings([...problemFindings(problems), ...missingMedia(project, opts.baseDir), ...mergePlatforms(runs)]), opts.file);
}

/** The optional context fields the built-in checks read beyond the basics (sampled boxes, probed facts, alpha). */
export function qaExtras(facts: Map<string, MediaFacts>, alpha: boolean | undefined, sampled: Layers | undefined, probed: boolean): Partial<CheckContext> {
  const extra: Record<string, unknown> = {};
  if (sampled) extra.sampled = sampled;
  if (probed) {
    extra.sourceDuration = (id: string) => facts.get(id)?.duration;
    extra.sourceAlpha = (id: string) => facts.get(id)?.alpha;
  }
  if (alpha) extra.alpha = true;
  return extra as Partial<CheckContext>;
}
