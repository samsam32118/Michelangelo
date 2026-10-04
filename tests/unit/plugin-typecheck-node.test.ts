/** `mgl plugin test` without @types/node: unknown Node built-ins must not fail a plugin's type-check. */
import { describe, expect, it } from 'vitest';
import { filterDiagnostics } from '../../src/plugin/test-runner.js';

const DIR = '/work/plugins/voice';
// what tsc prints for a provider that loads Node built-ins lazily (`await import('node:path')`) with no @types/node
const TSC = [
  "src/index.ts(24,36): error TS2591: Cannot find name 'node:path'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.",
  "src/index.ts(29,34): error TS2591: Cannot find name 'node:child_process'. Do you need to install type definitions for node?",
  "src/index.ts(35,20): error TS7006: Parameter 'e' implicitly has an 'any' type.",
  "src/index.ts(40,9): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.",
  "src/index.ts(41,3): error TS2591: Cannot find name 'process'. Do you need to install type definitions for node?",
  "src/other.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/other.ts(9,20): error TS7006: Parameter 'x' implicitly has an 'any' type.",
  "../../node_modules/lib/x.ts(1,1): error TS2304: Cannot find name 'foo'.",
].join('\n');

describe('filterDiagnostics', () => {
  it('drops unknown Node built-ins (static and dynamic imports) and their implicit-any follow-ons without @types/node', () => {
    const r = filterDiagnostics(TSC, DIR, false);
    expect(r.kept).toEqual([
      "src/other.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/other.ts(9,20): error TS7006: Parameter 'x' implicitly has an 'any' type.",
    ]);
    expect(r.skippedNode).toBe(5);
    expect(r.outside).toBe(1);
  });
  it('keeps every diagnostic of the plugin when @types/node is installed', () => {
    const r = filterDiagnostics(TSC, DIR, true);
    expect(r.kept).toHaveLength(7);
    expect(r.skippedNode).toBe(0);
  });
});
