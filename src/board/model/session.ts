/**
 * A board session: the board in memory, a version counter, and undo / redo across processes. History lives in
 * <dir>/.mgl/board-history.jsonl (one line per step: {t: "do", before, after} snapshots, or {t: "undo" | "redo", seq}).
 * Every write happens under a lock; a step is undone only when the file on disk is still what that step wrote.
 * Spend rows are a ledger of CPU already spent: a spend-only batch is not an undo step, and undo / redo keep the
 * current spend rows (so a still rendered while scrubbing never becomes "the last edit").
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MglError, fail } from '../../core/errors.js';
import { withLock } from '../../sdk/project.js';
import type { BoardFile, BoardOp, Outline, Who } from '../shared/types.js';
import { emptyBoard, parseBoardText, readBoard } from './file.js';
import { entityLine, formatBoard, formatBrief } from './format.js';
import { applyOps } from './ops.js';

const HISTORY_LIMIT = 200;

interface DoEntry { t: 'do'; seq: number; board: string; at: string; by: Who; summary: string; before: string; after: string }
interface StepEntry { t: 'undo' | 'redo'; seq: number; board: string }
type Entry = DoEntry | StepEntry;

export interface ApplyResult { changed: string[]; created: string[]; version: number; board: BoardFile; dryRun?: boolean }
export interface StepResult { changed: string[]; version: number; summary: string[] }
/** One history step as the CLI and page show it. */
export interface HistoryStep { summary: string; by: Who; at: string }
export interface StepOptions { /** who is stepping: undo refuses a step the other party made (E_UNDO_OTHER) unless force */ by?: Who; force?: boolean }

/** A short text for an op: its name and its main argument. */
export function opSummary(op: BoardOp): string {
  const o = op as unknown as Record<string, unknown>;
  const sh = o.shape as { type?: string; text?: string; label?: string; src?: string } | undefined;
  const main = o.id ?? o.ids ?? o.round ?? o.target ?? o.t ?? o.goal ?? o.text ?? sh?.type;
  const m = main === undefined ? '' : ' ' + (typeof main === 'string' ? (main.length > 40 ? JSON.stringify(main.slice(0, 39) + '…') : main) : JSON.stringify(main));
  // what a shape says matters to the other party reading the history ("shape.add note \"try a sunrise open\"")
  const said = sh ? sh.text ?? sh.label ?? sh.src : undefined;
  return `${o.op}${m}${typeof said === 'string' && said ? ' ' + JSON.stringify(said.length > 60 ? said.slice(0, 59) + '…' : said) : ''}`;
}

/** Ids whose line differs between two boards ("brief" for the brief). */
export function diffIds(a: BoardFile, b: BoardFile): string[] {
  const lines = (x: BoardFile) => {
    const m = new Map<string, string>();
    for (const t of ['shapes', 'rounds', 'log', 'spend'] as const) for (const e of (x[t] ?? []) as { id: string }[]) m.set(e.id, entityLine(t, e));
    m.set('brief', formatBrief(x.brief ?? {}));
    return m;
  };
  const la = lines(a), lb = lines(b);
  return [...new Set([...la.keys(), ...lb.keys()])].filter((k) => la.get(k) !== lb.get(k));
}

export class BoardSession {
  /** bumped on every change, whatever the cause (ops, undo, a hand edit seen by reload) */
  version = 1;
  private constructor(public boardPath: string, public board: BoardFile, private text: string | null, public projectPath?: string) {}

  static async open(boardPath: string): Promise<BoardSession> {
    const { board, text } = await readBoard(boardPath);
    return new BoardSession(boardPath, board, text, projectOf(boardPath, board));
  }

  private get dir() { return path.dirname(path.resolve(this.boardPath)); }
  private get lockDir() { return path.join(this.dir, '.mgl', 'board'); }
  private get historyPath() { return path.join(this.dir, '.mgl', 'board-history.jsonl'); }
  private get key() { return path.basename(this.boardPath); }

  private readDisk(): string | null {
    try { return readFileSync(this.boardPath, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  /** adopt what is on disk when it changed (a hand edit, another process); true when it did */
  private sync(): boolean {
    const disk = this.readDisk();
    if (disk === this.text) return false;
    try { this.board = disk === null ? emptyBoard(this.boardPath, this.projectPath) : parseBoardText(disk); } catch (e) {
      if (e instanceof MglError) prefixError(e, this.key);
      throw e;
    }
    this.text = disk;
    this.projectPath = projectOf(this.boardPath, this.board);
    this.version++;
    return true;
  }
  private write(text: string) {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.boardPath}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, this.boardPath);
    this.text = text;
  }

  /** Re-read the file; true when it changed on disk. */
  async reload(): Promise<boolean> { return this.sync(); }

  /** Apply ops (atomic) and save; with dryRun nothing is written. */
  async apply(ops: BoardOp[], by: Who, outline?: Outline | null, opts: { dryRun?: boolean; now?: string } = {}): Promise<ApplyResult> {
    if (opts.dryRun) {
      this.sync();
      const r = applyOps(this.board, ops, { by, outline: outline ?? null, ...(opts.now ? { now: opts.now } : {}) });
      return { changed: r.changed, created: r.created, version: this.version, board: r.board, dryRun: true };
    }
    return withLock(this.lockDir, () => {
      this.sync();
      const r = applyOps(this.board, ops, { by, outline: outline ?? null, ...(opts.now ? { now: opts.now } : {}) });
      const before = this.text ?? formatBoard(this.board);
      const after = formatBoard(r.board);
      if (after === before && this.text !== null) return { changed: [], created: [], version: this.version, board: this.board };
      this.write(after);
      if (!ops.every((o) => o.op === 'spend.add')) this.record({ t: 'do', seq: this.nextSeq(), board: this.key, at: opts.now ?? new Date().toISOString(), by, summary: ops.map(opSummary).join('; '), before, after });
      this.board = r.board;
      this.version++;
      return { changed: r.changed, created: r.created, version: this.version, board: r.board };
    });
  }

  async undo(n = 1, o: StepOptions = {}): Promise<StepResult> { return this.step('undo', n, o); }
  async redo(n = 1, o: StepOptions = {}): Promise<StepResult> { return this.step('redo', n, o); }

  /** Undo and redo stacks (newest first) as summaries, and the same steps with who made them. */
  historyStatus(): { undo: string[]; redo: string[]; undoSteps: HistoryStep[]; redoSteps: HistoryStep[] } {
    const { undo, redo } = this.stacks();
    const step = (e: DoEntry): HistoryStep => ({ summary: e.summary, by: e.by, at: e.at });
    return { undo: undo.map((e) => e.summary).reverse(), redo: redo.map((e) => e.summary).reverse(), undoSteps: undo.map(step).reverse(), redoSteps: redo.map(step).reverse() };
  }

  /** Steps `other` made after `self`'s latest step (oldest first): what the other party did since you last acted. */
  since(self: Who): HistoryStep[] {
    const { undo } = this.stacks();
    let i = undo.length;
    while (i > 0 && undo[i - 1]!.by !== self) i--;
    return undo.slice(i).map((e) => ({ summary: e.summary, by: e.by, at: e.at }));
  }

  private step(dir: 'undo' | 'redo', n: number, o: StepOptions = {}): StepResult {
    if (!Number.isInteger(n) || n < 1) fail('E_ARG', `${dir} takes a number of steps, got ${n}.`, `e.g. mgl board edit <file> ${dir} 2`);
    return withLock(this.lockDir, () => {
      const disk = this.readDisk();
      const { undo, redo } = this.stacks();
      const from = dir === 'undo' ? undo : redo;
      if (!from.length) fail('E_HISTORY_EMPTY', `nothing to ${dir}.`, dir === 'undo' ? 'no recorded board edits (hand edits are not recorded).' : 'redo only works right after an undo.');
      // one shared history: an agent's undo must not silently take back the person's edit (and the other way round)
      if (dir === 'undo' && o.by && !o.force) {
        const other = from.slice(-n).reverse().find((e) => e.by !== o.by);
        if (other) fail('E_UNDO_OTHER', `the step to undo was made by the ${other.by === 'human' ? 'person' : 'agent'}: "${other.summary}".`,
          o.by === 'ai' ? 'leave the person\'s edit, or ask them first; to take it back anyway: mgl board edit <file> undo --force (or change it with an op).' : 'undo the agent\'s step anyway with force, or change it with an op.');
      }
      const old = this.board;
      const spend = disk === null ? undefined : parseBoardText(disk).spend;
      let text = disk === null ? null : withoutSpend(disk);
      const summary: string[] = [];
      for (let i = 0; i < n && from.length; i++) {
        const e = from.pop()!;
        const expect = withoutSpend(dir === 'undo' ? e.after : e.before);
        if (text !== expect) {
          if (i > 0) break;
          fail('E_HISTORY_STALE', `cannot ${dir}: ${this.key} changed on disk since "${e.summary}" (a hand edit or another tool).`,
            `${dir === 'undo' ? 'undo' : 'redo'} it with an op instead (e.g. shape.remove / shape.set), or restore the file by hand; history only steps over its own writes.`);
        }
        text = withoutSpend(dir === 'undo' ? e.before : e.after);
        summary.push(`${dir === 'undo' ? 'undid' : 'redid'}: ${e.summary}`);
        this.record({ t: dir, seq: e.seq, board: this.key }, false);
      }
      const board = parseBoardText(text!);
      if (spend?.length) board.spend = spend; else delete board.spend;
      this.write(formatBoard(board));
      this.board = board;
      this.projectPath = projectOf(this.boardPath, board);
      this.version++;
      return { changed: diffIds(old, board), version: this.version, summary };
    });
  }

  private entries(): Entry[] {
    let raw: string;
    try { raw = readFileSync(this.historyPath, 'utf8'); } catch { return []; }
    const out: Entry[] = [];
    for (const l of raw.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l) as Entry); } catch { /* a torn line: skip */ } }
    return out;
  }
  private stacks(all = this.entries()): { undo: DoEntry[]; redo: DoEntry[] } {
    const undo: DoEntry[] = [], redo: DoEntry[] = [];
    for (const e of all) {
      if (e.board !== this.key) continue;
      if (e.t === 'do') { undo.push(e); redo.length = 0; }
      else if (e.t === 'undo') { const i = undo.findIndex((x) => x.seq === e.seq); if (i >= 0) redo.push(...undo.splice(i, 1)); }
      else { const i = redo.findIndex((x) => x.seq === e.seq); if (i >= 0) undo.push(...redo.splice(i, 1)); }
    }
    return { undo, redo };
  }
  private nextSeq(): number { return this.entries().reduce((m, e) => Math.max(m, e.seq), 0) + 1; }
  private record(e: Entry, trim = true) {
    mkdirSync(path.dirname(this.historyPath), { recursive: true });
    appendFileSync(this.historyPath, JSON.stringify(e) + '\n');
    if (!trim) return;
    const all = this.entries();
    const mine = all.filter((x) => x.board === this.key);
    if (mine.length <= HISTORY_LIMIT * 2) return;
    // keep other boards' lines; this board keeps its last HISTORY_LIMIT undo steps (redo is empty right after a "do")
    const { undo } = this.stacks(all);
    const kept = [...all.filter((x) => x.board !== this.key), ...undo.slice(-HISTORY_LIMIT)];
    const tmp = this.historyPath + '.tmp';
    writeFileSync(tmp, kept.map((x) => JSON.stringify(x)).join('\n') + '\n');
    renameSync(tmp, this.historyPath);
  }
}

/** The board text with its spend rows removed (the form undo compares and restores). */
function withoutSpend(text: string): string {
  const b = parseBoardText(text);
  delete b.spend;
  return formatBoard(b);
}

/** the linked project, absolute (a "project" that is already absolute stays as it is) */
export function projectOf(boardPath: string, b: BoardFile): string | undefined {
  return b.project ? path.resolve(path.dirname(path.resolve(boardPath)), b.project) : undefined;
}

/** "<file>: message", on the error and on the problem that repeats it (so the CLI does not print it twice). */
export function prefixError(e: MglError, key: string): void {
  const old = e.message;
  e.message = `${key}: ${old}`;
  for (const p of e.problems ?? []) if (p.message === old) p.message = e.message;
}
