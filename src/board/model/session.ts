/**
 * A board session: the board in memory, a version counter, and undo / redo across processes. History lives in
 * <dir>/.mgl/board-history.jsonl (one line per step: {t: "do", before, after} snapshots, or {t: "undo" | "redo", seq}).
 * Every write happens under a lock; a step is undone only when the file on disk is still what that step wrote.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fail } from '../../core/errors.js';
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

/** A short text for an op: its name and its main argument. */
export function opSummary(op: BoardOp): string {
  const o = op as unknown as Record<string, unknown>;
  const main = o.id ?? o.ids ?? o.round ?? o.target ?? o.t ?? o.goal ?? o.text ?? (o.shape as { type?: string } | undefined)?.type;
  const m = main === undefined ? '' : ' ' + (typeof main === 'string' ? (main.length > 40 ? JSON.stringify(main.slice(0, 39) + '…') : main) : JSON.stringify(main));
  return `${o.op}${m}`;
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
    this.board = disk === null ? emptyBoard(this.boardPath, this.projectPath) : parseBoardText(disk);
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
      this.record({ t: 'do', seq: this.nextSeq(), board: this.key, at: opts.now ?? new Date().toISOString(), by, summary: ops.map(opSummary).join('; '), before, after });
      this.board = r.board;
      this.version++;
      return { changed: r.changed, created: r.created, version: this.version, board: r.board };
    });
  }

  async undo(n = 1): Promise<StepResult> { return this.step('undo', n); }
  async redo(n = 1): Promise<StepResult> { return this.step('redo', n); }

  /** Undo and redo stacks (newest first) as summaries. */
  historyStatus(): { undo: string[]; redo: string[] } {
    const { undo, redo } = this.stacks();
    return { undo: undo.map((e) => e.summary).reverse(), redo: redo.map((e) => e.summary).reverse() };
  }

  private step(dir: 'undo' | 'redo', n: number): StepResult {
    if (!Number.isInteger(n) || n < 1) fail('E_ARG', `${dir} takes a number of steps, got ${n}.`, `e.g. mgl board edit <file> ${dir} 2`);
    return withLock(this.lockDir, () => {
      const disk = this.readDisk();
      const { undo, redo } = this.stacks();
      const from = dir === 'undo' ? undo : redo;
      if (!from.length) fail('E_HISTORY_EMPTY', `nothing to ${dir}.`, dir === 'undo' ? 'no recorded board edits (hand edits are not recorded).' : 'redo only works right after an undo.');
      const old = this.board;
      let text = disk;
      const summary: string[] = [];
      for (let i = 0; i < n && from.length; i++) {
        const e = from.pop()!;
        const expect = dir === 'undo' ? e.after : e.before;
        if (text !== expect) {
          if (i > 0) break;
          fail('E_HISTORY_STALE', `cannot ${dir}: ${this.key} changed on disk since "${e.summary}" (a hand edit or another tool).`,
            `${dir === 'undo' ? 'undo' : 'redo'} it with an op instead (e.g. shape.remove / shape.set), or restore the file by hand; history only steps over its own writes.`);
        }
        text = dir === 'undo' ? e.before : e.after;
        summary.push(`${dir === 'undo' ? 'undid' : 'redid'}: ${e.summary}`);
        this.record({ t: dir, seq: e.seq, board: this.key }, false);
      }
      const board = parseBoardText(text!);
      this.write(text!);
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

function projectOf(boardPath: string, b: BoardFile): string | undefined {
  return b.project ? path.join(path.dirname(boardPath), b.project) : undefined;
}
