/** Regression tests: shell-safe examples and fix lines, invalid JSON in k=v, whole guides in `mgl docs <topic>`. */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MglError } from '../../src/core/errors.js';
import { exampleLine, getCommand, listCommands } from '../../src/core/commands/index.js';
import { kvCommand } from '../../src/cli/kv.js';
import { shellExampleLine, shellQuote, shellSafeFix } from '../../src/cli/shell.js';
import { commandDoc } from '../../src/cli/docs.js';
import { withPluginProblems } from '../../src/sdk/index.js';
import { mgl } from './cli-fixtures.js';

/** Split a command line the way sh does (one argument per line, NUL-free examples). */
const shWords = (line: string): string[] => execFileSync('sh', ['-c', `set -- ${line}; for a in "$@"; do printf '%s\\0' "$a"; done`], { encoding: 'utf8' }).split('\0').slice(0, -1);

describe('shell-quoted examples', () => {
  it('quotes words with spaces, quotes, globs and leading #', () => {
    expect(shellQuote('clip')).toBe('clip');
    expect(shellQuote('Put your phone away')).toBe("'Put your phone away'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('#ffcc00')).toBe("'#ffcc00'");
    expect(shellWordsRoundTrip(["it's", '["c3","c4"]', 'a b', '#x', '*'])).toBe(true);
  });

  it('every command example survives a real shell and parses back to the example', () => {
    for (const def of listCommands()) {
      const line = shellExampleLine(def, 'v.mgl.json');
      const words = shWords(line);
      expect(words.slice(0, 4)).toEqual(['mgl', 'edit', 'v.mgl.json', def.op]);
      const cmd = kvCommand(def.op, words.slice(4));
      expect(cmd, line).toEqual({ op: def.op, ...JSON.parse(JSON.stringify(def.example)) });
    }
  });

  it('mgl docs <op> and the E_ARG fix line use the quoted form', async () => {
    const add = getCommand('cue.add');
    expect(commandDoc(add).join('\n')).toContain(shellExampleLine(add));
    const merge = getCommand('cue.merge');
    expect(await shellSafeFix(`example: ${exampleLine(merge)}`)).toBe(`example: ${shellExampleLine(merge)}`);
    expect(await shellSafeFix('give it once.')).toBe('give it once.');
  });
});

function shellWordsRoundTrip(words: string[]): boolean {
  return JSON.stringify(shWords(words.map(shellQuote).join(' '))) === JSON.stringify(words);
}

describe('k=v values that look like JSON but are not', () => {
  it('reports a type error with the received text and a shell-safe fix, not "is required"', () => {
    let err: MglError | undefined;
    try { kvCommand('cue.merge', ['ids=[c3,c4]']); } catch (e) { err = e as MglError; }
    expect(err?.code).toBe('E_ARG');
    expect(err?.message).toMatch(/"ids" is not valid JSON: \[c3,c4\]/);
    expect(err?.fix).toContain(`ids='["c3","c4"]'`);
    expect(kvCommand('cue.merge', ['ids=["c3","c4"]'])).toEqual({ op: 'cue.merge', ids: ['c3', 'c4'] });
  });

  it('keeps bracketed text for string fields', () => {
    expect(kvCommand('cue.add', ['clip=subs', 'text=[laughs]']).text).toBe('[laughs]');
  });
});

describe('plugin problems on unknown names', () => {
  it('adds the plugin load error to an unknown-effect error', () => {
    const e = new MglError({ code: 'E_UNKNOWN_EFFECT', message: 'unknown effect "film-tint".', fix: 'mgl docs effects' });
    withPluginProblems(e, [{ code: 'E_PLUGIN_LOAD', severity: 'error', message: 'plugin "film-tint" failed to load: boom', fix: 'mgl plugin test plugins/film-tint' }]);
    expect(e.message).toMatch(/failed to load: boom/);
    expect(e.fix).toMatch(/^mgl plugin test plugins\/film-tint/);
    const other = new MglError({ code: 'E_ARG', message: 'x', fix: 'y' });
    expect(withPluginProblems(other, [{ code: 'E_PLUGIN_LOAD', severity: 'error', message: 'm', fix: 'f' }]).message).toBe('x');
  });
});

describe('mgl docs <topic>', () => {
  it('prints a guide whole (SKILL.md points to them), not cut at 40 lines', async () => {
    const d = mkdtempSync(join(tmpdir(), 'mgl-docs-'));
    try {
      const r = await mgl(['docs', 'plugins'], { cwd: d });
      expect(r.code).toBe(0);
      expect(r.stdout).not.toMatch(/more \(use --all/);
      expect(r.stdout.trim().split('\n').length).toBeGreaterThan(40);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, 60_000);
});
