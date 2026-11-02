import { useEffect, useState } from 'react';
import type { AppSettings, AuditRow, SecretStatus, ToolConfirmRequest, ToolInfo, VerifyResult } from '../../shared/api';
import type { ModelCapabilities } from '../../shared/capabilities';
import { chipsFor, Chip, Legend, type ChipContext, VERIFY_LABEL } from './Capabilities';
import { Modal } from './ui';
import { cleanError, fmtCtx, studio } from '../lib/util';

// ---------- Configurações ----------

interface SettingsProps {
  secret: SecretStatus | null;
  settings: AppSettings | null;
  onClose: () => void;
  onSecret: (s: SecretStatus) => void;
  onSettings: (s: AppSettings) => void;
}

export function SettingsDialog({ secret, settings, onClose, onSecret, onSettings }: SettingsProps) {
  const [key, setKey] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [asr, setAsr] = useState(settings?.asr);
  const [asrKey, setAsrKey] = useState('');

  useEffect(() => setAsr(settings?.asr), [settings]);

  async function saveKey() {
    setErr(null);
    setOk(null);
    try {
      onSecret(await studio().secrets.set(key));
      setKey('');
      setOk('Chave guardada no cofre do sistema.');
    } catch (e) {
      setErr(cleanError(e));
    }
  }

  async function patch(p: Parameters<typeof window.studio.settings.set>[0]) {
    setErr(null);
    try {
      onSettings(await studio().settings.set(p));
      setOk('Configuração salva.');
    } catch (e) {
      setErr(cleanError(e));
    }
  }

  const localAsr = asr?.url ? /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(asr.url) : false;

  return (
    <Modal title="Configurações" onClose={onClose}>
      <section>
        <h3>Chave da API Ollama Cloud</h3>
        <p className="muted small">
          Autenticação por <code>Authorization: Bearer</code> em https://ollama.com/api (docs.ollama.com/api/authentication). A chave fica cifrada no cofre do sistema e nunca volta para esta tela.{' '}
          <a href="https://ollama.com/settings/keys" onClick={(e) => (e.preventDefault(), void studio().system.openExternal('https://ollama.com/settings/keys'))}>
            Criar chave
          </a>
        </p>
        <p className="small">
          Estado:{' '}
          <strong>
            {secret?.configured ? (secret.source === 'vault' ? 'configurada (cofre do sistema)' : 'configurada (variável OLLAMA_API_KEY do ambiente)') : 'não configurada'}
          </strong>
          {secret?.backend ? ` · cofre: ${secret.backend}` : ''}
        </p>
        {secret && !secret.secure && (
          <div className="badge bad">
            Cofre do sistema indisponível: o app recusa gravar a chave em texto puro. No Linux Mint instale/abra o chaveiro (<code>sudo apt install gnome-keyring libsecret-1-0</code>) e reinicie, ou use{' '}
            <code>export OLLAMA_API_KEY=…</code> no terminal antes de abrir o app.
          </div>
        )}
        <div className="row">
          <input type="password" autoComplete="off" spellCheck={false} placeholder="Cole a chave aqui" value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="primary" disabled={key.trim().length < 8} onClick={() => void saveKey()}>
            Salvar
          </button>
          <button
            disabled={secret?.source !== 'vault'}
            onClick={async () => {
              onSecret(await studio().secrets.clear());
              setOk('Chave removida.');
            }}
          >
            Remover
          </button>
        </div>
      </section>

      <section>
        <h3>Concorrência</h3>
        <p className="muted small">Quantos modelos na nuvem rodam ao mesmo tempo; o excedente espera em fila local. Documentado: Free = 1, Pro = 3, Max = 10.</p>
        <label className="field inline">
          <span>Máximo simultâneo</span>
          <input type="number" min={1} max={10} value={settings?.maxConcurrent ?? 1} onChange={(e) => void patch({ maxConcurrent: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })} />
        </label>
      </section>

      <section>
        <h3>Adaptador ASR (áudio → texto)</h3>
        <p className="muted small">
          Os modelos do catálogo não ouvem áudio. Para voz/áudio/vídeo o app envia o áudio a um serviço ASR (POST multipart <code>file</code> + <code>model</code> → <code>{'{"text": …}'}</code>, como o servidor do whisper.cpp). Desligado por padrão. Não testado
          contra um serviço real nesta versão.
        </p>
        {asr && (
          <>
            <label className="check">
              <input type="checkbox" checked={asr.enabled} onChange={(e) => void patch({ asr: { enabled: e.target.checked } })} />
              Ativar ASR
            </label>
            <label className="field">
              <span>URL do serviço</span>
              <input value={asr.url} placeholder="http://localhost:8080/inference" onChange={(e) => setAsr({ ...asr, url: e.target.value })} onBlur={() => void patch({ asr: { url: asr.url } })} />
            </label>
            <label className="field">
              <span>Modelo (opcional)</span>
              <input value={asr.model} onChange={(e) => setAsr({ ...asr, model: e.target.value })} onBlur={() => void patch({ asr: { model: asr.model } })} />
            </label>
            {!localAsr && asr.url && (
              <label className="check warn">
                <input type="checkbox" checked={asr.consentExternalAudio} onChange={(e) => void patch({ asr: { consentExternalAudio: e.target.checked } })} />
                Autorizo enviar meu áudio a este serviço externo (o áudio sai do computador)
              </label>
            )}
            <label className="field">
              <span>Chave do ASR (opcional, guardada no cofre){asr.keyConfigured ? ' — já configurada' : ''}</span>
              <div className="row">
                <input type="password" autoComplete="off" value={asrKey} onChange={(e) => setAsrKey(e.target.value)} />
                <button
                  disabled={asrKey.length < 8}
                  onClick={async () => {
                    await patch({ asr: { apiKey: asrKey } });
                    setAsrKey('');
                  }}
                >
                  Salvar
                </button>
                <button disabled={!asr.keyConfigured} onClick={() => void patch({ asr: { apiKey: '' } })}>
                  Remover
                </button>
              </div>
            </label>
          </>
        )}
      </section>
      {err && <div className="badge bad">{err}</div>}
      {ok && <div className="badge ok">{ok}</div>}
    </Modal>
  );
}

// ---------- Registro de capacidades ----------

interface ModelsProps {
  models: ModelCapabilities[];
  ctx: ChipContext;
  hasKey: boolean;
  onClose: () => void;
  onVerified: (r: VerifyResult) => void;
}

export function ModelsDialog({ models, ctx, hasKey, onClose, onVerified }: ModelsProps) {
  const [running, setRunning] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  async function verify() {
    setRunning(true);
    setErrors([]);
    try {
      const r = await studio().models.verify();
      onVerified(r);
      setErrors(r.errors);
      setDone(true);
    } catch (e) {
      setErrors([cleanError(e)]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal title="Registro de capacidades dos modelos" onClose={onClose} wide>
      <p className="small muted">
        Os valores iniciais vêm de páginas oficiais e de agregadores (fonte indicada em cada marca). O botão abaixo consulta só os metadados da sua conta (<code>/api/tags</code> e <code>/api/show</code>) — <strong>não executa inferência nem gasta tokens</strong>.
        Se a API contradizer o catálogo, vale a API e a divergência aparece aqui.
      </p>
      <div className="row">
        <button className="primary" disabled={running || !hasKey} onClick={() => void verify()} title={hasKey ? '' : 'Configure a chave primeiro'}>
          {running ? 'Consultando…' : 'Verificar capacidades na minha conta'}
        </button>
        {!hasKey && <span className="muted small">Configure a chave da API em Configurações.</span>}
        {done && errors.length === 0 && <span className="badge ok">Verificação concluída.</span>}
      </div>
      {errors.length > 0 && (
        <details className="badge warn" open>
          <summary>{errors.length} aviso(s) na verificação</summary>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      )}
      <Legend />
      {models.map((m) => (
        <article key={m.id} className="model-card">
          <header>
            <strong>{m.displayName}</strong> <code>{m.id}</code>
            <span className="chip ctx">Ollama Cloud ☁</span>
            <span className={`chip ${m.availability === 'listed' ? 'native' : m.availability === 'not-listed' ? 'unsupported' : 'ctx'}`}>
              {m.availability === 'listed' ? 'disponível na sua conta' : m.availability === 'not-listed' ? 'não listado na sua conta' : 'disponibilidade não verificada'}
            </span>
            <span className="chip ctx">ctx {fmtCtx(m.contextTokens)}</span>
          </header>
          <div className="chips">
            {chipsFor(m, ctx).map((c) => (
              <Chip key={c.key} c={c} />
            ))}
          </div>
          {m.drift.length > 0 && (
            <div className="badge warn">
              Divergências com o catálogo embutido:
              <ul>
                {m.drift.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          <details className="small">
            <summary>
              Fontes e observações · verificado em {m.checkedAt} · contexto: {VERIFY_LABEL[m.contextVerification]}
            </summary>
            <ul>
              {m.sources.map((s) => (
                <li key={s}>{s}</li>
              ))}
              {[m.imageIn, m.toolCalling, m.thinking, m.structuredJson]
                .filter((e) => e.note)
                .map((e, i) => (
                  <li key={i} className="muted">
                    {e.note}
                  </li>
                ))}
            </ul>
          </details>
        </article>
      ))}
    </Modal>
  );
}

// ---------- Tools ----------

const RISK_LABEL = { read: 'leitura', 'write-local': 'altera dados locais (confirma)', external: 'ação externa (confirma)' } as const;

export function ToolsDialog({ settings, onClose, onSettings }: { settings: AppSettings | null; onClose: () => void; onSettings: (s: AppSettings) => void }) {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void studio().tools.list().then(setTools);
    void studio().tools.audit().then(setAudit);
  }, []);

  async function toggle(name: string, on: boolean) {
    const cur = settings?.toolAllowlist ?? [];
    const next = on ? [...new Set([...cur, name])] : cur.filter((n) => n !== name);
    try {
      onSettings(await studio().settings.set({ toolAllowlist: next }));
    } catch (e) {
      setErr(cleanError(e));
    }
  }

  return (
    <Modal title="Tools e auditoria" onClose={onClose} wide>
      <p className="small muted">
        Só as tools marcadas são oferecidas ao modelo. Argumentos são validados contra o JSON Schema antes de executar. Tools que alteram dados ou agem fora do app <strong>sempre pedem sua confirmação</strong>. Não existe tool de shell nem de código
        arbitrário.
      </p>
      {tools.map((t) => (
        <article key={t.name} className="tool-card">
          <label className="check">
            <input type="checkbox" checked={settings?.toolAllowlist.includes(t.name) ?? false} onChange={(e) => void toggle(t.name, e.target.checked)} />
            <code>{t.name}</code> <span className={`risk ${t.risk}`}>{RISK_LABEL[t.risk]}</span>
          </label>
          <p className="small">{t.description}</p>
          <details className="small">
            <summary>JSON Schema dos argumentos</summary>
            <pre>{JSON.stringify(t.schema, null, 2)}</pre>
          </details>
        </article>
      ))}
      {err && <div className="badge bad">{err}</div>}
      <h3>Trilha de auditoria (últimas 100 chamadas)</h3>
      <table className="audit">
        <thead>
          <tr>
            <th>Quando</th>
            <th>Tool</th>
            <th>Decisão</th>
            <th>Resultado</th>
            <th>Argumentos (redigidos)</th>
          </tr>
        </thead>
        <tbody>
          {audit.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Nenhuma chamada ainda.
              </td>
            </tr>
          )}
          {audit.map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.createdAt).toLocaleString('pt-BR')}</td>
              <td>
                <code>{a.tool}</code>
              </td>
              <td>{a.decision}</td>
              <td>{a.outcome}</td>
              <td>
                <code className="small">{a.argsJson.slice(0, 120)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

// ---------- Confirmação de ação ----------

export function ConfirmDialog({ request, onAnswer }: { request: ToolConfirmRequest; onAnswer: (approved: boolean) => void }) {
  return (
    <Modal title="Confirmar ação do agente" onClose={() => onAnswer(false)}>
      <div className={`badge ${request.risk === 'external' ? 'bad' : 'warn'}`}>
        O modelo quer executar <code>{request.name}</code> — {request.risk === 'external' ? 'AÇÃO EXTERNA' : 'altera dados locais'}.
      </div>
      <p className="small">{request.description}</p>
      <div className="muted small">Argumentos exatos que serão usados:</div>
      <pre>{JSON.stringify(request.args, null, 2)}</pre>
      <div className="row">
        <button className="primary" onClick={() => onAnswer(true)}>
          Permitir uma vez
        </button>
        <button className="danger" onClick={() => onAnswer(false)}>
          Negar
        </button>
      </div>
      <p className="muted small">Fechar esta janela ou deixar expirar (2 min) conta como “negar”.</p>
    </Modal>
  );
}
