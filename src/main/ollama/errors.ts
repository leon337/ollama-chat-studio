import { redact } from '../../shared/redact';

export type OllamaErrorCode =
  | 'AUTH'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'QUEUE_FULL'
  | 'PROTOCOL'
  | 'NO_API_KEY';

export class OllamaError extends Error {
  readonly code: OllamaErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(code: OllamaErrorCode, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(redact(message));
    this.name = 'OllamaError';
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    this.retryable = code === 'RATE_LIMIT' || code === 'SERVER' || code === 'NETWORK';
  }
}

export function errorFromStatus(status: number, body: string, retryAfterMs?: number): OllamaError {
  const detail = extractMessage(body);
  const opts = { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  if (status === 401 || status === 403) return new OllamaError('AUTH', `Chave da API recusada (${status}). ${detail}`, opts);
  if (status === 404) return new OllamaError('NOT_FOUND', `Modelo ou endpoint não encontrado. ${detail}`, opts);
  if (status === 429) return new OllamaError('RATE_LIMIT', `Limite de uso/concorrência atingido. ${detail}`, opts);
  if (status >= 500) return new OllamaError('SERVER', `Erro no servidor Ollama (${status}). ${detail}`, opts);
  return new OllamaError('BAD_REQUEST', `Requisição inválida (${status}). ${detail}`, opts);
}

function extractMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: unknown };
    if (typeof j.error === 'string') return j.error.slice(0, 300);
  } catch {
    /* corpo não-JSON */
  }
  return body.slice(0, 200);
}

/** "Retry-After" em segundos ou data HTTP -> ms. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
