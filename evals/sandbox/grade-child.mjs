// Runs one grader in a child process (so a crashing or hanging grader cannot take the runner down).
// Usage: node grade-child.mjs <grade.mjs> <dir>  → prints "MGL_GRADE <json>" on the last line.
import { pathToFileURL } from 'node:url';

const [gradePath, dir] = process.argv.slice(2);
try {
  const { grade } = await import(pathToFileURL(gradePath).href);
  const r = await grade(dir);
  process.stdout.write(`\nMGL_GRADE ${JSON.stringify(r)}\n`);
} catch (e) {
  process.stdout.write(`\nMGL_GRADE ${JSON.stringify({ pass: false, score: 0, checks: [{ name: 'grader ran', pass: false, detail: String(e?.stack ?? e).slice(0, 1500) }] })}\n`);
}
