/**
 * A project session: load a file, run commands (with dry-run), save atomically, undo/redo across processes.
 * The CLI and the SDK both use this class; nothing else writes project files.
 */
import { createHash } from 'node:crypto';
import { promises as fs, openSync, closeSync, unlinkSync, statSync, writeFileSync, renameSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { MglError, fail } from '../core/errors.js';
import { parseProjectText, normaliseAndValidate, type Problem } from '../core/load.js';
import { formatProject } from '../core/format.js';
import { runCommand, applyPatch, invertPatch, clone, type Command, type CommandServices, type Patch } from '../core/commands/index.js';
import { FORMAT_VERSION, TABLES, type ProjectFile, type TableName } from '../core/schema/index.js';

export interface ChangedLine { kind: 'add' | 'change' | 'remove'; table: TableName | 'project'; id: string; line?: number; text?: string }

export interface EditResult {
  ok: true;
  dryRun: boolean;
  summary: string[];
  notes: string[];
  changes: ChangedLine[];
  /** data from the commands (e.g. the created id) */
  out: Record<string, unknown>[];
  /** render-blocking issues remaining after the edit */
  issues: Problem[];
  patch: Patch;
}

export interface HistoryEntry { at: string; summary: string; commands: Command[]; patch: Patch; /** when last undone or redone */ stepped?: string }
interface HistoryFile { undo: HistoryEntry[]; redo: HistoryEntry[] }
const HISTORY_LIMIT = 200;

export function hashText(t: string) { return createHash('sha256').update(t).digest('hex').slice(0, 16); }

/** The per-project work directory: .mgl/<basename>/ next to the file. */
export function workDir(file: string): string {
  const base = path.basename(file).replace(/\.mgl\.json$|\.json$/, '');
  return path.join(path.dirname(path.resolve(file)), '.mgl', base);
}

export class Project {
  readonly file: string;
  data: ProjectFile;
  problems: Problem[];
  services: CommandServices;
  private openedHash: string;
  private lineOf: (p: (string | number)[]) => number | undefined;

  private constructor(file: string, data: ProjectFile, problems: Problem[], text: string, lineOf: Project['lineOf'], services: CommandServices) {
    this.file = file;
    this.data = data;
    this.problems = problems;
    this.openedHash = hashText(text);
    this.lineOf = lineOf;
    this.services = services;
  }

  /** Open and validate a project file. Throws MglError (with line numbers and fixes) on load errors. */
  static async open(file: string, services: CommandServices = {}): Promise<Project> {
    let text: string;
    try { text = await fs.readFile(file, 'utf8'); } catch {
      fail('E_NO_FILE', `${file} does not exist.`, `create it with: mgl new shorts -o ${file}`);
    }
    const r = parseProjectText(text);
    return new Project(file, r.project, r.problems, text, r.lineOf, services);
  }

  /** A new in-memory project (not yet saved). */
  static create(file: string, data: ProjectFile, services: CommandServices = {}): Project {
    const r = normaliseAndValidate(clone(data) as unknown as Record<string, unknown>);
    return new Project(file, r.project, r.problems, '', r.lineOf, services);
  }

  get dir(): string { return path.dirname(path.resolve(this.file)); }
  get work(): string { return workDir(this.file); }

  /** Render-blocking issues (overlaps, word/cue mismatches). */
  get issues(): Problem[] { return this.problems.filter((p) => p.renderOnly); }

  text(): string { return formatProject(this.data); }

  /** Run one command or a list (atomically: all or nothing). */
  async edit(cmds: Command | Command[], opts: { dryRun?: boolean; save?: boolean } = {}): Promise<EditResult> {
    const list = Array.isArray(cmds) ? cmds : [cmds];
    if (!list.length) fail('E_COMMAND', 'no commands given.', 'pass a command like {"op": "clip.split", "id": "shot1", "at": "2s"}.');
    const before = this.data;
    let cur = clone(before);
    const summary: string[] = [], notes: string[] = [], out: Record<string, unknown>[] = [];
    for (const [i, cmd] of list.entries()) {
      try {
        const r = await runCommand(cur, cmd, this.services);
        // normalise time strings and validate the result after every command
        const v = normaliseAndValidate(clone(r.project) as unknown as Record<string, unknown>);
        cur = v.project;
        summary.push(...r.summaries);
        notes.push(...r.notes, ...v.problems.filter((p) => p.severity === 'warning' && p.code === 'W_TIME_ROUNDED').map((p) => p.message));
        out.push(r.out);
      } catch (e) {
        if (e instanceof MglError && list.length > 1) e.message = `command ${i + 1} (${cmd.op}): ${e.message} Nothing was changed.`;
        throw e;
      }
    }
    const v = normaliseAndValidate(clone(cur) as unknown as Record<string, unknown>);
    const newIssues = v.problems.filter((p) => p.renderOnly);
    const oldIssues = this.issues;
    if (newIssues.length > oldIssues.length) {
      const added = newIssues.find((n) => !oldIssues.some((o) => o.message === n.message)) ?? newIssues[0]!;
      throw new MglError({ code: added.code, message: `the edit would create a problem: ${added.message}`, fix: added.fix });
    }
    const { diffProjects } = await import('../core/commands/registry.js');
    const patch = diffProjects(before, v.project);
    const changes = this.describe(patch, v.project);
    const result: EditResult = { ok: true, dryRun: !!opts.dryRun, summary, notes, changes, out, issues: newIssues, patch };
    if (opts.dryRun) return result;
    const prevData = this.data, prevProblems = this.problems;
    this.data = v.project;
    this.problems = v.problems;
    if (!patch.length) return result;
    const entry: HistoryEntry = { at: new Date().toISOString(), summary: summary.join(' '), commands: list, patch };
    try {
      // the history entry is recorded only once the file is written, under the same lock
      if (opts.save !== false) this.writeFile({}, entry);
      else if (this.file) withLock(this.work, () => this.record(entry));
    } catch (e) {
      this.data = prevData;
      this.problems = prevProblems;
      throw e;
    }
    return result;
  }

  /** Lines that a patch changes, located in the formatted text of `after`. */
  describe(patch: Patch, after: ProjectFile = this.data): ChangedLine[] {
    const text = formatProject(after).split('\n');
    const findLine = (table: string, id: string) => {
      if (table === 'project') { const i = text.findIndex((l) => l.startsWith('"project"')); return i >= 0 ? i : undefined; }
      const needle = `{"id": ${JSON.stringify(id)},`;
      const needle2 = `{"id": ${JSON.stringify(id)}}`;
      const i = text.findIndex((l) => l.startsWith(needle) || l.startsWith(needle2));
      return i >= 0 ? i : undefined;
    };
    // a moved entity is a removal plus an insertion in the patch: report it once, as a change at its new line
    const key = (c: { table: string; id: string }) => `${c.table}\u0000${c.id}`;
    const removed = new Set(patch.filter((c) => c.after === undefined).map(key));
    const added = new Set(patch.filter((c) => c.before === undefined).map(key));
    const moved = new Set([...removed].filter((k) => added.has(k)));
    return patch.filter((c) => !(moved.has(key(c)) && c.after === undefined)).map((c) => {
      const kind: ChangedLine['kind'] = moved.has(key(c)) ? 'change' : c.before === undefined ? 'add' : c.after === undefined ? 'remove' : 'change';
      const i = kind === 'remove' ? undefined : findLine(c.table, c.id);
      const o: ChangedLine = { kind, table: c.table, id: c.id };
      if (i !== undefined) { o.line = i + 1; o.text = text[i]; }
      return o;
    });
  }

  /** Write the file atomically; refuses if it changed on disk since it was opened (unless force). */
  async save(opts: { force?: boolean } = {}): Promise<void> {
    this.writeFile(opts);
  }

  /** Write this.data under the lock, then record `entry` while still holding it. */
  private writeFile(opts: { force?: boolean }, entry?: HistoryEntry): void {
    const text = formatProject(this.data);
    withLock(this.work, () => {
      this.writeLocked(text, !!opts.force);
      if (entry) this.record(entry);
    });
  }

  /** The atomic write; the caller holds the lock. */
  private writeLocked(text: string, force: boolean) {
    if (existsSync(this.file) && !force && this.openedHash) {
      const disk = readFileSync(this.file, 'utf8');
      if (hashText(disk) !== this.openedHash && hashText(disk) !== hashText(text)) {
        fail('E_CHANGED_ON_DISK', `${this.file} changed on disk since it was opened (another command or a hand edit).`, 'open it again and repeat the change (SDK: await open(file)), or save({ force: true }) to overwrite.');
      }
    }
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, this.file);
    this.openedHash = hashText(text);
  }

  // --- history (undo/redo across processes) ---

  private historyPath() { return path.join(this.work, 'history.json'); }
  private readHistory(): HistoryFile {
    try { return JSON.parse(readFileSync(this.historyPath(), 'utf8')) as HistoryFile; } catch { return { undo: [], redo: [] }; }
  }
  private writeHistory(h: HistoryFile) {
    mkdirSync(this.work, { recursive: true });
    const tmp = this.historyPath() + '.tmp';
    writeFileSync(tmp, JSON.stringify(h));
    renameSync(tmp, this.historyPath());
  }
  /** Append a history entry; the caller holds the lock. */
  private record(e: HistoryEntry) {
    if (!this.file) return;
    const h = this.readHistory();
    h.undo.push(e);
    if (h.undo.length > HISTORY_LIMIT) h.undo.splice(0, h.undo.length - HISTORY_LIMIT);
    h.redo = [];
    this.writeHistory(h);
  }

  historyStatus(): { undo: string[]; redo: string[] } {
    const h = this.readHistory();
    return { undo: h.undo.map((e) => e.summary).reverse(), redo: h.redo.map((e) => e.summary).reverse() };
  }

  /** The recorded steps that can be undone, oldest first. */
  historyEntries(): HistoryEntry[] { return this.readHistory().undo; }
  /** Every recorded step on either stack (undo and redo are commands too: `stepped` says when they last ran). */
  historyTrace(): HistoryEntry[] { const h = this.readHistory(); return [...h.undo, ...h.redo]; }

  async undo(steps = 1): Promise<EditResult> { return this.step('undo', steps); }
  async redo(steps = 1): Promise<EditResult> { return this.step('redo', steps); }

  private async step(dir: 'undo' | 'redo', steps: number): Promise<EditResult> {
    // read history, apply, write the file and the history under one lock (no lost updates between processes)
    return withLock(this.work, () => this.stepLocked(dir, steps));
  }

  private stepLocked(dir: 'undo' | 'redo', steps: number): EditResult {
    const h = this.readHistory();
    const from = dir === 'undo' ? h.undo : h.redo;
    const to = dir === 'undo' ? h.redo : h.undo;
    if (!from.length) fail('E_HISTORY_EMPTY', `nothing to ${dir}.`, dir === 'undo' ? 'no recorded edits for this file (hand edits are not recorded).' : 'redo only works right after an undo.');
    let data = this.data;
    const summary: string[] = [];
    const patches: Patch = [], now = new Date().toISOString();
    for (let i = 0; i < steps && from.length; i++) {
      const e = from[from.length - 1]!;
      const patch = dir === 'undo' ? invertPatch(e.patch) : e.patch;
      data = applyPatch(data, patch, true);
      patches.push(...patch);
      summary.push(`${dir === 'undo' ? 'undid' : 'redid'}: ${e.summary}`);
      e.stepped = now;
      to.push(from.pop()!);
    }
    const v = normaliseAndValidate(clone(data) as unknown as Record<string, unknown>);
    this.writeLocked(formatProject(v.project), false);
    this.writeHistory(h);
    this.data = v.project;
    this.problems = v.problems;
    return { ok: true, dryRun: false, summary, notes: [], changes: this.describe(patches), out: [], issues: this.issues, patch: patches };
  }

  // --- queries ---

  clip(id: string) { return (this.data.clips ?? []).find((c) => c.id === id); }
  clips(filter: { track?: string; comp?: string } = {}) {
    const trackComp = new Map((this.data.tracks ?? []).map((t) => [t.id, t.comp]));
    return (this.data.clips ?? []).filter((c) => (!filter.track || c.track === filter.track) && (!filter.comp || trackComp.get(c.track) === filter.comp));
  }
  /** the comp `render`/`look` use by default */
  mainComp() {
    const id = this.data.project?.main ?? (this.data.comps.find((c) => c.id === 'main') ? 'main' : this.data.comps[0]!.id);
    return this.data.comps.find((c) => c.id === id)!;
  }
  line(table: TableName, id: string): number | undefined {
    const i = ((this.data[table] as { id: string }[] | undefined) ?? []).findIndex((e) => e.id === id);
    return i < 0 ? undefined : this.lineOf([table, i]);
  }
}

/** A simple cross-process lock (O_EXCL lock file; stale after 30 s). */
export function withLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'lock');
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) fail('E_LOCKED_FILE', `the project is locked by another process (${lock}).`, 'wait for the other command to finish, or delete the lock file if no other command runs.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* gone */ } }
}

export function emptyProject(opts: { size?: [number, number]; fps?: number | string; name?: string; platform?: ProjectFile['project'] extends infer P ? P extends { platform?: infer Q } ? Q : never : never; length?: number | string } = {}): ProjectFile {
  const p: ProjectFile = {
    michelangelo: FORMAT_VERSION,
    comps: [{ id: 'main', size: opts.size ?? [1080, 1920], fps: opts.fps ?? 30, ...(opts.length !== undefined ? { length: opts.length as number } : {}) }],
    tracks: [{ id: 'V1', comp: 'main' }, { id: 'T1', comp: 'main' }, { id: 'A1', comp: 'main', audio: true, bus: 'dialogue' }, { id: 'A2', comp: 'main', audio: true, bus: 'music' }],
  };
  if (opts.name || opts.platform) p.project = { ...(opts.name ? { name: opts.name } : {}), ...(opts.platform ? { platform: opts.platform } : {}) };
  void TABLES;
  return p;
}
