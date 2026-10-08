import { definePlugin, defineCommand, z, type CommandContext } from 'michelangelo/plugin';

/**
 * maquette: animated 3D shots for Michelangelo, rendered headless with Blender (Cycles, CPU or GPU).
 *
 * A shot is a small Python file with `build(m)` (m = blender/maquette.py: scene, lights, materials, props, and Michelangelo,
 * the studio's robot) or an OpenUSD text stage (.usda) with a camera. `maquette.shot` renders it, encodes it
 * (ProRes 4444 with alpha when the shot is transparent, else H.264), writes it to media/generated/ (cached by a hash of
 * the shot and the settings) and adds it as an asset + clip. `maquette.still` renders a few frames as PNGs into the
 * work folder so an agent can look before paying for a full render.
 *
 * Blender: $MAQUETTE_BLENDER (a blender binary, run with -b), else $MAQUETTE_PYTHON (a Python with the `bpy` module:
 * `pip install bpy`), else `python3`. ffmpeg: $MGL_FFMPEG, else `ffmpeg` on PATH. Node built-ins load lazily.
 */

export const VERSION = '0.1.0';
const SHOT_EXT = ['.py', '.usda'];
const Time = z.union([z.number().int().min(0), z.string().min(1)]);
const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);

interface RenderInfo { frames: number; fps: number; transparent: boolean; width: number; height: number; seconds?: number }
interface Meta extends RenderInfo { shot: string; hash: string; usd?: string; quality?: Quality }
type Quality = 'draft' | 'final';

type Files = { writeFile?(rel: string, data: Uint8Array): Promise<void>; fileExists?(rel: string): Promise<boolean> };

/** The file-name stem for a shot path: "shots/a_pop.py" -> "a_pop". */
export function stem(shot: string): string {
  const base = shot.split(/[\\/]/).pop() ?? shot;
  return base.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'shot';
}

/** What a shot renders to: the generated file name follows the shot, its settings and the kit's own code. */
export async function shotHash(parts: string[]): Promise<string> {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\0');
  return h.digest('hex').slice(0, 10);
}

/** The kit's Python files (so a change to the character or the renderer re-renders every shot). */
async function kitSource(): Promise<{ dir: string; text: string }> {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('../blender/', import.meta.url));
  const text = (await readFile(dir + 'maquette.py', 'utf8')) + (await readFile(dir + 'render_shot.py', 'utf8'));
  return { dir, text };
}

/** Michelangelo's bundled fonts (Montserrat, Inter, ...) for 3D text, when they can be found. */
function fontDir(): string | undefined {
  if (process.env.MAQUETTE_FONTS) return process.env.MAQUETTE_FONTS;
  try {
    const url = import.meta.resolve('michelangelo/plugin');
    return decodeURIComponent(new URL('../../fonts', url).pathname);
  } catch { return undefined; }
}

function fail(code: string, message: string, fix: string): never {
  const e = new Error(`${message} (fix: ${fix})`) as Error & { code: string; fix: string };
  e.code = code; e.fix = fix;
  throw e;
}

async function run(cmd: string, args: string[], what: string): Promise<string> {
  const { spawn } = await import('node:child_process');
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => err.push(d));
    p.on('error', (e) => rej(new Error(`cannot run ${cmd} for ${what}: ${e.message}`)));
    p.on('close', (code) => {
      const so = Buffer.concat(out).toString();
      if (code === 0) return res(so);
      const tail = (Buffer.concat(err).toString() + so).trim().split('\n').filter((l) => /Error|Traceback|line \d+|error/.test(l)).slice(-6).join(' | ');
      rej(new Error(`${what} failed (exit ${code}): ${tail || 'no output'}`));
    });
  });
}

/** How to start Blender: a blender binary (-b), or a Python that has bpy. */
export function blenderCommand(script: string, args: string[]): [string, string[]] {
  const bin = process.env.MAQUETTE_BLENDER;
  if (bin) return [bin, ['-b', '--factory-startup', '--python', script, '--', ...args]];
  return [process.env.MAQUETTE_PYTHON || 'python3', [script, ...args]];
}

const BLENDER_FIX = 'install Blender and set MAQUETTE_BLENDER=/path/to/blender, or `pip install bpy` (Blender as a Python module, Python 3.13 for bpy 5.x) and set MAQUETTE_PYTHON to that python';

/** Render a shot source into PNG frames in a temp folder; returns the folder and what Blender reported. */
async function renderFrames(source: string, ext: string, opts: { res?: string; samples?: number; still?: number[]; usd?: boolean; draft?: boolean }): Promise<{ dir: string; info: RenderInfo; usd?: string }> {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const kit = await kitSource();
  const dir = await mkdtemp(join(tmpdir(), 'maquette-'));
  const shot = join(dir, 'shot' + ext);
  await writeFile(shot, source);
  const args = ['--shot', shot, '--out', join(dir, 'frames')];
  if (opts.draft) args.push('--draft');
  if (opts.res) args.push('--res', opts.res);
  if (opts.samples) args.push('--samples', String(opts.samples));
  if (opts.still?.length) args.push('--still', opts.still.join(','));
  const usd = opts.usd ? join(dir, 'stage.usdc') : undefined;
  if (usd) args.push('--usd', usd);
  const fonts = fontDir();
  if (fonts) args.push('--fonts', fonts);
  const [cmd, argv] = blenderCommand(kit.dir + 'render_shot.py', args);
  let out: string;
  try { out = await run(cmd, argv, 'Blender'); } catch (e) {
    const msg = (e as Error).message;
    if (/cannot run|No module named 'bpy'/.test(msg)) fail('E_BLENDER', `Blender is not available here: ${msg}`, BLENDER_FIX);
    fail('E_SHOT', `the shot did not render: ${msg}`, 'fix the shot file (its build(m) function); `maquette.still` renders single frames faster while you iterate');
  }
  const line = out.trim().split('\n').reverse().find((l) => l.startsWith('{'));
  const info = line ? JSON.parse(line) as RenderInfo & { error?: string } : undefined;
  if (!info || info.error) fail('E_SHOT', `the shot did not render: ${info?.error ?? 'no report from Blender'}`, 'a .py shot needs build(m); a .usda stage needs a camera');
  return { dir, info, ...(usd ? { usd } : {}) };
}

/** Encode the PNG frames; a draft has every second frame, each held for two frames. */
async function encode(frames: string, info: RenderInfo, out: string, draft = false): Promise<void> {
  const ffmpeg = process.env.MGL_FFMPEG || 'ffmpeg';
  const codec = info.transparent
    ? ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0']
    : ['-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  await run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...(draft ? ['-framerate', String(info.fps / 2), '-pattern_type', 'glob', '-i', `${frames}/*.png`, '-r', String(info.fps)] : ['-framerate', String(info.fps), '-start_number', '1', '-i', `${frames}/%04d.png`]), ...codec, out], 'ffmpeg');
}

/** The shot's extension, or an error naming what a shot is. */
export function shotExt(shot: string): string {
  const ext = (shot.match(/\.[^.\\/]+$/)?.[0] ?? '').toLowerCase();
  if (!SHOT_EXT.includes(ext)) fail('E_ARG', `"${shot}" is not a shot file (.py with build(m), or an OpenUSD .usda stage).`, 'binary .usd/.usdc stages: convert with `usdcat in.usdc -o shot.usda`');
  return ext;
}

async function readShot(ctx: CommandContext, shot: string): Promise<{ source: string; ext: string }> {
  const ext = shotExt(shot);
  if (!ctx.services.readText) fail('E_NO_SERVICE', 'maquette reads the shot file, and no file service is available here.', 'run it through the CLI (mgl edit) or the SDK (open(file))');
  return { source: await ctx.services.readText(shot), ext };
}

const shotCmd = defineCommand({
  op: 'maquette.shot', group: 'media',
  doc: 'Render an animated 3D shot (a .py file with build(m) using the maquette kit and its robot Michelangelo, or an OpenUSD .usda stage) headless with Blender, write it to media/generated/maquette-<shot>-<hash>.mov|mp4 (ProRes 4444 with alpha for transparent shots; reused while the shot and settings are unchanged) and add it as a clip. usd=true also writes the stage as OpenUSD (.usdc). quality=draft (the default) is the cheap pass for storyboards and animatics: 360x450, 2 samples, every second frame held, about 12x cheaper than quality=final (the shot\'s own settings, minutes per second of animation). Render final only after a person has approved the draft.',
  schema: z.strictObject({
    shot: z.string().min(1), track: Id, at: Time.optional(), len: Time.optional(), id: Id.optional(),
    res: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(), samples: z.number().int().min(1).max(4096).optional(),
    fit: z.enum(['cover', 'contain', 'fill', 'none']).optional(), usd: z.boolean().optional(),
    quality: z.enum(['draft', 'final']).optional(),
  }),
  primary: 'shot',
  example: { shot: 'shots/hook.py', track: 'V2', at: '0.8s' },
  async apply(ctx, p) {
    shotExt(p.shot);
    const files = ctx.services as typeof ctx.services & Files;
    if (!files.writeFile) fail('E_NO_SERVICE', 'maquette.shot writes the rendered video, and no file service is available here.', 'run it through the CLI (mgl edit) or the SDK (open(file))');
    if (p.id !== undefined && (ctx.project.clips ?? []).some((c) => c.id === p.id)) fail('E_DUPLICATE_ID', `clip "${p.id}" already exists.`, 'choose another id, or omit it');
    const comp = ctx.compOfTrack(p.track);
    const { source, ext } = await readShot(ctx, p.shot);
    const kit = await kitSource();
    const quality: Quality = p.quality ?? 'draft';
    const draft = quality === 'draft';
    const hash = await shotHash([VERSION, source, kit.text, p.res ?? '', String(p.samples ?? ''), p.usd ? 'usd' : '', ...(draft ? ['draft'] : [])]);
    const base = `media/generated/maquette-${stem(p.shot)}-${draft ? 'draft-' : ''}${hash}`;
    let meta: Meta | undefined;
    try { meta = JSON.parse(await ctx.services.readText!(`${base}.json`)) as Meta; } catch { meta = undefined; }
    const src = meta ? `${base}.${meta.transparent ? 'mov' : 'mp4'}` : '';
    const reused = !!meta && (!files.fileExists || (await files.fileExists(src)));
    let rel = src;
    if (!reused) {
      const { readFile, rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const r = await renderFrames(source, ext, { ...(p.res ? { res: p.res } : {}), ...(p.samples ? { samples: p.samples } : {}), usd: !!p.usd, draft });
      try {
        rel = `${base}.${r.info.transparent ? 'mov' : 'mp4'}`;
        const video = join(r.dir, r.info.transparent ? 'shot.mov' : 'shot.mp4');
        await encode(join(r.dir, 'frames'), r.info, video, draft);
        await files.writeFile(rel, new Uint8Array(await readFile(video)));
        meta = { ...r.info, shot: p.shot, hash, quality };
        if (r.usd) { meta.usd = `${base}.usdc`; await files.writeFile(meta.usd, new Uint8Array(await readFile(r.usd))); }
        await files.writeFile(`${base}.json`, new TextEncoder().encode(JSON.stringify(meta, null, 1) + '\n'));
      } finally {
        await rm(r.dir, { recursive: true, force: true });
      }
    }
    const m = meta!;
    const assets = (ctx.project.assets ??= []);
    let asset = assets.find((a) => a.src === rel);
    if (!asset) { asset = { id: ctx.newId(`3d-${stem(p.shot)}`), src: rel, note: `3D shot (maquette): ${p.shot}, ${m.width}x${m.height}${m.transparent ? ', alpha' : ''}` }; assets.push(asset); }
    const rate = ctx.rate(comp);
    const fps = rate.num / rate.den;
    const full = Math.max(1, Math.round((m.frames / m.fps) * fps));
    const at = p.at !== undefined ? ctx.time(p.at, comp, 'at') : 0;
    const len = p.len !== undefined ? Math.min(full, ctx.time(p.len, comp, 'len')) : full;
    const clip = { id: p.id ?? ctx.newId(`shot-${stem(p.shot)}`), track: p.track, at, len, asset: asset.id, ...(p.fit ? { fit: p.fit } : {}) };
    (ctx.project.clips ??= []).push(clip as never);
    ctx.out.id = clip.id; ctx.out.asset = asset.id; ctx.out.src = rel; ctx.out.frames = m.frames; ctx.out.transparent = m.transparent;
    if (m.usd) ctx.out.usd = m.usd;
    ctx.out.rendered = !reused;
    ctx.out.quality = quality;
    ctx.summary(`added 3D shot "${clip.id}" on ${p.track} at ${at}–${at + len} (${(m.frames / m.fps).toFixed(2)}s, ${m.width}x${m.height}${m.transparent ? ' with alpha' : ''}); ${reused ? 'reused' : `rendered${m.seconds ? ` in ${m.seconds}s` : ''}`} ${rel}${m.usd ? ` and ${m.usd}` : ''}.${draft ? ' This is the draft (360x450, 12 fps, 2 samples), for the storyboard and animatic: once a person has watched it and the story works, re-run with quality=final.' : ''}`);
  },
});

const stillCmd = defineCommand({
  op: 'maquette.still', group: 'media',
  doc: 'Render a few frames of a 3D shot as PNGs into the work folder (.mgl/<project>/maquette-<shot>-<frame>.png), at draft quality (360x450, 2 samples, a few seconds each): the storyboard panels to check framing and acting before any animation is rendered. Changes nothing in the project.',
  schema: z.strictObject({ shot: z.string().min(1), frames: z.array(z.number().int().min(1)).min(1).max(12).optional(), res: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(), samples: z.number().int().min(1).max(4096).optional() }),
  primary: 'shot',
  example: { shot: 'shots/hook.py', frames: [1, 24, 48] },
  async apply(ctx, p) {
    shotExt(p.shot);
    if (!ctx.services.writeWork) fail('E_NO_SERVICE', 'maquette.still writes images into the work folder, and none is available here.', 'run it through the CLI (mgl edit)');
    const { source, ext } = await readShot(ctx, p.shot);
    const frames = p.frames ?? [1];
    const { readFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const r = await renderFrames(source, ext, { draft: true, ...(p.res ? { res: p.res } : {}), ...(p.samples ? { samples: p.samples } : {}), still: frames });
    const paths: string[] = [];
    try {
      for (const f of frames) {
        const png = await readFile(join(r.dir, 'frames', `still_${String(f).padStart(4, '0')}.png`));
        paths.push(await ctx.services.writeWork(`maquette-${stem(p.shot)}-${f}.png`, new Uint8Array(png)));
      }
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
    ctx.out.images = paths;
    ctx.summary(`rendered ${frames.length} frame${frames.length > 1 ? 's' : ''} of ${p.shot} (${r.info.width}x${r.info.height}; look at them): ${paths.join(', ')}`);
  },
});

export default definePlugin({ name: 'maquette', version: VERSION, commands: [shotCmd, stillCmd] });
