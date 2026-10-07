/**
 * `--fix` for check and look: apply the findings' fix commands, keep only the ones that verifiably help.
 *
 * Each round runs QA, dry-runs every fixable finding's command, then tries them all at once on a scratch copy;
 * when that batch removes every targeted finding and adds no error or warning it is kept, otherwise each fix is
 * tried alone and kept only if its finding disappears and nothing new (error/warning) appears. Rounds repeat
 * until no fix helps (at most 10). The kept commands are then dry-run and applied to the real project in ONE
 * edit: one transaction, one undo step. A fix is never applied that makes the project worse by QA's own measure.
 */
import type { Finding } from '../plugin/api.js';
import type { ProjectFile } from '../core/schema/index.js';
import type { Command } from '../core/commands/registry.js';
import { Project, type EditResult } from '../sdk/project.js';

export type Severity = Finding['severity'];
const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** A finding's fix as commands, or why it cannot be applied automatically. */
export type ParsedFix = { cmds: Command[] } | { reason: string };

/** POSIX-shell words of a command line (single and double quotes, backslash escapes). */
export function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur = '', inWord = false, i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error('unterminated single quote');
      cur += line.slice(i + 1, end); inWord = true; i = end + 1; continue;
    }
    if (ch === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) { cur += line[i + 1]; i += 2; continue; }
        cur += line[i++];
      }
      if (i >= line.length) throw new Error('unterminated double quote');
      inWord = true; i++; continue;
    }
    if (ch === '\\' && i + 1 < line.length) { cur += line[i + 1]; inWord = true; i += 2; continue; }
    if (/\s/.test(ch)) { if (inWord) { out.push(cur); cur = ''; inWord = false; } i++; continue; }
    if (ch === '#' && !inWord) break; // a shell comment
    cur += ch; inWord = true; i++;
  }
  if (inWord) out.push(cur);
  return out;
}

/** Split a fix on top-level "&&" (outside quotes). */
function andParts(fix: string): string[] {
  const parts: string[] = [];
  let q: string | undefined, cur = '';
  for (let i = 0; i < fix.length; i++) {
    const ch = fix[i]!;
    if (q) { if (ch === q) q = undefined; cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '&' && fix[i + 1] === '&') { parts.push(cur); cur = ''; i++; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Parse a fix line ("mgl edit <file> clip.set logo y=120 && mgl edit <file> ...") into commands. Only `mgl edit`
 * commands with every value given are applied; placeholders ("<path to ...>"), other verbs and undo/redo are not.
 */
export async function parseFix(fix: string | undefined): Promise<ParsedFix> {
  if (!fix?.trim()) return { reason: 'no fix command' };
  const { kvCommand, jsonCommands } = await import('../cli/kv.js');
  const cmds: Command[] = [];
  for (const part of andParts(fix)) {
    if (/<[^>]+>/.test(part.replaceAll('<file>', 'FILE'))) return { reason: 'needs a value you choose (placeholder in the fix)' };
    let w: string[];
    try { w = shellWords(part); } catch (e) { return { reason: `fix does not parse (${(e as Error).message})` }; }
    if (w[0] !== 'mgl' && w[0] !== 'michelangelo') return { reason: 'not an edit command' };
    if (w[1] !== 'edit') return { reason: `"mgl ${w[1] ?? ''}" is not an edit` };
    const [, , , op, ...rest] = w;
    if (!op || ['undo', 'redo', 'history'].includes(op) || rest.includes('--batch')) return { reason: 'not a single edit command' };
    try {
      if (/^\s*[[{]/.test(op)) cmds.push(...jsonCommands(op, 'the fix'));
      else cmds.push(kvCommand(op, rest.filter((x) => x !== '--dry-run')));
    } catch (e) { return { reason: firstLine(e) }; }
  }
  return cmds.length ? { cmds } : { reason: 'no fix command' };
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 160);

/** Identity of a finding across QA runs (frames and numbers in the message may move). */
export const findingKey = (f: Finding & { platform?: string }) => `${f.rule}|${f.clip ?? ''}|${f.platform ?? ''}`;
const sevKey = (f: Finding & { platform?: string }) => `${findingKey(f)}|${f.severity}`;

function counts(fs: Finding[], key: (f: Finding) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of fs) m.set(key(f), (m.get(key(f)) ?? 0) + 1);
  return m;
}

/** Errors and warnings in `after` beyond those in `before` (by rule, clip, platform and severity). */
export function newProblems(before: Finding[], after: Finding[]): Finding[] {
  const b = counts(before, sevKey), seen = new Map<string, number>(), out: Finding[] = [];
  for (const f of after) {
    if (f.severity === 'info') continue;
    const k = sevKey(f), n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > (b.get(k) ?? 0)) out.push(f);
  }
  return out;
}

/** Did the targeted findings disappear (each key's count dropped by at least how many were targeted)? */
function cleared(before: Finding[], after: Finding[], targets: Finding[]): Finding[] {
  const b = counts(before, findingKey), a = counts(after, findingKey), t = counts(targets, findingKey);
  return targets.filter((f) => (a.get(findingKey(f)) ?? 0) > (b.get(findingKey(f)) ?? 0) - (t.get(findingKey(f)) ?? 0));
}

export interface FixOutcome<R> {
  /** fixes kept, in the order they are applied */
  applied: { finding: Finding; fix: string; cmds: Command[]; round: number }[];
  /** fixes tried and dropped, with the reason */
  rejected: { finding: Finding; fix?: string; reason: string }[];
  /** QA findings before and after */
  before: Finding[];
  remaining: Finding[];
  rounds: number;
  /** the real edit (undefined when nothing was kept or with dryRun) */
  edit?: EditResult;
  /** the last QA report (for look: the sheet, crops and sound of the fixed project) */
  report: R;
  dryRun: boolean;
}

export interface FixOptions<R> {
  /** run QA on project data: findings plus the whole report */
  qa: (data: ProjectFile) => Promise<{ findings: Finding[]; report: R }>;
  /** fix findings at this severity or worse (default warning: errors and warnings) */
  severity?: Severity;
  /** at most this many rounds (default 10) */
  maxRounds?: number;
  /** find the fixes but do not write the project */
  dryRun?: boolean;
}

/** The project session `fixProject` needs: data, services, and an atomic edit (Project or the SDK's MglProject). */
export type FixTarget = Pick<Project, 'data' | 'services' | 'edit'>;

/** Apply verified fixes until QA stops improving; one edit (one undo step) on `p` at the end. */
export async function fixProject<R>(p: FixTarget, opts: FixOptions<R>): Promise<FixOutcome<R>> {
  const max = Math.max(1, Math.min(10, opts.maxRounds ?? 10));
  const sev = RANK[opts.severity ?? 'warning'];
  const scratch = (data: ProjectFile) => Project.create('', data, p.services);
  let cur = scratch(p.data);
  let run = await opts.qa(cur.data);
  const before = run.findings;
  const applied: FixOutcome<R>['applied'] = [];
  const rejected = new Map<string, FixOutcome<R>['rejected'][number]>();
  const reject = (finding: Finding, fix: string | undefined, reason: string) => rejected.set(`${findingKey(finding)}|${fix ?? ''}`, { finding, ...(fix ? { fix } : {}), reason });
  let rounds = 0;
  for (; rounds < max; rounds++) {
    const findings = run.findings;
    const candidates: { finding: Finding; fix: string; cmds: Command[] }[] = [];
    const seenFix = new Set<string>();
    for (const f of findings) {
      if (RANK[f.severity] > sev || !f.fix) continue;
      if (rejected.has(`${findingKey(f)}|${f.fix}`) || seenFix.has(f.fix)) continue;
      const parsed = await parseFix(f.fix);
      if ('reason' in parsed) { reject(f, f.fix, parsed.reason); continue; }
      // dry-run first: a fix that fails on the current project is dropped with the command's own error
      try { await cur.edit(parsed.cmds, { dryRun: true, save: false }); } catch (e) { reject(f, f.fix, firstLine(e)); continue; }
      seenFix.add(f.fix);
      candidates.push({ finding: f, fix: f.fix, cmds: parsed.cmds });
    }
    if (!candidates.length) break;
    candidates.sort((a, b) => RANK[a.finding.severity] - RANK[b.finding.severity]);
    let kept = 0;
    // all at once first (the common case: independent fixes), then one by one
    if (candidates.length > 1) {
      const trial = scratch(cur.data);
      try {
        await trial.edit(candidates.flatMap((c) => c.cmds), { save: false });
        const after = await opts.qa(trial.data);
        if (!cleared(findings, after.findings, candidates.map((c) => c.finding)).length && !newProblems(findings, after.findings).length) {
          for (const c of candidates) applied.push({ ...c, round: rounds + 1 });
          cur = trial; run = after; kept = candidates.length;
        }
      } catch { /* conflicting fixes: try them one by one */ }
    }
    if (!kept) {
      for (const c of candidates) {
        // an earlier fix this round may have solved or changed this finding: the next round looks again
        if (!run.findings.some((f) => findingKey(f) === findingKey(c.finding) && f.fix === c.fix)) continue;
        const trial = scratch(cur.data);
        try { await trial.edit(c.cmds, { save: false }); } catch (e) { reject(c.finding, c.fix, firstLine(e)); continue; }
        const after = await opts.qa(trial.data);
        const worse = newProblems(run.findings, after.findings);
        if (worse.length) { reject(c.finding, c.fix, `adds ${worse[0]!.severity === 'error' ? 'an error' : 'a warning'}: ${worse[0]!.rule}${worse[0]!.clip ? ` on ${worse[0]!.clip}` : ''}`); continue; }
        if (cleared(run.findings, after.findings, [c.finding]).length) { reject(c.finding, c.fix, 'the finding remains after the fix'); continue; }
        applied.push({ ...c, round: rounds + 1 });
        cur = trial; run = after; kept++;
      }
    }
    if (!kept) { rounds++; break; }
  }
  // a fix rejected early may have been superseded: forget rejections of findings that are gone
  const left = new Set(run.findings.map(findingKey));
  const out: FixOutcome<R> = {
    applied, rejected: [...rejected.values()].filter((r) => left.has(findingKey(r.finding))),
    before, remaining: run.findings, rounds, report: run.report, dryRun: !!opts.dryRun,
  };
  if (applied.length && !opts.dryRun) {
    const all = applied.flatMap((a) => a.cmds);
    await p.edit(all, { dryRun: true }); // throws (nothing written) if the project changed under us
    out.edit = await p.edit(all);
  }
  return out;
}

/** The ≤ 10-line text summary of a fix run. */
export function formatFix(o: FixOutcome<unknown>, file: string, verb: 'check' | 'look'): string[] {
  const lines: string[] = [];
  const n = o.applied.length;
  const sevs = (fs: Finding[]) => {
    const c = (['error', 'warning', 'info'] as const).map((s) => [s, fs.filter((f) => f.severity === s).length] as const).filter(([, k]) => k);
    return c.length ? c.map(([s, k]) => `${k} ${s === 'warning' ? 'warn' : s}`).join(', ') : 'none';
  };
  lines.push(`fix: ${n ? `${o.dryRun ? 'would apply' : 'applied'} ${n} fix${n === 1 ? '' : 'es'} in ${o.rounds} round${o.rounds === 1 ? '' : 's'}` : o.rejected.length ? 'no fix helped' : 'nothing to fix'}; findings ${o.before.length} → ${o.remaining.length}${n && !o.dryRun ? ` (one undo step: mgl edit ${file} undo)` : o.dryRun && n ? ' (dry run: nothing written)' : ''}`);
  const short = (s: string) => (s.length > 110 ? s.slice(0, 109) + '…' : s);
  const what = (f: Finding) => `${f.rule}${f.clip ? ` ${f.clip}` : ''}`;
  const room = 10 - 2;
  const appliedLines = o.applied.map((a) => `  ok   ${what(a.finding)}: ${short(a.fix.replace(/^mgl edit \S+ /, '').replace(/ && mgl edit \S+ /g, ' && '))}`);
  const rejectedLines = o.rejected.map((r) => `  skip ${what(r.finding)}: ${short(r.reason)}`);
  const budgetA = Math.min(appliedLines.length, Math.max(room - Math.min(rejectedLines.length, 3), Math.ceil(room / 2)));
  const budgetR = Math.min(rejectedLines.length, room - budgetA);
  const shownA = appliedLines.length > budgetA ? [...appliedLines.slice(0, budgetA - 1), `  ok   … ${appliedLines.length - budgetA + 1} more`] : appliedLines;
  const shownR = rejectedLines.length > budgetR ? [...rejectedLines.slice(0, Math.max(0, budgetR - 1)), ...(budgetR > 0 ? [`  skip … ${rejectedLines.length - budgetR + 1} more`] : [])] : rejectedLines;
  lines.push(...shownA, ...shownR);
  lines.push(o.remaining.length ? `remaining: ${o.remaining.length} (${sevs(o.remaining)}): mgl ${verb} ${file} lists them` : 'remaining: none, QA is clean');
  return lines.slice(0, 10);
}

// ------------------------------------------------------------------------------------------- check / look runners

type MglProject = import('../sdk/index.js').MglProject;

export interface FixVerbOptions {
  severity?: Severity;
  maxRounds?: number;
  dryRun?: boolean;
  platforms?: string[];
  alpha?: boolean;
  /** how fixes name the project file (default: the file relative to the cwd) */
  displayFile?: string;
}

/** `check --fix`: project-stage QA (no pixels) as the verifier. */
export async function fixCheck(p: MglProject, o: FixVerbOptions = {}): Promise<FixOutcome<{ findings: Finding[] }>> {
  const { checkProject } = await import('./check.js');
  const { displayName } = await import('./look.js');
  const { getMediaBackend } = await import('../media/index.js');
  const backend = getMediaBackend({ baseDir: p.dir });
  const probe = async (abs: string) => {
    const info = await backend.probe(abs);
    return { ...(info.duration ? { duration: info.duration } : {}), ...(info.width ? { width: info.width, height: info.height } : {}), ...(info.pixFmt ? { pixFmt: info.pixFmt } : {}) };
  };
  const file = o.displayFile ?? displayName(p.file);
  return fixProject(p, {
    ...verbOpts(o),
    qa: async (data) => {
      const findings = await checkProject(data, { baseDir: p.dir, registry: p.registry, probe, file, ...(o.platforms?.length ? { platforms: o.platforms } : {}), ...(o.alpha ? { alpha: true } : {}) });
      return { findings, report: { findings } };
    },
  });
}

export interface FixLookOptions extends FixVerbOptions {
  comp?: string;
  /** comp frames to judge (default: n evenly spaced) */
  frames?: number[];
  n?: number;
  cuts?: boolean;
  audio?: boolean;
  /** outline the platform interface panels on the sheet and crops */
  safe?: boolean;
}

/** `look --fix`: the full look (rendered frames, project, frame and audio rules) as the verifier. */
export async function fixLook(p: MglProject, o: FixLookOptions = {}): Promise<FixOutcome<import('./look.js').LookReport>> {
  const { look, displayName } = await import('./look.js');
  const file = o.displayFile ?? displayName(p.file);
  return fixProject(p, {
    ...verbOpts(o),
    qa: async (data) => {
      const report = await look(data, {
        baseDir: p.dir, file: p.file, registry: p.registry, displayFile: file,
        ...(o.comp ? { comp: o.comp } : {}), ...(o.frames?.length ? { frames: o.frames } : {}), ...(o.n !== undefined ? { n: o.n } : {}),
        ...(o.cuts ? { cuts: true } : {}), ...(o.audio === false ? { audio: false } : {}),
        ...(o.platforms?.length ? { platforms: o.platforms } : {}), ...(o.alpha ? { alpha: true } : {}), ...(o.safe ? { safe: true } : {}),
        storyboard: false, // candidates may be rejected: never let one become the snapshot ● compares against
      });
      return { findings: report.findings, report };
    },
  });
}

function verbOpts(o: FixVerbOptions): Pick<FixOptions<unknown>, 'severity' | 'maxRounds' | 'dryRun'> {
  return { ...(o.severity ? { severity: o.severity } : {}), ...(o.maxRounds ? { maxRounds: o.maxRounds } : {}), ...(o.dryRun ? { dryRun: true } : {}) };
}

/** The JSON form of a fix run (for --json and the SDK). */
export function fixJson(o: FixOutcome<unknown>) {
  return {
    applied: o.applied.map((a) => ({ rule: a.finding.rule, clip: a.finding.clip, message: a.finding.message, fix: a.fix, round: a.round })),
    rejected: o.rejected.map((r) => ({ rule: r.finding.rule, clip: r.finding.clip, message: r.finding.message, fix: r.fix, reason: r.reason })),
    rounds: o.rounds, before: o.before.length, remaining: o.remaining, dryRun: o.dryRun,
  };
}
