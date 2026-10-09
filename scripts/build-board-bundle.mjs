// Build step: bundle the board page (src/board/client/main.ts and what it imports) into one classic script,
// dist/board/board.bundle.js (IIFE, es2022, not minified). `mgl board export` inlines it, so an exported page runs
// under a CSP that allows inline scripts only (no data:/blob: scripts, no import maps of data: URLs), and the served
// page loads it as one same-origin file. esbuild is a devDependency: the package ships the bundle, not esbuild.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const entry = fileURLToPath(new URL('../src/board/client/main.ts', import.meta.url));
const out = fileURLToPath(new URL('../dist/board/board.bundle.js', import.meta.url));
let esbuild;
try { esbuild = await import('esbuild'); } catch {
  console.error('esbuild is missing. fix: npm install (it is a devDependency).');
  process.exit(1);
}
// keep in step with boardBundle() in src/board/server/assets.ts (the dev path, run from source)
const r = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', target: 'es2022', platform: 'browser', charset: 'utf8', legalComments: 'none', write: false });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, r.outputFiles[0].text);
console.log(`dist/board/board.bundle.js (${Math.round(r.outputFiles[0].contents.length / 1024)} KB)`);
