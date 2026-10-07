/**
 * The SDK: `open` and `create` return a Project session whose `data` is the plain project and whose every
 * change is `p.edit(command)`. Plugins named by the project are loaded and services attached.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MglError, fail } from '../core/errors.js';
import type { Problem } from '../core/load.js';
import { PRESETS } from '../core/commands/structure.js';
import { PLATFORMS, type ProjectFile } from '../core/schema/index.js';
import { parseRate, parseTime } from '../core/time.js';
import type { PluginRegistry } from '../plugin/registry.js';
import type { Command } from '../core/commands/registry.js';
import { Project, emptyProject, workDir, type EditResult } from './project.js';
import { makeServices, type MglServices } from './services.js';
import '../core/commands/index.js';

export { MglError } from '../core/errors.js';
export type { MglErrorInfo, ErrorKind } from '../core/errors.js';
export { listCommands, getCommand, type Command, type CommandDef } from '../core/commands/index.js';
export { Project, emptyProject, workDir, type EditResult, type ChangedLine } from './project.js';
export { makeServices, type MglServices } from './services.js';
export { parseTime, parseRate, formatSeconds, framesToSeconds } from '../core/time.js';
export { formatProject } from '../core/format.js';
export type * from '../core/schema/index.js';
export type { Problem } from '../core/load.js';

export interface LookOptions {
  /** times (frames or "2.5s") to show instead of evenly spaced frames */
  at?: (number | string)[];
  /** number of evenly spaced frames (default 12) */
  frames?: number;
  comp?: string;
  /** add the first frame of every cut */
  cuts?: boolean;
  /** skip the sound report */
  audio?: boolean;
  /** check safe zones (and project-stage rules) against several platforms at once; default: project.platform */
  platforms?: string[];
  /** the render will use --alpha (enables the alpha-with-bg rule) */
  alpha?: boolean;
  /** outline the TikTok / Reels / Shorts interface panels on the sheet and crops (never rendered) */
  safe?: boolean;
  /** how fixes name the project file (default: the file relative to the cwd when below it, else as opened) */
  displayFile?: string;
  /** apply verified auto-fixes (one undo step) and report what remains; the result gains `fix` */
  fix?: boolean;
  /** with fix: find the fixes but do not write the project */
  dryRun?: boolean;
  /** one scene (number or id): scene-<n>.png with its three moments and each visual lane alone, and its level-2 text */
  scene?: number | string;
  /** false: the plain contact sheet even without at / frames / cuts (default: the storyboard) */
  storyboard?: boolean;
}

/** The storyboard summary in look and render results (scenes with their marks: idea, issue, changed). */
export interface StoryboardSummary {
  page?: string;
  scenes: { n: number; id: string; label: string; at: number; len: number; marks: string[]; changes: string[]; issues: number; /** the first issue */ issue?: string; /** a scene marker's note (the label) */ note?: boolean }[];
  notes: string[];
  since?: string;
  scene?: number;
  detail?: string[];
}

export interface StoryboardOptions {
  comp?: string;
  /** where to write the image and the page (default: storyboard.png / storyboard.html in .mgl/<name>/look/) */
  png?: string;
  html?: string;
  /** how fixes and commands name the project file */
  displayFile?: string;
}

/** What p.storyboard() writes: the level-1 image, the page, the scenes. */
export interface StoryboardResult { png: string; html: string; size: [number, number]; seconds: number; storyboard: StoryboardSummary }

export interface CheckOptions {
  /** run the checks once per platform and merge the findings (a platform-specific finding names its platform) */
  platforms?: string[];
  /** the render will use --alpha (enables the alpha-with-bg rule) */
  alpha?: boolean;
  /** how fixes name the project file (default: the file relative to the cwd when below it, else as opened) */
  displayFile?: string;
  /** apply verified auto-fixes (one undo step) and report what remains; the report gains `fix` */
  fix?: boolean;
  /** with fix: find the fixes but do not write the project */
  dryRun?: boolean;
}

/** What look returns (src/qa): the contact sheet, findings with fixes, the sound summary. */
export interface LookResult {
  sheet: string;
  findings: { rule: string; severity: 'error' | 'warning' | 'info'; message: string; clip?: string; frame?: number; fix?: string; platform?: string }[];
  frames: number[];
  crops: { finding: number; path: string }[];
  sound?: { integrated: number; truePeak: number; lra: number; silences: { start: number; end: number }[]; bpm?: number };
  /** the storyboard (default look and scene) */
  storyboard?: StoryboardSummary;
  [k: string]: unknown;
}

export interface RenderOpts {
  quality?: 'draft' | 'final' | 'hq';
  /** [start, end) in frames or edge times */
  range?: [number | string, number | string];
  /** .png: the frame to write */
  still?: number | string;
  alpha?: boolean;
  comp?: string;
  segments?: number;
  /** audio stems: one bus's contribution to master, or 'all' (one stereo pair per bus in a multichannel .wav) */
  bus?: string;
  /** video constant rate factor (mp4 x264 0–51, webm VP9 0–63; lower = better) */
  crf?: number;
  /** video bitrate, e.g. "8M" (mp4/webm) */
  bitrate?: string;
  /** audio bitrate for aac/opus/mp3, e.g. "320k" */
  audioBitrate?: string;
  /** PCM bit depth for .wav/.flac and .mov audio */
  pcmDepth?: 16 | 24;
  /** ProRes profile for .mov: proxy, lt, 422, hq (default), 4444 (default with alpha), 4444xq */
  prores?: 'proxy' | 'lt' | '422' | 'hq' | '4444' | '4444xq';
  /** start timecode written to .mov/.mp4, "HH:MM:SS:FF" (";" before FF for drop-frame) */
  timecode?: string;
  /** colour range flag of the video: tv (limited, default) or pc (full) */
  colorRange?: 'tv' | 'pc';
  onEstimate?(e: { seconds: number; note: string }): void;
  onProgress?(p: { frame: number; total: number; fps: number; etaSec: number }): void;
}

export interface CheckReport {
  /** load warnings and render-blocking issues, plugin problems */
  problems: Problem[];
  /** QA findings that need no pixels */
  findings: { rule: string; severity: 'error' | 'warning' | 'info'; message: string; clip?: string; frame?: number; fix?: string; line?: number; platform?: string }[];
  /** errors (problems with severity error + findings with severity error) */
  errors: number;
  /** with `fix: true`: the fixes applied and rejected (findings then hold what remains) */
  fix?: { applied: { rule: string; clip?: string | undefined; message: string; fix: string; round: number }[]; rejected: { rule: string; clip?: string | undefined; message: string; fix?: string | undefined; reason: string }[]; rounds: number; before: number; remaining: unknown[]; dryRun?: boolean | undefined };
}

/** A project session with the plugin registry and the look / render / check verbs. */
export type MglProject = Project & {
  registry: PluginRegistry;
  /** probe, analyzeAudio, analyzeLevels, measureText, readText ... bound to the project folder */
  services: MglServices;
  /** plugin problems (untrusted, not found, wrong version) */
  pluginProblems: Problem[];
  /** what p.edit(cmd) would change, without changing anything */
  dryRun(cmds: Command | Command[]): Promise<EditResult>;
  look(opts?: LookOptions): Promise<LookResult>;
  render(out: string, opts?: RenderOpts): Promise<import('../render/pipeline.js').RenderResult>;
  check(opts?: CheckOptions): Promise<CheckReport>;
  /** the storyboard image and page alone (what render writes next to a video); ● against the previous storyboard */
  storyboard(opts?: StoryboardOptions): Promise<StoryboardResult>;
};

/** Error codes for a name a plugin might have defined (effect type, op, template, ...). */
const PLUGIN_NAME_CODES = new Set(['E_UNKNOWN_EFFECT', 'E_UNKNOWN_TRANSITION', 'E_UNKNOWN_TEMPLATE', 'E_UNKNOWN_ANIMATION', 'E_UNKNOWN_OP', 'E_UNKNOWN_GENERATOR', 'E_UNKNOWN_STYLE', 'E_UNKNOWN_CHECK']);

/**
 * When an unknown effect / transition / op / ... error happens while some of the project's plugins failed to
 * load, say so: the name probably comes from that plugin, and the plugin's load error is the real fix.
 * Returns the error itself (changed in place) so callers can `throw withPluginProblems(e, problems)`.
 */
export function withPluginProblems<E>(e: E, problems: readonly Problem[]): E {
  if (!(e instanceof MglError) || !PLUGIN_NAME_CODES.has(e.code)) return e;
  const failed = problems.filter((x) => x.severity === 'error' && x.code.startsWith('E_PLUGIN'));
  if (!failed.length || e.message.includes('did not load')) return e;
  const f = failed[0]!;
  e.message = `${e.message} Plugin ${failed.length > 1 ? `problems (${failed.length})` : 'problem'}: ${f.message}${/[.!?]$/.test(f.message) ? '' : '.'} (it may define this name, but it did not load)`;
  e.fix = `${f.fix} (then retry; or: ${e.fix})`;
  e.problems = [...(e.problems ?? []), ...failed.slice(1).map(({ code, message, fix }) => ({ code, message, fix }))];
  return e;
}

async function attach(p: Project): Promise<MglProject> {
  const { loadRegistry } = await import('../plugin/loader.js');
  const self = p as MglProject;
  let loaded = '';
  /** (Re)load the registry when the project's plugin list changed: a plugin named by `project.set plugins=...` is usable on this session at once. */
  const sync = async (): Promise<void> => {
    const want = JSON.stringify(p.data.project?.plugins ?? null);
    if (self.registry && want === loaded) return;
    const reg = await loadRegistry(p.data, p.dir);
    loaded = want;
    p.services = makeServices(p.dir, reg, { workDir: workDir(p.file) });
    self.registry = reg;
    self.pluginProblems = reg.problems;
  };
  await sync();
  const edit = p.edit.bind(p), undo = p.undo.bind(p), redo = p.redo.bind(p);
  // a dry run changes nothing, so it cannot change the plugin list either
  self.edit = async (cmds, opts) => {
    try { return await edit(cmds, opts); } catch (e) { throw withPluginProblems(e, self.pluginProblems); } finally { if (!opts?.dryRun) await sync(); }
  };
  self.undo = async (steps) => { try { return await undo(steps); } finally { await sync(); } };
  self.redo = async (steps) => { try { return await redo(steps); } finally { await sync(); } };
  self.dryRun = (cmds) => self.edit(cmds, { dryRun: true });
  self.look = (opts = {}) => lookProject(self, opts);
  self.render = (out, opts = {}) => renderProject(self, out, opts);
  self.check = (opts = {}) => checkProject(self, opts);
  self.storyboard = (opts = {}) => storyboardProject(self, opts);
  return self;
}

/** Open and validate a project file (throws MglError with line numbers and fixes), load its plugins. */
export async function open(file: string): Promise<MglProject> {
  return attach(await Project.open(file));
}

export interface CreateOptions {
  /** shorts, tiktok, reels, vertical, youtube, landscape, square, portrait, 4k (default shorts) */
  preset?: string;
  fps?: number | string;
  name?: string;
  platform?: NonNullable<ProjectFile['project']>['platform'];
  /** overwrite an existing file */
  force?: boolean;
  /** write the file now (default true) */
  save?: boolean;
}

/** The project data `create` writes for a preset. */
export function presetProject(opts: CreateOptions = {}): ProjectFile {
  const name = opts.preset ?? 'shorts';
  const preset = PRESETS[name];
  if (!preset) fail('E_PRESET', `"${name}" is not a preset.`, `use one of: ${Object.keys(PRESETS).join(', ')}.`);
  const platform = opts.platform ?? preset.platform;
  return emptyProject({ size: preset.size, fps: opts.fps ?? 30, ...(opts.name ? { name: opts.name } : {}), ...(platform ? { platform } : {}) });
}

/** Create a new project file from a preset (refuses to overwrite unless force). */
export async function create(file: string, opts: CreateOptions = {}): Promise<MglProject> {
  if (existsSync(file) && !opts.force && opts.save !== false) fail('E_EXISTS', `${file} already exists.`, 'choose another name (-o other.mgl.json), or pass force (--force) to overwrite it.');
  const p = Project.create(file, presetProject(opts));
  if (opts.save !== false) await p.save({ force: true });
  return attach(p);
}

// ------------------------------------------------------------------------------------------- verbs

/** Plugin errors refuse render/look (untrusted, missing, incompatible plugins). */
function assertPlugins(p: MglProject) {
  const errs = p.pluginProblems.filter((x) => x.severity === 'error');
  if (errs.length) {
    const { severity: _s, renderOnly: _r, ...first } = errs[0]!;
    throw new MglError({ ...first, problems: errs.slice(1) });
  }
}

/** Throw the first plugin problem or render-blocking issue (with its fix), as render and look do. */
export function assertRenderable(p: MglProject) {
  assertPlugins(p);
  const issues = p.issues;
  if (issues.length) {
    const { severity: _s, renderOnly: _r, ...first } = issues[0]!;
    throw new MglError({ ...first, message: `cannot render: ${first.message}${issues.length > 1 ? ` (+${issues.length - 1} more; mgl check lists them)` : ''}`, problems: issues.slice(1) });
  }
}

/** RenderOpts fields passed to the pipeline as they are (stems and delivery settings). */
export const DELIVERY_FIELDS = ['bus', 'crf', 'bitrate', 'audioBitrate', 'pcmDepth', 'prores', 'timecode', 'colorRange'] as const;

async function renderProject(p: MglProject, out: string, o: RenderOpts) {
  assertRenderable(p);
  const pipeline = await import('../render/pipeline.js');
  const comp = pipeline.resolveComp(p.data, o.comp);
  const rate = parseRate(comp.fps);
  const opts: import('../render/pipeline.js').RenderOptions = { baseDir: p.dir, registry: p.registry, comp: comp.id, quality: o.quality ?? 'final' };
  if (o.range) opts.range = [parseTime(o.range[0], rate, 'range start'), parseTime(o.range[1], rate, 'range end')];
  if (o.still !== undefined) opts.still = parseTime(o.still, rate, 'still');
  if (o.alpha) opts.alpha = true;
  if (o.segments) opts.segments = o.segments;
  for (const k of DELIVERY_FIELDS) if (o[k] !== undefined) (opts as unknown as Record<string, unknown>)[k] = o[k];
  if (o.onEstimate) opts.onEstimate = o.onEstimate;
  if (o.onProgress) opts.onProgress = o.onProgress;
  return pipeline.render(p.data, resolve(out), opts);
}

/** The QA functions (src/qa: look, checkProject, formatLook, formatFindings), when present in this build. */
export async function qaModule(): Promise<Record<string, any> | undefined> {
  const mods: Record<string, any> = {};
  // literal specifiers, so bundlers and vitest resolve them too
  for (const load of [() => import('../qa/look.js'), () => import('../qa/check.js'), () => import('../qa/format.js')]) {
    try { Object.assign(mods, await load()); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw e;
    }
  }
  return Object.keys(mods).length ? mods : undefined;
}

/** Validate a platform list ("tiktok,reels" or an array); unknown names are an error with the known list. */
export function parsePlatforms(v: string | string[]): string[] {
  const list = (Array.isArray(v) ? v : v.split(',')).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((x) => !(PLATFORMS as readonly string[]).includes(x));
  if (!list.length || bad.length) fail('E_ARG', bad.length ? `"${bad.join('", "')}" ${bad.length > 1 ? 'are not platforms' : 'is not a platform'}.` : 'no platform given.', `use a comma-separated list of ${PLATFORMS.join(', ')} (e.g. --platform tiktok,reels,shorts).`);
  return [...new Set(list)];
}

async function lookProject(p: MglProject, o: LookOptions): Promise<LookResult> {
  assertRenderable(p);
  if (o.fix) {
    const { resolveComp } = await import('../render/pipeline.js');
    const comp = resolveComp(p.data, o.comp);
    const rate = parseRate(comp.fps);
    const { fixLook, fixJson } = await import('../qa/fix.js');
    const r = await fixLook(p, {
      comp: comp.id, ...(o.at?.length ? { frames: o.at.map((t) => parseTime(t, rate, 'at')) } : {}), ...(o.frames !== undefined ? { n: o.frames } : {}),
      ...(o.cuts ? { cuts: true } : {}), ...(o.audio === false ? { audio: false } : {}), ...(o.platforms?.length ? { platforms: parsePlatforms(o.platforms) } : {}),
      ...(o.alpha ? { alpha: true } : {}), ...(o.safe ? { safe: true } : {}), ...(o.displayFile ? { displayFile: o.displayFile } : {}), ...(o.dryRun ? { dryRun: true } : {}),
    });
    return { ...(r.report as unknown as LookResult), findings: r.remaining as LookResult['findings'], fix: fixJson(r) };
  }
  const qa = await qaModule();
  if (!qa?.look) fail('E_NOT_AVAILABLE', 'look is not available in this build (src/qa is missing).', 'render stills instead: mgl render <file> frame.png --still 1s');
  const { resolveComp } = await import('../render/pipeline.js');
  const comp = resolveComp(p.data, o.comp);
  const rate = parseRate(comp.fps);
  const opts: Record<string, unknown> = { baseDir: p.dir, file: p.file, comp: comp.id, registry: p.registry };
  if (o.at?.length) opts.frames = o.at.map((t) => parseTime(t, rate, 'at'));
  if (o.frames !== undefined) opts.n = o.frames;
  if (o.cuts) opts.cuts = true;
  if (o.audio === false) opts.audio = false;
  // several platforms: the QA module runs the platform-dependent rules once per platform and tags what differs
  if (o.platforms?.length) opts.platforms = parsePlatforms(o.platforms);
  if (o.alpha) opts.alpha = true;
  if (o.safe) opts.safe = true;
  if (o.displayFile) opts.displayFile = o.displayFile;
  if (o.scene !== undefined) opts.scene = o.scene;
  if (o.storyboard === false) opts.storyboard = false;
  opts.history = p.historyTrace();
  opts.lineOf = (id: string) => p.line('clips', id);
  return qa.look(p.data, opts) as Promise<LookResult>;
}

async function storyboardProject(p: MglProject, o: StoryboardOptions): Promise<StoryboardResult> {
  assertRenderable(p);
  const qa = await qaModule();
  if (!qa?.writeStoryboard) fail('E_NOT_AVAILABLE', 'the storyboard is not available in this build (src/qa is missing).', 'render stills instead: mgl render <file> frame.png --still 1s');
  const { resolveComp } = await import('../render/pipeline.js');
  const comp = resolveComp(p.data, o.comp);
  return qa.writeStoryboard(p.data, {
    baseDir: p.dir, file: p.file, comp: comp.id, registry: p.registry, history: p.historyTrace(), lineOf: (id: string) => p.line('clips', id),
    ...(o.png ? { png: resolve(o.png) } : {}), ...(o.html ? { html: resolve(o.html) } : {}), ...(o.displayFile ? { displayFile: o.displayFile } : {}),
  }) as Promise<StoryboardResult>;
}

/** A probe for QA (absolute paths): media sizes, durations and pixel formats for exact boxes, the clip-past-source rule and source alpha. */
async function qaProbe(p: MglProject): Promise<(abs: string) => Promise<{ duration?: number; width?: number; height?: number; pixFmt?: string }>> {
  const { getMediaBackend } = await import('../media/index.js');
  const backend = getMediaBackend({ baseDir: p.dir });
  return async (abs) => {
    const info = await backend.probe(abs);
    return { ...(info.duration ? { duration: info.duration } : {}), ...(info.width ? { width: info.width, height: info.height } : {}), ...(info.pixFmt ? { pixFmt: info.pixFmt } : {}) };
  };
}

async function checkProject(p: MglProject, o: CheckOptions = {}): Promise<CheckReport> {
  if (o.fix) {
    const { fixCheck, fixJson } = await import('../qa/fix.js');
    const r = await fixCheck(p, { ...(o.platforms?.length ? { platforms: parsePlatforms(o.platforms) } : {}), ...(o.alpha ? { alpha: true } : {}), ...(o.displayFile ? { displayFile: o.displayFile } : {}), ...(o.dryRun ? { dryRun: true } : {}) });
    const findings = r.remaining as CheckReport['findings'];
    for (const f of findings) if (f.clip) { const l = p.line('clips', f.clip); if (l) f.line = l; }
    const problems = [...p.problems];
    const errors = problems.filter((x) => x.severity === 'error').length + findings.filter((f) => f.severity === 'error').length;
    return { problems, findings, errors, fix: fixJson(r) };
  }
  const qa = await qaModule();
  // with the QA module, plugin problems come back as findings (rule "plugin")
  const problems = qa?.checkProject ? [...p.problems] : [...p.problems, ...p.pluginProblems];
  let findings: CheckReport['findings'] = [];
  if (qa?.checkProject) {
    const opts: Record<string, unknown> = { baseDir: p.dir, registry: p.registry, probe: await qaProbe(p) };
    if (o.platforms?.length) opts.platforms = parsePlatforms(o.platforms);
    if (o.alpha) opts.alpha = true;
    const file = o.displayFile ?? (typeof qa.displayName === 'function' ? qa.displayName(p.file) : p.file);
    if (file) opts.file = file;
    findings = await qa.checkProject(p.data, opts);
  }
  for (const f of findings) if (f.clip) { const l = p.line('clips', f.clip); if (l) f.line = l; }
  const errors = problems.filter((x) => x.severity === 'error').length + findings.filter((f) => f.severity === 'error').length;
  return { problems, findings, errors };
}
