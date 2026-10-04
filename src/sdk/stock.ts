/**
 * Open-media services (plugin API 1.4) behind media.search / media.fetch: every 'stock' provider of the registry,
 * HTTP with a descriptive User-Agent and timeouts, a 30-day item cache (so media.fetch can find what media.search
 * showed), confined downloads into <project>/media/stock/, sidecars, and a numbered contact sheet of previews.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile, open as openFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fail } from '../core/errors.js';
import type { StockService } from '../core/commands/registry.js';
import type { StockContext, StockItem, StockProvider, StockQuery } from '../plugin/api.js';
import type { PluginRegistry } from '../plugin/registry.js';
import { cacheRoot } from '../media/ffmpeg.js';
import { confined } from './services.js';

/** Download paths: media/stock/<kind>/<name>.<ext> (and .json sidecars). */
const STOCK_PATH = /^media\/stock\/(image|video|music|sfx)\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ITEM_TTL_MS = 30 * 24 * 3600 * 1000;
const SEARCH_TIMEOUT_MS = 30_000, DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
export const USER_AGENT = 'michelangelo/0.1 (video editing library for AI agents; +https://github.com/samsam32118/Michelangelo)';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface StockOptions {
  /** HTTP for tests (recorded responses); default: global fetch */
  fetch?: FetchFn;
  /** environment for API keys (default: process.env) */
  env?: Record<string, string | undefined>;
  /** cache root (default: cacheRoot()/stock) */
  cacheDir?: string;
}

export function stockProviders(registry: PluginRegistry | undefined): StockProvider[] {
  const m = registry?.providers?.get('stock');
  return m ? ([...m.values()] as StockProvider[]) : [];
}

/** A StockContext for one provider: UA header, timeout, one retry on 429 / 5xx. */
export function stockContext(provider: string, o: StockOptions, timeoutMs = SEARCH_TIMEOUT_MS): StockContext {
  const http = o.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const env = o.env ?? process.env;
  return {
    async fetch(url, init) {
      const go = () => http(url, { ...init, headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
      let r = await go();
      if (r.status === 429 || r.status >= 500) { await new Promise((res) => setTimeout(res, 1500)); r = await go(); }
      return r;
    },
    env: (name) => { const v = env[name]; return v && v.trim() ? v.trim() : undefined; },
    cacheDir: join(o.cacheDir ?? join(cacheRoot(), 'stock'), provider.replace(/[^A-Za-z0-9._-]/g, '_')),
  };
}

const itemKey = (id: string) => createHash('sha1').update(id).digest('hex');

function looksLikeHtml(head: Buffer): boolean {
  const s = head.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  return s.startsWith('<!doctype html') || s.startsWith('<html') || (s.startsWith('<?xml') && s.includes('<html')) || s.startsWith('{"error');
}

export function stockService(projectDir: string, registry: PluginRegistry | undefined, o: StockOptions = {}): StockService | undefined {
  const providers = stockProviders(registry);
  if (!providers.length) return undefined;
  const root = o.cacheDir ?? join(cacheRoot(), 'stock');
  const memory = new Map<string, StockItem>();
  const byPrefix = (id: string) => providers.find((p) => id.startsWith(`${p.id}:`)) ?? providers.find((p) => id.split(':')[0] === p.id);

  const remember = async (items: StockItem[]) => {
    const dir = join(root, 'items');
    await mkdir(dir, { recursive: true });
    await Promise.all(items.map(async (it) => {
      memory.set(it.id, it);
      try { await writeFile(join(dir, itemKey(it.id) + '.json'), JSON.stringify(it)); } catch { /* cache only */ }
    }));
  };

  const target = (rel: string): string => {
    if (!STOCK_PATH.test(rel)) fail('E_PATH', `open media goes in media/stock/<kind>/, not "${rel}".`, 'use media.fetch; it names the file.');
    return confined(projectDir, rel);
  };

  const svc: StockService = {
    providers: providers.map((p) => ({ id: p.id, describe: p.describe, media: [...p.media], ...(p.sources ? { sources: [...p.sources] } : {}) })),

    async search(q) {
      const list = providers.filter((p) => p.media.includes(q.kind) && (!q.provider || p.id === q.provider));
      const failed: { provider: string; error: string }[] = [];
      const results = await Promise.all(list.map(async (p) => {
        try {
          const { provider: _drop, ...query } = q;
          const items = await p.search(query as StockQuery, stockContext(p.id, o));
          // ids must carry the provider prefix so media.fetch finds the provider again
          return items.filter((it) => it && typeof it.id === 'string' && it.file && it.licence?.id).map((it) => (it.id.startsWith(`${p.id}:`) ? it : { ...it, id: `${p.id}:${it.id}` }));
        } catch (e) {
          failed.push({ provider: p.id, error: ((e as Error).message || String(e)).split('\n')[0]!.slice(0, 200) });
          return [];
        }
      }));
      // interleave providers so one source does not fill the page
      const items: StockItem[] = [];
      for (let i = 0; results.some((r) => i < r.length); i++) for (const r of results) if (i < r.length) items.push(r[i]!);
      await remember(items);
      return { items, failed };
    },

    async item(id) {
      if (memory.has(id)) return memory.get(id);
      const file = join(root, 'items', itemKey(id) + '.json');
      try {
        const st = await stat(file);
        if (Date.now() - st.mtimeMs < ITEM_TTL_MS) { const it = JSON.parse(await readFile(file, 'utf8')) as StockItem; memory.set(id, it); return it; }
      } catch { /* not cached */ }
      const p = byPrefix(id);
      if (!p?.item) return undefined;
      const it = await p.item(id, stockContext(p.id, o));
      if (it) await remember([it.id.startsWith(`${p.id}:`) ? it : { ...it, id: `${p.id}:${it.id}` }]);
      return it ? memory.get(it.id.startsWith(`${p.id}:`) ? it.id : `${p.id}:${it.id}`) ?? it : undefined;
    },

    async download(item, rel) {
      const abs = target(rel);
      await mkdir(dirname(abs), { recursive: true });
      target(rel); // again, now the folder exists (a symlinked media/stock is refused)
      const tmp = `${abs}.${process.pid}.part`;
      const p = byPrefix(item.id);
      try {
        if (p?.fetch) await p.fetch({ item, out: tmp }, stockContext(p.id, o, DOWNLOAD_TIMEOUT_MS));
        else {
          const r = await stockContext(p?.id ?? 'download', o, DOWNLOAD_TIMEOUT_MS).fetch(item.file);
          if (!r.ok) fail('E_DOWNLOAD', `download of ${item.id} failed: HTTP ${r.status} from ${new URL(item.file).host}.`, 'try again later, or pick another result (media.search).');
          await writeFile(tmp, Buffer.from(await r.arrayBuffer()));
        }
        const fh = await openFile(tmp, 'r');
        const head = Buffer.alloc(512);
        const { bytesRead } = await fh.read(head, 0, 512, 0);
        await fh.close();
        if (!bytesRead) fail('E_MEDIA_FILE', `download of ${item.id} is empty.`, 'pick another result (media.search).');
        if (looksLikeHtml(head.subarray(0, bytesRead))) fail('E_MEDIA_FILE', `download of ${item.id} returned a web page, not a media file (the source may need a login or has moved the file).`, 'pick another result (media.search).');
        const data = await readFile(tmp);
        const sha256 = createHash('sha256').update(data).digest('hex');
        await rename(tmp, abs);
        return { bytes: data.length, sha256 };
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },

    async exists(rel) {
      if (!STOCK_PATH.test(rel)) return false;
      const abs = confined(projectDir, rel);
      if (!existsSync(abs)) return false;
      try { return (await stat(abs)).isFile(); } catch { return false; }
    },

    async remove(rel) { await rm(target(rel), { force: true }); },

    async writeSidecar(rel, data) {
      const abs = target(rel);
      if (!rel.endsWith('.json')) fail('E_PATH', `a sidecar is a .json file, not "${rel}".`, 'use <file>.json.');
      await mkdir(dirname(abs), { recursive: true });
      const tmp = `${abs}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 1) + '\n');
      await rename(tmp, abs);
    },

    async readSidecar(rel) {
      try { return JSON.parse(await readFile(target(rel), 'utf8')) as Record<string, unknown>; } catch { return undefined; }
    },

    async sheet(items) {
      const shown = items.filter((it) => it.preview).slice(0, 12);
      if (!shown.length) return undefined;
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const cols = Math.min(4, shown.length), rows = Math.ceil(shown.length / cols);
      const tile = Math.floor(Math.min(1568 / cols, 1568 / rows / 1.15)), label = Math.round(tile * 0.15);
      const cv = createCanvas(cols * tile, rows * (tile + label));
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#16161a';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.textBaseline = 'middle';
      await Promise.all(shown.map(async (it, i) => {
        const x = (i % cols) * tile, y = Math.floor(i / cols) * (tile + label);
        try {
          const p = byPrefix(it.id);
          const r = await stockContext(p?.id ?? 'preview', o, 20_000).fetch(it.preview!);
          if (r.ok) {
            const img = await loadImage(Buffer.from(await r.arrayBuffer()));
            const k = Math.min((tile - 8) / img.width, (tile - 8) / img.height);
            ctx.drawImage(img, x + (tile - img.width * k) / 2, y + (tile - img.height * k) / 2, img.width * k, img.height * k);
          }
        } catch { /* a missing preview leaves the tile empty */ }
        ctx.fillStyle = '#ffd400';
        ctx.font = `bold ${Math.round(label * 0.5)}px "JetBrains Mono", "Inter", sans-serif`;
        const n = items.indexOf(it) + 1;
        ctx.fillText(`${n}`, x + 6, y + tile + label / 2);
        ctx.fillStyle = '#e8e8ec';
        ctx.font = `${Math.round(label * 0.32)}px "JetBrains Mono", "Inter", sans-serif`;
        const size = it.width && it.height ? `${it.width}x${it.height}` : it.seconds ? `${it.seconds.toFixed(1)}s` : '';
        ctx.fillText(`${it.licence.id} ${size}`.trim(), x + 6 + label * 0.7, y + tile + label / 2, tile - label);
      }));
      return new Uint8Array(await cv.encode('png'));
    },
  };
  return svc;
}
