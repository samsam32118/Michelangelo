/**
 * The page's modules: GET /app/client/<name>.js and /app/shared/<name>.js. Compiled (dist/board/...) they are served as
 * they are; from source (this file is .ts, run by tsx or vitest) the .ts is transformed with esbuild, which tsx brings
 * in dev. Names are strictly [a-z0-9-]+.js under those two folders.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FROM_SOURCE = import.meta.url.endsWith('.ts');
const NAME = /^\/app\/(client|shared)\/([a-z0-9-]+)\.js$/;
const cache = new Map<string, { mtime: number; code: string }>();

/** The module's JavaScript, or undefined (bad name, missing file). Throws on a transform error. */
export async function appModule(urlPath: string): Promise<string | undefined> {
  const m = NAME.exec(urlPath);
  if (!m) return undefined;
  const file = fileURLToPath(new URL(`../${m[1]}/${m[2]}.${FROM_SOURCE ? 'ts' : 'js'}`, import.meta.url));
  if (!existsSync(file)) return undefined;
  const mtime = statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.code;
  let code = readFileSync(file, 'utf8');
  if (FROM_SOURCE) {
    const name = 'esbuild'; // dev only (comes with tsx); not a package dependency
    const esbuild = (await import(name)) as { transform(src: string, o: Record<string, unknown>): Promise<{ code: string }> };
    code = (await esbuild.transform(code, { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: file, sourcemap: 'inline' })).code;
  }
  cache.set(file, { mtime, code });
  return code;
}

/** The page HTML from src/board/client/page.ts (pageHtml), or a placeholder while the page module is absent. */
export async function pageHtml(): Promise<string> {
  try {
    const mod = (await import('../client/page.js')) as { pageHtml?: () => string };
    if (typeof mod.pageHtml === 'function') return mod.pageHtml();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ERR_MODULE_NOT_FOUND') throw e;
  }
  return PLACEHOLDER;
}

const PLACEHOLDER = `<!doctype html><html><head><meta charset="utf-8"><title>Michelangelo board</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font:15px/1.5 system-ui,sans-serif;margin:40px;color:#222;background:#fff">
<h1 style="font-size:20px">Michelangelo board</h1>
<p>The page is not built in this checkout. The board works without it: <code>mgl board show</code>, <code>edit</code>, <code>snapshot</code>.</p>
<p>API: <a href="/api/state">/api/state</a> · events at <code>/api/events</code> · ops by <code>POST /api/ops</code>.</p>
<pre id="s"></pre><script>fetch('/api/state').then(r=>r.json()).then(j=>{document.getElementById('s').textContent=JSON.stringify(j.board,null,1)})</script>
</body></html>`;
