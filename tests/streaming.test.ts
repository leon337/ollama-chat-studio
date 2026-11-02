import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSafeBaseUrl, OllamaCloudAdapter, type StreamEvent } from '../src/main/ollama/adapter';
import { OllamaError } from '../src/main/ollama/errors';
import { ConcurrencyLimiter } from '../src/main/ollama/limiter';
import { chunk, doneChunk, MockOllama, thinkingChunk, toolCallChunk, until, wait, writeNdjson } from './helpers/mockServer';
import { TEST_KEY } from './helpers/fakes';

const mock = new MockOllama();
beforeAll(() => mock.start());
afterAll(() => mock.stop());
beforeEach(() => {
  mock.requests = [];
  mock.chatHandlers = [];
  mock.aborted = 0;
  mock.maxActive = 0;
});

const make = (o: Partial<ConstructorParameters<typeof OllamaCloudAdapter>[0]> = {}) =>
  new OllamaCloudAdapter({
    baseUrl: mock.baseUrl,
    allowLocalHttp: true,
    getApiKey: () => TEST_KEY,
    retry: { attempts: 3, baseMs: 1, maxMs: 50 },
    sleep: async () => {},
    ...o,
  });

const collect = async (gen: AsyncGenerator<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};
const req = { model: 'gpt-oss:120b', messages: [{ role: 'user' as const, content: 'oi' }] };

describe('streaming de /api/chat', () => {
  it('envia Bearer, faz stream dos deltas e calcula uso/latência', async () => {
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('Olá, '), chunk('mundo'), doneChunk()]));
    const events = await collect(make().chatStream(req));
    expect(events.filter((e) => e.type === 'delta').map((e: any) => e.text).join('')).toBe('Olá, mundo');
    const done: any = events.at(-1);
    expect(done.type).toBe('done');
    expect(done.usage).toMatchObject({ promptTokens: 5, completionTokens: 10, totalMs: 2000, tokensPerSec: 10, doneReason: 'stop' });
    expect(done.usage.ttftMs).toBeGreaterThanOrEqual(0);
    const sent = mock.chatRequests()[0]!;
    expect(sent.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(sent.body.stream).toBe(true);
  });

  it('reconstrói linhas NDJSON partidas entre pedaços de rede', async () => {
    mock.chatHandlers.push(async (_r, res) => {
      res.writeHead(200);
      const line = JSON.stringify(chunk('fragmentado')) + '\n' + JSON.stringify(doneChunk()) + '\n';
      res.write(line.slice(0, 17));
      await wait(15);
      res.write(line.slice(17, 60));
      await wait(15);
      res.end(line.slice(60));
    });
    const events = await collect(make().chatStream(req));
    expect(events.some((e: any) => e.type === 'delta' && e.text === 'fragmentado')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('expõe raciocínio e tool_calls como eventos próprios', async () => {
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [thinkingChunk('pensando…'), toolCallChunk('calculate', { expression: '1+1' }), doneChunk()]));
    const events = await collect(make().chatStream(req));
    expect(events.map((e) => e.type)).toEqual(['reasoning', 'tool_calls', 'done']);
    expect((events[1] as any).calls[0]).toEqual({ name: 'calculate', args: { expression: '1+1' } });
  });

  it('erro enviado no meio do stream vira OllamaError SERVER', async () => {
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('a'), { error: 'out of memory' }]));
    await expect(collect(make().chatStream(req))).rejects.toMatchObject({ code: 'SERVER' });
  });

  it('stream sem marcador final é PROTOCOL', async () => {
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('a')]));
    await expect(collect(make().chatStream(req))).rejects.toMatchObject({ code: 'PROTOCOL' });
  });
});

describe('cancelamento e timeouts', () => {
  it('abortar o signal interrompe o stream e FECHA a conexão no servidor', async () => {
    mock.chatHandlers.push(async (_r, res) => {
      res.writeHead(200);
      res.write(JSON.stringify(chunk('começo')) + '\n');
      await wait(2000); // servidor "continuaria" por 2 s
      res.end();
    });
    const ac = new AbortController();
    const got: StreamEvent[] = [];
    const run = (async () => {
      for await (const e of make().chatStream(req, ac.signal)) {
        got.push(e);
        ac.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ code: 'ABORTED' });
    expect(got).toHaveLength(1);
    await until(() => mock.aborted === 1); // o servidor viu a desconexão
  });

  it('cancelar ainda na fila local não chega a abrir conexão', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const hold = await limiter.acquire();
    const ac = new AbortController();
    const p = collect(make({ limiter }).chatStream(req, ac.signal));
    await wait(20);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    expect(mock.chatRequests()).toHaveLength(0);
    hold();
  });

  it('timeout de ociosidade: servidor que trava gera TIMEOUT', async () => {
    mock.chatHandlers.push(async (_r, res) => {
      res.writeHead(200);
      res.write(JSON.stringify(chunk('x')) + '\n');
      await wait(1500);
      res.end();
    });
    await expect(collect(make({ idleTimeoutMs: 150 }).chatStream(req))).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('retry, backoff e rate limit', () => {
  it('429 com Retry-After curto: espera o tempo pedido e tenta de novo', async () => {
    const sleep = vi.fn(async () => {});
    mock.chatHandlers.push((_r, res) => {
      res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'too many requests' }));
    });
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('ok'), doneChunk()]));
    const events = await collect(make({ sleep, retry: { attempts: 3, baseMs: 1, maxMs: 5000 } }).chatStream(req));
    expect(events.at(-1)?.type).toBe('done');
    expect(sleep).toHaveBeenCalledWith(1000, undefined);
    expect(mock.chatRequests()).toHaveLength(2);
  });

  it('429 com espera longa (cota esgotada) NÃO trava: devolve RATE_LIMIT na hora', async () => {
    const sleep = vi.fn(async () => {});
    mock.chatHandlers.push((_r, res) => {
      res.writeHead(429, { 'Retry-After': '3600' });
      res.end('{"error":"quota"}');
    });
    const err = await collect(make({ sleep, retry: { attempts: 3, baseMs: 1, maxMs: 5000 } }).chatStream(req)).catch((e) => e);
    expect(err).toBeInstanceOf(OllamaError);
    expect(err.code).toBe('RATE_LIMIT');
    expect(err.retryAfterMs).toBe(3_600_000);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('5xx é repetido com backoff e depois desiste após o limite de tentativas', async () => {
    for (let i = 0; i < 3; i++) mock.chatHandlers.push((_r, res) => (res.writeHead(503), res.end('{"error":"busy"}')));
    const sleep = vi.fn(async () => {});
    await expect(collect(make({ sleep }).chatStream(req))).rejects.toMatchObject({ code: 'SERVER', status: 503 });
    expect(mock.chatRequests()).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('401 não é repetido, e a chave NUNCA aparece na mensagem de erro', async () => {
    mock.chatHandlers.push((_r, res) => (res.writeHead(401), res.end(JSON.stringify({ error: `invalid key ${TEST_KEY}` }))));
    const err: OllamaError = await collect(make().chatStream(req)).catch((e) => e);
    expect(err.code).toBe('AUTH');
    expect(err.message).not.toContain(TEST_KEY);
    expect(err.message).not.toContain('TopSecretTokenValue123');
    expect(mock.chatRequests()).toHaveLength(1);
  });

  it('sem chave configurada: NO_API_KEY antes de qualquer rede', async () => {
    await expect(collect(make({ getApiKey: () => undefined }).chatStream(req))).rejects.toMatchObject({ code: 'NO_API_KEY' });
    expect(mock.requests).toHaveLength(0);
  });

  it('erro de rede (porta fechada) vira NETWORK', async () => {
    const a = make({ baseUrl: 'http://127.0.0.1:1', retry: { attempts: 1, baseMs: 1, maxMs: 1 } });
    await expect(collect(a.chatStream(req))).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('limite de concorrência (conta Free = 1)', () => {
  it('duas conversas simultâneas nunca passam de 1 requisição ativa', async () => {
    for (let i = 0; i < 2; i++) {
      mock.chatHandlers.push(async (_r, res) => {
        await wait(60);
        writeNdjson(res, [chunk('ok'), doneChunk()]);
      });
    }
    const a = make({ limiter: new ConcurrencyLimiter(1) });
    await Promise.all([collect(a.chatStream(req)), collect(a.chatStream(req))]);
    expect(mock.maxActive).toBe(1);
  });

  it('fila local cheia é rejeitada com QUEUE_FULL', async () => {
    const l = new ConcurrencyLimiter(1, 1);
    const hold = await l.acquire();
    const waiting = l.acquire();
    await expect(l.acquire()).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    hold();
    (await waiting)();
  });
});

describe('endpoints de metadados', () => {
  it('listModels (/api/tags) e showModel (/api/show) usam Bearer e não fazem inferência', async () => {
    mock.show['gpt-oss:120b'] = { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'gptoss.context_length': 131072 } };
    const a = make();
    expect(await a.listModels()).toContain('gpt-oss:120b');
    expect((await a.showModel('gpt-oss:120b')).contextLength).toBe(131072);
    expect(mock.requests.every((r) => r.headers.authorization === `Bearer ${TEST_KEY}`)).toBe(true);
    expect(mock.chatRequests()).toHaveLength(0);
  });
});

describe('URL base', () => {
  it('exige https (http só em localhost quando explicitamente permitido)', () => {
    expect(assertSafeBaseUrl('https://ollama.com')).toBe('https://ollama.com');
    expect(() => assertSafeBaseUrl('http://evil.example.com')).toThrow(/https/);
    expect(() => assertSafeBaseUrl('http://127.0.0.1:1234')).toThrow(/https/);
    expect(assertSafeBaseUrl('http://127.0.0.1:1234', true)).toBe('http://127.0.0.1:1234');
    expect(() => assertSafeBaseUrl('ftp://ollama.com')).toThrow();
  });
});
