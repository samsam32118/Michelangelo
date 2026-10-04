import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, symlinkSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { getFfmpeg, resetFfmpeg, parseVersion, parseList, loadManifest, downloadBuild, type BuildEntry } from '../../src/media/ffmpeg.js';
import { filterToString, filtersToString, escapeValue } from '../../src/media/filters.js';
import { tempDir } from './media-fixtures.js';

const t = tempDir();
const env = { ...process.env };
afterEach(() => { process.env = { ...env }; resetFfmpeg(); });
afterAll(() => t.cleanup());

describe('locating ffmpeg', () => {
  it('parses versions and capability listings', () => {
    expect(parseVersion('ffmpeg version 6.1.1-3ubuntu5 Copyright')).toMatchObject({ major: 6, minor: 1 });
    expect(parseVersion('ffmpeg version n7.0.2 Copyright')).toMatchObject({ major: 7, minor: 0 });
    expect(parseVersion('ffmpeg version N-112233-gabc Copyright')).toMatchObject({ major: 99 });
    expect(parseVersion('ffmpeg version 5.1.4 Copyright')).toMatchObject({ major: 5, minor: 1 });
    expect(parseVersion('hello')).toBeNull();
    expect(parseList('Encoders:\n V..... = Video\n ------\n V....D libx264              libx264 H.264\n A....D aac                  AAC\n', 'codec')).toEqual(['libx264', 'aac']);
    expect(parseList('Filters:\n  T.. = Timeline support\n ... abench            A->A       Benchmark\n TSC ebur128           A->N       EBU\n', 'filter')).toEqual(['abench', 'ebur128']);
  });
  it('finds the system ffmpeg with its encoders and filters', async () => {
    const i = await getFfmpeg();
    expect(i.source).toBe('system');
    expect(i.encoders).toEqual(expect.arrayContaining(['libx264', 'aac', 'prores_ks', 'libvpx-vp9']));
    expect(i.filters).toEqual(expect.arrayContaining(['ebur128', 'loudnorm', 'sidechaincompress', 'silencedetect']));
    expect(i.licence).toMatch(/GPL/);
    expect(await getFfmpeg()).toBe(i);
  });
  it('honours MGL_FFMPEG and reports a bad one with a fix', async () => {
    process.env.MGL_FFMPEG = '/usr/bin/ffmpeg';
    expect((await getFfmpeg()).source).toBe('env');
    resetFfmpeg();
    process.env.MGL_FFMPEG = join(t.dir, 'nope');
    await expect(getFfmpeg()).rejects.toMatchObject({ code: 'E_FFMPEG', exitCode: 2, fix: expect.stringContaining('MGL_FFMPEG') });
  });
  it('without ffmpeg on PATH says to run doctor --fetch', async () => {
    process.env.PATH = join(t.dir, 'empty');
    process.env.MGL_CACHE_DIR = join(t.dir, 'cache-none');
    delete process.env.MGL_FFMPEG;
    await expect(getFfmpeg()).rejects.toMatchObject({ code: 'E_FFMPEG', fix: expect.stringContaining('mgl doctor --fetch') });
  });
  it('the pinned manifest has real linux entries', () => {
    const m = loadManifest();
    for (const k of ['linux-x64', 'linux-arm64']) {
      expect(m.platforms[k]).toMatchObject({ url: expect.stringMatching(/^https:\/\//), sha256: expect.stringMatching(/^[0-9a-f]{64}$/), archive: 'tar.xz' });
      expect(m.platforms[k]!.size).toBeGreaterThan(1e6);
    }
  });
  it('downloads, verifies and extracts a build (local server), and refuses a bad checksum', async () => {
    const pkg = join(t.dir, 'pkg', 'ff-test');
    mkdirSync(pkg, { recursive: true });
    copyFileSync('/usr/bin/ffmpeg', join(pkg, 'ffmpeg'));
    copyFileSync('/usr/bin/ffprobe', join(pkg, 'ffprobe'));
    const tarball = join(t.dir, 'ff.tar.xz');
    execFileSync('tar', ['-cJf', tarball, '-C', join(t.dir, 'pkg'), 'ff-test']);
    const body = readFileSync(tarball);
    const server = createServer((req, res) => {
      const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
      if (range) { res.writeHead(206, { 'content-length': body.length - Number(range[1]) }); res.end(body.subarray(Number(range[1]))); }
      else { res.writeHead(200, { 'content-length': body.length }); res.end(body); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ff.tar.xz`;
      const entry: BuildEntry = { url, sha256: createHash('sha256').update(body).digest('hex'), size: body.length, archive: 'tar.xz', dir: 'ff-test', licence: 'test' };
      const dir = join(t.dir, 'dl');
      // a partial earlier download is resumed with a Range request
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'download.tar.xz.part'), body.subarray(0, 1000));
      await downloadBuild(entry, dir, { quiet: true });
      expect(statSync(join(dir, 'ffmpeg')).mode & 0o111).toBeTruthy();
      expect(execFileSync(join(dir, 'ffprobe'), ['-version']).toString()).toMatch(/ffprobe version/);
      await expect(downloadBuild({ ...entry, sha256: '0'.repeat(64) }, join(t.dir, 'dl2'), { quiet: true })).rejects.toMatchObject({ code: 'E_DOWNLOAD' });
      expect(existsSync(join(t.dir, 'dl2', 'download.tar.xz.part'))).toBe(false);
    } finally {
      server.close();
    }
  });
  it.skipIf(!process.env.MGL_TEST_DOWNLOAD)('downloads the real pinned build (MGL_TEST_DOWNLOAD=1)', async () => {
    const bin = join(t.dir, 'bin-tar-only');
    mkdirSync(bin, { recursive: true });
    for (const b of ['tar', 'xz']) symlinkSync(execFileSync('which', [b]).toString().trim(), join(bin, b));
    process.env.PATH = bin;
    process.env.MGL_CACHE_DIR = join(t.dir, 'real');
    delete process.env.MGL_FFMPEG;
    const i = await getFfmpeg({ allowDownload: true, quiet: true });
    expect(i.source).toBe('download');
    expect(i.encoders).toContain('libx264');
  }, 600_000);
});

describe('filters', () => {
  it('escapes values for both parser levels', () => {
    expect(escapeValue('a:b')).toBe('a\\\\:b');
    expect(escapeValue('p(X,Y)')).toBe('p(X\\,Y)');
    expect(escapeValue("it's")).toBe("it\\\\\\'s");
    expect(filterToString({ filter: 'eq', args: { brightness: 0.1, saturation: 1.2 } })).toBe('eq=brightness=0.1:saturation=1.2');
    expect(filterToString({ filter: 'hflip' })).toBe('hflip');
    expect(filtersToString([{ filter: 'negate' }, { filter: 'hue', args: { s: 0 } }])).toBe('negate,hue=s=0');
  });
  it('refuses filters and options that read files or run commands', () => {
    for (const f of ['movie', 'amovie', 'sendcmd', 'zmq', 'drawtext']) expect(() => filterToString({ filter: f })).toThrow(expect.objectContaining({ code: 'E_FILTER' }));
    expect(() => filterToString({ filter: 'curves', args: { psfile: '/etc/passwd' } })).toThrow(expect.objectContaining({ code: 'E_FILTER' }));
    expect(() => filterToString({ filter: 'hue', args: { 's=0,movie': 1 } })).toThrow(expect.objectContaining({ code: 'E_FILTER' }));
    expect(() => filterToString({ filter: 'lut3d', args: { file: '/etc/passwd' } })).toThrow(expect.objectContaining({ code: 'E_FILTER' }));
    expect(() => filterToString({ filter: 'hue', args: { s: Number.NaN } })).toThrow(expect.objectContaining({ code: 'E_FILTER' }));
    try { filterToString({ filter: 'negat' }); } catch (e) { expect((e as { didYouMean: string[] }).didYouMean).toContain('negate'); }
  });
  it('allows lut3d with an existing .cube file, resolved against baseDir', () => {
    writeFileSync(join(t.dir, 'look.cube'), 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
    expect(filterToString({ filter: 'lut3d', args: { file: 'look.cube' } }, { baseDir: t.dir })).toContain('look.cube');
    expect(() => filterToString({ filter: 'lut3d', args: { file: 'missing.cube' } }, { baseDir: t.dir })).toThrow(expect.objectContaining({ code: 'E_FILTER' }));
  });
});
