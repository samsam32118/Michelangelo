/**
 * Watch a set of files for changes made by others (a hand edit, the CLI door, mgl edit on the project). Watches their
 * folders (atomic writes replace the inode), debounces 150 ms, and compares mtime + size so the server's own writes,
 * recorded with `mark`, are ignored. Falls back to polling where fs.watch is unavailable.
 */
import { statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const sig = (p: string): string => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; } };

export class FileWatch {
  private files = new Map<string, string>();
  private watchers = new Map<string, FSWatcher>();
  private timer: NodeJS.Timeout | undefined;
  private poll: NodeJS.Timeout | undefined;
  private closed = false;
  constructor(private onChange: (file: string) => void, private debounceMs = 150, private pollMs = 1000) {}

  /** Watch exactly these files (others are dropped). */
  set(files: string[]): void {
    const want = new Set(files.map((f) => resolve(f)));
    for (const f of [...this.files.keys()]) if (!want.has(f)) this.files.delete(f);
    for (const f of want) if (!this.files.has(f)) this.files.set(f, sig(f));
    const dirs = new Set([...want].map((f) => dirname(f)));
    for (const [d, w] of this.watchers) if (!dirs.has(d)) { w.close(); this.watchers.delete(d); }
    for (const d of dirs) {
      if (this.watchers.has(d)) continue;
      try {
        const names = () => new Set([...this.files.keys()].filter((f) => dirname(f) === d).map((f) => basename(f)));
        const w = watch(d, { persistent: false }, (_e, name) => { if (!name || names().has(String(name))) this.kick(); });
        w.on('error', () => { w.close(); this.watchers.delete(d); this.startPolling(); });
        this.watchers.set(d, w);
      } catch { this.startPolling(); }
    }
  }
  /** Record the current state of a file as known (the server just wrote it). */
  mark(file: string): void { const f = resolve(file); if (this.files.has(f)) this.files.set(f, sig(f)); }
  /** Check now (also what the debounce and the poll call). */
  check(): void {
    if (this.closed) return;
    for (const [f, old] of this.files) {
      const now = sig(f);
      if (now !== old) { this.files.set(f, now); this.onChange(f); }
    }
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.poll);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
  private kick(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), this.debounceMs);
    this.timer.unref();
  }
  private startPolling(): void {
    if (this.poll || this.closed) return;
    this.poll = setInterval(() => this.check(), this.pollMs);
    this.poll.unref();
  }
}
