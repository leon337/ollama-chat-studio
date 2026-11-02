import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, ChatEvent, ChatParams, ConversationSummary, SecretStatus, StoredMessage, ToolCallRecord, ToolConfirmRequest } from '../shared/api';
import { asrBlockedReason } from '../shared/asr';
import type { ModelCapabilities } from '../shared/capabilities';
import { conservativeEntry } from '../shared/registry';
import { CapabilityChips } from './components/Capabilities';
import { Composer } from './components/Composer';
import { ConfirmDialog, ModelsDialog, SettingsDialog, ToolsDialog } from './components/Dialogs';
import { Markdown } from './components/Markdown';
import { MessageView, ToolCallCard } from './components/MessageView';
import { ParamsPanel } from './components/ParamsPanel';
import { Sidebar } from './components/Sidebar';
import { ttsAvailable, ttsSupported } from './lib/audio';
import { cleanError, fmtMs, loadJson, saveJson, studio } from './lib/util';

interface Live {
  runId: string;
  conversationId: string;
  text: string;
  reasoning: boolean;
  tools: ToolCallRecord[];
}

type DialogName = 'settings' | 'models' | 'tools' | null;
const DEFAULT_MODEL = 'gpt-oss:20b'; // faixa de uso "baixo" da Ollama: bom ponto de partida na conta Free

export function App() {
  const [models, setModels] = useState<ModelCapabilities[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [secret, setSecret] = useState<SecretStatus | null>(null);
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [modelId, setModelId] = useState<string>(() => loadJson('ocs.model', DEFAULT_MODEL));
  const [params, setParams] = useState<ChatParams>(() => loadJson('ocs.params', {}));
  const [toolsOn, setToolsOn] = useState<boolean>(() => loadJson('ocs.tools', false));
  const [showParams, setShowParams] = useState(true);
  const [live, setLive] = useState<Live | null>(null);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [confirms, setConfirms] = useState<ToolConfirmRequest[]>([]);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [ttsOk, setTtsOk] = useState(ttsSupported());
  const activeRef = useRef<string | null>(null);
  const queryRef = useRef('');
  const scroller = useRef<HTMLDivElement>(null);
  activeRef.current = activeId;
  queryRef.current = query;

  const caps = useMemo(() => models.find((m) => m.id === modelId) ?? conservativeEntry(modelId), [models, modelId]);
  const asrReason = settings ? asrBlockedReason(settings.asr) : 'Carregando configurações…';
  const adapters = useMemo(() => ({ asr: asrReason === null, tts: ttsOk }), [asrReason, ttsOk]);
  const toolsReason = caps.toolCalling.level !== 'native' ? `${caps.displayName} não tem tool calling confirmado.` : settings && settings.toolAllowlist.length === 0 ? 'Nenhuma tool está marcada na allowlist (menu Tools).' : null;
  const toolsEffective = toolsOn && !toolsReason;

  const flash = useCallback((text: string, kind: 'error' | 'info' = 'info') => setNotice({ kind, text }), []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.kind === 'error' ? 9000 : 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // vozes de TTS carregam de forma assíncrona no Chromium
  useEffect(() => {
    let alive = true;
    const refresh = () => { void ttsAvailable().then((ok) => { if (alive) setTtsOk(ok); }); };
    refresh();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener('voiceschanged', refresh);
    return () => {
      alive = false;
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.removeEventListener('voiceschanged', refresh);
    };
  }, []);

  const refreshConvs = useCallback(async () => setConvs(await studio().conversations.list(queryRef.current || undefined)), []);
  const loadMessages = useCallback(async (id: string) => setMessages(await studio().conversations.messages(id)), []);

  // carga inicial
  useEffect(() => {
    void (async () => {
      try {
        const [m, s, sec] = await Promise.all([studio().models.list(), studio().settings.get(), studio().secrets.status()]);
        setModels(m);
        setSettings(s);
        setSecret(sec);
        if (!sec.configured) setDialog('settings');
        await refreshConvs();
      } catch (e) {
        flash(cleanError(e), 'error');
      }
    })();
  }, [refreshConvs, flash]);

  // busca (com debounce)
  useEffect(() => {
    const t = setTimeout(() => void refreshConvs(), 200);
    return () => clearTimeout(t);
  }, [query, refreshConvs]);

  // persistência leve de preferências de UI
  useEffect(() => saveJson('ocs.model', modelId), [modelId]);
  useEffect(() => saveJson('ocs.params', params), [params]);
  useEffect(() => saveJson('ocs.tools', toolsOn), [toolsOn]);

  // eventos de streaming vindos do main
  useEffect(() => {
    return studio().onChatEvent((e: ChatEvent) => {
      switch (e.type) {
        case 'start':
          setLive({ runId: e.runId, conversationId: e.conversationId, text: '', reasoning: false, tools: [] });
          if (e.conversationId === activeRef.current) void loadMessages(e.conversationId);
          void refreshConvs();
          break;
        case 'delta':
          setLive((l) => (l?.runId === e.runId ? { ...l, text: l.text + e.text } : l));
          break;
        case 'reasoning':
          setLive((l) => (l?.runId === e.runId ? { ...l, reasoning: e.active } : l));
          break;
        case 'tool':
          setLive((l) => {
            if (l?.runId !== e.runId) return l;
            const others = l.tools.filter((t) => t.callId !== e.call.callId);
            return { ...l, tools: [...others, e.call] };
          });
          break;
        default:
          setLive((l) => (l?.runId === e.runId ? null : l));
          if (e.conversationId === activeRef.current) void loadMessages(e.conversationId);
          void refreshConvs();
          if (e.type === 'error') flash(e.message, 'error');
      }
    });
  }, [loadMessages, refreshConvs, flash]);

  useEffect(() => studio().onToolConfirm((r) => setConfirms((q) => [...q, r])), []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages, live?.text, live?.tools.length]);

  function selectModel(id: string) {
    const next = models.find((m) => m.id === id) ?? conservativeEntry(id);
    // limpa parâmetros que o novo modelo não aceita (nada de controle "fantasma")
    const p = { ...params };
    if (p.think !== undefined && p.think !== null && p.think !== false) {
      const ok = next.thinking.level === 'native' && (!next.thinking.levels || next.thinking.levels.includes(p.think));
      if (!ok) delete p.think;
    }
    if (p.num_ctx && next.contextTokens && p.num_ctx > next.contextTokens) delete p.num_ctx;
    setParams(p);
    setModelId(id);
  }

  async function openConversation(id: string) {
    setActiveId(id);
    setLive(null);
    await loadMessages(id);
    const c = convs.find((x) => x.id === id);
    if (c) selectModel(c.model);
  }

  const newConversation = () => {
    setActiveId(null);
    setMessages([]);
    setLive(null);
  };

  async function send(text: string, attachmentIds: string[]) {
    let id = activeId;
    if (!id) {
      const c = await studio().conversations.create(modelId);
      id = c.id;
      setActiveId(id);
      setMessages([]);
    }
    await studio().chat.send({ conversationId: id, model: modelId, text, attachmentIds, params, toolsEnabled: toolsEffective });
  }

  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      flash(cleanError(e), 'error');
    }
  };

  const stats = useMemo(() => {
    let tin = 0;
    let tout = 0;
    let ms = 0;
    let n = 0;
    for (const m of messages) {
      if (m.usage) {
        tin += m.usage.promptTokens ?? 0;
        tout += m.usage.completionTokens ?? 0;
        ms += m.usage.totalMs ?? 0;
        n++;
      }
    }
    return { tin, tout, avg: n ? Math.round(ms / n) : undefined };
  }, [messages]);

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;
  const streaming = live !== null;
  const liveHere = live && live.conversationId === activeId ? live : null;
  const answerConfirm = (approved: boolean) => {
    const [first, ...rest] = confirms;
    if (!first) return;
    void studio().tools.confirm(first.requestId, approved);
    setConfirms(rest);
  };

  const chipCtx = { asrOk: adapters.asr, asrReason, ttsOk };

  return (
    <div className={`app${showParams ? ' with-params' : ''}`}>
      <Sidebar
        conversations={convs}
        activeId={activeId}
        query={query}
        onQuery={setQuery}
        onSelect={(id) => void openConversation(id)}
        onNew={newConversation}
        onRename={(id, t) => void guard(async () => (await studio().conversations.rename(id, t), refreshConvs()))}
        onDelete={(id) =>
          void guard(async () => {
            await studio().conversations.remove(id);
            if (id === activeId) newConversation();
            await refreshConvs();
          })
        }
        onExport={(id, f) =>
          void guard(async () => {
            const r = await studio().conversations.exportTo(id, f);
            if (r.path) flash(`Exportado para ${r.path}`);
          })
        }
      />

      <main className="main">
        <header className="topbar">
          <div className="row">
            <label className="model-select">
              <span className="sr">Modelo</span>
              <select value={modelId} onChange={(e) => selectModel(e.target.value)} aria-label="Modelo">
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName} — {m.id}
                    {m.availability === 'not-listed' ? ' (não listado na conta)' : ''}
                  </option>
                ))}
                {!models.some((m) => m.id === modelId) && <option value={modelId}>{modelId} (fora do catálogo)</option>}
              </select>
            </label>
            <span className="chip ctx" title="Toda inferência roda na nuvem da Ollama; nenhum modelo local é usado.">
              Ollama Cloud ☁
            </span>
            <span className="spacer" />
            <button onClick={() => setDialog('models')}>Capacidades</button>
            <button onClick={() => setDialog('tools')}>Tools</button>
            <button onClick={() => setShowParams((v) => !v)} aria-pressed={showParams}>
              Parâmetros
            </button>
            <button onClick={() => setDialog('settings')}>Configurações</button>
          </div>
          <CapabilityChips model={caps} ctx={chipCtx} />
        </header>

        {secret && !secret.configured && (
          <div className="banner">
            Nenhuma chave da API configurada. <button onClick={() => setDialog('settings')}>Configurar agora</button>
          </div>
        )}

        <div className="scroller" ref={scroller}>
          {messages.length === 0 && !liveHere && (
            <div className="welcome">
              <h1>Ollama Chat Studio</h1>
              <p>
                Converse com <strong>{caps.displayName}</strong> na nuvem da Ollama. Os recursos acima mostram o que este modelo faz de forma nativa, o que depende de adaptador externo e o que não é suportado — o app só habilita o que é compatível.
              </p>
              <p className="muted small">Abra “Capacidades” e use “Verificar capacidades” para confirmar tudo na sua conta (só metadados, sem gastar tokens).</p>
            </div>
          )}
          {messages.map((m) => (
            <MessageView
              key={m.id}
              message={m}
              isLastAssistant={m.id === lastAssistantId && !streaming}
              busy={streaming}
              ttsOk={ttsOk}
              onRegenerate={() => void guard(() => studio().chat.regenerate(activeId!, modelId, params, toolsEffective))}
              onEdit={(id, text) => void guard(() => studio().chat.editResend(id, text, modelId, params, toolsEffective))}
            />
          ))}
          {liveHere && (
            <article className="msg assistant live">
              <div className="bubble">
                {liveHere.tools.map((c) => (
                  <ToolCallCard key={c.callId} call={c} />
                ))}
                {liveHere.reasoning && <div className="badge info">Raciocinando… (o conteúdo do raciocínio não é exibido)</div>}
                {liveHere.text ? <Markdown text={liveHere.text} /> : !liveHere.reasoning && liveHere.tools.length === 0 && <span className="typing">●●●</span>}
              </div>
            </article>
          )}
        </div>

        {notice && (
          <div className={`toast ${notice.kind}`} role="alert" onClick={() => setNotice(null)}>
            {notice.text}
          </div>
        )}

        <Composer
          model={caps}
          params={params}
          toolsOn={toolsEffective}
          adapters={adapters}
          asrReason={asrReason}
          streaming={streaming}
          onSend={send}
          onStop={() => live && void studio().chat.cancel(live.runId)}
          onNotice={(t) => flash(t)}
        />

        <footer className="statusbar small muted">
          <span>Ollama Cloud · {caps.id}</span>
          <span>{secret?.configured ? 'chave ✓' : 'sem chave'}</span>
          <span>
            conversa: {stats.tin} tok entrada · {stats.tout} tok saída{stats.avg !== undefined ? ` · latência média ${fmtMs(stats.avg)}` : ''}
          </span>
          <span title="O consumo da franquia da conta é medido pela Ollama e não é exposto por esta API.">simultâneos: {settings?.maxConcurrent ?? 1}</span>
        </footer>
      </main>

      {showParams && (
        <ParamsPanel model={caps} params={params} onChange={setParams} toolsOn={toolsEffective} toolsReason={toolsReason} onToolsChange={setToolsOn} />
      )}

      {dialog === 'settings' && <SettingsDialog secret={secret} settings={settings} onClose={() => setDialog(null)} onSecret={setSecret} onSettings={setSettings} />}
      {dialog === 'models' && (
        <ModelsDialog
          models={models}
          ctx={chipCtx}
          hasKey={!!secret?.configured}
          onClose={() => setDialog(null)}
          onVerified={(r) => {
            setModels(r.models);
            if (r.errors.length === 0 || r.tagsOk) flash('Capacidades atualizadas com os dados da sua conta.');
          }}
        />
      )}
      {dialog === 'tools' && <ToolsDialog settings={settings} onClose={() => setDialog(null)} onSettings={setSettings} />}
      {confirms[0] && <ConfirmDialog request={confirms[0]} onAnswer={answerConfirm} />}
    </div>
  );
}
