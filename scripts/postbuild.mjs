// After tsc: make the CLI entry executable (bin: mgl, michelangelo). JSON imported by src (ffmpeg-builds.json) is emitted by tsc.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
if (!existsSync(main)) {
  console.error('dist/cli/main.js is missing. fix: run "npm run build" (tsc -p tsconfig.build.json) first.');
  process.exit(1);
}
const text = readFileSync(main, 'utf8');
if (!text.startsWith('#!')) writeFileSync(main, '#!/usr/bin/env node\n' + text);
chmodSync(main, 0o755);
console.log('dist/cli/main.js is executable');
