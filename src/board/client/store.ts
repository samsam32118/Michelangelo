/**
 * The page's state: the server's board plus optimistic batches not yet acknowledged, the project outline, presence,
 * advice, flashes (who changed what, recently) and drag previews. Every change goes through send() → POST /api/ops;
 * nothing here mutates the board without an op. Detached (an exported page with no server), ops are applied locally
 * and queued for `mgl.pending()`.
 */
import type { Advice, BoardFile, BoardOp, BoardState, OpsResult, Outline, Presence, Shape, Who } from '../shared/types.js';
import { shapeBounds } from '../shared/shapes.js';
import type { Box } from '../shared/geometry.js';
import { applyLocal } from './local-ops.js';

export type Change = 'board' | 'project' | 'view' | 'advice' | 'flash' | 'conn';
export const FLASH_MS = 1400;

/** `ack`: the server version that contains the batch (from the POST answer); until then it is in flight */
interface Batch { seq: number; ops: BoardOp[]; by: Who; ack?: number }

export class Store {
  board: BoardFile = { michelangeloBoard: 1 };
  version = 0;
  project: Outline | null = null;
  projectError?: { code: string; message: string; fix?: string };
  view: Partial<Record<Who, Presence>> = {};
  advice?: Advice[];
  detached = false;
  /** 'live' (SSE), 'polling', 'offline', 'detached' */
  conn = 'offline';
  /** ops applied while detached, for mgl.pending() / "Copy changes" */
  pending: { op: BoardOp; by: Who }[] = [];
  flashes = new Map<string, { by: Who; until: number }>();
  /** ephemeral previews while dragging (never sent as such) */
  overrides = new Map<string, Shape>();
  private server: BoardFile = { michelangeloBoard: 1 };
  private batches: Batch[] = [];
  /** the newest server state that arrived while a batch was in flight (it may or may not contain that batch) */
  private held?: { board: BoardFile; version: number };
  private seq = 0;
  private listeners = new Set<(c: Change) => void>();
  private mine = new Map<string, { by: Who; at: number }>();
  private memo?: { key: unknown; ov: number; shapes: Shape[]; byId: Map<string, Shape>; bounds: Map<string, Box> };
  private ovVersion = 0;

  constructor(private base = '') {}

  on(fn: (c: Change) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(c: Change): void { for (const fn of this.listeners) fn(c); }

  /** shapes in z-order with drag previews applied (memoised per board object + overrides) */
  shapes(): Shape[] { return this.index().shapes; }
  get(id: string): Shape | undefined { return this.index().byId.get(id); }
  bounds(id: string): Box | undefined {
    const ix = this.index();
    let b = ix.bounds.get(id);
    if (!b) { const s = ix.byId.get(id); if (!s) return undefined; b = shapeBounds(s, (x) => ix.byId.get(x), this.project); ix.bounds.set(id, b); }
    return b;
  }
  private index() {
    if (this.memo && this.memo.key === this.board && this.memo.ov === this.ovVersion) return this.memo;
    const shapes = (this.board.shapes ?? []).map((s) => this.overrides.get(s.id) ?? s);
    this.memo = { key: this.board, ov: this.ovVersion, shapes, byId: new Map(shapes.map((s) => [s.id, s])), bounds: new Map() };
    return this.memo;
  }
  setOverrides(m: Map<string, Shape>): void { this.overrides = m; this.ovVersion++; this.emit('board'); }
  clearOverrides(): void { if (this.overrides.size) { this.overrides = new Map(); this.ovVersion++; this.emit('board'); } }
  /** the project changed: still sizes may change */
  setProject(o: Outline | null): void { this.project = o; this.ovVersion++; this.emit('project'); this.emit('board'); }

  /** full state from GET /api/state or an embedded export */
  load(st: BoardState & { projectError?: Store['projectError'] }): void {
    if (st.project !== undefined) this.setProject(st.project);
    this.projectError = st.projectError;
    this.view = st.view ?? {};
    this.advice = st.advice;
    this.serverState(st.board, st.version, true);
    this.emit('view');
    this.emit('advice');
  }

  /**
   * SSE `state` / poll result: the server's truth. A batch is re-applied on top only while the server state is older
   * than the batch's ack version. While a POST is unanswered we cannot tell whether a state contains its batch (applying
   * it twice doubles a move), so the state is held until the answer names the version.
   */
  serverState(board: BoardFile, version: number, force = false): void {
    if (!force && version < this.version) return;
    if (!force && this.batches.some((x) => x.ack === undefined)) {
      if (!this.held || version >= this.held.version) this.held = { board, version };
      return;
    }
    this.held = undefined;
    const old = new Map((this.server.shapes ?? []).map((s) => [s.id, stable(s)]));
    const now = performance.now();
    if (!(force && !this.version)) {
      for (const s of board.shapes ?? []) {
        if (old.get(s.id) === stable(s)) continue;
        const m = this.mine.get(s.id);
        this.flash(s.id, m && now - m.at < 5000 ? m.by : old.has(s.id) ? 'ai' : s.by ?? 'ai');
      }
    }
    this.server = board;
    this.version = version;
    this.batches = this.batches.filter((x) => x.ack === undefined || x.ack > version);
    this.rebuild();
  }

  private rebuild(): void {
    let b = this.server;
    for (const x of this.batches) { try { b = applyLocal(b, x.ops, x.by).board; } catch { /* the server decides */ } }
    this.board = b;
    this.emit('board');
  }

  flash(id: string, by: Who): void { this.flashes.set(id, { by, until: performance.now() + FLASH_MS }); this.emit('flash'); }
  flashOf(id: string, now = performance.now()): Who | undefined {
    const f = this.flashes.get(id);
    if (!f) return undefined;
    if (f.until < now) { this.flashes.delete(id); return undefined; }
    return f.by;
  }

  /** apply ops: optimistic locally, then POST /api/ops; the server's state event reconciles */
  async send(ops: BoardOp[], by: Who): Promise<OpsResult> {
    if (!ops.length) return { ok: true, version: this.version, changed: [] };
    if (this.detached) {
      try {
        const r = applyLocal(this.server, ops, by);
        this.server = r.board;
        this.version++;
        for (const op of ops) this.pending.push({ op, by });
        r.changed.forEach((id) => this.flash(id, by));
        this.rebuild();
        return { ok: true, version: this.version, changed: r.changed };
      } catch (e) {
        return { ok: false, error: { code: 'E_DETACHED', message: (e as Error).message, fix: 'detached pages apply simple ops only; run mgl board serve for the rest.' } };
      }
    }
    const batch: Batch = { seq: ++this.seq, ops, by };
    this.batches.push(batch);
    try { const t = performance.now(); for (const id of applyLocal(this.board, ops, by).changed) this.mine.set(id, { by, at: t }); } catch { /* the server decides */ }
    this.rebuild();
    let res: OpsResult;
    try {
      const r = await fetch(`${this.base}/api/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops, by }) });
      res = (await r.json()) as OpsResult;
    } catch (e) {
      res = { ok: false, error: { code: 'E_NETWORK', message: `the board server did not answer (${(e as Error).message}).`, fix: 'is mgl board serve still running?' } };
    }
    if (res.ok) {
      // keep the batch until a server state at (or past) its version arrives: the shape never blinks out
      batch.ack = res.version;
      const t = performance.now();
      for (const id of [...res.changed, ...(res.created ?? [])]) { this.mine.set(id, { by, at: t }); this.flash(id, by); }
    } else this.batches = this.batches.filter((x) => x !== batch);
    const held = this.held;
    if (held && !this.batches.some((x) => x.ack === undefined)) this.serverState(held.board, held.version);
    else { this.batches = this.batches.filter((x) => x.ack === undefined || x.ack > this.version); this.rebuild(); }
    if (res.ok && res.version > this.version && this.conn !== 'live') void this.refresh();
    return res;
  }

  async post(path: string, body: unknown = {}): Promise<Record<string, unknown>> {
    if (this.detached) return { ok: false, error: { code: 'E_DETACHED', message: `${path} needs the board server.`, fix: 'run mgl board serve <file>.' } };
    try {
      const r = await fetch(`${this.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return (await r.json()) as Record<string, unknown>;
    } catch (e) {
      return { ok: false, error: { code: 'E_NETWORK', message: (e as Error).message, fix: 'is mgl board serve still running?' } };
    }
  }

  async refresh(): Promise<boolean> {
    if (this.detached) return false;
    try {
      const r = await fetch(`${this.base}/api/state?since=${this.version}`, { cache: 'no-store' });
      if (!r.ok) return false;
      const st = (await r.json()) as BoardState & { projectError?: Store['projectError'] };
      if (JSON.stringify(st.project) !== JSON.stringify(this.project)) this.setProject(st.project);
      this.projectError = st.projectError;
      if (st.advice) { this.advice = st.advice; this.emit('advice'); }
      if (st.view) { this.view = st.view; this.emit('view'); }
      this.serverState(st.board, st.version);
      return true;
    } catch { return false; }
  }

  setConn(c: string): void { if (c !== this.conn) { this.conn = c; this.emit('conn'); } }
}

/** JSON with sorted keys: the server may write keys in another order without changing anything */
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
}
