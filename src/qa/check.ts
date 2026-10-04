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

export type { Finding };
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

/** Run every check of a stage; a check that throws becomes an info finding instead of failing the run. */
export async function runStage(registry: PluginRegistry, stage: Stage, ctx: CheckContext): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const def of registry.checks.values()) {
    if (def.stage !== stage) continue;
    try { out.push(...(await def.run(ctx))); } catch (e) {
      out.push({ rule: def.id, severity: 'info', message: `check "${def.id}" failed: ${(e as Error).message.split('\n')[0]}`, fix: `mgl plugin list # report it to the plugin that provides "${def.id}"` });
    }
  }
  return out;
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
export async function projectLayers(project: ProjectFile, compId: string, frames: number[], opts: { baseDir: string; registry: PluginRegistry; layouter?: TextLayouter }): Promise<Layers> {
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
  const eo = {
    layouter, registry: opts.registry,
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

/** Project-stage QA (no pixels): plugin problems, missing media, and every project-stage check. Load problems are reported separately by the loader. */
export async function checkProject(project: ProjectFile, opts: CheckOptions): Promise<Finding[]> {
  const compId = compIdOf(project, opts.comp);
  let registry = opts.registry, problems: Problem[] = [];
  if (!registry) ({ registry, problems } = await projectRegistry(project, opts.baseDir));
  else if (Array.isArray((registry as { problems?: unknown }).problems)) problems = (registry as unknown as { problems: Problem[] }).problems;
  const layers = await projectLayers(project, compId, restFrames(project, compId), { baseDir: opts.baseDir, registry, ...(opts.layouter ? { layouter: opts.layouter } : {}) });
  const ctx = makeContext(project, compId, opts.platform, { layers });
  return sortFindings([...problemFindings(problems), ...missingMedia(project, opts.baseDir), ...await runStage(registry, 'project', ctx)]);
}
