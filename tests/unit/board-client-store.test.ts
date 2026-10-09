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
