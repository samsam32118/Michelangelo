/**
 * `mgl board`: the shared canvas (docs/plans/BOARD.md §6.1). serve | show | edit | view | focus | say | snapshot | export | render.
 * Mutations go to the running server when there is one (single writer, pages update at once), else to the file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MglError, fail, suggest } from '../core/errors.js';
import type { BoardFile, BoardOp, BoardState, Outline, Presence, Shape, Who } from '../board/shared/types.js';
import {
  BoardSession, OP_EXAMPLES, OP_NAMES, advise, briefMissing, entityLine, formatBoard, formatBrief, ladderGap, parseOp, pinContext,
  projectOf, projectOutline, resolveBoardPath, readBoard, saveBoard, spentMs, unanswered, type ApplyResult, type HistoryStep,
} from '../board/model/index.js';
import { clip, secondsText, str, bool, type Args, type Out } from './io.js';
import { jsonCommands, parseValue } from './kv.js';

const SUBS = ['serve', 'show', 'edit', 'view', 'focus', 'say', 'snapshot', 'export', 'render'];

/** `mgl board` / `mgl board --help`: enough to start, alone (≤ 40 lines). */
export const BOARD_HELP = [
  'mgl board: a shared canvas where you and the person agree on a video before spending renders.',
  'The loop: brief → round (2-3 options with tradeoffs and taste) → the person chooses → climb one rung → pins → repeat.',
  'Ladder (cost grows): 0 sketch (shapes) · 1 frames (stills, ms) · 2 sheet (look) · 3 draft render · 4 final render.',
  '',
  '  mgl board show <file>                    brief, current round, open pins, spend, and next: what to do now',
  '  mgl board serve <file> [--port 4477]     the page for the person (run it in the background; give them the URL)',
  "  mgl board edit <file> <op> [k=v ...]     also '<json>', --batch f.jsonl, --dry-run, --by human, undo, redo, history",
  '  mgl board view <file>                    what the person sees now (needs serve)',
  "  mgl board focus <file> <id...>           move the person's camera to shapes (needs serve)",
  '  mgl board say <file> "text"              a chat line (a toast on the page)',
  '  mgl board snapshot <file> [-o b.png]     the board as a PNG (Skia): look at it; --frame id, --ids a,b',
  '  mgl board export <file> [-o b.html]      one offline HTML file (no server): for remote panes and Artifacts',
  '  mgl board render <file> --level 1..4     climb the ladder; --ids s1,s2, --range 0-3s; records spend',
  '<file> is video.mgl.json (uses video.board.json, created on first use) or the .board.json itself.',
  '',
  'Ops: shape.add|set|remove|move|order, brief.set, round.open|option|decide|set, pin.add|resolve, say, still.add,',
  '     storyboard.make, spend.add. Start:',
  '  mgl board edit video.mgl.json brief.set goal="..." audience="..." success="..." budget.cpuMin=10',
  '  mgl board edit video.mgl.json storyboard.make every=3s',
  '  mgl board edit video.mgl.json round.open "pick the opening" fidelity=1',
  '  mgl board edit video.mgl.json round.option r1 title="Bold hook" tradeoffs="..." taste="..." shapes=s1',
  '  mgl board edit video.mgl.json pin.resolve p1 reply="title is 1.3x larger"',
  'In the page console: mgl.help(). Guide: mgl docs board. One subcommand: mgl board help <sub>.',
];

/** `mgl board help <sub>`: one subcommand's usage, flags and an example. */
export const SUB_HELP: Record<string, string[]> = {
  serve: ['mgl board serve <file> [--port 4477] [--host 127.0.0.1] [--allow-host name] [--json]', '  the page for the person; long-running (run it in the background). --port 0: any free port.', '  --host 0.0.0.0 listens on every interface (the printed URL stays 127.0.0.1); --allow-host names your tunnel.', '  writes .mgl/board/server.json so the other subcommands go through it.'],
  show: ['mgl board show <file> [--json]', "  brief, current round and options, open pins, spend vs budget, the person's unanswered messages,", '  what the person changed since your last op, and next: what to do now.'],
  edit: ["mgl board edit <file> <op> [bare] [k=v ...] | '<json>' | --batch f.jsonl [--dry-run] [--by human]", '  undo [n] [--force]: undoes your own latest step; a step the other party made is refused (E_UNDO_OTHER) unless --force.', '  redo [n] · history (who made each step).', `  ops: ${OP_NAMES.join(', ')}.`, '  e.g. mgl board edit video.mgl.json say "Two options are up" re=m4'],
  view: ['mgl board view <file> [--json]', '  what the person sees now: camera, selection, shapes in view, the last log lines (needs serve).'],
  focus: ['mgl board focus <file> <id...>', "  moves every open page's camera to the shapes and highlights them (needs serve)."],
  say: ['mgl board say <file> "text" [--by human]', '  a chat line (a toast on the page). To answer a message by id: mgl board edit <file> say "..." re=m4'],
  snapshot: ['mgl board snapshot <file> [-o board.png] [--frame id] [--ids a,b]', '  the board drawn with Skia (stills rendered and cached), long edge ≤ 1568 px: look at it.'],
  export: ['mgl board export <file> [-o board.html]', '  one offline HTML file (no server) for remote panes and Artifacts; edits there are queued as JSONL.'],
  render: ['mgl board render <file> --level 1..4 [--ids s1,s2] [--range a-b] [--dry-run] [--force] [--by human]', '  1 stills (the board\'s stills, cached) · 2 sheet (look: contact sheet, QA, sound) · 3 draft · 4 final.', '  --dry-run: print the estimate and the budget it would use; renders nothing, records no spend.', "  refused without --force: 3/4 before the brief's goal and success; a level above budget.maxLevel; an estimate over", '  the budget left. The sheet and the renders appear on the board as images (renders link /files/renders/<name>.mp4).'],
};
const CHANGE_LINES = 12;
const LEVELS = ['sketch', 'frames', 'sheet', 'draft', 'final'];

type ServerMod = typeof import('../board/server/index.js');
const serverMod = (): Promise<ServerMod> => import('../board/server/index.js');

export async function board(a: Args, o: Out) {
  const [sub, ...pos] = a.pos;
  const args: Args = { pos, flags: a.flags };
  if (sub === 'help' && pos[0] && SUB_HELP[pos[0]]) { o.line(...SUB_HELP[pos[0]]!); o.set({ subcommand: pos[0], help: SUB_HELP[pos[0]] }); return; }
  if (!sub || sub === 'help') { o.line(...BOARD_HELP); o.set({ subcommands: SUBS, ops: OP_NAMES }); return; }
  const run: Record<string, (a: Args, o: Out) => Promise<void>> = { serve, show, edit, view, focus, say, snapshot, export: exportPage, render };
  const fn = run[sub];
  if (!fn) {
    if (OP_NAMES.includes(sub as never)) fail('E_USAGE', `"${sub}" is a board op, not a subcommand.`, `ops go through edit: mgl board edit <file> ${OP_EXAMPLES[sub] ?? sub}`);
    const dym = suggest(sub, SUBS);
    fail('E_USAGE', `"${sub}" is not a board subcommand.`, dym.length ? `did you mean "mgl board ${dym[0]}"?` : `subcommands: ${SUBS.join(', ')}`);
  }
  await fn(args, o);
}

function fileArg(a: Args, usage: string): { boardPath: string; projectPath?: string; arg: string } {
  const arg = a.pos[0];
  if (!arg) fail('E_USAGE', 'give the board or project file.', usage);
  return { ...resolveBoardPath(arg), arg };
}

function who(a: Args): Who {
  const b = str(a, 'by') ?? 'ai';
  if (b !== 'ai' && b !== 'human') fail('E_ARG', `--by must be human or ai, got "${b}".`, '--by human (the CLI and console default to ai).');
  return b;
}

/** The running server for a board, or null (also null while the server module cannot load). */
async function server(boardPath: string): Promise<{ url: string; port: number } | null> {
  try { return await (await serverMod()).findServer(boardPath); } catch { return null; }
}

async function http<T>(url: string, route: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    return fail('E_SERVER', `the board server at ${url} did not answer (${(e as Error).message}).`, 'restart it: mgl board serve <file> (in the background).');
  }
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: { code: string; message: string; fix?: string } };
  if (!res.ok || j.ok === false) {
    const e = j.error;
    throw new MglError({ code: e?.code ?? 'E_SERVER', message: e?.message ?? `the board server answered ${res.status} for ${route}.`, fix: e?.fix ?? 'check the server output.' });
  }
  return j as T;
}

/** The linked project's outline, or null with the reason. */
async function outlineFor(boardPath: string, b: BoardFile, projectPath?: string): Promise<{ outline: Outline | null; error?: MglError }> {
  const p = projectOf(boardPath, b) ?? projectPath;
  if (!p) return { outline: null };
  try { return { outline: await projectOutline(p) }; } catch (e) {
    if (e instanceof MglError) return { outline: null, error: e };
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { outline: null, error: new MglError({ code: 'E_NO_FILE', message: `${p} does not exist.`, fix: 'fix "project" in the board file, or create it: mgl new' }) };
    throw e;
  }
}

// ------------------------------------------------------------------ serve

async function serve(a: Args, o: Out) {
  const { boardPath, arg } = fileArg(a, 'mgl board serve video.mgl.json [--port 4477] [--host 127.0.0.1] [--allow-host name]');
  const port = str(a, 'port');
  if (port !== undefined && !/^\d+$/.test(port)) fail('E_ARG', `--port must be a number, got "${port}".`, '--port 4477 (0 picks a free port)');
  // the board file is created on first serve, linked to its project
  const { board: b, text } = await readBoard(boardPath);
  if (text === null) await saveBoard(boardPath, b);
  const host = str(a, 'host');
  const allowHost = str(a, 'allow-host')?.split(',').map((x) => x.trim()).filter(Boolean);
  // the CLI owns the signals: a stopped server is a normal end (exit 0), not 130 / 143
  const s = await (await serverMod()).startBoardServer({ file: arg, ...(port !== undefined ? { port: Number(port) } : {}), ...(host ? { host } : {}), ...(allowHost?.length ? { allowHost } : {}), quiet: o.json, handleSignals: false });
  const lines = [`board ${boardPath}: ${s.url}`, `open it in your browser; agents: mgl board show|view|edit ${arg}, or window.mgl in the page console`, 'stop: Ctrl-C (or kill the process)'];
  if (o.json) process.stdout.write(JSON.stringify({ ok: true, url: s.url, port: s.port, board: boardPath }) + '\n');
  else process.stdout.write(lines.join('\n') + '\n');
  await new Promise<void>((done) => { process.once('SIGINT', () => done()); process.once('SIGTERM', () => done()); });
  await s.close().catch(() => undefined);
  process.exit(0); // stopped by a signal: a normal end; the JSON line was written at start
}

// ------------------------------------------------------------------ show

const q = (s: string, n = 80) => JSON.stringify(clip(s, n));
const list = (xs: string[] | undefined, n = 60) => clip((xs ?? []).join(', '), n);

function currentRound(b: BoardFile) {
  const rs = b.rounds ?? [];
  return [...rs].reverse().find((r) => r.status === 'open' || r.status === 'proposed') ?? rs.at(-1);
}

async function show(a: Args, o: Out) {
  const { boardPath, projectPath } = fileArg(a, 'mgl board show video.mgl.json');
  const { board: b, text } = await readBoard(boardPath);
  if (text === null) await saveBoard(boardPath, b);
  const [{ outline, error }, srv] = await Promise.all([outlineFor(boardPath, b, projectPath), server(boardPath)]);
  let view: Partial<Record<Who, Presence>> = {};
  let live = b;
  if (srv) { try { const st = await http<BoardState>(srv.url, '/api/state'); view = st.view ?? {}; live = st.board ?? b; } catch { /* show the file */ } }
  const advice = advise(live, outline, view);
  const lines: string[] = [];
  const shapes = live.shapes ?? [];
  let head = `board ${boardPath}${text === null ? ' (new)' : ''} · ${shapes.length} shape${shapes.length === 1 ? '' : 's'}`;
  if (outline) {
    const c = outline.comps.find((x) => x.id === outline.main)!;
    head += ` · project ${live.project ?? projectPath} (${c.id} ${c.size[0]}x${c.size[1]} ${Math.round(c.fps * 100) / 100}fps ${secondsText(c.length / c.fps)}, ${outline.clips.length} clips)`;
  } else if (error) head += ` · project does not load (${error.code}: ${clip(error.message, 80)})`;
  else head += ' · no project (sketching)';
  if (srv) head += ` · server ${srv.url}`;
  lines.push(head);
  // brief
  const br = live.brief ?? {};
  const missing = briefMissing(live);
  const bits = [br.goal && `goal ${q(br.goal, 100)}`, br.audience && `audience ${q(br.audience, 50)}`, br.platform && `platform ${br.platform}`, br.length && `length ${br.length}`].filter(Boolean);
  lines.push(`brief: ${bits.length ? bits.join(' · ') : '(empty)'}`);
  const more = [br.tone?.length && `tone ${list(br.tone)}`, br.mustHave?.length && `must have: ${list(br.mustHave)}`, br.avoid?.length && `avoid: ${list(br.avoid)}`, br.success?.length && `success: ${list(br.success, 100)}`, br.references?.length && `refs: ${list(br.references)}`].filter(Boolean);
  if (more.length) lines.push(`  ${more.join(' · ')}`);
  if (br.budget) lines.push(`  budget: ${br.budget.cpuMin !== undefined ? `${br.budget.cpuMin} render min (wall clock)` : ''}${br.budget.maxLevel !== undefined ? `${br.budget.cpuMin !== undefined ? ', ' : ''}max level ${br.budget.maxLevel} (${LEVELS[br.budget.maxLevel]})` : ''}`);
  if (missing.length) lines.push(`  missing: ${missing.join(', ')}`);
  if (br.questions?.length) lines.push(`  questions: ${br.questions.map((x) => q(x, 70)).join('; ')}`);
  // rounds
  const cur = currentRound(live);
  if (cur) {
    lines.push(`round ${cur.id} ${q(cur.goal, 70)} · level ${cur.fidelity} (${LEVELS[cur.fidelity]}) · ${cur.status}${cur.chosen ? ` → ${cur.chosen}` : ''}${cur.why ? ` (${clip(cur.why, 60)})` : ''}`);
    for (const opt of (cur.options ?? []).slice(0, 4)) {
      const t = [opt.summary && clip(opt.summary, 60), opt.tradeoffs ? `tradeoffs: ${clip(opt.tradeoffs, 80)}` : 'no tradeoffs yet', opt.cost && `cost ${opt.cost}`, opt.taste && `taste: ${clip(opt.taste, 50)}`, opt.shapes?.length && `shapes ${list(opt.shapes, 30)}`].filter(Boolean);
      lines.push(`  ${opt.id === cur.chosen ? '*' : ' '}${opt.id} ${q(opt.title, 40)}: ${t.join(' · ')}`);
    }
    if ((cur.options?.length ?? 0) > 4) lines.push(`   … ${cur.options!.length - 4} more options`);
    if (cur.notes) lines.push(`  notes: ${clip(cur.notes, 120)}`);
    const earlier = (live.rounds ?? []).filter((r) => r !== cur && r.status === 'decided').slice(-2);
    for (const r of earlier) {
      const ch = r.options?.find((x) => x.id === r.chosen);
      lines.push(`  earlier: ${r.id} L${r.fidelity} ${q(r.goal, 40)} → ${r.chosen}${ch ? ` ${q(ch.title, 30)}` : ''}${r.why ? ` (${clip(r.why, 50)})` : ''}`);
    }
  } else lines.push('rounds: none yet');
  // pins
  const pins = shapes.filter((s): s is Shape & { type: 'pin' } => s.type === 'pin' && s.status !== 'resolved');
  if (pins.length) {
    lines.push(`pins: ${pins.length} open`);
    for (const p of pins.slice(0, 5)) {
      const c = pinContext(live, outline, p);
      lines.push(`  ${p.id} on ${p.target}${c.t !== undefined ? ` @ ${c.t}` : ''}${c.clips ? ` [clips: ${c.clips.join(', ') || 'none'}]` : ''}: ${q(p.text ?? '', 80)} (${p.by ?? 'human'})`);
    }
    if (pins.length > 5) lines.push(`  … ${pins.length - 5} more pins`);
  }
  // spend
  const ms = spentMs(live);
  const spend = live.spend ?? [];
  if (spend.length || br.budget?.cpuMin !== undefined) {
    const byLevel = [1, 2, 3, 4].map((l) => [l, spend.filter((s) => s.level === l).reduce((t, s) => t + s.ms, 0)] as const).filter(([, v]) => v > 0);
    const budget = br.budget?.cpuMin;
    lines.push(`spend: ${secondsText(ms / 1000)}${budget !== undefined ? ` of ${budget} render min (${budget > 0 ? Math.round((ms / 600) / budget) : '∞'} %)` : ''} in ${spend.length} render${spend.length === 1 ? '' : 's'}${byLevel.length ? ' · ' + byLevel.map(([l, v]) => `L${l} ${secondsText(v / 1000)}`).join(' · ') : ''}`);
  }
  // presence
  if (srv) {
    const h = view.human;
    if (h) {
      const cam = h.camera ? `camera ${Math.round(h.camera.x)},${Math.round(h.camera.y)} zoom ${h.camera.zoom.toFixed(2)}` : 'no camera yet';
      lines.push(`person: ${cam}${h.selection?.length ? ` · selected ${list(h.selection, 50)}` : ''}${h.inView ? ` · ${h.inView.length} shapes in view` : ''}${h.at ? ` · ${Math.round((Date.now() - h.at) / 1000)} s ago` : ''}`);
    } else lines.push('person: no page open (send them the server URL)');
  }
  // what the person said and did that the agent has not answered / seen: never hide it behind the last line
  const log = live.log ?? [];
  const open = unanswered(live);
  const last = log.at(-1);
  if (open.length) {
    lines.push(`person said (unanswered, ${open.length}):`);
    for (const m of open.slice(-6)) lines.push(`  ${m.id}: ${q(m.text, 300)}`);
    if (open.length > 6) lines.push(`  … ${open.length - 6} older (${open.slice(0, -6).map((m) => m.id).join(', ')})`);
  }
  if (last && !open.includes(last)) lines.push(`log: ${last.id} ${last.by}: ${q(last.text, 100)}${log.length > 1 ? ` (${log.length} messages)` : ''}`);
  const me = who(a);
  let since: HistoryStep[] = [];
  try { since = (await BoardSession.open(boardPath)).since(me); } catch { /* no history */ }
  const edits = since.filter((x) => !x.summary.startsWith('say ') && x.summary !== 'say');
  if (edits.length) {
    lines.push(`${me === 'ai' ? 'person' : 'agent'} changed since your last op (${edits.length}):`);
    for (const x of edits.slice(-4)) lines.push(`  ${clip(x.summary, 150)}`);
    if (edits.length > 4) lines.push(`  … ${edits.length - 4} more (mgl board edit <file> history)`);
  }
  lines.push('next:');
  if (!advice.length) lines.push('  nothing pending: wait for the person, or check the board (mgl board view)');
  const room = Math.max(3, 40 - lines.length - 1);
  for (const x of advice.slice(0, room)) lines.push(`  ${x.level}: ${clip(x.text, 200)}`);
  if (advice.length > room) lines.push(`  … ${advice.length - room} more (use --json)`);
  o.line(...lines);
  o.set({ file: boardPath, created: text === null, project: live.project ?? null, board: live, outline, projectError: error?.toJSON() ?? null, missing, advice, spendMs: ms, view, server: srv?.url ?? null, unanswered: open.map((m) => m.id), since });
}

// ------------------------------------------------------------------ edit

/** The field a bare word fills, per op. */
const PRIMARY: Record<string, string> = {
  'shape.add': 'type', 'shape.set': 'id', 'shape.remove': 'id', 'shape.move': 'ids', 'shape.order': 'ids', 'round.open': 'goal', 'round.option': 'round',
  'round.decide': 'round', 'round.set': 'round', 'pin.add': 'target', 'pin.resolve': 'id', say: 'text', 'still.add': 't', 'storyboard.make': 'frame', 'spend.add': 'what',
};
/** k=v words that go into a nested object, except the listed top-level keys. */
const NEST: Record<string, [string, string[]]> = { 'shape.add': ['shape', []], 'shape.set': ['props', ['id']], 'round.option': ['option', ['round']], 'round.set': ['props', ['round']] };
/** Values kept as typed (text=123 stays "123"); "null" still means remove. */
const TEXT = new Set(['text', 'label', 'title', 'goal', 'why', 'reply', 'summary', 'tradeoffs', 'cost', 'taste', 'notes', 'what', 'src', 'comp', 'id', 'round', 'chosen', 'target', 'frame', 'audience', 'platform', 'length', 'parent', 'type', 'status', 'color', 'fill', 'project']);
/** comma-separated id lists */
const ID_LISTS = new Set(['ids', 'shapes', 'tags', 're']);
/** brief lists: one string is one item */
const TEXT_LISTS = new Set(['tone', 'references', 'mustHave', 'avoid', 'success', 'questions']);

function kvValue(key: string, raw: string): unknown {
  const leaf = key.split('.').at(-1)!;
  if (raw === 'null') return null;
  if (TEXT.has(leaf)) return raw;
  const v = parseValue(raw);
  if (typeof v === 'string' && ID_LISTS.has(leaf)) return v.split(',').map((x) => x.trim()).filter(Boolean);
  if (typeof v === 'string' && TEXT_LISTS.has(leaf)) return [v];
  return v;
}

function setPath(o: Record<string, unknown>, keys: string[], v: unknown, op: string) {
  let cur = o;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] === undefined) cur[k] = {};
    if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) fail('E_ARG', `${op}: "${keys.join('.')}" sets inside "${k}", which already has a value.`, 'give each field once.');
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys.at(-1)!;
  if (last in cur) fail('E_ARG', `${op}: "${keys.join('.')}" is given twice.`, 'give each field once (k=v).');
  cur[last] = v;
}

/** `<op> [bare] [k=v ...]` → an op object. Dotted keys nest (budget.cpuMin=10, add.tone=fast). */
export function boardKv(op: string, words: string[]): BoardOp {
  if (!OP_NAMES.includes(op as never)) {
    const dym = suggest(op, OP_NAMES);
    fail('E_UNKNOWN_OP', `"${op}" is not a board op.`, dym.length ? `did you mean "${dym[0]}"? (e.g. mgl board edit <file> ${OP_EXAMPLES[dym[0]!]})` : `ops: ${OP_NAMES.join(', ')}.`, dym.length ? { didYouMean: dym } : {});
  }
  const cmd: Record<string, unknown> = { op };
  const [nestKey, top] = NEST[op] ?? [undefined, []];
  const bare: string[] = [];
  for (const w of words) {
    const eq = w.indexOf('=');
    if (eq <= 0) { bare.push(w); continue; }
    const k = w.slice(0, eq);
    if (k === 'op') fail('E_ARG', '"op" cannot be set with k=v.', `the op is the word after the file: mgl board edit <file> ${op} ...`);
    let v = kvValue(k, w.slice(eq + 1));
    const keys = k.split('.');
    if ((keys[0] === 'add' || keys[0] === 'remove') && op === 'brief.set' && typeof v === 'string') v = [v];
    if (nestKey && !top.includes(keys[0]!) && keys[0] !== nestKey && keys[0] !== 'by') setPath(cmd, [nestKey, ...keys], v, op);
    else setPath(cmd, keys, v, op);
  }
  if (bare.length) {
    const prim = PRIMARY[op]!;
    if (bare.length > 1) fail('E_ARG', `${op}: only one bare word is allowed (it fills "${prim}"); got ${bare.map((b) => `"${b}"`).join(', ')}.`, 'write the other values as k=v; quote text with spaces: text="Hello there".');
    const v = kvValue(prim, bare[0]!);
    if (nestKey && prim === 'type') setPath(cmd, [nestKey, 'type'], v, op);
    else setPath(cmd, [prim], v, op);
  }
  if (nestKey && cmd[nestKey] === undefined) cmd[nestKey] = {};
  return cmd as unknown as BoardOp;
}

/** Ops that need the linked project's outline. */
const needsOutline = (ops: BoardOp[]) => ops.some((x) => {
  const r = x as unknown as Record<string, unknown>;
  return r.op === 'still.add' || r.op === 'storyboard.make' || (r.op === 'shape.add' && (r.shape as { type?: string } | undefined)?.type === 'still') || (r.op === 'shape.set' && r.props && typeof r.props === 'object' && ('t' in r.props || 'comp' in r.props));
});

async function edit(a: Args, o: Out) {
  const { boardPath, projectPath } = fileArg(a, "mgl board edit video.mgl.json say \"hello\" | '<json>' | --batch f.jsonl | undo | redo");
  const [, op, ...rest] = a.pos;
  const by = who(a);
  const dryRun = bool(a, 'dry-run');
  const batch = str(a, 'batch');
  const srv = dryRun ? null : await server(boardPath);
  if (op === 'undo' || op === 'redo') {
    const n = rest[0] === undefined ? 1 : Number(rest[0]);
    if (!Number.isInteger(n) || n < 1) fail('E_ARG', `${op} takes a number of steps, got "${rest[0]}".`, `mgl board edit ${a.pos[0]} ${op} 2`);
    const before = (await readBoard(boardPath)).board;
    const so = { by, force: bool(a, 'force') };
    const r = srv ? await http<{ summary?: string[]; changed?: string[]; version: number }>(srv.url, `/api/${op}`, { n, ...so }) : await (await BoardSession.open(boardPath))[op](n, so);
    const after = (await readBoard(boardPath)).board;
    o.line(...(r.summary?.length ? r.summary : [`${op} done`]));
    changeLines(o, before, after, [], r.changed ?? [], boardPath);
    o.set({ file: boardPath, summary: r.summary ?? [], changed: r.changed ?? [], version: r.version, server: srv?.url ?? null });
    return;
  }
  if (op === 'history') {
    const s = await BoardSession.open(boardPath);
    const h = s.historyStatus();
    const step = (i: number, x: HistoryStep) => `  ${i + 1}. ${x.by === 'human' ? 'person' : 'agent'}: ${clip(x.summary, 140)}`;
    o.line(`undo: ${h.undo.length} step${h.undo.length === 1 ? '' : 's'}${h.undo.length ? ' (newest first; undo takes back your own latest step)' : ' (hand edits are not recorded)'}`);
    for (const [i, x] of h.undoSteps.slice(0, 12).entries()) o.line(step(i, x));
    if (h.undo.length > 12) o.line(`  … ${h.undo.length - 12} more (--json)`);
    o.line(`redo: ${h.redo.length} step${h.redo.length === 1 ? '' : 's'}`);
    for (const [i, x] of h.redoSteps.slice(0, 6).entries()) o.line(step(i, x));
    if (h.redo.length > 6) o.line(`  … ${h.redo.length - 6} more (--json)`);
    o.set({ file: boardPath, ...h });
    return;
  }
  let ops: BoardOp[];
  if (batch) {
    if (op) fail('E_USAGE', 'give either --batch or an op, not both.', `mgl board edit ${a.pos[0]} --batch ops.jsonl`);
    let text: string;
    try { text = readFileSync(batch, 'utf8'); } catch { return fail('E_NO_FILE', `${batch} does not exist.`, 'give a .json (list of ops) or .jsonl (one op per line) file.'); }
    ops = jsonCommands(text, batch) as unknown as BoardOp[];
  } else if (!op) {
    return fail('E_USAGE', 'edit needs an op after the file.', `e.g. mgl board edit ${a.pos[0]} ${OP_EXAMPLES['shape.add']} (ops: ${OP_NAMES.join(', ')}; or undo, redo, history)`);
  } else if (/^\s*[[{]/.test(op)) {
    if (rest.length) fail('E_USAGE', 'a JSON op takes no further words.', `put every field inside the JSON: mgl board edit ${a.pos[0]} '{"op": "say", "text": "hello"}'`);
    ops = jsonCommands(op, 'the JSON op') as unknown as BoardOp[];
  } else ops = [boardKv(op, rest)];
  ops.forEach((x) => parseOp(x)); // fail fast with the op's own message, before any server round trip
  await applyAndReport(o, { boardPath, ...(projectPath ? { projectPath } : {}) }, ops, by, { dryRun, srv });
}

/** Apply ops through the server (when it runs) or the file, then print what changed. */
async function applyAndReport(o: Out, f: { boardPath: string; projectPath?: string }, ops: BoardOp[], by: Who, opts: { dryRun?: boolean; srv?: { url: string } | null }) {
  const before = (await readBoard(f.boardPath)).board;
  let r: Pick<ApplyResult, 'changed' | 'created' | 'version'> & { board: BoardFile };
  if (opts.srv) {
    const res = await http<{ version: number; changed: string[]; created?: string[] }>(opts.srv.url, '/api/ops', { ops, by });
    const st = await http<BoardState>(opts.srv.url, '/api/state');
    r = { changed: res.changed, created: res.created ?? [], version: res.version, board: st.board };
  } else {
    const s = await BoardSession.open(f.boardPath);
    const { outline, error } = needsOutline(ops) ? await outlineFor(f.boardPath, s.board, f.projectPath) : { outline: null };
    try { r = await s.apply(ops, by, outline, { dryRun: !!opts.dryRun }); } catch (e) {
      if (e instanceof MglError && e.code === 'E_NO_PROJECT' && error) { e.message += ` The project did not load: ${error.message}`; e.fix = error.fix; }
      throw e;
    }
  }
  const summary = ops.map((x) => (x as { op: string }).op);
  o.line(`${opts.dryRun ? 'would apply' : 'applied'} ${ops.length} op${ops.length === 1 ? '' : 's'} (${[...new Set(summary)].join(', ')})${opts.srv ? ` via ${opts.srv.url}` : ''}${r.changed.length ? '' : ': nothing changed'}`);
  changeLines(o, before, r.board, r.created, r.changed, f.boardPath);
  if (opts.dryRun) o.line('dry run: nothing written');
  const tip = advise(r.board, null)[0];
  if (tip) o.hint(`next: ${tip.level}: ${clip(tip.text, 180)}`);
  o.set({ file: f.boardPath, dryRun: !!opts.dryRun, version: r.version, changed: r.changed, created: r.created, server: opts.srv?.url ?? null });
}

type Entity = { table: 'shapes' | 'rounds' | 'log' | 'spend'; e: { id: string } };
function findEntity(b: BoardFile, id: string): Entity | undefined {
  for (const table of ['shapes', 'rounds', 'log', 'spend'] as const) {
    const e = ((b[table] ?? []) as { id: string }[]).find((x) => x.id === id);
    if (e) return { table, e };
  }
  return undefined;
}

/** "L7 + {...}" per created / changed / removed entity (options show through their round). */
function changeLines(o: Out, before: BoardFile, after: BoardFile, created: string[], changed: string[], file: string) {
  const text = formatBoard(after).split('\n');
  const lineOf = (id: string) => { const i = text.findIndex((l) => l.startsWith(`{"id": ${JSON.stringify(id)},`)); return i < 0 ? '   ' : `L${i + 1}`; };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...created, ...changed.filter((x) => !created.includes(x))]) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === 'brief') { out.push(`  ${'L' + (text.findIndex((l) => l.startsWith('"brief"')) + 1)} ~ brief: ${clip(formatBrief(after.brief ?? {}), 150)}`); continue; }
    const now = findEntity(after, id), was = findEntity(before, id);
    if (now) out.push(`  ${lineOf(id)} ${was ? '~' : '+'} ${clip(entityLine(now.table, now.e), 150)}`);
    else if (was) out.push(`      - ${clip(entityLine(was.table, was.e), 150)}`);
  }
  o.line(...out.slice(0, CHANGE_LINES));
  if (out.length > CHANGE_LINES) o.line(`  … ${out.length - CHANGE_LINES} more changed lines (mgl board show ${file} --json)`);
}

// ------------------------------------------------------------------ view / focus / say

async function view(a: Args, o: Out) {
  const { boardPath } = fileArg(a, 'mgl board view video.mgl.json');
  const srv = await server(boardPath);
  if (!srv) fail('E_NO_SERVER', `no board server is running for ${boardPath}, so there is no page to look at.`, 'start one: mgl board serve <file> (in the background)');
  const st = await http<BoardState>(srv.url, '/api/state');
  const shapes = st.board.shapes ?? [];
  const lines: string[] = [`board ${boardPath} · ${srv.url} · version ${st.version}`];
  for (const w of ['human', 'ai'] as const) {
    const p = st.view?.[w];
    if (!p) { lines.push(`${w === 'human' ? 'person' : 'agent'}: no presence yet${w === 'human' ? ' (no page open?)' : ''}`); continue; }
    const cam = p.camera ? `camera ${Math.round(p.camera.x)},${Math.round(p.camera.y)} zoom ${p.camera.zoom.toFixed(2)}` : 'no camera';
    lines.push(`${w === 'human' ? 'person' : 'agent'}: ${cam}${p.cursor ? ` · cursor ${Math.round(p.cursor[0])},${Math.round(p.cursor[1])}` : ''}${p.selection?.length ? ` · selected ${list(p.selection, 60)}` : ' · nothing selected'}${p.at ? ` · ${Math.round((Date.now() - p.at) / 1000)} s ago` : ''}`);
  }
  const h = st.view?.human;
  const inView = h?.inView ? shapes.filter((s) => h.inView!.includes(s.id)) : [];
  if (h?.inView) {
    lines.push(`in view: ${inView.length} shape${inView.length === 1 ? '' : 's'}`);
    for (const s of inView.slice(0, 20)) lines.push(`  ${clip(entityLine('shapes', s), 150)}`);
    if (inView.length > 20) lines.push(`  … ${inView.length - 20} more`);
  }
  const log = (st.board.log ?? []).slice(-5);
  if (log.length) lines.push('log:', ...log.map((m) => `  ${m.id} ${m.by}: ${q(m.text, 120)}`));
  o.line(...lines);
  o.set({ file: boardPath, server: srv.url, version: st.version, view: st.view, inView: inView.map((s) => s.id), log });
}

async function focus(a: Args, o: Out) {
  const { boardPath } = fileArg(a, 'mgl board focus video.mgl.json s1 s2');
  const ids = a.pos.slice(1).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  if (!ids.length) fail('E_USAGE', 'focus needs shape ids.', `mgl board focus ${a.pos[0]} s1 s2`);
  const srv = await server(boardPath);
  if (!srv) fail('E_NO_SERVER', `no board server is running for ${boardPath}, so no page can be focused.`, 'start one: mgl board serve <file> (in the background)');
  const r = await http<{ pages?: number }>(srv.url, '/api/focus', { ids });
  o.line(`focused ${r.pages ?? 0} open page${r.pages === 1 ? '' : 's'} on ${ids.join(', ')}`);
  if (!r.pages) o.hint(`no page is open: send the person ${srv.url}`);
  o.set({ file: boardPath, server: srv.url, ids, pages: r.pages ?? 0 });
}

async function say(a: Args, o: Out) {
  const { boardPath, projectPath } = fileArg(a, 'mgl board say video.mgl.json "Two options are up"');
  const text = a.pos.slice(1).join(' ').trim();
  if (!text) fail('E_USAGE', 'say needs the text.', `mgl board say ${a.pos[0]} "Two options are up in round r2"`);
  const srv = await server(boardPath);
  await applyAndReport(o, { boardPath, ...(projectPath ? { projectPath } : {}) }, [{ op: 'say', text }], who(a), { srv });
}

// ------------------------------------------------------------------ snapshot / render

async function snapshot(a: Args, o: Out) {
  const { arg } = fileArg(a, 'mgl board snapshot video.mgl.json [-o board.png] [--frame id] [--ids a,b]');
  const out = str(a, 'out'), frame = str(a, 'frame'), ids = str(a, 'ids');
  const r = await (await serverMod()).snapshotBoard(arg, { ...(out ? { out } : {}), ...(frame ? { frame } : {}), ...(ids ? { ids: ids.split(',').map((x) => x.trim()).filter(Boolean) } : {}) });
  o.line(`${r.path} (${r.width}x${r.height}, ${Math.round(r.ms)} ms)`);
  for (const w of (r as { warnings?: string[] }).warnings ?? []) o.line(`warn: ${clip(w, 160)}`);
  o.hint('look at it with your image viewer');
  o.set({ ...r });
}

async function exportPage(a: Args, o: Out) {
  const { arg } = fileArg(a, 'mgl board export video.mgl.json [-o board.html]');
  const out = str(a, 'out');
  const r = await (await serverMod()).exportBoard(arg, out ? { out } : {});
  o.line(`${r.path} (${Math.round(r.bytes / 1024)} KB: ${r.modules} modules, ${r.stills} still${r.stills === 1 ? '' : 's'}, ${r.images} image${r.images === 1 ? '' : 's'}, ${Math.round(r.ms)} ms)`);
  for (const w of r.warnings ?? []) o.line(`warn: ${clip(w, 160)}`);
  o.hint(`open it from disk or publish it; edits there are queued: the person clicks "Copy changes", then mgl board edit ${arg} --batch changes.jsonl --by human`);
  o.set({ ...r });
}

async function render(a: Args, o: Out) {
  const { boardPath, arg } = fileArg(a, 'mgl board render video.mgl.json --level 1..4 [--ids s1,s2] [--range a-b] [--dry-run] [--force]');
  const lv = str(a, 'level');
  const level = Number(lv);
  if (lv === undefined || ![1, 2, 3, 4].includes(level)) fail('E_LEVEL', lv === undefined ? 'render needs --level.' : `--level ${lv} is not a render level.`, '--level 1 (stills), 2 (sheet), 3 (draft) or 4 (final); level 0 is the board itself.');
  const force = bool(a, 'force'), dryRun = bool(a, 'dry-run');
  const b = (await readBoard(boardPath)).board;
  const missing = briefMissing(b).filter((x) => x !== 'audience');
  if (level >= 3 && missing.length && !force && !dryRun) fail('E_BRIEF', `a ${LEVELS[level]} render needs the brief's ${missing.join(' and ')} first (they say what a good result is).`, `agree them with the person: mgl board edit ${arg} brief.set goal="..." success="..." (or --force)`);
  const maxLevel = b.brief?.budget?.maxLevel;
  if (maxLevel !== undefined && level > maxLevel && !force && !dryRun) fail('E_BUDGET', `level ${level} (${LEVELS[level]}) is above the brief's budget.maxLevel ${maxLevel} (${LEVELS[maxLevel]}).`, `agree it with the person first (brief.set budget.maxLevel=${level}), or --force.`);
  const gap = ladderGap(b, level);
  if (gap) o.line(`warn: ${gap}`);
  const ids = str(a, 'ids')?.split(',').map((x) => x.trim()).filter(Boolean);
  const range = str(a, 'range');
  const by = who(a);
  const srv = await server(boardPath);
  const mod = await serverMod();
  // the price first: --dry-run stops here; 3/4 are checked against the budget left
  const budget = b.brief?.budget?.cpuMin;
  const left = budget === undefined ? undefined : budget * 60 - spentMs(b) / 1000;
  const priced = dryRun || (level >= 3 && left !== undefined);
  const est = priced ? await mod.estimateLevel(arg, { level: level as 1 | 2 | 3 | 4, ...(ids?.length ? { ids } : {}), ...(range ? { range } : {}) }) : undefined;
  const vsBudget = est && budget !== undefined ? `${Math.round((est.seconds / 60 / Math.max(budget, 1e-9)) * 100)} % of the ${budget} render min budget (${secondsText(Math.max(0, left!))} left)` : undefined;
  if (dryRun) {
    o.line(`dry run: level ${level} (${LEVELS[level]}) ${est!.note}`);
    if (vsBudget) o.line(`  that is ${vsBudget}`);
    if (maxLevel !== undefined && level > maxLevel) o.line(`  above the brief's budget.maxLevel ${maxLevel}: agree it with the person first`);
    if (level >= 3 && missing.length) o.line(`  the brief lacks ${missing.join(' and ')}: agree them before a ${LEVELS[level]} render`);
    o.line('nothing rendered, no spend recorded');
    o.hint(`tell the person what it costs and why, then: mgl board render ${arg} --level ${level}${ids?.length ? ` --ids ${ids.join(',')}` : ''}${range ? ` --range ${range}` : ''}`);
    o.set({ file: boardPath, level, dryRun: true, estimate: est, budgetMin: budget ?? null, leftSeconds: left ?? null, files: [], spend: [], ...(gap ? { warning: gap } : {}) });
    return;
  }
  if (est && left !== undefined && est.seconds > left && !force) fail('E_BUDGET', `the ${LEVELS[level]} render is estimated at ${secondsText(est.seconds)}, over the ${secondsText(Math.max(0, left))} left of the ${budget} render min budget.`, `agree a bigger budget with the person (brief.set budget.cpuMin=...), render a range (--range 0-5s), or --force.`);
  // spend rows and result shapes go through the running server (single writer) when there is one
  const record = srv ? async (e: { level: 0 | 1 | 2 | 3 | 4; what: string; ms: number }, w: Who) => {
    const live = await http<BoardState>(srv.url, '/api/state');
    const round = mod.currentRound(live.board);
    const res = await http<{ created?: string[] }>(srv.url, '/api/ops', { ops: [{ op: 'spend.add', level: e.level, what: e.what, ms: Math.round(e.ms), ...(round ? { round } : {}) }], by: w });
    return { id: res.created?.[0] ?? '', level: e.level, what: e.what, ms: Math.round(e.ms), ...(round ? { round } : {}) };
  } : undefined;
  const addShape = srv ? async (shape: Record<string, unknown>, w: Who) => (await http<{ created?: string[] }>(srv.url, '/api/ops', { ops: [{ op: 'shape.add', shape }], by: w })).created?.[0] ?? '' : undefined;
  const r = await mod.renderLevel(arg, {
    level: level as 1 | 2 | 3 | 4, by, ...(ids?.length ? { ids } : {}), ...(range ? { range } : {}), ...(record ? { record } : {}), ...(addShape ? { addShape } : {}),
    onEstimate: (e) => { o.line(e.note + (e.seconds > 120 ? '  (over 2 min: run this in the background)' : '')); o.flush(); },
  });
  o.line(`level ${level} (${LEVELS[level]}): ${r.files.length} file${r.files.length === 1 ? '' : 's'} in ${secondsText(r.ms / 1000)}${r.cached ? ` (${r.cached} from cache)` : ''}`);
  if (r.summary) o.line(`  QA: ${r.summary.findings} finding${r.summary.findings === 1 ? '' : 's'}${r.summary.errors ? ` (${r.summary.errors} error${r.summary.errors === 1 ? '' : 's'})` : ''}${r.summary.lufs !== undefined ? ` · ${Math.round(r.summary.lufs)} LUFS` : ''} · ${r.summary.frames} frames`);
  for (const f of r.files.slice(0, 12)) o.line(`  ${f}`);
  if (r.files.length > 12) o.line(`  … ${r.files.length - 12} more`);
  if (r.shape) o.line(`on the board: ${r.shape}${level >= 3 && srv ? ` · watch: ${srv.url}/files/renders/${path.basename(r.files[0] ?? '')}` : ''}`);
  for (const sp of r.spend) o.line(`spend ${sp.id}: L${sp.level} ${sp.what} ${secondsText(sp.ms / 1000)}${sp.round ? ` (round ${sp.round})` : ''}`);
  // the footer is the advice for the board as it is now, not a fixed line
  const after = (await readBoard(boardPath)).board;
  const tip = advise(after, null)[0];
  if (tip) o.hint(`next: ${tip.level}: ${clip(tip.text, 180)}`);
  o.set({ file: boardPath, level, files: r.files, ms: r.ms, spend: r.spend, ...(r.shape ? { shape: r.shape } : {}), ...(r.summary ? { summary: r.summary } : {}), ...(r.estimate ? { estimate: r.estimate } : {}), ...(gap ? { warning: gap } : {}) });
}
