// The vision score (DESIGN §17.1): contact sheets and a sound summary of a run's deliverable(s), judged by a model
// with a fixed rubric (evals/vision/rubric.md). The judge is `claude -p` with only the Read tool, in a temp dir that
// holds the sheets, task.md, sound.txt and rubric.md. Its cost is recorded apart from the arm's cost.
//
// Determinism: `claude -p` exposes no temperature, so the judge is not deterministic. It runs once per run (no
// best-of-n, no retries on a parseable answer); the rubric pins the scale, and the overall score is recomputed
// from the criteria (mean, integer-rounded) so arithmetic slips of the judge do not count.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG, run, findFiles, readSetup } from '../lib/util.mjs';
import { probe } from '../lib/probe.mjs';
import { loudness, silences } from '../lib/audio.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUBRIC = join(HERE, 'rubric.md');
export const CRITERIA = ['brief', 'composition', 'text', 'motion', 'polish', 'sound'];
export const VIDEO_RE = /\.(mp4|webm|mov|gif)$/i;
export const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const MEDIA_RE = /\.(mp4|webm|mov|gif|png|jpe?g|webp)$/i;
/** Contact sheet: long edge ≤ 1568 px (3 tiles of 512 + padding and margin = 1552). */
export const SHEET_MAX = 1568, TILE = 512;

const inside = (p, d) => p === d || p.startsWith(d + '/');

/**
 * The deliverables of a run dir, relative paths: meta.deliverables when the task lists them (existing files only);
 * otherwise media files named in the grader's check details, then the newest video (else image) under out/, else
 * the newest non-fixture video (else image) anywhere in the dir.
 */
export function pickDeliverables(dir, { meta = {}, result = {} } = {}) {
  const ok = (f) => { const p = resolve(dir, f); try { return inside(p, resolve(dir)) && statSync(p).isFile(); } catch { return false; } };
  if (Array.isArray(meta.deliverables) && meta.deliverables.length) return meta.deliverables.filter((f) => typeof f === 'string' && ok(f));
  const setup = readSetup(dir);
  const isFixture = (f) => f in (setup.hashes ?? {}) || /^\.?golden\//.test(f) || f.startsWith('media/');
  const mtime = (f) => statSync(join(dir, f)).mtimeMs;
  const newestFirst = (fs) => [...new Set(fs)].filter(ok).sort((a, b) => mtime(b) - mtime(a));
  const named = [];
  for (const c of [...(result.checks ?? []), ...(result.skippedChecks ?? [])]) {
    for (const m of `${c?.name ?? ''} ${c?.detail ?? ''}`.matchAll(/(?:^|[\s(`'"])((?:[\w.-]+\/)*[\w.-]+\.(?:mp4|webm|mov|gif|png|jpe?g|webp))\b/gi)) {
      const f = m[1].replace(/^\.\//, '');
      if (!isFixture(f) && ok(f)) named.push(f);
    }
  }
  const pick = (fs) => { const v = newestFirst(fs.filter((f) => VIDEO_RE.test(f))); if (v.length) return [v[0]]; const i = newestFirst(fs.filter((f) => IMAGE_RE.test(f))); return i.length ? [i[0]] : []; };
  if (named.length) return pick(named);
  const out = findFiles(join(dir, 'out'), MEDIA_RE).map((f) => `out/${f}`);
  if (out.length) return pick(out);
  return pick(findFiles(dir, MEDIA_RE).filter((f) => !isFixture(f)));
}

const fmtT = (t) => `${Math.floor(t / 60)}m${(t % 60).toFixed(2).padStart(5, '0')}s`;

async function ff(args, timeoutMs = 120_000) {
  const r = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { timeoutMs });
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.slice(-800)}`);
}

/**
 * A 3x3 contact sheet of a video (9 evenly spaced frames, each labelled with its timestamp) or the image itself
 * scaled to fit, written to outPng (long edge ≤ 1568). Returns {kind, duration, times, width, height}.
 */
export async function contactSheet(file, outPng) {
  const info = await probe(file);
  if (!info?.video) throw new Error(`${basename(file)} has no video stream`);
  mkdirSync(dirname(outPng), { recursive: true });
  const still = IMAGE_RE.test(file) || !(info.duration > 0.05) || (info.frames === 1);
  if (still) {
    await ff(['-i', file, '-frames:v', '1', '-vf', `scale='min(iw,${SHEET_MAX})':'min(ih,${SHEET_MAX})':force_original_aspect_ratio=decrease`, outPng]);
    return { kind: 'image', duration: 0, times: [0], width: info.displayWidth, height: info.displayHeight };
  }
  const d = info.duration;
  const times = Array.from({ length: 9 }, (_, i) => Math.min(d - 0.001, ((i + 0.5) / 9) * d));
  const tmp = mkdtempSync(join(tmpdir(), 'mgl-vision-sheet-'));
  try {
    const fit = `scale=${TILE}:${TILE}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
    for (let i = 0; i < 9; i++) {
      const f = join(tmp, `f${i}.png`);
      const label = `drawtext=text='${fmtT(times[i])}':x=6:y=6:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=4`;
      // seek before the input (fast), then fall back to the last decodable frame near the end
      try { await ff(['-ss', times[i].toFixed(3), '-i', file, '-frames:v', '1', '-vf', `${fit},${label}`, f]); } catch {
        await ff(['-ss', times[i].toFixed(3), '-i', file, '-frames:v', '1', '-vf', fit, f]).catch(() => {});
      }
      if (!existsSync(f)) await ff(['-sseof', '-0.2', '-i', file, '-frames:v', '1', '-vf', fit, f]).catch(() => {});
      if (!existsSync(f) && i > 0) copyFileSync(join(tmp, `f${i - 1}.png`), f);
    }
    if (!existsSync(join(tmp, 'f0.png'))) throw new Error(`no frames could be decoded from ${basename(file)}`);
    for (let i = 1; i < 9; i++) if (!existsSync(join(tmp, `f${i}.png`))) copyFileSync(join(tmp, 'f0.png'), join(tmp, `f${i}.png`));
    await ff(['-framerate', '1', '-i', join(tmp, 'f%d.png'), '-vf', 'tile=3x3:padding=4:margin=4:color=0x202020', '-frames:v', '1', outPng]);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return { kind: 'video', duration: d, times, width: info.displayWidth, height: info.displayHeight, fps: info.fps };
}

/** The sound of a deliverable as text: integrated loudness, true peak, LRA and silences (or "no audio"). */
export async function soundSummary(file, name = basename(file)) {
  const info = await probe(file);
  if (!info) return `${name}: missing or unreadable`;
  const head = `${name}: ${info.width ?? '?'}x${info.height ?? '?'}${info.fps ? ` @ ${Math.round(info.fps * 100) / 100} fps` : ''}, ${Math.round((info.duration ?? 0) * 100) / 100} s`;
  if (!info.audio) return `${head}\n  audio: none (no audio stream)`;
  const [l, sil] = await Promise.all([loudness(file), silences(file, { db: -50, minDuration: 0.5 })]);
  const f = (v, u) => (v === undefined ? 'n/a' : v === -Infinity ? `-inf ${u}` : `${v} ${u}`);
  const silText = sil.length ? sil.slice(0, 12).map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)} s`).join(', ') + (sil.length > 12 ? ` (+${sil.length - 12} more)` : '') : 'none';
  return [head, `  audio: ${info.audio.codec}, ${info.audio.sampleRate ?? '?'} Hz, ${info.audio.channels ?? '?'} ch`,
    `  integrated loudness (EBU R128): ${f(l.integrated, 'LUFS')}`, `  true peak: ${f(l.truePeak, 'dBTP')}`, `  loudness range: ${f(l.range, 'LU')}`,
    `  silences below -50 dB lasting >= 0.5 s: ${silText}`].join('\n');
}

/** Candidate JSON objects in text: fenced ```json blocks first, then every balanced {...}, last first. */
function jsonCandidates(text) {
  const out = [];
  for (const m of String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) out.push(m[1].trim());
  const s = String(text);
  const objs = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { objs.push(s.slice(i, j + 1)); break; }
    }
  }
  return [...out.reverse(), ...objs.reverse()];
}

const clamp10 = (v) => Math.max(0, Math.min(10, Number(v)));

/**
 * Parse the judge's final answer: the last JSON object with criteria (or overall). Criteria are clamped to 0–10;
 * overall is the integer-rounded mean of the criteria present (the judge's own is kept as reportedOverall).
 * Throws when no usable object is found.
 */
export function parseJudgeJson(text) {
  for (const c of jsonCandidates(text)) {
    let j;
    try { j = JSON.parse(c); } catch { continue; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
    const crit = {};
    for (const [k, v] of Object.entries(j.criteria ?? {})) {
      const n = typeof v === 'object' && v ? v.score : v;
      if (Number.isFinite(Number(n)) && n !== null && n !== '') crit[k] = clamp10(n);
    }
    const vals = Object.values(crit);
    if (!vals.length && !Number.isFinite(Number(j.overall))) continue;
    const overall = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : Math.round(clamp10(j.overall));
    const missing = CRITERIA.filter((k) => !(k in crit));
    return { overall, criteria: crit, notes: typeof j.notes === 'string' ? j.notes.slice(0, 2000) : '', ...(Number.isFinite(Number(j.overall)) ? { reportedOverall: Number(j.overall) } : {}), ...(missing.length && vals.length ? { missingCriteria: missing } : {}) };
  }
  throw new Error(`no judge JSON with criteria found in: ${String(text).slice(-300)}`);
}

/** The final text, cost, tokens and turns of a stream-json transcript (or the plain text when it is not JSON). */
export function judgeTranscript(stdout) {
  const lines = String(stdout).split('\n').filter(Boolean);
  const ev = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const res = ev.filter((e) => e?.type === 'result');
  const last = res.at(-1);
  let text = last && typeof last.result === 'string' ? last.result : '';
  if (!text) {
    const asst = ev.filter((e) => e?.type === 'assistant').flatMap((e) => (e.message?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text));
    text = asst.at(-1) ?? (ev.length ? '' : String(stdout));
  }
  const u = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let costUsd = null, turns = 0;
  for (const r of res) {
    if (typeof r.total_cost_usd === 'number') costUsd = (costUsd ?? 0) + r.total_cost_usd;
    if (typeof r.num_turns === 'number') turns += r.num_turns;
    u.input += r.usage?.input_tokens ?? 0; u.output += r.usage?.output_tokens ?? 0; u.cacheRead += r.usage?.cache_read_input_tokens ?? 0; u.cacheCreation += r.usage?.cache_creation_input_tokens ?? 0;
  }
  return { text, costUsd, turns, tokens: u, isError: !!last?.is_error };
}

export const JUDGE_PROMPT = `Read rubric.md in the current directory and follow it. Then read task.md, sound.txt and every sheet-*.png file listed below, score the deliverable, and end your answer with the JSON object the rubric asks for (nothing after it).

Sheets: `;

/** Run the judge once in judgeDir. Returns {..., judge: {costUsd, tokens, turns, wallSec, model, exitCode}} or throws. */
export function runJudge({ judgeDir, sheets, claude = 'claude', model = 'claude-opus-5-5', timeoutMs = 600_000, transcript, env = process.env }) {
  const args = ['-p', JUDGE_PROMPT + sheets.join(', '), '--output-format', 'stream-json', '--verbose', '--model', model, '--max-turns', '20',
    '--allowedTools', 'Read', '--disallowedTools', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch'];
  return new Promise((done, fail) => {
    const t0 = Date.now();
    const p = spawn(claude, args, { cwd: judgeDir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const out = [], err = [];
    p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => err.push(d));
    const timer = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); fail(new Error(`judge did not start: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString();
      if (transcript) { try { writeFileSync(transcript, stdout); } catch { /* best effort */ } }
      const t = judgeTranscript(stdout);
      const judge = { model, costUsd: t.costUsd, tokens: t.tokens, turns: t.turns, wallSec: Math.round((Date.now() - t0) / 100) / 10, exitCode: code };
      try { done({ ...parseJudgeJson(t.text), judge }); } catch (e) {
        const er = new Error(`${e.message}${code ? ` (judge exited ${code}: ${Buffer.concat(err).toString().slice(-300)})` : ''}`);
        er.judge = judge;
        fail(er);
      }
    });
  });
}

/**
 * Vision-score a run dir: pick its deliverables, make sheets and the sound summary, run the judge once.
 * Writes sheets, sound.txt and the judge transcript to keepDir (when given). Never throws: returns
 * {overall, criteria, notes, deliverables, judge} or {error, deliverables, judge?} / {skipped}.
 */
export async function visionScore({ dir, taskMd, meta = {}, result = {}, claude = 'claude', model = 'claude-opus-5-5', keepDir, timeoutMs, env } = {}) {
  const deliverables = pickDeliverables(dir, { meta, result });
  if (!deliverables.length) return { skipped: 'no deliverable (no video or image output found)', deliverables: [] };
  const judgeDir = mkdtempSync(join(tmpdir(), 'mgl-vision-judge-'));
  try {
    const sheets = [], sound = [];
    for (const [i, f] of deliverables.entries()) {
      const name = `sheet-${i + 1}.png`;
      try {
        const s = await contactSheet(join(dir, f), join(judgeDir, name));
        sheets.push(name);
        sound.push(`${name} = ${f} (${s.kind}${s.kind === 'video' ? `; frames at ${s.times.map((t) => t.toFixed(2)).join(', ')} s` : ''})`);
      } catch (e) { sound.push(`${f}: no sheet (${String(e.message).slice(0, 200)})`); }
      sound.push(await soundSummary(join(dir, f), f), '');
    }
    if (!sheets.length) return { error: 'no contact sheet could be made', deliverables };
    writeFileSync(join(judgeDir, 'sound.txt'), sound.join('\n'));
    writeFileSync(join(judgeDir, 'task.md'), taskMd ?? '');
    copyFileSync(RUBRIC, join(judgeDir, 'rubric.md'));
    if (keepDir) {
      mkdirSync(keepDir, { recursive: true });
      for (const n of [...sheets, 'sound.txt']) copyFileSync(join(judgeDir, n), join(keepDir, n));
    }
    try {
      const r = await runJudge({ judgeDir, sheets, claude, model, timeoutMs, env, transcript: keepDir ? join(keepDir, 'judge.jsonl') : undefined });
      return { ...r, deliverables };
    } catch (e) { return { error: String(e.message).slice(0, 600), deliverables, ...(e.judge ? { judge: e.judge } : {}) }; }
  } finally { rmSync(judgeDir, { recursive: true, force: true }); }
}
