/** `mgl doctor`: what this machine has (node, ffmpeg, fonts, cores, memory, disk, proxy, trust store, plugins) and a fix for each gap. */
import { statfsSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { MglError } from '../core/errors.js';
import { bool, bytesText, type Args, type Out } from './io.js';

const ENCODERS = ['libx264', 'aac', 'libvpx-vp9', 'prores_ks', 'libmp3lame', 'libopus', 'gif'];
const DECODERS = ['hevc', 'h264', 'prores'];
const FILTERS = ['loudnorm', 'ebur128', 'silencedetect', 'sidechaincompress', 'lut3d', 'zscale', 'flite', 'drawtext'];
const WHY: Record<string, string> = {
  'libvpx-vp9': '.webm output', prores_ks: '.mov (ProRes) output', libmp3lame: '.mp3 output', libopus: '.webm audio', gif: '.gif output',
  hevc: 'HEVC (iPhone) input', prores: 'ProRes input', loudnorm: 'audio.normalize', ebur128: 'loudness in look', silencedetect: 'audio.cut-silences, captions timing',
  sidechaincompress: 'ducking', lut3d: 'the lut effect', zscale: 'HDR → SDR tone mapping', flite: 'speech fixtures (tests, evals)', drawtext: 'text fixtures (tests, evals)',
};

export async function doctor(a: Args, o: Out) {
  const gaps: { what: string; fix: string; fatal?: boolean; code?: string }[] = [];
  const lines: string[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  lines.push(`node ${process.versions.node}${major >= 22 ? '' : '  (need ≥ 22)'}`);
  if (major < 22) gaps.push({ what: `node ${process.versions.node} is older than 22`, fix: 'install Node 22 or newer (nvm install 22).', fatal: true });

  const media = await import('../media/index.js');
  let ff: Awaited<ReturnType<typeof media.getFfmpeg>> | undefined;
  try {
    if (bool(a, 'fetch')) media.resetFfmpeg();
    ff = await media.getFfmpeg({ allowDownload: bool(a, 'fetch') });
  } catch (e) {
    if (!(e instanceof MglError)) throw e;
    lines.push(`ffmpeg: not usable — ${e.message}`);
    gaps.push({ what: 'no usable ffmpeg', fix: e.fix, fatal: true, code: e.code });
  }
  const has = { encoders: [] as string[], decoders: [] as string[], filters: [] as string[] };
  if (ff) {
    lines.push(`ffmpeg ${ff.version} (${ff.source}, ${ff.licence}) ${ff.ffmpeg}`);
    const check = (kind: 'encoders' | 'decoders' | 'filters', names: string[]) => {
      const set = new Set(ff![kind]);
      const ok = names.filter((n) => set.has(n)), missing = names.filter((n) => !set.has(n));
      has[kind] = ok;
      lines.push(`  ${kind}: ${ok.join(' ') || '-'}${missing.length ? `  missing: ${missing.join(' ')}` : ''}`);
      for (const n of missing) gaps.push({ what: `ffmpeg lacks ${n.replace(/^/, kind === 'filters' ? 'filter ' : kind === 'encoders' ? 'encoder ' : 'decoder ')} (${WHY[n] ?? 'optional'})`, fix: ff!.source === 'system' ? 'run "mgl doctor --fetch" for the pinned full build, or set MGL_FFMPEG to an ffmpeg that has it.' : 'set MGL_FFMPEG to an ffmpeg build that has it.' });
    };
    check('encoders', ENCODERS);
    check('decoders', DECODERS);
    check('filters', FILTERS);
  }

  let fonts = 0, families: string[] = [];
  try {
    const { registerFonts } = await import('../render/text.js');
    const { GlobalFonts } = await import('@napi-rs/canvas');
    registerFonts();
    families = [...new Set(GlobalFonts.families.map((f: { family: string }) => f.family))].filter((f) => /Inter|Noto|Anton|JetBrains/.test(f));
    fonts = families.length;
    lines.push(`fonts: ${families.join(', ') || 'none bundled'}`);
    if (!fonts) gaps.push({ what: 'the bundled fonts did not register', fix: 'reinstall the package (the fonts/ folder is missing).' });
  } catch (e) {
    lines.push(`skia: not loadable (${(e as Error).message.split('\n')[0]})`);
    gaps.push({ what: 'the Skia renderer (@napi-rs/canvas) does not load', fix: 'run npm install again on this platform (the native binary is per OS/CPU).', fatal: true });
  }

  const cores = cpus().length;
  let disk: number | undefined;
  try { const s = statfsSync(process.cwd()); disk = s.bavail * s.bsize; } catch { /* unknown */ }
  lines.push(`cpus ${cores} · memory ${bytesText(totalmem())} (${bytesText(freemem())} free) · disk free here ${disk === undefined ? '?' : bytesText(disk)}`);
  if (disk !== undefined && disk < 1024 ** 3) gaps.push({ what: `only ${bytesText(disk)} free disk`, fix: 'free some space: renders and caches need ~1 GB (caches: ~/.cache/michelangelo, .mgl/).' });
  const proxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS'].filter((k) => process.env[k]);
  lines.push(`proxy env: ${proxy.length ? proxy.join(', ') : 'none'}`);
  const { trustStorePath, listTrusted, loadRegistry } = await import('../plugin/index.js');
  let trusted = 0;
  try { trusted = listTrusted().length; } catch { /* unreadable store: reported by plugin commands */ }
  lines.push(`trust store: ${trustStorePath()} (${trusted} trusted)`);

  let plugins: unknown;
  const file = a.pos[0];
  if (file) {
    const { Project } = await import('../sdk/project.js');
    const p = await Project.open(file);
    const reg = await loadRegistry(p.data, p.dir);
    const extra = [...reg.plugins].filter(([, i]) => i.source !== 'builtin');
    lines.push(`plugins of ${file}: ${extra.length ? extra.map(([n, i]) => `${n} ${i.version}`).join(', ') : 'none (built-ins only)'}`);
    for (const pr of reg.problems.filter((x) => x.severity === 'error')) gaps.push({ what: pr.message, fix: pr.fix });
    plugins = { loaded: reg.loaded, problems: reg.problems };
  }

  lines.push(gaps.length ? `${gaps.length} gap${gaps.length > 1 ? 's' : ''}:` : 'ready: nothing missing');
  for (const g of gaps) lines.push(`  ${g.fatal ? 'error' : 'warn'} ${g.what}`, `    fix: ${g.fix}`);
  o.line(...lines);
  const fatal = gaps.find((g) => g.fatal);
  if (fatal) { o.exit = 2; o.set({ error: { code: fatal.code ?? 'E_ENVIRONMENT', message: fatal.what, fix: fatal.fix } }); }
  o.set({ node: process.versions.node, ffmpeg: ff ? { path: ff.ffmpeg, ffprobe: ff.ffprobe, version: ff.version, source: ff.source, licence: ff.licence, ...has } : null, fonts: families, cpus: cores, memory: { total: totalmem(), free: freemem() }, disk, proxy, trustStore: trustStorePath(), plugins, gaps });
}
