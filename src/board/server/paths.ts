/** Where the board server keeps its caches and its discovery file: <board dir>/.mgl/board/. */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** <board dir>/.mgl/board */
export const boardCacheDir = (boardPath: string): string => join(dirname(resolve(boardPath)), '.mgl', 'board');
export const serverJsonPath = (boardPath: string): string => join(boardCacheDir(boardPath), 'server.json');

/** The project a board links to (absolute), from the board's `project` field. */
export function linkedProject(boardPath: string, project: string | undefined, fallback?: string): string | undefined {
  if (project) return resolve(dirname(resolve(boardPath)), project);
  return fallback ? resolve(fallback) : undefined;
}

/**
 * `rel` resolved under `root`, or undefined when it escapes it (.., absolute paths, NUL, symlinks pointing out).
 * The file need not exist; when it does, its real path must stay under the real root.
 */
export function safeJoin(root: string, rel: string): string | undefined {
  if (!rel || rel.includes('\0') || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return undefined;
  const abs = resolve(root, rel);
  const inside = (r: string, p: string) => { const d = relative(r, p); return !!d && !d.startsWith('..') && !isAbsolute(d) && !d.split(sep).includes('..'); };
  if (!inside(resolve(root), abs)) return undefined;
  if (existsSync(abs)) {
    try { if (!inside(realpathSync(root), realpathSync(abs))) return undefined; } catch { return undefined; }
  }
  return abs;
}

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.json': 'application/json', '.jsonl': 'application/json',
};
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
/** Content type for a served file (undefined: not servable). */
export const contentType = (p: string): string | undefined => TYPES[extname(p).toLowerCase()];
