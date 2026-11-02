import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { calculate } from '../src/main/tools/calculator';
import { ToolRegistry } from '../src/main/tools/registry';
import { registerBuiltinTools } from '../src/main/tools/builtin';
import { validateJsonOutput } from '../src/main/chat/service';
import { fitHistory } from '../src/main/chat/service';
import { compareModels } from '../src/main/chat/compare';
import { runWorkflow, validateWorkflow } from '../src/main/chat/workflow';
import { ModelCapabilityRegistry } from '../src/shared/registry';
import { chunk, doneChunk, MockOllama, thinkingChunk, toolCallChunk, writeNdjson } from './helpers/mockServer';
import { makeHarness, TEST_KEY } from './helpers/fakes';

const mock = new MockOllama();
beforeAll(() => mock.start());
afterAll(() => mock.stop());
beforeEach(() => {
  mock.requests = [];
  mock.chatHandlers = [];
});

describe('calculadora segura (sem eval)', () => {
  it('precedência, unário, potência e funções', () => {
    expect(calculate('2+3*4')).toBe(14);
    expect(calculate('(2+3)*4')).toBe(20);
    expect(calculate('-2^2')).toBe(-4);
    expect(calculate('2^3^2')).toBe(512);
    expect(calculate('2^-1')).toBe(0.5);
    expect(calculate('sqrt(16)+abs(-3)')).toBe(7);
    expect(calculate('max(1;5;3)')).toBe(5);
    expect(calculate('10 % 4')).toBe(2);
  });
  it('recusa código, identificadores e divisão por zero', () => {
    for (const bad of ['process.exit(1)', 'require("fs")', '1/0', 'constructor', '__proto__', '2+', '((((', 'alert(1)']) {
      expect(() => calculate(bad), bad).toThrow();
    }
    expect(() => calculate('1+'.repeat(150) + '1')).toThrow(/longa/);
  });
});

describe('Tool Registry', () => {
  it('exige schema estrito, nome válido e risco declarado', () => {
    const r = new ToolRegistry();
    const base = { description: 'x', risk: 'read' as const, handler: () => 'ok' };
    expect(() => r.register({ ...base, name: 'Bad-Name', parameters: { type: 'object', additionalProperties: false } })).toThrow(/Nome/);
    expect(() => r.register({ ...base, name: 'frouxa', parameters: { type: 'object' } })).toThrow(/additionalProperties/);
    expect(() => r.register({ ...base, name: 'sem_risco', risk: undefined as any, parameters: { type: 'object', additionalProperties: false } })).toThrow(/Risco/);
    r.register({ ...base, name: 'ok_tool', parameters: { type: 'object', additionalProperties: false } });
    expect(() => r.register({ ...base, name: 'ok_tool', parameters: { type: 'object', additionalProperties: false } })).toThrow(/duplicada/);
  });

  it('valida argumentos (tipos errados, campos extras, ausentes) sem coerção', () => {
    const r = new ToolRegistry();
    registerBuiltinTools(r);
    expect(r.validate('calculate', { expression: '1+1' }).ok).toBe(true);
    expect(r.validate('calculate', { expression: 5 }).ok).toBe(false);
    expect(r.validate('calculate', {}).ok).toBe(false);
    expect(r.validate('calculate', { expression: '1', extra: true }).ok).toBe(false);
    expect(r.validate('nao_existe', {}).ok).toBe(false);
  });

  it('INVARIANTE: não existe tool de shell/código/arquivo arbitrário', () => {
    const r = new ToolRegistry();
    registerBuiltinTools(r);
    const names = r.list().map((t) => t.name).sort();
    expect(names).toEqual(['calculate', 'get_current_time', 'open_url', 'save_note', 'search_history']);
    expect(names.join(' ')).not.toMatch(/shell|exec|eval|bash|run_code|fs|file|delete/);
    expect(r.list().find((t) => t.name === 'open_url')!.risk).toBe('external');
    expect(r.list().find((t) => t.name === 'save_note')!.risk).toBe('write-local');
  });

  it('specs() entrega ao modelo só o que está na allowlist', () => {
    const r = new ToolRegistry();
    registerBuiltinTools(r);
    expect(r.specs(['calculate']).map((s) => s.function.name)).toEqual(['calculate']);
    expect(r.specs([])).toEqual([]);
  });
});

describe('ToolRunner: allowlist, confirmação, auditoria', () => {
  const run = (h: ReturnType<typeof makeHarness>, name: string, args: any, allow = ['calculate', 'save_note', 'open_url', 'get_current_time']) =>
    h.s.runner.execute({ conversationId: null, callId: `c-${name}`, name, args, allowlist: new Set(allow) });

  it('read roda sem pedir confirmação e é auditada', async () => {
    const h = makeHarness(mock);
    const r = await run(h, 'calculate', { expression: '6*7' });
    expect(JSON.parse(r.content)).toEqual({ result: 42 });
    expect(h.confirms).toHaveLength(0);
    const audit = h.s.store.listAudit();
    expect(audit[0]).toMatchObject({ tool: 'calculate', decision: 'auto', outcome: 'ok' });
  });

  it('write-local: pede confirmação; negado = NÃO executa e nada é gravado', async () => {
    const h = makeHarness(mock);
    h.setConfirm(() => false);
    const r = await run(h, 'save_note', { title: 't', content: 'c' });
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]).toMatchObject({ name: 'save_note', risk: 'write-local' });
    expect(JSON.parse(r.content).error).toBe('negado_pelo_usuario');
    expect(h.s.store.db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 0 });
    expect(h.s.store.listAudit()[0]).toMatchObject({ decision: 'denied', outcome: 'skipped' });
  });

  it('write-local aprovado executa; external aprovado abre a URL só se for https público', async () => {
    const h = makeHarness(mock);
    h.setConfirm(() => true);
    await run(h, 'save_note', { title: 't', content: 'c' });
    expect(h.s.store.db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 1 });

    const ok = await run(h, 'open_url', { url: 'https://docs.ollama.com/cloud' });
    expect(JSON.parse(ok.content)).toEqual({ opened: true });
    expect(h.opened).toEqual(['https://docs.ollama.com/cloud']);

    for (const bad of ['http://example.com', 'https://127.0.0.1/admin', 'https://192.168.0.1', 'https://user:pw@example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const r = await run(h, 'open_url', { url: bad });
      expect(JSON.parse(r.content).error, bad).toMatch(/url_nao_permitida|argumentos_invalidos/);
    }
    expect(h.opened).toHaveLength(1);
  });

  it('confirmação que lança erro ou expira conta como NEGADA', async () => {
    const h = makeHarness(mock);
    h.setConfirm(() => Promise.reject(new Error('janela fechada')));
    const r = await run(h, 'open_url', { url: 'https://example.com' });
    expect(JSON.parse(r.content).error).toBe('negado_pelo_usuario');
    expect(h.opened).toHaveLength(0);
  });

  it('tool fora da allowlist ou inexistente é bloqueada; argumentos inválidos também', async () => {
    const h = makeHarness(mock);
    expect(JSON.parse((await run(h, 'open_url', { url: 'https://a.com' }, ['calculate'])).content).error).toBe('tool_nao_permitida');
    expect(JSON.parse((await run(h, 'rm_rf', { path: '/' })).content).error).toBe('tool_nao_permitida');
    expect(JSON.parse((await run(h, 'calculate', { expression: 123 })).content).error).toBe('argumentos_invalidos');
    expect(h.confirms).toHaveLength(0);
    expect(h.s.store.listAudit().every((a: any) => a.decision === 'blocked')).toBe(true);
  });

  it('segredos nos argumentos são redigidos na auditoria', async () => {
    const h = makeHarness(mock);
    h.setConfirm(() => true);
    await run(h, 'save_note', { title: 'k', content: `chave Bearer ${TEST_KEY}` });
    const a: any = h.s.store.listAudit()[0];
    expect(a.args_json).not.toContain('TopSecretTokenValue123');
  });
});

describe('loop de tool calling ponta a ponta (servidor simulado)', () => {
  const setupConv = (h: ReturnType<typeof makeHarness>, model = 'gpt-oss:120b') => h.s.store.createConversation(model).id;
  const params = {};

  it('modelo pede tool -> app executa -> devolve role=tool -> resposta final; histórico auditável', async () => {
    const h = makeHarness(mock);
    const conv = setupConv(h);
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [thinkingChunk('devo calcular'), toolCallChunk('calculate', { expression: '12*12' }), doneChunk()]));
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('O resultado é 144.'), doneChunk()]));

    const { runId } = await h.s.chat.send({ conversationId: conv, model: 'gpt-oss:120b', text: 'quanto é 12*12?', attachmentIds: [], params, toolsEnabled: true }, h.emit);
    const end = await h.waitForEnd(runId);
    expect(end.type).toBe('done');

    const [first, second] = mock.chatRequests();
    expect(first!.body.tools.map((t: any) => t.function.name)).toContain('calculate');
    const toolMsg = second!.body.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ tool_name: 'calculate' });
    expect(JSON.parse(toolMsg.content)).toEqual({ result: 144 });
    // o raciocínio retorna ao modelo (continuidade), mas nunca é exibido nem salvo
    expect(second!.body.messages.some((m: any) => m.thinking === 'devo calcular')).toBe(true);

    const msgs = h.s.store.listMessages(conv);
    const final = msgs.at(-1)!;
    expect(final.content).toBe('O resultado é 144.');
    expect(final.toolCalls).toHaveLength(1);
    expect(final.toolCalls[0]).toMatchObject({ name: 'calculate', state: 'done' });
    expect(JSON.stringify(msgs)).not.toContain('devo calcular');
    expect(h.events.some((e) => e.type === 'reasoning')).toBe(true);
    expect(h.events.filter((e) => e.type === 'delta').map((e: any) => e.text).join('')).not.toContain('devo calcular');
  });

  it('modelo alucina tool/argumentos: erro volta ao modelo, nada executa de verdade', async () => {
    const h = makeHarness(mock);
    const conv = setupConv(h);
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [toolCallChunk('delete_everything', { path: '/' }), doneChunk()]));
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('Não consegui.'), doneChunk()]));
    const { runId } = await h.s.chat.send({ conversationId: conv, model: 'gpt-oss:120b', text: 'apague tudo', attachmentIds: [], params, toolsEnabled: true }, h.emit);
    expect((await h.waitForEnd(runId)).type).toBe('done');
    const toolMsg = mock.chatRequests()[1]!.body.messages.find((m: any) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content).error).toBe('tool_nao_permitida');
    expect(h.confirms).toHaveLength(0);
  });

  it('com toolsEnabled=false (ou modelo sem tools) NENHUMA tool é enviada', async () => {
    const h = makeHarness(mock);
    const conv = setupConv(h);
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('oi'), doneChunk()]));
    const { runId } = await h.s.chat.send({ conversationId: conv, model: 'gpt-oss:120b', text: 'oi', attachmentIds: [], params, toolsEnabled: false }, h.emit);
    await h.waitForEnd(runId);
    expect(mock.chatRequests()[0]!.body.tools).toBeUndefined();
  });

  it('tool de risco no meio do loop: usuário nega, o modelo é informado e o loop continua', async () => {
    const h = makeHarness(mock);
    h.setConfirm(() => false);
    const conv = setupConv(h);
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [toolCallChunk('open_url', { url: 'https://example.com' }), doneChunk()]));
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('Ok, não abri.'), doneChunk()]));
    const { runId } = await h.s.chat.send({ conversationId: conv, model: 'gpt-oss:120b', text: 'abra example.com', attachmentIds: [], params, toolsEnabled: true }, h.emit);
    expect((await h.waitForEnd(runId)).type).toBe('done');
    expect(h.opened).toHaveLength(0);
    expect(JSON.parse(mock.chatRequests()[1]!.body.messages.find((m: any) => m.role === 'tool').content).error).toBe('negado_pelo_usuario');
    expect(h.events.some((e: any) => e.type === 'tool' && e.call.state === 'pending-confirmation')).toBe(true);
  });

  it('limite de passos impede loop infinito de tools', async () => {
    const h = makeHarness(mock);
    const conv = setupConv(h);
    for (let i = 0; i < 10; i++) mock.chatHandlers.push((_r, res) => writeNdjson(res, [toolCallChunk('calculate', { expression: '1+1' }), doneChunk()]));
    const { runId } = await h.s.chat.send({ conversationId: conv, model: 'gpt-oss:120b', text: 'loop', attachmentIds: [], params, toolsEnabled: true }, h.emit);
    const end: any = await h.waitForEnd(runId);
    expect(end.type).toBe('error');
    expect(end.message).toMatch(/passos/);
    expect(mock.chatRequests()).toHaveLength(5);
  });
});

describe('saída estruturada (JSON)', () => {
  const schema = { type: 'object', properties: { nome: { type: 'string' } }, required: ['nome'] };
  it('validateJsonOutput', () => {
    expect(validateJsonOutput('{"nome":"Leo"}', schema)).toBeNull();
    expect(validateJsonOutput('{"idade":3}', schema)).toMatch(/fora do schema/);
    expect(validateJsonOutput('nao é json', true)).toMatch(/não é JSON/);
    expect(validateJsonOutput('[1,2]', true)).toBeNull();
  });
  it('o schema vai no campo format da API e a resposta inválida é sinalizada', async () => {
    const h = makeHarness(mock);
    const conv = h.s.store.createConversation('gpt-oss:20b').id;
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('{"idade":3}'), doneChunk()]));
    const { runId } = await h.s.chat.send({ conversationId: conv, model: 'gpt-oss:20b', text: 'dados', attachmentIds: [], params: { json: schema }, toolsEnabled: false }, h.emit);
    await h.waitForEnd(runId);
    expect(mock.chatRequests()[0]!.body.format).toEqual(schema);
    expect(h.s.store.listMessages(conv).at(-1)!.error).toMatch(/fora do schema/);
  });
});

describe('comparação de modelos e workflow multiagente', () => {
  const deps = () => ({ adapter: makeHarness(mock).s.adapter, registry: new ModelCapabilityRegistry() });

  it('compara em série e PULA modelo incompatível sem chamar a API', async () => {
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('A'), doneChunk()]));
    const out = await compareModels(deps(), { prompt: 'oi', models: ['gpt-oss:20b', 'nemotron-3-super'], params: { think: 'low' } });
    expect(out[0]).toMatchObject({ model: 'gpt-oss:20b', content: 'A' });
    expect(out[1]!.skipped).toMatch(/thinking/);
    expect(mock.chatRequests()).toHaveLength(1);
  });

  it('workflow: passos encadeados com {{input}} e {{steps.x}}; referência futura é inválida', async () => {
    const spec = {
      name: 'rascunho-revisao',
      steps: [
        { id: 'rascunho', model: 'gpt-oss:20b', role: 'Redator', prompt: 'Escreva sobre {{input}}' },
        { id: 'revisao', model: 'gpt-oss:120b', role: 'Revisor', prompt: 'Revise: {{steps.rascunho}}' },
      ],
    };
    expect(validateWorkflow(spec)).toEqual([]);
    expect(validateWorkflow({ name: 'x', steps: [{ id: 'a', model: 'm', role: 'r', prompt: '{{steps.b}}' }, { id: 'b', model: 'm', role: 'r', prompt: 'x' }] })[0]).toMatch(/não existe antes/);
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('texto bruto'), doneChunk()]));
    mock.chatHandlers.push((_r, res) => writeNdjson(res, [chunk('texto revisado'), doneChunk()]));
    const r = await runWorkflow(deps(), spec, 'gatos');
    expect(r.outputs).toEqual({ rascunho: 'texto bruto', revisao: 'texto revisado' });
    expect(mock.chatRequests()[0]!.body.messages[1].content).toBe('Escreva sobre gatos');
    expect(mock.chatRequests()[1]!.body.messages[1].content).toBe('Revise: texto bruto');
  });
});

describe('janela de contexto', () => {
  it('fitHistory mantém system + mensagens mais recentes dentro do orçamento (a última sempre entra)', () => {
    const msgs = [
      { role: 'system' as const, content: 'sys' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `m${i} ` + 'x'.repeat(3500) })),
    ];
    const out = fitHistory(msgs, 3000);
    expect(out[0]!.role).toBe('system');
    expect(out.at(-1)!.content.startsWith('m9')).toBe(true);
    expect(out.length).toBeLessThan(msgs.length);
    expect(fitHistory(msgs, 1).length).toBe(2); // system + última
  });
});
