/**
 * window.mgl: the console door (BOARD.md §6.3) for agents that drive a browser. Every call returns a Promise of plain
 * JSON. Calls are by "ai" unless mgl.as('human'). Ops go through the same POST /api/ops path as the page.
 */
import type { BoardOp, Camera, OpsResult, RoundOption, Shape, Who, Level, Fidelity, Brief, PaletteName, TimeLike } from '../shared/types.js';
import type { App } from './app.js';
import type { Renderer } from './renderer.js';
import { undo } from './keys.js';

type Opts = Partial<{ x: number; y: number; w: number; h: number; color: PaletteName; parent: string; label: string; fill: 'none' | 'solid' | 'tint'; size: number; id: string; tags: string[] }>;
type Result = OpsResult & { id?: string };

const plain = <T>(v: T): T => (v === undefined ? (null as T) : JSON.parse(JSON.stringify(v)) as T);

export const HELP: [string, string, string][] = [
  ['mgl.help()', 'this list (also returned as text)', "mgl.help()"],
  ['mgl.state()', '{board, version, project, view, advice, selection, camera, playhead}', "(await mgl.state()).board.brief"],
  ['mgl.op(op) / mgl.ops([...])', 'any board op (BOARD.md §5); a batch is atomic', "mgl.op({op: 'shape.add', shape: {type: 'note', x: 0, y: 0, text: 'hi'}})"],
  ['mgl.note(text, {x, y, color})', 'a sticky note (placed for you without x/y)', "mgl.note('Open on the drawer', {color: 'yellow'})"],
  ['mgl.text(text, {x, y, size})', 'free text', "mgl.text('Act 1', {x: 0, y: -80, size: 32})"],
  ['mgl.rect(text, {x, y, w, h, fill})', 'a rectangle with a label (mgl.ellipse too)', "mgl.rect('CTA', {x: 300, y: 0, fill: 'tint', color: 'blue'})"],
  ['mgl.frame(label, {x, y, w, h})', 'a titled region', "mgl.frame('Options', {x: 0, y: 700, w: 1200, h: 600})"],
  ['mgl.arrow(fromId, toId, {text})', 'an arrow bound to two shapes', "mgl.arrow('n1', 's1', {text: 'becomes'})"],
  ['mgl.still(t, {fidelity, x, y, parent})', 'a still of the project at a time (thumb ≈ ms, half, full)', "mgl.still('2.5s', {fidelity: 'half'})"],
  ['mgl.storyboard({every | cuts, fidelity})', 'a frame of stills in a grid', "mgl.storyboard({every: '3s'})"],
  ['mgl.brief(fields)', 'set brief fields (lists replace; {add: {tone: [..]}} appends)', "mgl.brief({goal: '30 s Short…', questions: ['calm or punchy?']})"],
  ['mgl.round(goal, fidelity)', 'open a round at a ladder level (0 sketch … 4 final)', "mgl.round('pick the opening', 1)"],
  ['mgl.option(roundId, {title, tradeoffs, cost, taste, shapes})', 'propose an option', "mgl.option('r1', {title: 'Drawer close-up', tradeoffs: 'strong hook; needs a new shot', cost: '0.2 s', taste: 'the trick is the hook', shapes: ['s1']})"],
  ['mgl.decide(roundId, optionId, why)', 'record a decision', "mgl.decide('r1', 'r1a', 'the hook is the trick itself')"],
  ['mgl.pin(targetId, u, v, text) / mgl.resolve(pinId, reply)', 'feedback on a point of a shape; resolve says what changed', "mgl.resolve('p1', 'title is 20 % larger now')"],
  ['mgl.say(text)', 'a chat message (a toast on the page)', "mgl.say('Two openings to choose from in round r1.')"],
  ['mgl.set(id, props) / mgl.move(ids, dx, dy) / mgl.remove(ids)', 'edit shapes', "mgl.set('n1', {color: 'green'})"],
  ['mgl.select(ids) / mgl.selection()', 'the page selection', "mgl.select(['n1'])"],
  ['mgl.focus(ids) / mgl.camera({x, y, zoom})', 'move the camera (focus animates and highlights)', "mgl.focus(['s1'])"],
  ['mgl.find(query) / mgl.get(id)', 'shapes by fields ({type: \'still\'}; q: text search)', "mgl.find({type: 'pin', status: 'open'})"],
  ['mgl.undo(force) / mgl.redo()', "history (shared with the CLI): undo takes back your own latest step; the other party's step is refused (E_UNDO_OTHER) unless force", "mgl.undo()"],
  ['mgl.snapshot()', 'PNG data URL of the viewport', "await mgl.snapshot()"],
  ['mgl.timeline()', 'the project outline (comps, tracks, clips)', "(await mgl.timeline()).clips.length"],
  ['mgl.view()', "presence: what the person and the agent see", "(await mgl.view()).human.inView"],
  ['mgl.as(who)', "tag later calls 'human' or 'ai' (default 'ai')", "mgl.as('human')"],
  ['mgl.pending()', 'ops queued on a detached (exported) page', "mgl.pending()"],
];

export function helpText(): string {
  const lines = ['Michelangelo board: window.mgl (every call returns a Promise of plain JSON; by "ai" unless mgl.as("human"))', ''];
  for (const [sig, what, ex] of HELP) lines.push(`${sig}\n    ${what}\n    e.g. ${ex}`);
  lines.push('', 'A refused op resolves to {ok: false, error: {code, message, fix}}; the browser also logs the HTTP 400 as a network error. That line is expected: read the result, not the console.');
  lines.push('', 'Talk tradeoffs and taste with the person: brief → round with 2–3 options → wait → decide → climb the ladder.');
  return lines.join('\n');
}

export function installConsole(app: App, r: Renderer): Record<string, unknown> {
  let by: Who = 'ai';
  const run = async (ops: BoardOp[]): Promise<Result> => {
    const res = await app.store.send(ops, by);
    return plain(res.ok ? { ...res, ...(res.created?.length === 1 ? { id: res.created[0] } : res.changed.length === 1 ? { id: res.changed[0] } : {}) } : res);
  };
  const add = (type: Shape['type'], extra: Record<string, unknown>, o: Opts = {}) => run([{ op: 'shape.add', shape: { type, ...extra, ...o } as never }]);
  const ids = (v: string | string[]) => (Array.isArray(v) ? v : [v]);
  const api = {
    help: async () => { const t = helpText(); console.log(t); return t; },
    state: async () => plain({ board: app.store.board, version: app.store.version, project: app.store.project, view: app.store.view, advice: app.store.advice ?? null, selection: app.selection, camera: app.camera.cam, playhead: app.playhead, tool: app.tool, conn: app.store.conn }),
    op: async (op: BoardOp) => run([op]),
    ops: async (ops: BoardOp[]) => run(ops),
    note: async (text: string, o?: Opts) => add('note', { text }, o),
    text: async (text: string, o?: Opts) => add('text', { text }, o),
    rect: async (text?: string, o?: Opts) => add('rect', text ? { text } : {}, o),
    ellipse: async (text?: string, o?: Opts) => add('ellipse', text ? { text } : {}, o),
    frame: async (label: string, o?: Opts) => add('frame', { label }, o),
    arrow: async (from: string | [number, number], to: string | [number, number], o: { text?: string; color?: PaletteName } = {}) => add('arrow', { from, to }, o as Opts),
    still: async (t: TimeLike, o: { fidelity?: Fidelity; comp?: string; x?: number; y?: number; parent?: string } = {}) => run([{ op: 'still.add', t, ...o }]),
    storyboard: async (o: { every?: TimeLike; cuts?: boolean; fidelity?: Fidelity; frame?: string } = {}) => run([{ op: 'storyboard.make', ...o }]),
    brief: async (fields: Partial<Brief> & { add?: Record<string, string[]>; remove?: Record<string, string[]> }) => run([{ op: 'brief.set', ...fields }]),
    round: async (goal: string, fidelity: Level = 0, id?: string) => run([{ op: 'round.open', goal, fidelity, ...(id ? { id } : {}) }]),
    option: async (round: string, option: Partial<RoundOption> & { title: string }) => run([{ op: 'round.option', round, option }]),
    decide: async (round: string, chosen: string, why?: string) => run([{ op: 'round.decide', round, chosen, ...(why ? { why } : {}) }]),
    pin: async (target: string, u = 0.5, v = 0.5, text = '') => run([{ op: 'pin.add', target, u, v, text }]),
    resolve: async (id: string, reply?: string) => run([{ op: 'pin.resolve', id, ...(reply ? { reply } : {}) }]),
    say: async (text: string) => run([{ op: 'say', text }]),
    set: async (id: string, props: Record<string, unknown>) => run([{ op: 'shape.set', id, props }]),
    move: async (v: string | string[], dx: number, dy: number) => run([{ op: 'shape.move', ids: ids(v), dx, dy }]),
    remove: async (v: string | string[]) => run([{ op: 'shape.remove', ids: ids(v) }]),
    select: async (v: string | string[]) => { app.select(ids(v)); return plain({ selection: app.selection }); },
    selection: async () => plain({ ids: app.selection, shapes: app.selection.map((id) => app.store.get(id)) }),
    focus: async (v: string | string[]) => { const list = ids(v).filter((id) => app.store.get(id)); app.focus(list); return plain({ ok: list.length > 0, ids: list }); },
    camera: async (c?: Partial<Camera>) => { if (c) app.camera.animateTo({ ...app.camera.cam, ...c }); return plain({ ...app.camera.cam, ...(c ?? {}) }); },
    find: async (q: Record<string, unknown> = {}) => {
      const { q: text, ...eq } = q;
      return plain(app.store.shapes().filter((s) => Object.entries(eq).every(([k, v]) => JSON.stringify((s as unknown as Record<string, unknown>)[k]) === JSON.stringify(v))
        && (typeof text !== 'string' || JSON.stringify(s).toLowerCase().includes(text.toLowerCase()))));
    },
    get: async (id: string) => plain(app.store.get(id) ?? null),
    undo: async (force?: boolean) => plain(await undo(app, 'undo', by, force === true)),
    redo: async () => plain(await undo(app, 'redo', by)),
    snapshot: async () => { r.request(); await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); return r.snapshot(); },
    timeline: async () => plain(app.store.project),
    view: async () => plain({ ...app.store.view, page: { camera: app.camera.cam, selection: app.selection } }),
    as: async (who: Who) => { if (who !== 'human' && who !== 'ai') throw new Error(`mgl.as: "${String(who)}" is not human or ai.`); by = who; return { by }; },
    pending: async () => plain(app.store.pending),
  };
  (window as unknown as { mgl: typeof api }).mgl = api;
  return api;
}
