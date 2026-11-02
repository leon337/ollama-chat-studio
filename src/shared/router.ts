import type { ModelCapabilities } from './capabilities';

// ModelRouter (parte pura): decide se um pedido é compatível com o modelo e qual
// pipeline é necessário. Roda no main (aplicação obrigatória) E no renderer
// (para desabilitar controles e explicar limites). Nunca assume compatibilidade.

export type AttachmentKind = 'image' | 'audio' | 'video' | 'pdf' | 'text';

export interface AdapterAvailability {
  asr: boolean;
  tts: boolean;
}

export type RouteCode =
  | 'VISION_UNSUPPORTED'
  | 'VIDEO_NEEDS_VISION'
  | 'ASR_ADAPTER_MISSING'
  | 'TOOLS_UNSUPPORTED'
  | 'THINK_UNSUPPORTED'
  | 'THINK_VALUE_INVALID'
  | 'CONTEXT_EXCEEDED'
  | 'TEXT_UNSUPPORTED'
  | 'JSON_UNVERIFIED'
  | 'VIDEO_NO_AUDIO_TRANSCRIPT'
  | 'MODEL_NOT_LISTED';

export interface RouteIssue {
  code: RouteCode;
  message: string;
}

export interface PipelineStep {
  id: 'pdf-text' | 'text-inline' | 'image-native' | 'video-frames' | 'audio-asr' | 'tts';
  label: string;
  /** true = o modelo faz; false = pipeline externo ao modelo (adaptador). */
  native: boolean;
}

export interface RoutePlan {
  ok: boolean;
  blocks: RouteIssue[];
  warnings: RouteIssue[];
  pipeline: PipelineStep[];
}

export interface RouteRequest {
  model: ModelCapabilities;
  attachments: AttachmentKind[];
  tools: boolean;
  json: boolean;
  think?: boolean | string | null;
  numCtx?: number | null;
  adapters: AdapterAvailability;
}

export function planRoute(req: RouteRequest): RoutePlan {
  const { model: m, adapters } = req;
  const blocks: RouteIssue[] = [];
  const warnings: RouteIssue[] = [];
  const pipeline: PipelineStep[] = [];
  const add = (step: PipelineStep) => {
    if (!pipeline.some((p) => p.id === step.id)) pipeline.push(step);
  };

  if (m.textIn.level === 'unsupported') {
    blocks.push({ code: 'TEXT_UNSUPPORTED', message: `${m.displayName} não aceita texto de entrada.` });
  }
  if (m.availability === 'not-listed') {
    warnings.push({ code: 'MODEL_NOT_LISTED', message: 'Este modelo não apareceu em /api/tags da sua conta; a chamada pode falhar.' });
  }

  const kinds = new Set(req.attachments);
  const vision = m.imageIn.level === 'native';

  if (kinds.has('image')) {
    if (vision) add({ id: 'image-native', label: 'Imagem enviada direto ao modelo (visão nativa)', native: true });
    else blocks.push({ code: 'VISION_UNSUPPORTED', message: `${m.displayName} não tem visão. Escolha um modelo com visão para enviar imagens.` });
  }

  if (kinds.has('pdf')) add({ id: 'pdf-text', label: 'Texto extraído do PDF no app (não é leitura nativa)', native: false });
  if (kinds.has('text')) add({ id: 'text-inline', label: 'Arquivo de texto incluído como dado no prompt', native: false });

  if (kinds.has('audio')) {
    // Nenhum modelo do catálogo ouve áudio: só entra via ASR. (Mesmo que um modelo
    // futuro declare áudio nativo, o app ainda não envia áudio bruto — usa ASR.)
    if (adapters.asr) add({ id: 'audio-asr', label: 'Áudio transcrito por ASR externo e enviado como texto', native: false });
    else blocks.push({ code: 'ASR_ADAPTER_MISSING', message: 'O modelo não processa áudio. Configure um adaptador ASR em Configurações para transcrever.' });
  }

  if (kinds.has('video')) {
    if (!vision) {
      blocks.push({ code: 'VIDEO_NEEDS_VISION', message: `Vídeo é analisado por quadros; ${m.displayName} não tem visão.` });
    } else {
      add({ id: 'video-frames', label: 'Vídeo → quadros com timestamps (pipeline do app, não vídeo nativo)', native: false });
      if (adapters.asr) add({ id: 'audio-asr', label: 'Áudio do vídeo transcrito por ASR externo', native: false });
      else warnings.push({ code: 'VIDEO_NO_AUDIO_TRANSCRIPT', message: 'Sem ASR configurado, o áudio do vídeo será ignorado (só quadros).' });
    }
  }

  if (req.tools && m.toolCalling.level !== 'native') {
    blocks.push({ code: 'TOOLS_UNSUPPORTED', message: `${m.displayName} não tem tool calling confirmado.` });
  }

  if (req.json && m.structuredJson.verification === 'unverified') {
    warnings.push({ code: 'JSON_UNVERIFIED', message: 'Saída JSON depende do campo format; o app validará o resultado com o schema.' });
  }

  if (req.think !== undefined && req.think !== null && req.think !== false) {
    if (m.thinking.level !== 'native') {
      blocks.push({ code: 'THINK_UNSUPPORTED', message: `${m.displayName} não tem modo de raciocínio (thinking).` });
    } else if (m.thinking.levels && !m.thinking.levels.includes(req.think)) {
      blocks.push({
        code: 'THINK_VALUE_INVALID',
        message: `Valor de thinking inválido. Aceitos: ${m.thinking.levels.map(String).join(', ')}.`,
      });
    }
  }

  if (req.numCtx && m.contextTokens && req.numCtx > m.contextTokens) {
    blocks.push({ code: 'CONTEXT_EXCEEDED', message: `num_ctx ${req.numCtx} excede o contexto do modelo (${m.contextTokens}).` });
  }

  return { ok: blocks.length === 0, blocks, warnings, pipeline };
}

export interface AttachAccept {
  image: { enabled: boolean; reason: string | null };
  audio: { enabled: boolean; reason: string | null };
  video: { enabled: boolean; reason: string | null };
  pdf: { enabled: boolean; reason: string | null };
  text: { enabled: boolean; reason: string | null };
}

/** Para a UI: o que o composer pode habilitar para este modelo, e o porquê quando não pode. */
export function attachAccept(m: ModelCapabilities, adapters: AdapterAvailability): AttachAccept {
  const vision = m.imageIn.level === 'native';
  return {
    image: { enabled: vision, reason: vision ? null : `${m.displayName} não tem visão.` },
    audio: { enabled: adapters.asr, reason: adapters.asr ? null : 'Modelo sem áudio nativo e nenhum ASR configurado.' },
    video: { enabled: vision, reason: vision ? null : 'Vídeo é analisado por quadros e exige modelo com visão.' },
    pdf: { enabled: true, reason: null },
    text: { enabled: true, reason: null },
  };
}
