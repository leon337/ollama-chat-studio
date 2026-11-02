import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// Servidor Ollama SIMULADO. Nenhum teste fala com a nuvem real (não consome franquia).

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: any;
}

export type ChatHandler = (req: IncomingMessage, res: ServerResponse, body: any) => unknown;

export const chunk = (text: string, extra: Record<string, unknown> = {}) => ({ model: 'm', message: { role: 'assistant', content: text, ...extra }, done: false });
export const thinkingChunk = (text: string) => ({ model: 'm', message: { role: 'assistant', content: '', thinking: text }, done: false });
export const toolCallChunk = (name: string, args: Record<string, unknown>) => ({
  model: 'm',
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] },
  done: false,
});
export const doneChunk = (extra: Record<string, unknown> = {}) => ({
  model: 'm',
  message: { role: 'assistant', content: '' },
  done: true,
  done_reason: 'stop',
  total_duration: 2_000_000_000,
  prompt_eval_count: 5,
  eval_count: 10,
  eval_duration: 1_000_000_000,
  ...extra,
});

export function writeNdjson(res: ServerResponse, objs: unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const o of objs) res.write(`${JSON.stringify(o)}\n`);
  res.end();
}

export class MockOllama {
  server!: Server;
  port = 0;
  requests: Recorded[] = [];
  chatHandlers: ChatHandler[] = [];
  tags: string[] = ['beam', 'gemma4:31b', 'gpt-oss:120b', 'gpt-oss:20b', 'nemotron-3-nano:30b', 'nemotron-3-super', 'nemotron-3-ultra'];
  show: Record<string, unknown> = {};
  aborted = 0;
  active = 0;
  maxActive = 0;

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  chatRequests(): Recorded[] {
    return this.requests.filter((r) => r.url === '/api/chat');
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', async () => {
        const raw = Buffer.concat(parts).toString('utf8');
        let body: any;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = raw;
        }
        this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return void res.end(JSON.stringify({ models: this.tags.map((name) => ({ name, model: name })) }));
        }
        if (req.url === '/api/show') {
          const spec = this.show[body?.model];
          if (!spec) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return void res.end(JSON.stringify({ error: 'model not found' }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return void res.end(JSON.stringify(spec));
        }
        if (req.url === '/api/chat') {
          this.active++;
          this.maxActive = Math.max(this.maxActive, this.active);
          res.on('close', () => {
            this.active--;
            if (!res.writableEnded) this.aborted++;
          });
          const h = this.chatHandlers.shift();
          if (!h) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return void res.end(JSON.stringify({ error: 'sem handler configurado' }));
          }
          return void (await h(req, res, body));
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until(): tempo esgotado');
    await wait(10);
  }
}
