/**
 * `mgl board export`: one self-contained HTML file (BOARD.md §8.1) for browser panes that cannot reach the server and
 * for Artifacts. The page is inlined as ONE classic script (the IIFE bundle, see boardBundle), because an Artifact's CSP
 * allows inline scripts but no data: or blob: scripts (an import map of data: URLs fails there). The board state is
 * embedded as window.MGL_EMBED (the page then runs detached) and stills / images as data URIs in MGL_EMBED_FILES.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fail } from '../../core/errors.js';
import type { BoardState, Outline, Shape } from '../shared/types.js';
import { advise, loadBoard, projectOutline, resolveBoardPath } from '../model/index.js';
import { boardBundle, pageHtml } from './assets.js';
import { contentType, IMAGE_EXT, linkedProject, safeJoin } from './paths.js';
import { renderStill, stillWidth, variantProject } from './render.js';

/** total bytes of embedded bitmaps; later ones are left out (the page shows placeholders) */
export const EXPORT_MAX_FILES = 8 << 20;

export interface ExportOptions { out?: string }
export interface ExportResult { path: string; bytes: number; /** scripts inlined (1: the bundle) */ modules: number; stills: number; images: number; ms: number; warnings?: string[] }

/**
 * Code safe inside a classic inline <script>: "</script" would end the element, "<!--" would switch the HTML parser to
 * the script-data-escaped state. The bundle is esbuild output, where both can only appear in strings, templates and
 * regexes, and "<\/" means "</" in all three.
 */
export function inlineScript(code: string): string {
  const out = code.replace(/\n\/\/# sourceMappingURL=\S*\s*$/, '\n').replace(/<\/(script)/gi, '<\\/$1');
  if (/<!--/.test(out)) fail('E_EXPORT', 'the board page script contains "<!--", which cannot be inlined safely.', 'this is a bug in the board page; report it.');
  return out;
}

/** JSON safe inside <script> */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export async function exportBoard(file: string, o: ExportOptions = {}): Promise<ExportResult> {
  const t0 = performance.now();
  const { boardPath, projectPath: given } = resolveBoardPath(file);
  const board = await loadBoard(boardPath);
  const warnings: string[] = [];
  const projectPath = linkedProject(boardPath, board.project, given);
  let outline: Outline | null = null;
  if (projectPath) { try { outline = await projectOutline(projectPath); } catch (e) { warnings.push(`project: ${(e as Error).message}`); } }

  // the page: one classic script
  const bundle = await boardBundle();
  if (bundle === undefined) fail('E_EXPORT', 'the board page bundle (dist/board/board.bundle.js) is missing from this install.', 'build the package (npm run build), or run mgl from a full checkout with its devDependencies (npm install).');

  // bitmaps
  const files: Record<string, string> = {};
  let bytes = 0, stills = 0, images = 0, dropped = 0;
  const add = (key: string, buf: Buffer, type: string) => {
    if (files[key]) return true;
    if (bytes + buf.length > EXPORT_MAX_FILES) { dropped++; return false; }
    files[key] = `data:${type};base64,${buf.toString('base64')}`;
    bytes += buf.length;
    return true;
  };
  const shapes: Shape[] = board.shapes ?? [];
  for (const s of shapes) {
    if (s.type === 'still' && projectPath && outline) {
      const comp = outline.comps.find((c) => c.id === (s.comp ?? outline!.main)) ?? outline.comps[0];
      try {
        const r = await renderStill(s.project ? variantProject(boardPath, s.project) : projectPath, { t: s.t, ...(s.comp ? { comp: s.comp } : {}), width: stillWidth(s.fidelity, comp?.size[0] ?? 1080) });
        if (add(`still:${s.t}|${s.comp ?? ''}|${s.fidelity ?? 'thumb'}${s.project ? `|${s.project}` : ''}`, readFileSync(r.path), 'image/png')) stills++;
      } catch (e) { warnings.push(`still ${s.id}: ${(e as Error).message}`); }
    } else if (s.type === 'image' && !/^(data:|https?:)/.test(s.src)) {
      const p = safeJoin(dirname(resolve(boardPath)), s.src);
      if (!p || !existsSync(p) || !IMAGE_EXT.has(extname(p).toLowerCase())) { warnings.push(`image ${s.id}: ${s.src} is not an image next to the board`); continue; }
      if (add(`image:${s.src}`, readFileSync(p), contentType(p) ?? 'image/png')) images++;
    }
  }
  if (dropped) warnings.push(`${dropped} bitmap(s) left out: the embedded files would pass ${EXPORT_MAX_FILES >> 20} MB (use thumb stills)`);

  const state: BoardState = { board, version: 1, project: outline, view: {}, advice: advise(board, outline) };
  const boot = `<script>window.MGL_EMBED=${scriptJson(state)};window.MGL_EMBED_FILES=${scriptJson(files)};</script>\n`
    + `<script>${inlineScript(bundle)}</script>`;
  const page = await pageHtml();
  const tag = '<script type="module" src="/app/client/main.js"></script>';
  if (!page.includes(tag)) fail('E_EXPORT', 'the board page has no module entry to replace.', 'rebuild the package (npm run build).');
  const html = page.replace(tag, () => boot);
  const out = resolve(o.out ?? resolve(boardPath).replace(/\.json$/, '') + '.html'); // video.board.json → video.board.html
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, html);
  renameSync(tmp, out);
  return { path: out, bytes: Buffer.byteLength(html), modules: 1, stills, images, ms: performance.now() - t0, ...(warnings.length ? { warnings } : {}) };
}
