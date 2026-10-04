// Metrics from a `claude -p --output-format stream-json --verbose` transcript (one JSON event per line).
import { readFileSync, existsSync } from 'node:fs';
import { posix } from 'node:path';

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

/** Did a tool result report a permission denial (rather than a tool failure)? */
const DENIAL_RE = /needs approval|requires? (?:explicit |manual )?approval|require explicit approval|can't be checked before it runs|haven't granted|permission to use .* (?:was|has been) denied|was blocked by|denied by (?:the )?(?:user|permission)/i;

const GLOB_CHARS = /[*?[{]/;
const PATHISH = /^(?:~(?=\/|$)|\/|\.\.(?=\/|$))[\w.~\/@+%:-]*$/;

/** Expand ~ and resolve a path against base (posix, no filesystem access). */
export function resolveAgainst(p, base, home) {
  let s = String(p);
  if (s === '~' || s.startsWith('~/')) s = home + s.slice(1);
  return posix.resolve(base || '/', s);
}

/** The literal directory part of a glob pattern ("/a/b/**\/*.js" → "/a/b"). */
export function globRoot(pattern) {
  const parts = String(pattern).split('/');
  const i = parts.findIndex((x) => GLOB_CHARS.test(x));
  return i < 0 ? String(pattern) : parts.slice(0, i).join('/') || (String(pattern).startsWith('/') ? '/' : '.');
}

/** A shell command without its heredoc bodies. */
export const stripHeredocs = (command) => String(command).replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, '');

/**
 * Paths a shell command refers to: absolute, ~ and ..-relative words (also after VAR=, --opt= and redirections),
 * resolved against the working directory as the command's own `cd`s change it. Variables are not expanded.
 */
export function shellPaths(command, cwd, home) {
  const res = [];
  res.climbed = new Set(); // paths reached through '..'
  let dir = cwd;
  // split into simple commands on ; && || | and newlines (quotes are not tracked precisely: good enough to audit)
  // heredoc bodies are data (code, JSON), not shell words
  const text = stripHeredocs(command);
  const FS = new Set(['find', 'ls', 'cd', 'cat', 'du', 'grep', 'rg', 'tree', 'head', 'tail', 'cp', 'mv', 'stat', 'file', 'less', 'more', 'xargs', 'tar']);
  for (const seg of text.split(/;|&&|\|\||\||\n/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^[<>]+|^\d>+|^&>+/, '').replace(/^['"(]+|['");]+$/g, ''));
    words.forEach((w0, i) => {
      let w = w0;
      const eq = /^(?:-{1,2}[\w-]+|[A-Za-z_]\w*)=(.*)$/.exec(w);
      if (eq) w = eq[1].replace(/^['"]|['"]$/g, '');
      // a bare "/" is the root only as a file-command argument (else it is a regex or comment fragment)
      if (/^\/+$/.test(w) && !FS.has(words[0])) return;
      if (!w || !PATHISH.test(w)) {
        if (words[0] === 'cd' && i === 1 && w && !w.startsWith('$') && !w.startsWith('-')) dir = resolveAgainst(w, dir, home);
        return;
      }
      const abs = resolveAgainst(globRoot(w), dir, home);
      res.push(abs);
      if (w.split('/').includes('..')) res.climbed.add(abs);
      if (words[0] === 'cd' && i === 1) dir = abs;
    });
    if (words.length === 1 && words[0] === 'cd') dir = home;
  }
  return res;
}

/**
 * Compute metrics. `runDir` is the sandbox path: paths outside it (other than system/tool paths and the agent's
 * HOME tool dirs) that the agent touches are violations, relative paths and globs resolved against runDir and
 * shell words followed through `cd`. `forbidden` lists path prefixes that are always violations. A violation is
 * *fatal* (the run counts as failed) when it touches `fatal` prefixes (the repository, evals/), another eval
 * sandbox (/tmp/mgl-eval-*, /home/<eval user>/runs/*) or another session's scratchpad (/tmp/claude-N/...).
 * Permission denials (from the result events and from denial tool results) are counted separately.
 */
export function metricsFrom(events, { runDir = '', forbidden = [], fatal = [], home = '/home/mgleval' } = {}) {
  const tools = new Map(); // tool_use id → {name, input}
  const m = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, toolCalls: 0, toolCounts: {}, bashTimeouts: 0, failedEdits: 0,
    permissionDenials: 0, errorCodes: {}, verbs: {}, violations: [], fatalViolations: [], resultSubtype: null, isError: false, apiMs: null };
  const seenMsg = new Set();
  const denied = new Set();
  let assistantTurns = 0, usageFromMessages = { input: 0, output: 0, cr: 0, cc: 0 };
  const inside = (p, d) => !!d && (p === d || p.startsWith(d.endsWith('/') ? d : d + '/'));
  const slug = runDir ? runDir.replace(/[^A-Za-z0-9]/g, '-') : null;
  const sandboxRoots = ['/tmp/mgl-eval-', `${home}/runs/`, '/home/mgleval/runs/', '/var/tmp/mgl-eval-'];
  for (const e of events) if (e?.type === 'result') for (const d of Array.isArray(e.permission_denials) ? e.permission_denials : []) if (d?.tool_use_id) denied.add(d.tool_use_id);
  /** 'ok' | 'violation' | 'fatal' for an absolute, normalised path. */
  const classify = (p) => {
    if (inside(p, runDir)) return 'ok';
    if (fatal.some((f) => inside(p, f) || p === f)) return 'fatal';
    const scratch = /^\/tmp\/claude-\d+\/([^/]+)/.exec(p);
    if (scratch) {
      if (slug && scratch[1] === slug) return 'ok';
      return /mgl-eval|-home-|-root/.test(scratch[1]) ? 'fatal' : 'violation';
    }
    if (inside(p, `${home}/runs`)) return 'fatal';
    if (inside(p, home)) return p === home || ['.claude', '.cache', '.npm', '.config/michelangelo', '.local/share/michelangelo'].some((d) => inside(p, `${home}/${d}`)) || /^\.ca-[\w-]+\.pem$/.test(p.slice(home.length + 1)) ? 'ok' : 'violation';
    if (sandboxRoots.some((r) => p.startsWith(r)) && !p.startsWith('/tmp/mgl-eval-pack') && !/^\/tmp\/mgl-eval-home-/.test(p)) return 'fatal';
    if (forbidden.some((f) => inside(p, f) || p === f)) return 'violation';
    if (/^\/tmp\/mgl-eval-home-/.test(p)) return 'violation';
    if (/^\/(usr|bin|sbin|lib|lib64|etc|opt|proc|dev|tmp|var\/tmp|sys|run)(\/|$)/.test(p)) return 'ok';
    return 'violation';
  };
  const violation = (where, raw, base = runDir, climbed = false) => {
    if (typeof raw !== 'string' || !raw) return;
    const p = resolveAgainst(raw, base, home);
    let c = classify(p);
    // a relative path that climbs out of the run dir is a violation even where the target itself is harmless
    if (c === 'ok' && (climbed || raw.split('/').includes('..')) && !inside(p, runDir)) c = 'violation';
    if (c === 'ok') return;
    const s = `${where}: ${raw === p ? p : `${raw} (${p})`}`.slice(0, 300);
    m.violations.push(s);
    if (c === 'fatal') m.fatalViolations.push(s);
  };
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
        for (const k of ['file_path', 'notebook_path']) violation(c.name, inp[k]);
        const base = typeof inp.path === 'string' ? resolveAgainst(inp.path, runDir, home) : runDir;
        violation(c.name, inp.path);
        if (c.name === 'Glob' || c.name === 'Grep') for (const k of ['pattern', 'glob']) {
          // Grep's pattern is a regex, not a path: only Glob patterns and Grep globs are paths
          if (typeof inp[k] === 'string' && (c.name === 'Glob' || k === 'glob') && (inp[k].startsWith('/') || inp[k].startsWith('~') || inp[k].split('/').includes('..'))) violation(`${c.name} ${k}`, globRoot(inp[k]), base);
        }
        if (c.name === 'Bash' && typeof inp.command === 'string') {
          for (const v of inp.command.matchAll(VERB_RE)) m.verbs[v[1]] = (m.verbs[v[1]] ?? 0) + 1;
          const before = m.violations.length, beforeFatal = m.fatalViolations.length;
          const sp = shellPaths(inp.command, runDir, home);
          for (const p of sp) violation('Bash', p, runDir, sp.climbed.has(p));
          // one entry per command (with the command text), fatal if any of its paths was
          if (m.violations.length > before) {
            const fatalHit = m.fatalViolations.length > beforeFatal;
            m.violations.length = before; m.fatalViolations.length = beforeFatal;
            const s = `Bash: ${inp.command}`.slice(0, 300);
            m.violations.push(s); if (fatalHit) m.fatalViolations.push(s);
          } else for (const f of forbidden) if (stripHeredocs(inp.command).includes(f)) { m.violations.push(`Bash: ${inp.command}`.slice(0, 300)); break; }
        }
      }
    }
    if (e.type === 'user' && e.message) {
      for (const c of Array.isArray(e.message.content) ? e.message.content : []) {
        if (c.type !== 'tool_result') continue;
        const tool = tools.get(c.tool_use_id);
        const text = textOf(c.content);
        if (tool?.name === 'Bash' && TIMEOUT_RE.test(text)) m.bashTimeouts++;
        const isDenial = c.is_error && (denied.has(c.tool_use_id) || DENIAL_RE.test(text.slice(0, 600)));
        if (isDenial) { denied.add(c.tool_use_id); continue; }
        if (tool && EDIT_TOOLS.has(tool.name) && (c.is_error || EDIT_FAIL_RE.test(text)) && (c.is_error ? true : text.length < 2000)) m.failedEdits++;
        // count codes the CLI/SDK actually raised ("error E_X ..." lines, JSON error objects, MglError stacks), not codes in docs output
        for (const mm of text.matchAll(RAISED_RE)) { const code = mm[1] ?? mm[2] ?? mm[3]; m.errorCodes[code] = (m.errorCodes[code] ?? 0) + 1; }
      }
    }
    if (e.type === 'result') {
      m.resultSubtype = e.subtype ?? null;
      for (const d of Array.isArray(e.permission_denials) ? e.permission_denials : []) denied.add(d?.tool_use_id ?? JSON.stringify(d));
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
  m.fatalViolations = [...new Set(m.fatalViolations)];
  m.permissionDenials = denied.size;
  return m;
}

/**
 * The violation policy: a run whose violations touch the repository, evals/, another eval sandbox or another
 * session's scratchpad counts as failed. Returns {fail, reason} (reason names the count and the first access).
 */
export function violationVerdict(metrics) {
  const f = Array.isArray(metrics?.fatalViolations) ? metrics.fatalViolations : [];
  if (!f.length) return { fail: false, reason: '' };
  return { fail: true, reason: `sandbox violation: ${f.length} access(es) to the repository, evals/ or another sandbox (first: ${f[0].slice(0, 160)})` };
}

/** Apply the policy to a result in place (keeps the graded verdict in gradedPass/gradedScore). */
export function applyViolationPolicy(r) {
  const v = violationVerdict(r.metrics);
  if (!v.fail) return r;
  Object.assign(r, { gradedPass: r.pass, gradedScore: r.score, pass: false, score: 0, violationFail: true, failReason: v.reason });
  return r;
}
