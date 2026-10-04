// Metrics from a `claude -p --output-format stream-json --verbose` transcript (one JSON event per line).
import { readFileSync, existsSync } from 'node:fs';

const TIMEOUT_RE = /Command timed out|timed out after \d|did not complete within its \d+s? timeout|Timeout(?:Error)?:|exceeded the (?:maximum )?(?:time|timeout)/i;
const EDIT_FAIL_RE = /String to replace not found|Found \d+ matches of the string|File has not been read yet|has been (?:modified|changed) since (?:it was )?(?:last )?read|old_string and new_string are (?:exactly )?the same|No changes to make/i;
const ERR_CODE_RE = /\bE_[A-Z][A-Z0-9_]+\b/g;
const RAISED_RE = /^error (E_[A-Z][A-Z0-9_]+)\b|"code":\s*"(E_[A-Z][A-Z0-9_]+)"|MglError[^\n]*?\b(E_[A-Z][A-Z0-9_]+)\b/gm;
const VERB_RE = /(?:^|[\s;&|(`$])(?:npx\s+(?:--no-install\s+)?|\.\/node_modules\/\.bin\/)?(?:mgl|michelangelo)\s+([a-z][a-z-]*)/g;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n') : '');

/** Parse transcript lines into events (bad lines skipped). */
export function readTranscript(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/**
 * Compute metrics. `runDir` is the sandbox path: absolute paths outside it (other than system/tool paths) that
 * the agent reads are violations; `forbidden` lists path prefixes that are always violations (the repository).
 */
export function metricsFrom(events, { runDir = '', forbidden = [], home = '/home/mgleval' } = {}) {
  const tools = new Map(); // tool_use id → {name, input}
  const m = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, toolCalls: 0, toolCounts: {}, bashTimeouts: 0, failedEdits: 0,
    errorCodes: {}, verbs: {}, violations: [], resultSubtype: null, isError: false, apiMs: null };
  const seenMsg = new Set();
  let assistantTurns = 0, usageFromMessages = { input: 0, output: 0, cr: 0, cc: 0 };
  const allowedAbs = (p) => !p.startsWith('/') || (runDir && (p === runDir || p.startsWith(runDir + '/'))) || p.startsWith(home + '/.claude') || p.startsWith(home + '/.cache')
    || /^\/(usr|bin|lib|lib64|etc|opt|proc|dev|tmp|var\/tmp|sys)(\/|$)/.test(p);
  const violation = (where, p) => { if (forbidden.some((f) => p.startsWith(f)) || !allowedAbs(p)) m.violations.push(`${where}: ${p}`.slice(0, 300)); };
  for (const e of events) {
    if (e.type === 'assistant' && e.message) {
      const id = e.message.id;
      if (!id || !seenMsg.has(id)) {
        if (id) seenMsg.add(id);
        assistantTurns++;
        const u = e.message.usage ?? {};
        usageFromMessages.input += u.input_tokens ?? 0; usageFromMessages.output += u.output_tokens ?? 0;
        usageFromMessages.cr += u.cache_read_input_tokens ?? 0; usageFromMessages.cc += u.cache_creation_input_tokens ?? 0;
      }
      for (const c of e.message.content ?? []) {
        if (c.type !== 'tool_use') continue;
        tools.set(c.id, { name: c.name, input: c.input ?? {} });
        m.toolCalls++;
        m.toolCounts[c.name] = (m.toolCounts[c.name] ?? 0) + 1;
        const inp = c.input ?? {};
        for (const k of ['file_path', 'path', 'notebook_path']) if (typeof inp[k] === 'string') violation(c.name, inp[k]);
        if (c.name === 'Bash' && typeof inp.command === 'string') {
          for (const v of inp.command.matchAll(VERB_RE)) m.verbs[v[1]] = (m.verbs[v[1]] ?? 0) + 1;
          for (const f of forbidden) if (inp.command.includes(f)) m.violations.push(`Bash: ${inp.command}`.slice(0, 300));
        }
      }
    }
    if (e.type === 'user' && e.message) {
      for (const c of Array.isArray(e.message.content) ? e.message.content : []) {
        if (c.type !== 'tool_result') continue;
        const tool = tools.get(c.tool_use_id);
        const text = textOf(c.content);
        if (tool?.name === 'Bash' && TIMEOUT_RE.test(text)) m.bashTimeouts++;
        if (tool && EDIT_TOOLS.has(tool.name) && (c.is_error || EDIT_FAIL_RE.test(text)) && (c.is_error ? true : text.length < 2000)) m.failedEdits++;
        // count codes the CLI/SDK actually raised ("error E_X ..." lines, JSON error objects, MglError stacks), not codes in docs output
        for (const mm of text.matchAll(RAISED_RE)) { const code = mm[1] ?? mm[2] ?? mm[3]; m.errorCodes[code] = (m.errorCodes[code] ?? 0) + 1; }
      }
    }
    if (e.type === 'result') {
      m.resultSubtype = e.subtype ?? null;
      m.isError = !!e.is_error;
      // a session can end more than once (a background task's notification wakes it again): sum every result
      m.results = (m.results ?? 0) + 1;
      if (typeof e.num_turns === 'number') m.turns += e.num_turns;
      if (typeof e.total_cost_usd === 'number') m.costUsd = (m.costUsd ?? 0) + e.total_cost_usd;
      if (typeof e.duration_api_ms === 'number') m.apiMs = (m.apiMs ?? 0) + e.duration_api_ms;
      const u = e.usage;
      if (u) { m.inputTokens += u.input_tokens ?? 0; m.outputTokens += u.output_tokens ?? 0; m.cacheReadTokens += u.cache_read_input_tokens ?? 0; m.cacheCreationTokens += u.cache_creation_input_tokens ?? 0; }
    }
  }
  if (!m.turns) m.turns = assistantTurns;
  if (!m.inputTokens && !m.outputTokens) {
    m.inputTokens = usageFromMessages.input; m.outputTokens = usageFromMessages.output; m.cacheReadTokens = usageFromMessages.cr; m.cacheCreationTokens = usageFromMessages.cc;
  }
  m.violations = [...new Set(m.violations)];
  return m;
}
