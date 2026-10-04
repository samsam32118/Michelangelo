/** `k=v` arguments → a command object. Values are JSON when they parse, else strings; the first bare word fills the primary field. */
import type { z } from 'zod';
import { fail } from '../core/errors.js';
import { getCommand, type Command, type CommandDef } from '../core/commands/registry.js';

/** Parse one value: JSON when it parses (numbers, booleans, null, arrays, objects), otherwise the string itself. */
export function parseValue(raw: string): unknown {
  const t = raw.trim();
  if (t === '') return '';
  // only JSON-looking text is tried, so "007" or "1e3x" stay strings
  if (/^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null|\{.*\}|\[.*\]|".*")$/s.test(t)) {
    try { return JSON.parse(t); } catch { /* not JSON */ }
  }
  return raw;
}

/** The field schema for a key, when the command declares it (dotted keys have none). */
function fieldSchema(def: CommandDef, key: string): z.ZodType | undefined {
  return (def.schema.shape as Record<string, z.ZodType>)[key];
}

/** Choose between the JSON-parsed and the raw string value using the field's schema (text=123 stays a string). */
function typed(def: CommandDef | undefined, key: string, raw: string): unknown {
  const v = parseValue(raw);
  if (!def || typeof v === 'string') return v;
  const s = fieldSchema(def, key);
  if (!s) return v;
  if (s.safeParse(v).success) return v;
  if (s.safeParse(raw).success) return raw;
  return v;
}

/** Turn `<op> [bare] [k=v ...]` into a command. */
export function kvCommand(op: string, words: string[]): Command {
  const def = getCommand(op);
  const cmd: Command = { op };
  const bare: string[] = [];
  for (const w of words) {
    const eq = w.indexOf('=');
    if (eq <= 0) { bare.push(w); continue; }
    const k = w.slice(0, eq);
    if (k in cmd && k !== 'op') fail('E_ARG', `${op}: "${k}" is given twice.`, `give each field once (k=v).`);
    if (k === 'op') fail('E_ARG', '"op" cannot be set with k=v.', `the command is the word after the file: mgl edit <file> ${op} ...`);
    cmd[k] = typed(def, k, w.slice(eq + 1));
  }
  if (bare.length) {
    if (!def.primary) fail('E_ARG', `${op} has no positional field, so "${bare[0]}" is not understood.`, `write fields as k=v (fields: ${Object.keys(def.schema.shape).join(', ')}).`);
    if (bare.length > 1) fail('E_ARG', `${op}: only one bare word is allowed (it fills "${def.primary}"); got ${bare.map((b) => `"${b}"`).join(', ')}.`, 'write the other values as k=v; quote text with spaces: text="Hello there".');
    if (def.primary in cmd) fail('E_ARG', `${op}: "${def.primary}" is given twice (bare word and ${def.primary}=).`, 'give it once.');
    cmd[def.primary] = typed(def, def.primary, bare[0]!);
  }
  return cmd;
}

/** Commands from a JSON string: an object, an array, or JSONL. */
export function jsonCommands(text: string, what = 'the JSON'): Command[] {
  const t = text.trim();
  if (!t) fail('E_COMMAND', `${what} is empty.`, 'give one command per line, or a JSON array of commands.');
  try {
    const v = JSON.parse(t) as unknown;
    return (Array.isArray(v) ? v : [v]) as Command[];
  } catch {
    const lines = t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    return lines.map((l, i) => {
      try { return JSON.parse(l) as Command; } catch (e) {
        return fail('E_JSON', `${what}: line ${i + 1} is not valid JSON (${(e as Error).message}).`, 'one command per line, e.g. {"op": "clip.split", "id": "shot1", "at": "2s"}; quote keys and strings with double quotes.', { line: i + 1 });
      }
    });
  }
}
