import type { ShowInfo } from '../../shared/capabilities';
import { parseShowResponse } from '../../shared/registry';
import type { UsageInfo } from '../../shared/api';
import { redact } from '../../shared/redact';
import { errorFromStatus, OllamaError, parseRetryAfter } from './errors';
import { ConcurrencyLimiter } from './limiter';
import { readNdjson } from './ndjson';

// OllamaCloudAdapter: único ponto do app que fala com https://ollama.com.
// Autenticação (docs.ollama.com/api/authentication): header "Authorization: Bearer <OLLAMA_API_KEY>".
// Endpoints usados: GET /api/tags, POST /api/show, POST /api/chat (NDJSON em stream).

export interface ChatToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[]; // base64 sem prefixo data:
  tool_calls?: ChatToolCall[];
  tool_name?: string;
  /** Raciocínio retornado pelo modelo; só circula em memória durante um loop de tools. */
  thinking?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  format?: 'json' | Record<string, unknown>;
  think?: boolean | string;
  options?: { temperature?: number; top_p?: number; seed?: number; num_ctx?: number; num_predict?: number };
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_calls'; calls: Array<{ name: string; args: Record<string, unknown> }> }
  | { type: 'done'; usage: UsageInfo };

export interface AdapterOptions {
  baseUrl?: string;
  getApiKey: () => string | undefined;
  fetchImpl?: typeof fetch;
  limiter?: ConcurrencyLimiter;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  retry?: { attempts: number; baseMs: number; maxMs: number };
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Somente testes: permite http://localhost. */
  allowLocalHttp?: boolean;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export const DEFAULT_BASE_URL = 'https://ollama.com';

export function assertSafeBaseUrl(raw: string, allowLocalHttp = false): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OllamaError('BAD_REQUEST', 'URL base inválida.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(allowLocalHttp && local && u.protocol === 'http:')) {
    throw new OllamaError('BAD_REQUEST', 'A URL base deve usar https.');
  }
  return u.origin;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new OllamaError('ABORTED', 'Cancelado.'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new OllamaError('ABORTED', 'Cancelado.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

interface Attempt {
  res: Response;
  ctl: AbortController;
  cleanup: () => void;
  touch: () => void;
  timedOut: () => 'connect' | 'idle' | null;
  userAborted: () => boolean;
}

export class OllamaCloudAdapter {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  readonly limiter: ConcurrencyLimiter;
  private readonly connectMs: number;
  private readonly idleMs: number;
  private readonly retry: { attempts: number; baseMs: number; maxMs: number };
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly opts: AdapterOptions) {
    this.base = assertSafeBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL, opts.allowLocalHttp);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limiter = opts.limiter ?? new ConcurrencyLimiter(1);
    this.connectMs = opts.connectTimeoutMs ?? 30_000;
    this.idleMs = opts.idleTimeoutMs ?? 120_000;
    this.retry = opts.retry ?? { attempts: 3, baseMs: 500, maxMs: 8_000 };
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const a = await this.request('GET', '/api/tags', undefined, signal);
    try {
      const json = (await a.res.json()) as { models?: Array<{ name?: string; model?: string }> };
      return (json.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean);
    } finally {
      a.cleanup();
    }
  }

  async showModel(model: string, signal?: AbortSignal): Promise<ShowInfo> {
    const a = await this.request('POST', '/api/show', { model }, signal);
    try {
      return parseShowResponse(await a.res.json());
    } finally {
      a.cleanup();
    }
  }

  /** Streaming de /api/chat. Uma vaga do limitador é mantida até o fim (ou cancelamento). */
  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const release = await this.limiter.acquire(signal);
    const startedAt = Date.now();
    let attempt: Attempt | undefined;
    try {
      attempt = await this.request('POST', '/api/chat', { ...req, stream: true }, signal);
      if (!attempt.res.body) throw new OllamaError('PROTOCOL', 'Resposta sem corpo de streaming.');
      let ttftMs: number | undefined;
      const mark = () => {
        if (ttftMs === undefined) ttftMs = Date.now() - startedAt;
      };
      let sawDone = false;
      try {
        for await (const chunk of readNdjson(attempt.res.body, attempt.touch)) {
          if (typeof chunk.error === 'string') throw new OllamaError('SERVER', `Erro durante o streaming: ${chunk.error}`);
          const msg = (chunk.message ?? {}) as { content?: unknown; thinking?: unknown; tool_calls?: unknown };
          if (typeof msg.thinking === 'string' && msg.thinking) {
            mark();
            yield { type: 'reasoning', text: msg.thinking };
          }
          if (typeof msg.content === 'string' && msg.content) {
            mark();
            yield { type: 'delta', text: msg.content };
          }
          if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
            mark();
            yield { type: 'tool_calls', calls: normalizeToolCalls(msg.tool_calls) };
          }
          if (chunk.done === true) {
            sawDone = true;
            yield { type: 'done', usage: buildUsage(chunk, ttftMs, Date.now() - startedAt) };
          }
        }
      } catch (e) {
        throw this.mapStreamError(e, attempt);
      }
      if (!sawDone) throw new OllamaError('PROTOCOL', 'Stream terminou sem o marcador final (done).');
    } finally {
      attempt?.ctl.abort(); // garante o fechamento da conexão (inclusive no cancelamento do consumidor)
      attempt?.cleanup();
      release();
    }
  }

  // ---- internos -------------------------------------------------------------

  private mapStreamError(e: unknown, a: Attempt): unknown {
    if (e instanceof OllamaError) return e;
    if (a.userAborted()) return new OllamaError('ABORTED', 'Cancelado pelo usuário.');
    const t = a.timedOut();
    if (t === 'idle') return new OllamaError('TIMEOUT', 'O modelo ficou muito tempo sem enviar dados (timeout de ociosidade).');
    return new OllamaError('NETWORK', `Conexão interrompida: ${(e as Error)?.message ?? 'erro desconhecido'}`);
  }

  private async request(method: 'GET' | 'POST', path: string, body: unknown, userSignal?: AbortSignal): Promise<Attempt> {
    const key = this.opts.getApiKey();
    if (!key) throw new OllamaError('NO_API_KEY', 'Nenhuma chave da API configurada.');

    let lastErr: OllamaError | undefined;
    for (let n = 0; n < this.retry.attempts; n++) {
      if (userSignal?.aborted) throw new OllamaError('ABORTED', 'Cancelado.');
      const ctl = new AbortController();
      let timedOut: 'connect' | 'idle' | null = null;
      let userAborted = false;
      const onUser = () => {
        userAborted = true;
        ctl.abort();
      };
      userSignal?.addEventListener('abort', onUser, { once: true });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (ms: number, kind: 'connect' | 'idle') => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = kind;
          ctl.abort();
        }, ms);
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        userSignal?.removeEventListener('abort', onUser);
      };
      const attempt = (res: Response): Attempt => ({
        res,
        ctl,
        cleanup,
        touch: () => arm(this.idleMs, 'idle'),
        timedOut: () => timedOut,
        userAborted: () => userAborted,
      });

      arm(this.connectMs, 'connect');
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            Accept: 'application/json',
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: ctl.signal,
        });
      } catch (e) {
        cleanup();
        if (userAborted) throw new OllamaError('ABORTED', 'Cancelado.');
        lastErr =
          timedOut === 'connect'
            ? new OllamaError('TIMEOUT', 'Tempo esgotado ao conectar com a Ollama Cloud.')
            : new OllamaError('NETWORK', `Falha de rede: ${redact((e as Error)?.message ?? 'desconhecida', [key])}`);
        if (n < this.retry.attempts - 1) {
          await this.sleep(this.backoff(n), userSignal);
          continue;
        }
        throw lastErr;
      }

      if (res.ok) {
        arm(this.idleMs, 'idle');
        return attempt(res);
      }

      const text = await res.text().catch(() => '');
      cleanup();
      const err = errorFromStatus(res.status, redact(text, [key]), parseRetryAfter(res.headers.get('retry-after')));
      lastErr = err;
      const wait = err.retryAfterMs ?? this.backoff(n);
      // Espera longa demais (ex.: cota esgotada): devolve o erro à UI em vez de travar.
      if (!err.retryable || n >= this.retry.attempts - 1 || wait > this.retry.maxMs) throw err;
      this.opts.log?.('warn', `Tentativa ${n + 1} falhou (${err.code}); nova tentativa em ${wait}ms`);
      await this.sleep(wait, userSignal);
    }
    throw lastErr ?? new OllamaError('NETWORK', 'Falha desconhecida.');
  }

  private backoff(n: number): number {
    const exp = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** n);
    return Math.round(exp / 2 + Math.random() * (exp / 2)); // jitter
  }
}

function normalizeToolCalls(raw: unknown[]): Array<{ name: string; args: Record<string, unknown> }> {
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const c of raw) {
    const fn = (c as { function?: { name?: unknown; arguments?: unknown } })?.function;
    if (!fn || typeof fn.name !== 'string') continue;
    let args: Record<string, unknown> = {};
    if (fn.arguments && typeof fn.arguments === 'object') args = fn.arguments as Record<string, unknown>;
    else if (typeof fn.arguments === 'string') {
      try {
        const parsed = JSON.parse(fn.arguments) as unknown;
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
      } catch {
        /* argumentos inválidos: segue vazio e a validação do schema recusa */
      }
    }
    out.push({ name: fn.name, args });
  }
  return out;
}

function buildUsage(chunk: Record<string, unknown>, ttftMs: number | undefined, wallMs: number): UsageInfo {
  const num = (k: string) => (typeof chunk[k] === 'number' ? (chunk[k] as number) : undefined);
  const evalCount = num('eval_count');
  const evalDur = num('eval_duration');
  const total = num('total_duration');
  const usage: UsageInfo = { totalMs: total !== undefined ? Math.round(total / 1e6) : wallMs };
  const p = num('prompt_eval_count');
  if (p !== undefined) usage.promptTokens = p;
  if (evalCount !== undefined) usage.completionTokens = evalCount;
  if (ttftMs !== undefined) usage.ttftMs = ttftMs;
  if (evalCount && evalDur) usage.tokensPerSec = Math.round((evalCount / (evalDur / 1e9)) * 10) / 10;
  if (typeof chunk.done_reason === 'string') usage.doneReason = chunk.done_reason;
  return usage;
}
