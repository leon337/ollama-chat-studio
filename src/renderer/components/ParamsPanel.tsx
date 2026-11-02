import { useState } from 'react';
import type { ChatParams } from '../../shared/api';
import type { ModelCapabilities, ParamKey } from '../../shared/capabilities';

interface Props {
  model: ModelCapabilities;
  params: ChatParams;
  onChange: (p: ChatParams) => void;
  toolsOn: boolean;
  toolsReason: string | null;
  onToolsChange: (v: boolean) => void;
}

const DEFS: Array<{ key: ParamKey; label: string; step: number; integer?: boolean; hint: string }> = [
  { key: 'temperature', label: 'Temperature', step: 0.05, hint: 'Aleatoriedade. Vazio = padrão do modelo.' },
  { key: 'top_p', label: 'Top P', step: 0.05, hint: 'Amostragem por núcleo. Vazio = padrão do modelo.' },
  { key: 'seed', label: 'Seed', step: 1, integer: true, hint: 'Tentativa de reprodutibilidade; a nuvem não garante.' },
  { key: 'num_predict', label: 'Máx. tokens de saída', step: 1, integer: true, hint: 'Limite de tokens gerados.' },
  { key: 'num_ctx', label: 'Contexto (num_ctx)', step: 1024, integer: true, hint: 'A nuvem pode ignorar ou limitar este valor.' },
];

export function ParamsPanel({ model, params, onChange, toolsOn, toolsReason, onToolsChange }: Props) {
  const [schemaText, setSchemaText] = useState('');
  const [schemaErr, setSchemaErr] = useState<string | null>(null);
  const set = (patch: Partial<ChatParams>) => {
    const next = { ...params, ...patch };
    for (const k of Object.keys(next) as Array<keyof ChatParams>) if (next[k] === undefined) delete next[k];
    onChange(next);
  };

  const thinkOptions: Array<{ value: string; label: string }> = [{ value: '', label: 'Padrão do modelo (não enviar)' }];
  if (model.thinking.level === 'native') {
    for (const v of model.thinking.levels ?? [false, true]) {
      thinkOptions.push({ value: String(v), label: v === false ? 'Desligado' : v === true ? 'Ligado' : `Nível: ${v}` });
    }
  }
  const thinkValue = params.think === undefined || params.think === null ? '' : String(params.think);

  function onThink(v: string) {
    if (v === '') return set({ think: undefined });
    set({ think: v === 'true' ? true : v === 'false' ? false : v });
  }

  function onJsonMode(mode: 'off' | 'json' | 'schema') {
    if (mode === 'off') {
      setSchemaErr(null);
      return set({ json: undefined });
    }
    if (mode === 'json') {
      setSchemaErr(null);
      return set({ json: true });
    }
    applySchema(schemaText || '{"type":"object","properties":{},"additionalProperties":true}');
  }

  function applySchema(text: string) {
    setSchemaText(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('O schema deve ser um objeto JSON.');
      setSchemaErr(null);
      set({ json: parsed as Record<string, unknown> });
    } catch (e) {
      setSchemaErr((e as Error).message);
    }
  }

  const jsonMode = params.json === undefined || params.json === false ? 'off' : params.json === true ? 'json' : 'schema';

  return (
    <aside className="params" aria-label="Parâmetros">
      <h3>Parâmetros</h3>
      <p className="muted small">Enviados à API no campo options. A eficácia de cada um por modelo não é garantida pela documentação.</p>

      {DEFS.map((d) => {
        const spec = model.params.find((p) => p.key === d.key);
        if (!spec) return null;
        const value = params[d.key];
        return (
          <label key={d.key} className="field" title={`${d.hint}${spec.note ? `\n${spec.note}` : ''}`}>
            <span>
              {d.label}
              {spec.min !== undefined || spec.max !== undefined ? <em className="muted small"> ({spec.min ?? '…'}–{spec.max ?? '…'})</em> : null}
            </span>
            <input
              type="number"
              value={value ?? ''}
              placeholder="padrão"
              step={d.step}
              {...(spec.min !== undefined ? { min: spec.min } : {})}
              {...(spec.max !== undefined ? { max: spec.max } : {})}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') return set({ [d.key]: undefined } as Partial<ChatParams>);
                const n = Number(raw);
                if (!Number.isFinite(n)) return;
                set({ [d.key]: d.integer ? Math.round(n) : n } as Partial<ChatParams>);
              }}
            />
          </label>
        );
      })}

      <label className="field">
        <span>Raciocínio (thinking)</span>
        <select value={thinkValue} disabled={model.thinking.level !== 'native'} onChange={(e) => onThink(e.target.value)}>
          {thinkOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {model.thinking.level !== 'native' && <small className="muted">Este modelo não oferece thinking.</small>}
        {model.thinking.level === 'native' && <small className="muted">O texto do raciocínio não é exibido nem salvo; só o indicador.</small>}
      </label>

      <label className="field">
        <span>Saída estruturada</span>
        <select value={jsonMode} onChange={(e) => onJsonMode(e.target.value as 'off' | 'json' | 'schema')}>
          <option value="off">Texto livre</option>
          <option value="json">JSON livre</option>
          <option value="schema">JSON Schema</option>
        </select>
        {model.structuredJson.verification === 'unverified' && jsonMode !== 'off' && (
          <small className="muted">Suporte por modelo não verificado: o app valida a resposta contra o schema e avisa se não bater.</small>
        )}
      </label>
      {jsonMode === 'schema' && (
        <label className="field">
          <textarea rows={6} spellCheck={false} value={schemaText} onChange={(e) => applySchema(e.target.value)} aria-label="JSON Schema" />
          {schemaErr && <small className="err">{schemaErr}</small>}
        </label>
      )}

      <label className={`check${toolsReason ? ' disabled' : ''}`} title={toolsReason ?? 'Permite ao modelo chamar as tools da allowlist.'}>
        <input type="checkbox" checked={toolsOn && !toolsReason} disabled={!!toolsReason} onChange={(e) => onToolsChange(e.target.checked)} />
        Tool calling
      </label>
      {toolsReason && <small className="muted">{toolsReason}</small>}
      <button className="link" onClick={() => onChange({})}>
        Restaurar padrões
      </button>
    </aside>
  );
}
