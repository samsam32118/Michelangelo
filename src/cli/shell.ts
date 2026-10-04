/** Shell-safe rendering of CLI examples (docs, `mgl docs <op>`, E_ARG fix lines), so they work when pasted into sh/bash/zsh. */
import type { CommandDef } from '../core/commands/registry.js';

/** Characters that never need quoting inside a word (and not at its start: "#" and "~" are special there). */
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quote a whole word for POSIX shells when needed: 'it'\''s'. */
export function shellQuote(s: string): string {
  if (s !== '' && SAFE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** One k=v word: the value is quoted when needed, as `k='v'` (the form the docs use). */
export function shellKv(k: string, v: string): string {
  const q = shellQuote(v);
  return q === v ? `${k}=${v}` : `${k}=${q}`;
}

const valueText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** `mgl edit <file> <op> ...` for a command's example, shell-quoted. */
export function shellExampleLine(def: Pick<CommandDef, 'op' | 'primary' | 'example'>, file = '<file>'): string {
  const parts = Object.entries(def.example as Record<string, unknown>).map(([k, v]) => (k === def.primary ? shellQuote(valueText(v)) : shellKv(k, valueText(v))));
  return `mgl edit ${file} ${def.op} ${parts.join(' ')}`.trim();
}

/**
 * Re-render a fix of the form "example: mgl edit <file> <op> ..." (the core's unquoted example line) shell-quoted.
 * Other fixes are returned unchanged.
 */
export async function shellSafeFix(fix: string): Promise<string> {
  const m = /^(.*?example: )(mgl edit <file> ([\w.-]+)(?: .*)?)$/s.exec(fix);
  if (!m) return fix;
  const { exampleLine, listCommands } = await import('../core/commands/registry.js');
  const def = listCommands().find((c) => c.op === m[3]);
  if (!def || exampleLine(def) !== m[2]) return fix;
  return m[1] + shellExampleLine(def);
}
