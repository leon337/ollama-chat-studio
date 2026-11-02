import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAsrAdapter, validateAsrUrl } from '../src/main/adapters/asr';
import { openDatabase, Store, toFtsQuery } from '../src/main/db/store';
import { MIGRATIONS, currentVersion, migrate } from '../src/main/db/migrations';
import { DatabaseSync } from 'node:sqlite';
import {
  attachmentBytesSchema,
  ingestSchema,
  paramsSchema,
  secretSchema,
  sendSchema,
  settingsPatchSchema,
} from '../src/main/ipc-schemas';
import { buildCsp, isAllowedExternalUrl, isTrustedSender, webPreferences } from '../src/main/security';
import { SecretStore, SecretStoreError } from '../src/main/secrets';
import { redact, redactDeep } from '../src/shared/redact';
import { FakeSafeStorage, makeHarness, TEST_KEY } from './helpers/fakes';
import { MockOllama } from './helpers/mockServer';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const tmp = () => mkdtempSync(join(tmpdir(), 'ocs-sec-'));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('cofre de segredos (safeStorage)', () => {
  it('grava só o blob cifrado; a chave em claro nunca aparece em disco', () => {
    const dir = tmp();
    const s = new SecretStore(new FakeSafeStorage(), join(dir, 'secrets.bin'), {});
    s.set(TEST_KEY);
    const raw = readFileSync(join(dir, 'secrets.bin'), 'latin1');
    expect(raw.startsWith('ENC1:')).toBe(true);
    expect(raw).not.toContain('TopSecretTokenValue123');
    expect(statSync(join(dir, 'secrets.bin')).mode & 0o077).toBe(0); // só o dono lê
    expect(s.get()).toBe(TEST_KEY);
    expect(new SecretStore(new FakeSafeStorage(), join(dir, 'secrets.bin'), {}).get()).toBe(TEST_KEY); // persiste
    expect(s.status()).toMatchObject({ configured: true, source: 'vault', secure: true });
  });

  it('SEM cofre real (criptografia indisponível ou backend basic_text): RECUSA gravar', () => {
    const dir = tmp();
    const a = new SecretStore(new FakeSafeStorage(false), join(dir, 's1.bin'), {});
    expect(() => a.set(TEST_KEY)).toThrowError(SecretStoreError);
    const b = new SecretStore(new FakeSafeStorage(true, 'basic_text'), join(dir, 's2.bin'), {});
    expect(() => b.set(TEST_KEY)).toThrow(/chaveiro/);
    expect(existsSync(join(dir, 's1.bin')) || existsSync(join(dir, 's2.bin'))).toBe(false);
    expect(b.status().secure).toBe(false);
  });

  it('chave inválida é recusada; clear() apaga; variável de ambiente é fallback somente em memória', () => {
    const dir = tmp();
    const s = new SecretStore(new FakeSafeStorage(), join(dir, 'secrets.bin'), { OLLAMA_API_KEY: ' env-key-123456 ' });
    expect(s.status()).toMatchObject({ source: 'env', configured: true });
    expect(s.get()).toBe('env-key-123456');
    expect(() => s.set('curta')).toThrow(/inválida/);
    expect(() => s.set('tem espaço no meio da chave')).toThrow(/inválida/);
    s.set(TEST_KEY);
    expect(s.get()).toBe(TEST_KEY); // cofre tem prioridade sobre env
    s.clear();
    expect(existsSync(join(dir, 'secrets.bin'))).toBe(false);
    expect(s.get()).toBe('env-key-123456');
  });

  it('CHAVE NÃO VAZA: após uso completo do app, nenhum arquivo do userData contém a chave em claro', async () => {
    const mock = new MockOllama();
    await mock.start();
    try {
      const h = makeHarness(mock);
      const conv = h.s.store.createConversation('beam').id;
      mock.chatHandlers.push((_r, res) => (res.writeHead(401), res.end(JSON.stringify({ error: `bad key ${TEST_KEY}` }))));
      const { runId } = await h.s.chat.send({ conversationId: conv, model: 'beam', text: 'oi', attachmentIds: [], params: {}, toolsEnabled: false }, h.emit);
      await h.waitForEnd(runId);
      h.s.store.addMessage({ conversationId: conv, role: 'user', content: 'x' });
      const files = walk(h.dir);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) expect(readFileSync(f).toString('latin1'), f).not.toContain('TopSecretTokenValue123');
      expect(JSON.stringify(h.s.store.listMessages(conv, true))).not.toContain('TopSecretTokenValue123');
      expect(JSON.stringify(h.events)).not.toContain('TopSecretTokenValue123');
      // e a chave nunca é exposta via status/IPC
      expect(JSON.stringify(h.s.secrets.status())).not.toContain('TopSecret');
    } finally {
      await mock.stop();
    }
  });
});

describe('redação de segredos', () => {
  it('remove Bearer, pares chave=valor e valores conhecidos', () => {
    expect(redact(`Authorization: Bearer ${TEST_KEY}`)).not.toContain('TopSecret');
    expect(redact('{"api_key":"abc123456789"}')).not.toContain('abc123456789');
    expect(redact('token=zzzzzzzz1234')).not.toContain('zzzzzzzz1234');
    expect(redact('falhou com segredo-estranho-9', ['segredo-estranho-9'])).toBe('falhou com [REDACTED]');
    expect(redact('texto normal sem segredos')).toBe('texto normal sem segredos');
  });
  it('redactDeep percorre objetos e mascara chaves sensíveis', () => {
    const out = redactDeep({ a: { apiKey: 'x', password: 'y', note: `Bearer ${TEST_KEY}` }, list: [`Bearer ${TEST_KEY}`] }) as any;
    expect(out.a.apiKey).toBe('[REDACTED]');
    expect(out.a.password).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('TopSecret');
  });
});

describe('Electron: configuração de segurança', () => {
  it('webPreferences: contextIsolation, sem nodeIntegration, sandbox, sem webview', () => {
    const p = webPreferences('/x/preload.js');
    expect(p).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false });
  });

  it('CSP de produção: sem unsafe-eval, sem inline em script, sem rede externa, sem frames', () => {
    const csp = buildCsp({ dev: false });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(csp.match(/script-src [^;]+/)![0]).toBe("script-src 'self'");
    expect(csp).not.toMatch(/https?:\/\/(?!localhost)/);
  });

  it('só IPC do próprio renderer é aceito; navegação externa é negada', () => {
    const trust = { rendererFileUrlPrefix: 'file:///app/dist/renderer' };
    expect(isTrustedSender('file:///app/dist/renderer/index.html', trust)).toBe(true);
    expect(isTrustedSender('https://evil.com/x', trust)).toBe(false);
    expect(isTrustedSender('file:///etc/passwd', trust)).toBe(false);
    expect(isTrustedSender('http://localhost:5173/', { ...trust, devUrl: 'http://localhost:5173' })).toBe(true);
  });

  it('URLs externas: https público apenas', () => {
    expect(isAllowedExternalUrl('https://ollama.com/library')).toBe(true);
    for (const bad of ['http://a.com', 'ftp://a.com', 'javascript:alert(1)', 'file:///etc/passwd', 'https://localhost/x', 'https://10.0.0.5', 'https://172.20.1.1', 'https://169.254.169.254/latest', 'https://u:p@a.com', 'não é url']) {
      expect(isAllowedExternalUrl(bad), bad).toBe(false);
    }
  });

  it('código-fonte: sem eval/new Function/child_process/exec nos módulos do app', () => {
    const files = walk(join(__dirname, '..', 'src')).filter((f) => /\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (f.endsWith('/src/main/tts.ts')) {
        // Sole audited native TTS exception: fixed executable, pipe stdin, no shell.
        expect(code).toContain("import { spawn, type ChildProcess } from 'node:child_process'");
        expect(code).toContain("'/usr/bin/spd-say'");
        expect(code).toContain('shell: false');
        expect(code).toContain("'--pipe-mode'");
        expect(code).not.toMatch(/execSync|eval\s*\(|new Function\s*\(|shell:\s*true/);
      } else {
        expect(code, f).not.toMatch(/\beval\s*\(|new Function\s*\(|child_process|\bexecSync\b|\bspawn\s*\(|dangerouslySetInnerHTML/);
      }
    }
  });

  it('o renderer não importa electron/node: só a ponte window.studio', () => {
    const files = walk(join(__dirname, '..', 'src', 'renderer')).filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of files) {
      const code = readFileSync(f, 'utf8');
      expect(code, f).not.toMatch(/from ['"](electron|node:[a-z]+|fs|path|child_process)['"]/);
      expect(code, f).not.toMatch(/ipcRenderer/);
    }
  });

  it('o preload expõe só métodos nomeados (sem ipcRenderer cru)', () => {
    const code = readFileSync(join(__dirname, '..', 'src', 'preload', 'index.ts'), 'utf8');
    expect(code.match(/exposeInMainWorld\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/exposeInMainWorld\('[a-z]+', ipcRenderer/i);
    expect(code).not.toMatch(/\bsend:\s*ipcRenderer/);
  });
});

describe('validação de payloads IPC (renderer não é confiável)', () => {
  it('rejeita campos extras, tipos errados e valores fora da faixa', () => {
    const ok = { conversationId: 'c1', model: 'beam', text: 'oi', attachmentIds: [], params: {}, toolsEnabled: false };
    expect(sendSchema.safeParse(ok).success).toBe(true);
    expect(sendSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(sendSchema.safeParse({ ...ok, attachmentIds: Array(11).fill('a') }).success).toBe(false);
    expect(paramsSchema.safeParse({ temperature: 9 }).success).toBe(false);
    expect(paramsSchema.safeParse({ think: 'Ultra; rm -rf /' }).success).toBe(false);
    expect(paramsSchema.safeParse({ unknown: 1 }).success).toBe(false);
    expect(attachmentBytesSchema.safeParse({ id: '../../x', frameIndex: 99 }).success).toBe(false);
    expect(ingestSchema.safeParse({ name: 'a', mime: 'x', bytes: new Uint8Array(0) }).success).toBe(false);
    expect(ingestSchema.safeParse({ name: 'a', mime: 'x', bytes: 'string' }).success).toBe(false);
    expect(secretSchema.safeParse('com espaço').success).toBe(false);
    expect(settingsPatchSchema.safeParse({ maxConcurrent: 0 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ asr: { enabled: true, hack: 1 } }).success).toBe(false);
  });
});

describe('adaptador ASR: privacidade do áudio', () => {
  const s = (o: object) => ({ enabled: true, url: 'https://asr.example.com/v1/transcribe', model: 'w', consentExternalAudio: false, ...o });
  it('desligado por padrão; endpoint externo exige consentimento explícito; local não', () => {
    expect(buildAsrAdapter({ enabled: false, url: '', model: '', consentExternalAudio: false }, () => undefined)).toBeNull();
    expect(buildAsrAdapter(s({}), () => undefined)).toBeNull();
    expect(buildAsrAdapter(s({ consentExternalAudio: true }), () => undefined)?.external).toBe(true);
    const local = buildAsrAdapter(s({ url: 'http://localhost:8080/inference' }), () => undefined);
    expect(local?.external).toBe(false);
    expect(local?.label).toMatch(/local/);
  });
  it('só https (http só em localhost)', () => {
    expect(validateAsrUrl('http://asr.example.com/x').ok).toBe(false);
    expect(validateAsrUrl('http://127.0.0.1:9000/x').ok).toBe(true);
    expect(validateAsrUrl('lixo').ok).toBe(false);
  });
});

describe('SQLite: migrations, busca e exportação', () => {
  it('aplica migrations em ordem, é idempotente e recusa banco de versão futura', () => {
    const db = new DatabaseSync(':memory:');
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (99,?,?)').run('futura', 1);
    expect(() => migrate(db)).toThrow(/Atualize o app/);
  });

  it('migration que falha faz ROLLBACK completo (sem esquema pela metade)', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => migrate(db, [{ version: 1, name: 'quebrada', sql: 'CREATE TABLE a(x); CREATE TABLE a(x);' }])).toThrow(/quebrada/);
    expect(currentVersion(db)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='a'").get()).toEqual({ n: 0 });
  });

  it('busca full-text (FTS5) acha por conteúdo, ignora superseded e resiste a sintaxe maliciosa', () => {
    const store = new Store(openDatabase(':memory:'));
    const c = store.createConversation('beam', 'Receitas');
    const u = store.addMessage({ conversationId: c.id, role: 'user', content: 'como fazer bolo de cenoura' });
    store.addMessage({ conversationId: c.id, role: 'assistant', content: 'misture farinha e ovos' });
    const other = store.createConversation('beam', 'Outro');
    store.addMessage({ conversationId: other.id, role: 'user', content: 'previsão do tempo em Recife' });
    expect(store.listConversations('cenoura').map((x) => x.id)).toEqual([c.id]);
    expect(store.listConversations('recif').map((x) => x.id)).toEqual([other.id]); // prefixo
    expect(store.listConversations('receitas').map((x) => x.id)).toEqual([c.id]); // por título
    for (const evil of ['"', 'a OR', 'NEAR(', '* ) --', "'; DROP TABLE messages;--"]) {
      expect(() => store.listConversations(evil), evil).not.toThrow();
    }
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 3 });
    store.supersedeFrom(u);
    expect(store.listConversations('cenoura')).toEqual([]);
    expect(toFtsQuery('   ')).toBeNull();
  });

  it('excluir conversa remove mensagens (cascade), índice e devolve caminhos de anexos', () => {
    const store = new Store(openDatabase(':memory:'));
    const c = store.createConversation('beam');
    const m = store.addMessage({ conversationId: c.id, role: 'user', content: 'apagável' });
    const a = store.insertAttachment({ kind: 'image', name: 'a.png', mime: 'image/png', size: 1, sha256: 'h', path: '/tmp/x.png', meta: {} });
    store.bindAttachments(m, [a.id]);
    expect(store.deleteConversation(c.id)).toEqual(['/tmp/x.png']);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    expect(store.searchMessages('apagável')).toEqual([]);
  });

  it('exporta JSON e Markdown com anexos e uso', () => {
    const store = new Store(openDatabase(':memory:'));
    const c = store.createConversation('beam', 'Exportável');
    store.addMessage({ conversationId: c.id, role: 'user', content: 'pergunta' });
    store.addMessage({ conversationId: c.id, role: 'assistant', content: 'resposta', model: 'beam', usage: { promptTokens: 3, completionTokens: 4, totalMs: 50 } });
    const json = JSON.parse(store.exportConversation(c.id, 'json'));
    expect(json.messages).toHaveLength(2);
    const md = store.exportConversation(c.id, 'md');
    expect(md).toContain('# Exportável');
    expect(md).toContain('## Assistente (beam)');
    expect(md).toContain('3 entrada / 4 saída');
  });
});
