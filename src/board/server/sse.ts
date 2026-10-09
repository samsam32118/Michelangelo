/** Server-Sent Events: one hub per server, a heartbeat every 15 s so proxies and the page notice a dead link. */
import type { ServerResponse } from 'node:http';

export type EventName = 'state' | 'project' | 'view' | 'focus' | 'toast';

export class SseHub {
  private clients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout;
  constructor(heartbeatMs = 15000) {
    this.timer = setInterval(() => { for (const c of this.clients) c.write(': hb\n\n'); }, heartbeatMs);
    this.timer.unref();
  }
  get size(): number { return this.clients.size; }
  /** Take over a response; `hello` writes the first events (current state). */
  add(res: ServerResponse, hello: (send: (ev: EventName, data: unknown) => void) => void): void {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 1000\n\n');
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
    hello((ev, data) => res.write(frame(ev, data)));
  }
  send(ev: EventName, data: unknown): void {
    const f = frame(ev, data);
    for (const c of this.clients) c.write(f);
  }
  close(): void {
    clearInterval(this.timer);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}

const frame = (ev: string, data: unknown): string => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
