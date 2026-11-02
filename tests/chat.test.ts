import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatBlockedError } from '../src/main/chat/service';
import { chunk, doneChunk, MockOllama, until, wait, writeNdjson } from './helpers/mockServer';
import { makeHarness } from './helpers/fakes';

const mock = new MockOllama();
beforeAll(() => mock.start());
afterAll(() => mock.stop());
beforeEach(() => {
  mock.requests = [];
  mock.chatHandlers = [];
  mock.aborted = 0;
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const base = { params: {}, toolsEnabled: false };

describe('chat: streaming, cancelamento, regenerar, editar', () => {
  it('stream completo: eventos start/delta/done, mensagem salva com uso e título automático', async () => {
    const h = makeHarness(mock);
    const conv = h.s.store.createConversation('beam').id;
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('Oi, '), chunk('Leo!'), doneChunk()]));
    const { runId } = await h.s.chat.send({ ...base, conversationId: conv, model: 'beam', text: 'Diga oi para o Leo', attachmentIds: [] }, h.emit);
    const end: any = await h.waitForEnd(runId);
    expect(h.events.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'done']);
    expect(end.usage).toMatchObject({ promptTokens: 5, completionTokens: 10 });
    const msgs = h.s.store.listMessages(conv);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([['user', 'Diga oi para o Leo'], ['assistant', 'Oi, Leo!']]);
    expect(msgs[1]!.usage?.tokensPerSec).toBe(10);
    expect(h.s.store.getConversation(conv)!.title).toBe('Diga oi para o Leo');
  });

  it('parâmetros e thinking só são enviados quando suportados', async () => {
    const h = makeHarness(mock);
    const conv = h.s.store.createConversation('gpt-oss:20b').id;
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('x'), doneChunk()]));
    const { runId } = await h.s.chat.send(
      { conversationId: conv, model: 'gpt-oss:20b', text: 'oi', attachmentIds: [], toolsEnabled: false, params: { temperature: 0.3, top_p: 0.9, seed: 7, num_predict: 100, think: 'high' } },
      h.emit,
    );
    await h.waitForEnd(runId);
    const body = mock.chatRequests()[0]!.body;
    expect(body.options).toEqual({ temperature: 0.3, top_p: 0.9, seed: 7, num_predict: 100 });
    expect(body.think).toBe('high');
    expect(body.messages[0].role).toBe('system');
  });

  it('cancelar no meio: mensagem parcial salva como "cancelled" e conexão fechada no servidor', async () => {
    const h = makeHarness(mock);
    const conv = h.s.store.createConversation('beam').id;
    mock.chatHandlers.push(async (_r, res) => {
      res.writeHead(200);
      res.write(JSON.stringify(chunk('parte 1 ')) + '\n');
      await wait(3000);
      res.end();
    });
    const { runId } = await h.s.chat.send({ ...base, conversationId: conv, model: 'beam', text: 'longo', attachmentIds: [] }, h.emit);
    await until(() => h.events.some((e) => e.type === 'delta'));
    h.s.chat.cancel(runId);
    const end: any = await h.waitForEnd(runId);
    expect(end.type).toBe('cancelled');
    const last = h.s.store.listMessages(conv).at(-1)!;
    expect(last).toMatchObject({ role: 'assistant', content: 'parte 1 ', status: 'cancelled' });
    await until(() => mock.aborted === 1);
  });

  it('erro da API vira evento "error" e fica registrado na conversa (sem vazar a chave)', async () => {
    const h = makeHarness(mock);
    const conv = h.s.store.createConversation('beam').id;
    mock.chatHandlers.push((_r, res) => (res.writeHead(401), res.end('{"error":"unauthorized"}')));
    const { runId } = await h.s.chat.send({ ...base, conversationId: conv, model: 'beam', text: 'oi', attachmentIds: [] }, h.emit);
    const end: any = await h.waitForEnd(runId);
    expect(end).toMatchObject({ type: 'error', code: 'AUTH' });
    expect(h.s.store.listMessages(conv).at(-1)).toMatchObject({ status: 'error' });
    expect(JSON.stringify(h.events)).not.toContain('TopSecretTokenValue123');
  });

  it('regenerar: substitui só a última resposta e preserva a antiga como histórico', async () => {
    const h = makeHarness(mock);
    const conv = h.s.store.createConversation('beam').id;
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('resposta A'), doneChunk()]));
    await h.waitForEnd((await h.s.chat.send({ ...base, conversationId: conv, model: 'beam', text: 'pergunta', attachmentIds: [] }, h.emit)).runId);
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('resposta B'), doneChunk()]));
    const r = await h.s.chat.regenerate(conv, 'beam', {}, false, h.emit);
    await h.waitForEnd(r.runId);
    expect(h.s.store.listMessages(conv).map((m) => m.content)).toEqual(['pergunta', 'resposta B']);
    expect(h.s.store.listMessages(conv, true).map((m) => m.content)).toEqual(['pergunta', 'resposta A', 'resposta B']);
    expect(mock.chatRequests()[1]!.body.messages.filter((m: any) => m.role === 'user')).toHaveLength(1);
  });

  it('editar e reenviar: troca a mensagem e tudo depois dela, mantendo o anexo', async () => {
    const h = makeHarness(mock);
    const conv = h.s.store.createConversation('gemma4:31b').id;
    const att = await h.s.attachments.ingest({ name: 'f.png', mime: 'image/png', bytes: PNG });
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('vejo um quadrado'), doneChunk()]));
    await h.waitForEnd((await h.s.chat.send({ ...base, conversationId: conv, model: 'gemma4:31b', text: 'o que é isso?', attachmentIds: [att.id] }, h.emit)).runId);
    const original = h.s.store.listMessages(conv)[0]!;
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('é um PNG'), doneChunk()]));
    const r = await h.s.chat.editResend(original.id, 'que formato é esse arquivo?', 'gemma4:31b', {}, false, h.emit);
    await h.waitForEnd(r.runId);
    const now = h.s.store.listMessages(conv);
    expect(now.map((m) => m.content)).toEqual(['que formato é esse arquivo?', 'é um PNG']);
    expect(now[0]!.attachments).toHaveLength(1);
    expect(mock.chatRequests()[1]!.body.messages.at(-1).images).toHaveLength(1);
    expect(h.s.store.listMessages(conv, true)).toHaveLength(4); // histórico antigo preservado
  });
});

describe('anexos no chat: gating aplicado no main (não só na UI)', () => {
  it('imagem para modelo sem visão é BLOQUEADA antes de qualquer chamada de rede', async () => {
    const h = makeHarness(mock);
    const conv = h.s.store.createConversation('gpt-oss:120b').id;
    const att = await h.s.attachments.ingest({ name: 'f.png', mime: 'image/png', bytes: PNG });
    await expect(h.s.chat.send({ ...base, conversationId: conv, model: 'gpt-oss:120b', text: 'veja', attachmentIds: [att.id] }, h.emit)).rejects.toBeInstanceOf(ChatBlockedError);
    expect(mock.requests).toHaveLength(0);
    expect(h.s.store.listMessages(conv)).toHaveLength(0);
  });

  it('imagem em modelo com visão vai em base64 no campo images', async () => {
    const h = makeHarness(mock);
    const conv = h.s.store.createConversation('gemma4:31b').id;
    const att = await h.s.attachments.ingest({ name: 'f.png', mime: 'image/png', bytes: PNG });
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('ok'), doneChunk()]));
    await h.waitForEnd((await h.s.chat.send({ ...base, conversationId: conv, model: 'gemma4:31b', text: 'veja', attachmentIds: [att.id] }, h.emit)).runId);
    expect(mock.chatRequests()[0]!.body.messages.at(-1).images).toEqual([Buffer.from(PNG).toString('base64')]);
  });

  it('áudio sem ASR configurado é bloqueado; anexo não pode ser reutilizado em outra mensagem', async () => {
    const h = makeHarness(mock);
    const conv = h.s.store.createConversation('gemma4:31b').id;
    const wav = Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WAVE'].map((c) => c.charCodeAt(0)), [0, 0, 0, 0]));
    const a = await h.s.attachments.ingest({ name: 'v.wav', mime: 'audio/wav', bytes: wav });
    await expect(h.s.chat.send({ ...base, conversationId: conv, model: 'gemma4:31b', text: '', attachmentIds: [a.id] }, h.emit)).rejects.toMatchObject({ name: 'ChatBlockedError' });

    const img = await h.s.attachments.ingest({ name: 'f.png', mime: 'image/png', bytes: PNG });
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('ok'), doneChunk()]));
    await h.waitForEnd((await h.s.chat.send({ ...base, conversationId: conv, model: 'gemma4:31b', text: 'a', attachmentIds: [img.id] }, h.emit)).runId);
    await expect(h.s.chat.send({ ...base, conversationId: conv, model: 'gemma4:31b', text: 'b', attachmentIds: [img.id] }, h.emit)).rejects.toThrow(/inválido|utilizado/);
  });

  it('áudio com ASR configurado (local) é transcrito pelo adaptador e vai ao modelo como TEXTO marcado', async () => {
    const asrCalls: any[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      asrCalls.push({ url: String(url), form: init.body });
      return new Response(JSON.stringify({ text: 'olá, isto é um teste' }), { status: 200 });
    }) as typeof fetch;
    // fetchImpl próprio só para o ASR; o adapter Ollama usa o mock HTTP via baseUrl/fetch global
    const h = makeHarness(mock, { fetchImpl: ((u: any, i: any) => (String(u).startsWith('http://127.0.0.1:9') ? fetchImpl(u, i) : fetch(u, i))) as typeof fetch });
    h.s.settings.set({ asr: { enabled: true, url: 'http://127.0.0.1:9/transcribe', model: 'whisper-local' } });
    const conv = h.s.store.createConversation('beam').id;
    const wav = Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WAVE'].map((c) => c.charCodeAt(0)), [0, 0, 0, 0]));
    const a = await h.s.attachments.ingest({ name: 'v.wav', mime: 'audio/wav', bytes: wav });
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('entendi'), doneChunk()]));
    await h.waitForEnd((await h.s.chat.send({ ...base, conversationId: conv, model: 'beam', text: 'resuma', attachmentIds: [a.id] }, h.emit)).runId);
    expect(asrCalls).toHaveLength(1);
    const sent = mock.chatRequests()[0]!.body.messages.at(-1);
    expect(sent.content).toContain('olá, isto é um teste');
    expect(sent.content).toContain('ASR externo');
    expect(sent.images).toBeUndefined();
  });
});

describe('verificação de capacidades em runtime (só metadados)', () => {
  it('verify() usa /api/tags + /api/show, atualiza o registro e NÃO faz inferência', async () => {
    mock.tags = ['gpt-oss:120b', 'gemma4:31b'];
    mock.show = {
      'gpt-oss:120b': { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'gptoss.context_length': 131072 }, thinking: { values: ['low', 'medium', 'high'] } },
      'gemma4:31b': { capabilities: ['completion', 'vision', 'tools', 'thinking'], model_info: { 'gemma4.context_length': 262144 } },
    };
    const h = makeHarness(mock);
    const r = await h.s.models.verify();
    expect(r.tagsOk).toBe(true);
    expect(mock.chatRequests()).toHaveLength(0);
    const byId = Object.fromEntries(r.models.map((m) => [m.id, m]));
    expect(byId['gemma4:31b']!.imageIn).toMatchObject({ level: 'native', verification: 'runtime' });
    expect(byId['gpt-oss:120b']!.availability).toBe('listed');
    expect(byId['beam']!.availability).toBe('not-listed');
    expect(r.errors.some((e) => e.includes('beam'))).toBe(true); // /api/show 404 para modelo não exposto
  });

  it('sem chave, verify() relata erro claro e não derruba o app', async () => {
    const h = makeHarness(mock);
    h.s.secrets.clear();
    const r = await h.s.models.verify();
    expect(r.tagsOk).toBe(false);
    expect(r.errors[0]).toMatch(/chave/i);
    expect(mock.requests).toHaveLength(0);
  });
});
