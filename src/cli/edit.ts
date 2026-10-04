/** `mgl edit`: apply commands (k=v, JSON, or a batch file), undo / redo / history; and `mgl check`. */
import { readFileSync } from 'node:fs';
import { fail, type MglErrorInfo } from '../core/errors.js';
import { entityLine } from '../core/format.js';
import type { Problem } from '../core/load.js';
import type { Command } from '../core/commands/registry.js';
import type { TableName } from '../core/schema/index.js';
import { Project, type EditResult } from '../sdk/project.js';
import { open, parsePlatforms, qaModule, withPluginProblems } from '../sdk/index.js';
import { MAX_LINES, bool, clip, str, type Args, type Out } from './io.js';
import { jsonCommands, kvCommand } from './kv.js';

const CHANGE_LINES = 10;

export async function edit(a: Args, o: Out) {
  const [file, op, ...rest] = a.pos;
  if (!file) fail('E_USAGE', 'edit needs a file and a command.', 'mgl edit video.mgl.json clip.add text="Hello" len=2s');
  const batch = str(a, 'batch');
  if (op === 'undo' || op === 'redo') {
    const n = rest[0] === undefined ? 1 : Number(rest[0]);
    if (!Number.isInteger(n) || n < 1) fail('E_ARG', `${op} takes a number of steps, got "${rest[0]}".`, `mgl edit ${file} ${op} 2`);
    const p = await Project.open(file);
    return report(await p[op](n), o, file);
  }
  if (op === 'history') {
    const p = await Project.open(file);
    const h = p.historyStatus();
    o.line(`undo: ${h.undo.length} step${h.undo.length === 1 ? '' : 's'}${h.undo.length ? '' : ' (hand edits are not recorded)'}`);
    for (const [i, s] of h.undo.slice(0, 12).entries()) o.line(`  ${i + 1}. ${clip(s, 150)}`);
    o.line(`redo: ${h.redo.length} step${h.redo.length === 1 ? '' : 's'}`);
    for (const [i, s] of h.redo.slice(0, 6).entries()) o.line(`  ${i + 1}. ${clip(s, 150)}`);
    o.set(h);
    return;
  }
  let cmds: Command[] | undefined;
  if (batch) {
    if (op) fail('E_USAGE', 'give either --batch or a command, not both.', `mgl edit ${file} --batch edits.jsonl`);
    let text: string;
    try { text = readFileSync(batch, 'utf8'); } catch { return fail('E_NO_FILE', `${batch} does not exist.`, 'give the path of a .json (array of commands) or .jsonl (one command per line) file.'); }
    cmds = jsonCommands(text, batch);
  } else if (!op) {
    return fail('E_USAGE', 'edit needs a command after the file.', `e.g. mgl edit ${file} clip.add text="Hello" len=2s (commands: mgl docs commands)`);
  } else if (/^\s*[[{]/.test(op)) {
    if (rest.length) fail('E_USAGE', 'a JSON command takes no further words.', `put every field inside the JSON: mgl edit ${file} '{"op": "clip.split", "id": "shot1", "at": "2s"}'`);
    cmds = jsonCommands(op, 'the JSON command');
  }
  // open first: the project's plugins register their commands (k=v parsing needs the op's schema)
  const p = await open(file);
  if (!cmds) {
    try { cmds = [kvCommand(op, rest)]; } catch (e) { throw withPluginProblems(e, p.pluginProblems); }
  }
  const r = await p.edit(cmds, { dryRun: bool(a, 'dry-run') });
  report(r, o, file);
}

function report(r: EditResult, o: Out, file: string) {
  const lines: string[] = [];
  lines.push(...(r.summary.length ? r.summary : ['nothing changed.']));
  for (const n of r.notes) lines.push(`note: ${n}`);
  const changes = r.changes.map((c) => {
    const mark = c.kind === 'add' ? '+' : c.kind === 'remove' ? '-' : '~';
    let text = c.text;
    if (c.kind === 'remove') {
      const before = r.patch.find((x) => x.table === c.table && x.id === c.id)?.before;
      text = before && c.table !== 'project' ? entityLine(c.table as TableName, before as object) : `${c.table} "${c.id}"`;
    }
    return `  ${c.line ? `L${c.line}` : '   '} ${mark} ${clip((text ?? `${c.table} "${c.id}"`).replace(/,$/, ''), 150)}`;
  });
  lines.push(...changes.slice(0, CHANGE_LINES));
  if (changes.length > CHANGE_LINES) lines.push(`  … ${changes.length - CHANGE_LINES} more changed lines (re-read the file or mgl show ${file})`);
  if (r.issues.length) {
    lines.push(`${r.issues.length} render-blocking issue${r.issues.length > 1 ? 's' : ''} remain:`);
    for (const i of r.issues.slice(0, 3)) lines.push(`  ${i.code}: ${clip(i.message, 150)}`, `    fix: ${clip(i.fix, 150)}`);
  }
  if (r.dryRun) lines.push('dry run: nothing written');
  o.line(...lines);
  if (!r.dryRun && r.patch.length) o.hint(`re-read the changed lines before editing ${file} by hand`);
  o.set({ file, dryRun: r.dryRun, summary: r.summary, notes: r.notes, changes: r.changes, out: r.out, issues: r.issues.map(info) });
}

function info(p: Problem): MglErrorInfo & { severity: string } {
  const { renderOnly: _r, ...rest } = p;
  return rest;
}

/** `mgl check`: load problems + QA findings that need no pixels. */
export async function check(a: Args, o: Out) {
  const file = a.pos[0];
  if (!file) fail('E_USAGE', 'check needs a file.', 'mgl check video.mgl.json');
  let p;
  try { p = await open(file); } catch (e) {
    const err = e as MglErrorInfo & { problems?: MglErrorInfo[]; code: string };
    if (!err || typeof err.code !== 'string' || err.code === 'E_NO_FILE') throw e;
    const problems = err.problems?.length ? err.problems : [err];
    o.line(`${file}: ${problems.length} error${problems.length > 1 ? 's' : ''} (the file does not load; nothing else runs until they are fixed)`);
    for (const pr of problems.slice(0, 19)) o.line(`error ${pr.code}: ${clip(pr.message, 200)}`, `  fix: ${clip(pr.fix, 200)}`);
    o.exit = 1;
    o.set({ file, issues: problems.length, errors: problems.length, problems: problems.map((x) => ({ severity: 'error', ...x })) });
    return;
  }
  const platform = str(a, 'platform');
  const rep = await p.check({ displayFile: file, ...(platform ? { platforms: parsePlatforms(platform) } : {}), ...(bool(a, 'alpha') ? { alpha: true } : {}) });
  const strict = bool(a, 'strict');
  const lines: string[] = [];
  const errs = rep.problems.filter((x) => x.severity === 'error');
  const warns = rep.problems.filter((x) => x.severity === 'warning');
  for (const x of [...errs, ...warns]) lines.push(`${x.severity === 'error' ? 'error' : 'warn'} ${x.code}: ${clip(x.message, 200)}`, `  fix: ${clip(x.fix, 200)}`);
  const qa = await qaModule();
  if (rep.findings.length) {
    if (qa?.formatFindings) lines.push(...(qa.formatFindings(rep.findings, { file, lineOf: (id: string) => p.line('clips', id) }) as string[]));
    else for (const f of rep.findings) lines.push(`${f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warn' : 'info'} ${f.rule}: ${clip(f.message, 180)}${f.fix ? `  fix: ${f.fix.replace(/<file>/g, file)}` : ''}`);
  }
  const issues = rep.problems.length + rep.findings.length;
  const pfNote = platform ? ` [platforms: ${parsePlatforms(platform).join(', ')}]` : '';
  const head = (issues ? `${file}: ${errs.length} error${errs.length === 1 ? '' : 's'}, ${warns.length} warning${warns.length === 1 ? '' : 's'}, ${rep.findings.length} QA finding${rep.findings.length === 1 ? '' : 's'}` : `${file}: ok (no problems${qa ? ', no QA findings' : ''})`) + pfNote;
  o.line(head, ...lines.slice(0, MAX_LINES - 2));
  if (lines.length > MAX_LINES - 2) o.line(`… ${lines.length - (MAX_LINES - 2)} more lines (use --json)`);
  if (strict && rep.errors > 0) o.exit = 1;
  o.set({ file, issues, errors: rep.errors, problems: rep.problems.map(info), findings: rep.findings });
}
