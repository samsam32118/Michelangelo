/** Board files: which file a CLI argument means, line-aware loading, atomic saving. */
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseTree, findNodeAtLocation, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import { MglError, fail } from '../../core/errors.js';
import { BOARD_FORMAT, type BoardFile } from '../shared/types.js';
import { validateBoard } from './schema.js';
import { formatBoard } from './format.js';

/** project.mgl.json → project.board.json next to it; a board file (or any other .json) as-is. */
export function resolveBoardPath(arg: string): { boardPath: string; projectPath?: string } {
  if (!arg) fail('E_USAGE', 'a board needs a file.', 'give the project (video.mgl.json) or the board (video.board.json).');
  if (arg.endsWith('.mgl.json')) return { boardPath: arg.replace(/\.mgl\.json$/, '.board.json'), projectPath: arg };
  if (arg.endsWith('.board.json')) {
    const proj = arg.replace(/\.board\.json$/, '.mgl.json');
    return existsSync(proj) ? { boardPath: arg, projectPath: proj } : { boardPath: arg };
  }
  if (!arg.endsWith('.json')) fail('E_USAGE', `"${arg}" is not a board or project file.`, `give video.mgl.json or video.board.json.`);
  return { boardPath: arg };
}

function lineIndex(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

function nodeValue(n: Node): unknown {
  if (n.type === 'object') {
    const o: Record<string, unknown> = {};
    for (const p of n.children ?? []) { const [k, v] = p.children ?? []; if (k && v) o[k.value as string] = nodeValue(v); }
    return o;
  }
  if (n.type === 'array') return (n.children ?? []).map(nodeValue);
  return n.value;
}

/** Parse and validate board text. Throws MglError with the line and a fix. */
export function parseBoardText(text: string): BoardFile {
  const errors: ParseError[] = [];
  const line = lineIndex(text);
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !tree) {
    const problems = errors.map((e) => {
      const code = printParseErrorCode(e.error), l = line(e.offset);
      return { code: 'E_JSON', line: l, message: `the board file is not valid JSON (${code}) at line ${l}.`,
        fix: code === 'CommaExpected' ? 'add a "," between the two entries (every entity line but the last in a table ends with ",").' : 'fix the JSON syntax on that line (quotes, commas, brackets).' };
    });
    if (!problems.length) problems.push({ code: 'E_JSON', line: 1, message: 'the board file is empty.', fix: `start with {"michelangeloBoard": ${BOARD_FORMAT}}.` });
    throw new MglError({ ...problems[0]!, problems });
  }
  const lineOf = (p: (string | number)[]) => {
    for (let n = p.length; n >= 0; n--) { const node = findNodeAtLocation(tree, p.slice(0, n)); if (node) return line(node.offset); }
    return undefined;
  };
  return validateBoard(nodeValue(tree), lineOf);
}

/** A new board for a project path (relative to the board's folder). */
export function emptyBoard(boardPath: string, projectPath?: string): BoardFile {
  const b: BoardFile = { michelangeloBoard: BOARD_FORMAT };
  if (projectPath) b.project = path.relative(path.dirname(path.resolve(boardPath)), path.resolve(projectPath)).split(path.sep).join('/');
  return b;
}

/** Load a board; a missing board is created in memory (not written) and linked to its project when one sits next to it. */
export async function loadBoard(boardPath: string): Promise<BoardFile> {
  return (await readBoard(boardPath)).board;
}

/** loadBoard plus the text read (null when the file does not exist). */
export async function readBoard(boardPath: string): Promise<{ board: BoardFile; text: string | null }> {
  let text: string;
  try { text = await readFile(boardPath, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const proj = boardPath.replace(/\.board\.json$/, '.mgl.json');
    return { board: emptyBoard(boardPath, proj !== boardPath && existsSync(proj) ? proj : undefined), text: null };
  }
  try { return { board: parseBoardText(text), text }; } catch (e) {
    if (e instanceof MglError) {
      const old = e.message;
      e.message = `${path.basename(boardPath)}: ${old}`;
      for (const p of e.problems ?? []) if (p.message === old) p.message = e.message;
    }
    throw e;
  }
}

/** Atomic write (tmp + rename). */
export async function saveBoard(boardPath: string, b: BoardFile, text?: string): Promise<void> {
  await mkdir(path.dirname(path.resolve(boardPath)), { recursive: true });
  const tmp = `${boardPath}.${process.pid}.tmp`;
  await writeFile(tmp, text ?? formatBoard(b));
  await rename(tmp, boardPath);
}
