/**
 * The SDK: `open` and `create` return a Project session whose `data` is the plain project and whose every
 * change is `p.edit(command)`. Plugins named by the project are loaded and services attached.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MglError, fail } from '../core/errors.js';
import type { Problem } from '../core/load.js';
import { PRESETS } from '../core/commands/structure.js';
import type { ProjectFile } from '../core/schema/index.js';
import { parseRate, parseTime } from '../core/time.js';
import type { PluginRegistry } from '../plugin/registry.js';
import type { Command } from '../core/commands/registry.js';
import { Project, emptyProject, type EditResult } from './project.js';
import { makeServices } from './services.js';
import '../core/commands/index.js';

export { MglError } from '../core/errors.js';
export type { MglErrorInfo, ErrorKind } from '../core/errors.js';
export { listCommands, getCommand, type Command, type CommandDef } from '../core/commands/index.js';
export { Project, emptyProject, workDir, type EditResult, type ChangedLine } from './project.js';
export { makeServices } from './services.js';
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
}

/** What look returns (src/qa): the contact sheet, findings with fixes, the sound summary. */
export interface LookResult {
  sheet: string;
  findings: { rule: string; severity: 'error' | 'warning' | 'info'; message: string; clip?: string; frame?: number; fix?: string }[];
  frames: number[];
  crops: { finding: number; path: string }[];
  sound?: { integrated: number; truePeak: number; lra: number; silences: { start: number; end: number }[]; bpm?: number };
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
  onEstimate?(e: { seconds: number; note: string }): void;
  onProgress?(p: { frame: number; total: number; fps: number; etaSec: number }): void;
}

export interface CheckReport {
  /** load warnings and render-blocking issues, plugin problems */
  problems: Problem[];
  /** QA findings that need no pixels */
  findings: { rule: string; severity: 'error' | 'warning' | 'info'; message: string; clip?: string; frame?: number; fix?: string; line?: number }[];
  /** errors (problems with severity error + findings with severity error) */
  errors: number;
}

/** A project session with the plugin registry and the look / render / check verbs. */
export type MglProject = Project & {
  registry: PluginRegistry;
  /** plugin problems (untrusted, not found, wrong version) */
  pluginProblems: Problem[];
  /** what p.edit(cmd) would change, without changing anything */
  dryRun(cmds: Command | Command[]): Promise<EditResult>;
  look(opts?: LookOptions): Promise<LookResult>;
  render(out: string, opts?: RenderOpts): Promise<import('../render/pipeline.js').RenderResult>;
  check(): Promise<CheckReport>;
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
  const reg = await loadRegistry(p.data, p.dir);
  p.services = makeServices(p.dir, reg);
  const self = p as MglProject;
  self.registry = reg;
  self.pluginProblems = reg.problems;
  const edit = p.edit.bind(p);
  self.edit = async (cmds, opts) => {
    try { return await edit(cmds, opts); } catch (e) { throw withPluginProblems(e, reg.problems); }
  };
  self.dryRun = (cmds) => p.edit(cmds, { dryRun: true });
  self.look = (opts = {}) => lookProject(self, opts);
  self.render = (out, opts = {}) => renderProject(self, out, opts);
  self.check = () => checkProject(self);
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
  if (o.onEstimate) opts.onEstimate = o.onEstimate;
  if (o.onProgress) opts.onProgress = o.onProgress;
  return pipeline.render(p.data, resolve(out), opts);
}

/** The QA functions (src/qa: look, checkProject, formatLook, formatFindings), when present in this build. */
export async function qaModule(): Promise<Record<string, any> | undefined> {
  const mods: Record<string, any> = {};
  for (const m of ['look', 'check', 'format']) {
    try { Object.assign(mods, await import(`../qa/${m}.js`)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw e;
    }
  }
  return Object.keys(mods).length ? mods : undefined;
}

async function lookProject(p: MglProject, o: LookOptions) {
  assertRenderable(p);
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
  return qa.look(p.data, opts) as Promise<LookResult>;
}

async function checkProject(p: MglProject): Promise<CheckReport> {
  const qa = await qaModule();
  // with the QA module, plugin problems come back as findings (rule "plugin")
  const problems = qa?.checkProject ? [...p.problems] : [...p.problems, ...p.pluginProblems];
  let findings: CheckReport['findings'] = [];
  if (qa?.checkProject) findings = await qa.checkProject(p.data, { baseDir: p.dir, registry: p.registry });
  for (const f of findings) if (f.clip) { const l = p.line('clips', f.clip); if (l) f.line = l; }
  const errors = problems.filter((x) => x.severity === 'error').length + findings.filter((f) => f.severity === 'error').length;
  return { problems, findings, errors };
}
