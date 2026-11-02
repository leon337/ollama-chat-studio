import { useEffect, useRef, useState } from 'react';
import type { ChatParams } from '../../shared/api';
import type { ModelCapabilities } from '../../shared/capabilities';
import { thinkingAvailable, thinkingChoiceKey, thinkingOptions, thinkingSummary } from '../../shared/thinking';

interface Props {
  model: ModelCapabilities;
  models: ModelCapabilities[];
  think: ChatParams['think'];
  disabled: boolean;
  onModelChange: (id: string) => void;
  onThinkChange: (value: string) => void;
  onOpenCapabilities: () => void;
}

/** O menu não modifica regras de envio: somente valores conhecidos chegam ao backend. */
export function ModelReasoningPicker({ model, models, think, disabled, onModelChange, onThinkChange, onOpenCapabilities }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const available = thinkingAvailable(model.thinking);
  const choices = thinkingOptions(model.thinking);
  const summary = thinkingSummary(model, think);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return (
    <div className="model-reasoning-picker" ref={root}>
      <button
        ref={trigger}
        className="model-reasoning-trigger"
        type="button"
        aria-label="Selecionar modelo e nível de raciocínio"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        title={model.displayName + ' · ' + summary}
        onClick={() => setOpen((x) => !x)}
      >
        <span className="picker-model">{model.displayName}</span>
        <span className="picker-thinking">{available ? summary : 'Sem raciocínio'}</span>
        <span className="picker-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="model-reasoning-menu" role="dialog" aria-label="Modelo e raciocínio">
          <div className="picker-menu-title">Modelo e raciocínio</div>
          <label className="field">
            <span>Modelo Ollama Cloud</span>
            <select aria-label="Modelo no compositor" value={model.id} onChange={(e) => onModelChange(e.target.value)}>
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName}{item.availability === 'not-listed' ? ' · fora da conta' : ''}
                </option>
              ))}
              {!models.some((m) => m.id === model.id) && <option value={model.id}>{model.id} · não verificado</option>}
            </select>
          </label>
          <label className="field">
            <span>Nível de raciocínio</span>
            <select aria-label="Nível de raciocínio" value={thinkingChoiceKey(model, think)} disabled={!available}
              onChange={(e) => onThinkChange(e.target.value)}>
              {choices.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          </label>
          <p className="picker-help">
            {!available
              ? 'Este modelo não permite configurar o raciocínio.'
              : model.thinking.verification === 'runtime'
                ? 'Níveis verificados na API Ollama para este modelo.'
                : 'Níveis do catálogo. Confirme as capacidades na sua conta para atualizar.'}
            {' '}O padrão deixa a Ollama decidir.
          </p>
          <button className="picker-verify" type="button" onClick={() => { setOpen(false); onOpenCapabilities(); }}>
            Verificar capacidades
          </button>
        </div>
      )}
    </div>
  );
}
