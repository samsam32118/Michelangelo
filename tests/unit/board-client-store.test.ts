/** The page store's optimistic batches against SSE / POST ordering (e2e: a shape at a double offset, a note that blinks out). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/board/client/store.js';
import type { BoardFile } from '../../src/board/shared/types.js';

const at = (x: number, y: number): BoardFile => ({ michelangeloBoard: 1, shapes: [{ id: 'n1', type: 'note', x, y }] });
const n1 = (s: Store) => s.get('n1') as { x: number; y: number } | undefined;

/** fetch that answers when `answer()` is called */
function pendingFetch() {
  let answer!: (body: unknown) => void;
  const p = new Promise<unknown>((r) => { answer = r; });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => p })));
  return (body: unknown) => answer(body);
}
afterEach(() => vi.unstubAllGlobals());

describe('Store optimistic batches', () => {
  it('a state that already holds the move, arriving before the POST answer, is not moved twice', async () => {
    const s = new Store();
    s.serverState(at(250, 180), 1, true);
    const answer = pendingFetch();
    const sent = s.send([{ op: 'shape.move', ids: ['n1'], dx: 150, dy: 80 }], 'human');
    expect(n1(s)).toMatchObject({ x: 400, y: 260 });
    s.serverState(at(400, 260), 2); // SSE first
    expect(n1(s)).toMatchObject({ x: 400, y: 260 });
    answer({ ok: true, version: 2, changed: ['n1'] });
    await sent;
    expect(n1(s)).toMatchObject({ x: 400, y: 260 });
  });
  it('a POST answer before the state keeps the new shape until the state arrives', async () => {
    const s = new Store();
    s.serverState({ michelangeloBoard: 1 }, 1, true);
    const answer = pendingFetch();
    const sent = s.send([{ op: 'shape.add', shape: { id: 'n1', type: 'note', x: 0, y: 0 } as never }], 'human');
    expect(n1(s)).toBeTruthy();
    answer({ ok: true, version: 2, changed: ['n1'], created: ['n1'] });
    await sent;
    expect(n1(s)).toBeTruthy(); // the editor can open on it
    s.serverState(at(0, 0), 2);
    expect(n1(s)).toMatchObject({ x: 0, y: 0 });
    s.serverState({ michelangeloBoard: 1 }, 3); // a later removal elsewhere: the batch is gone, not re-applied
    expect(n1(s)).toBeUndefined();
  });
  it('a refused batch is dropped at once', async () => {
    const s = new Store();
    s.serverState(at(0, 0), 1, true);
    const answer = pendingFetch();
    const sent = s.send([{ op: 'shape.move', ids: ['n1'], dx: 10, dy: 0 }], 'human');
    answer({ ok: false, error: { code: 'E_LOCKED', message: 'locked' } });
    await sent;
    expect(n1(s)).toMatchObject({ x: 0, y: 0 });
  });
});

describe('Store detached (an exported page)', () => {
  const detached = () => { const s = new Store(); s.detached = true; s.idTag = 'q7k'; s.load({ board: at(0, 0), version: 1, project: null, view: {} }); return s; };
  it('queues ops with the ids they got here, so later ops still name the same shapes on the real board', async () => {
    const s = detached();
    const r = await s.send([{ op: 'shape.add', shape: { type: 'note', x: 10, y: 10, text: 'a' } as never }], 'human');
    // tagged with this page's id tag: the real board may have its own n2 by the time the ops are applied
    expect(r).toMatchObject({ ok: true, created: ['n2-q7k'] });
    await s.send([{ op: 'shape.set', id: 'n2-q7k', props: { text: 'b' } }], 'human');
    expect(s.newId('n')).toBe('n3-q7k');
    await s.send([{ op: 'shape.add', shape: { type: 'note', x: 0, y: 0 } as never }, { op: 'shape.add', shape: { type: 'rect', x: 0, y: 0 } as never }], 'human');
    expect(s.pending.map((p) => p.op)).toEqual([
      { op: 'shape.add', shape: { type: 'note', x: 10, y: 10, text: 'a', id: 'n2-q7k' } },
      { op: 'shape.set', id: 'n2-q7k', props: { text: 'b' } },
      { op: 'shape.add', shape: { type: 'note', x: 0, y: 0, id: 'n3-q7k' } },
      { op: 'shape.add', shape: { type: 'rect', x: 0, y: 0, id: 'g1-q7k' } },
    ]);
    expect(s.pending.every((p) => p.by === 'human')).toBe(true);
  });
  it('undo and redo work on the queue, without a server', async () => {
    const s = detached();
    await s.send([{ op: 'shape.add', shape: { id: 'n9', type: 'note', x: 0, y: 0 } as never }], 'human');
    await s.send([{ op: 'shape.move', ids: ['n9'], dx: 5, dy: 0 }], 'human');
    expect(await s.post('/api/undo', { by: 'human' })).toMatchObject({ ok: true });
    expect(s.get('n9')).toMatchObject({ x: 0 });
    expect(s.pending).toHaveLength(1);
    expect(await s.post('/api/redo', {})).toMatchObject({ ok: true });
    expect(s.get('n9')).toMatchObject({ x: 5 });
    await s.post('/api/undo'); await s.post('/api/undo');
    expect(s.get('n9')).toBeUndefined();
    expect(s.pending).toHaveLength(0);
    expect(await s.post('/api/undo')).toMatchObject({ ok: false, error: { code: 'E_HISTORY_EMPTY' } });
    expect(n1(s)).toMatchObject({ x: 0, y: 0 }); // the embedded board is untouched
  });
});
