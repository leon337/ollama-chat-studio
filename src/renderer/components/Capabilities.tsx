import type { CapabilityEntry, ModelCapabilities, SupportLevel, Verification } from '../../shared/capabilities';
import { fmtCtx } from '../lib/util';

export const VERIFY_LABEL: Record<Verification, string> = {
  runtime: 'confirmado agora pela API da sua conta',
  official: 'documentação oficial da Ollama',
  'third-party': 'fonte de terceiros (não oficial)',
  unverified: 'ainda não verificado',
};

export const LEVEL_LABEL: Record<SupportLevel, string> = {
  native: 'nativo (o modelo/API faz)',
  adapter: 'adaptador externo (pipeline do app)',
  unsupported: 'não suportado',
};

interface ChipSpec {
  key: string;
  label: string;
  level: SupportLevel;
  verification: Verification;
  note?: string;
}

export interface ChipContext {
  asrOk: boolean;
  asrReason: string | null;
  ttsOk: boolean;
}

export function chipsFor(m: ModelCapabilities, ctx: ChipContext): ChipSpec[] {
  const spec = (key: string, label: string, e: CapabilityEntry, note?: string): ChipSpec => ({
    key,
    label,
    level: e.level,
    verification: e.verification,
    ...((note ?? e.note) ? { note: note ?? e.note } : {}),
  });
  const audioIn: ChipSpec = ctx.asrOk
    ? spec('audioIn', 'Áudio · ASR', { level: 'adapter', verification: m.audioIn.verification }, 'O modelo não ouve: o áudio é transcrito por um ASR externo e enviado como texto.')
    : spec('audioIn', 'Áudio · sem ASR', { level: 'unsupported', verification: m.audioIn.verification }, `O modelo não processa áudio. ${ctx.asrReason ?? ''}`);
  const think = m.thinking.level === 'native' ? `Thinking${m.thinking.levels ? ` (${m.thinking.levels.map(String).join('/')})` : ''}` : 'Thinking';
  return [
    spec('text', 'Texto', m.textIn),
    spec('image', 'Visão', m.imageIn),
    audioIn,
    spec('video', 'Vídeo · quadros', m.videoIn),
    ctx.ttsOk
      ? spec('audioOut', 'Voz · TTS', { level: 'adapter', verification: m.audioOut.verification }, 'O modelo só gera texto; a voz vem do TTS do sistema (adaptador local).')
      : spec('audioOut', 'Voz · sem TTS', { level: 'unsupported', verification: m.audioOut.verification }, 'Nenhuma voz do sistema disponível para TTS.'),
    spec('tools', 'Tools', m.toolCalling),
    spec('json', 'JSON', m.structuredJson),
    spec('think', think, m.thinking),
  ];
}

export function Chip({ c }: { c: ChipSpec }) {
  const tip = [`${c.label}: ${LEVEL_LABEL[c.level]}`, `Fonte: ${VERIFY_LABEL[c.verification]}`, c.note].filter(Boolean).join('\n');
  return (
    <span className={`chip ${c.level}`} title={tip}>
      <i className={`vmark v-${c.verification}`} aria-label={VERIFY_LABEL[c.verification]} />
      {c.label}
    </span>
  );
}

export function CapabilityChips({ model, ctx }: { model: ModelCapabilities; ctx: ChipContext }) {
  return (
    <div className="chips" aria-label="Capacidades do modelo">
      {chipsFor(model, ctx).map((c) => (
        <Chip key={c.key} c={c} />
      ))}
      <span className="chip ctx" title={`Janela de contexto · fonte: ${VERIFY_LABEL[model.contextVerification]}`}>
        Contexto {fmtCtx(model.contextTokens)}
      </span>
    </div>
  );
}

export function Legend() {
  return (
    <p className="legend">
      <span className="chip native">nativo</span> o modelo/API faz · <span className="chip adapter">adaptador</span> pipeline externo do app ·{' '}
      <span className="chip unsupported">não suportado</span> · fonte do dado: <i className="vmark v-runtime" /> confirmado na sua conta · <i className="vmark v-official" /> doc. oficial ·{' '}
      <i className="vmark v-third-party" /> terceiros · <i className="vmark v-unverified" /> não verificado
    </p>
  );
}
