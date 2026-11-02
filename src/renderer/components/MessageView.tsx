import { useEffect, useState } from 'react';
import type { StoredMessage, ToolCallRecord, UsageInfo } from '../../shared/api';
import { speak, stopSpeaking } from '../lib/audio';
import { fmtMs } from '../lib/util';
import { AttachmentView } from './AttachmentView';
import { Markdown } from './Markdown';

const RISK_LABEL = { read: 'leitura', 'write-local': 'altera dados locais', external: 'ação externa' } as const;
const STATE_LABEL: Record<ToolCallRecord['state'], string> = {
  'pending-confirmation': 'aguardando confirmação',
  running: 'executando',
  denied: 'negada',
  done: 'concluída',
  error: 'erro',
};

export function ToolCallCard({ call }: { call: ToolCallRecord }) {
  return (
    <details className={`toolcall ${call.state}`}>
      <summary>
        <code>{call.name}</code>
        <span className={`risk ${call.risk}`}>{RISK_LABEL[call.risk]}</span>
        <span className="muted small">{STATE_LABEL[call.state]}</span>
      </summary>
      <div className="small">
        <div className="muted">Argumentos (redigidos)</div>
        <pre>{JSON.stringify(call.args, null, 2)}</pre>
        {call.result !== undefined && (
          <>
            <div className="muted">Resultado devolvido ao modelo</div>
            <pre>{call.result}</pre>
          </>
        )}
      </div>
    </details>
  );
}

export function UsageLine({ usage, model }: { usage: UsageInfo; model?: string | undefined }) {
  const parts = [
    model && `Ollama Cloud · ${model}`,
    usage.promptTokens !== undefined && `${usage.promptTokens} tok entrada`,
    usage.completionTokens !== undefined && `${usage.completionTokens} tok saída`,
    usage.totalMs !== undefined && `total ${fmtMs(usage.totalMs)}`,
    usage.ttftMs !== undefined && `1º token ${fmtMs(usage.ttftMs)}`,
    usage.tokensPerSec !== undefined && `${usage.tokensPerSec} tok/s`,
    usage.doneReason && `fim: ${usage.doneReason}`,
  ].filter(Boolean);
  return parts.length ? <div className="usage">{parts.join(' · ')}</div> : null;
}

interface Props {
  message: StoredMessage;
  isLastAssistant: boolean;
  busy: boolean;
  ttsOk: boolean;
  onRegenerate: () => void;
  onEdit: (id: string, text: string) => void;
}

export function MessageView({ message: m, isLastAssistant, busy, ttsOk, onRegenerate, onEdit }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    const unsub = window.studio.tts.onState((state) => setSpeaking(state.playing));
    return () => { unsub(); void stopSpeaking(); };
  }, []);

  if (m.role === 'user') {
    return (
      <article className="msg user">
        <div className="bubble">
          {m.attachments.length > 0 && (
            <div className="atts">
              {m.attachments.map((a) => (
                <AttachmentView key={a.id} att={a} />
              ))}
            </div>
          )}
          {editing ? (
            <div className="edit">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} autoFocus />
              <div className="row">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    onEdit(m.id, draft);
                  }}
                >
                  Reenviar
                </button>
                <button onClick={() => setEditing(false)}>Cancelar</button>
                <span className="muted small">As mensagens seguintes serão substituídas (o histórico antigo é preservado).</span>
              </div>
            </div>
          ) : (
            <>
              {m.content && <p className="plain">{m.content}</p>}
              <div className="actions">
                <button disabled={busy} onClick={() => (setDraft(m.content), setEditing(true))}>
                  Editar e reenviar
                </button>
              </div>
            </>
          )}
        </div>
      </article>
    );
  }

  if (m.role !== 'assistant') return null;
  return (
    <article className="msg assistant">
      <div className="bubble">
        {m.toolCalls.map((c) => (
          <ToolCallCard key={c.callId} call={c} />
        ))}
        {m.content ? <Markdown text={m.content} /> : null}
        {m.status === 'cancelled' && <div className="badge warn">Interrompida — resposta parcial</div>}
        {m.status === 'error' && <div className="badge bad">Erro: {m.error}</div>}
        {m.status === 'complete' && m.error && <div className="badge warn">{m.error}</div>}
        {m.usage && <UsageLine usage={m.usage} model={m.model} />}
        <div className="actions">
          <button onClick={() => void navigator.clipboard.writeText(m.content)}>Copiar</button>
          {isLastAssistant && (
            <button disabled={busy} onClick={onRegenerate}>
              Regenerar
            </button>
          )}
          <button
            disabled={!ttsOk || !m.content}
            title={ttsOk ? 'Ler em voz alta com a voz do sistema (adaptador local; o modelo só gera texto)' : 'Nenhuma voz de TTS disponível neste sistema'}
            onClick={() => {
              if (speaking) {
                void stopSpeaking();
                setSpeaking(false);
              } else {
                void speak(m.content).then(() => setSpeaking(true)).catch(() => setSpeaking(false));
              }
            }}
          >
            {speaking ? 'Parar voz' : 'Ouvir'}
          </button>
        </div>
      </div>
    </article>
  );
}
