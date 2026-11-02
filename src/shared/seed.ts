import type { ModelCapabilities, ParamSpec, Verification } from './capabilities';

// Catálogo inicial. Cada valor veio de fonte consultada em 2026-10-31 (ver `sources`).
// NADA aqui é "palpite": o que não foi encontrado fica 'unverified' ou 'unsupported'.
// Ao clicar em "Verificar capacidades" o app consulta /api/show e sobrescreve com 'runtime'.

export const SEED_CHECKED_AT = '2026-10-31';

const OFFICIAL_TAGS_GEMMA4 = 'https://ollama.com/library/gemma4/tags';
const OFFICIAL_CLOUD_SEARCH = 'https://ollama.com/search?c=cloud';
const OFFICIAL_CLOUD_DOCS = 'https://docs.ollama.com/cloud';
const MODELS_DEV = 'https://models.dev (ollama-cloud, via mastra.ai/models/providers/ollama-cloud)';
const BEAM_PR = 'https://github.com/anomalyco/models.dev/pull/10626 (cita registry.ollama.com/library/beam:cloud)';
const BEAM_X = 'https://x.com/ollama/status/2111087699574903061 (anúncio oficial da Ollama)';
const GOOGLE_CARD = 'https://huggingface.co/google/gemma-4-E4B (áudio só em E2B/E4B; 31B sem áudio)';

const e = (level: 'native' | 'adapter' | 'unsupported', verification: Verification, note?: string) => ({
  level,
  verification,
  ...(note ? { note } : {}),
});

const baseParams = (ctx: number | null): ParamSpec[] => [
  { key: 'temperature', min: 0, max: 2, verification: 'unverified', note: 'Campo options da API; efeito por modelo não verificado.' },
  { key: 'top_p', min: 0, max: 1, verification: 'unverified' },
  { key: 'seed', verification: 'unverified', note: 'Reprodutibilidade não é garantida na nuvem.' },
  { key: 'num_predict', min: 1, verification: 'unverified' },
  { key: 'num_ctx', min: 512, ...(ctx ? { max: ctx } : {}), verification: 'unverified', note: 'A nuvem pode ignorar ou limitar este valor.' },
];

interface Partial1 {
  id: string;
  displayName: string;
  ctx: number | null;
  ctxVerification: Verification;
  imageIn: ModelCapabilities['imageIn'];
  tools: ModelCapabilities['toolCalling'];
  thinking: ModelCapabilities['thinking'];
  sources: string[];
}

function make(p: Partial1): ModelCapabilities {
  const hasVision = p.imageIn.level === 'native';
  return {
    id: p.id,
    displayName: p.displayName,
    provider: 'Ollama Cloud',
    cloud: true,
    contextTokens: p.ctx,
    contextVerification: p.ctxVerification,
    textIn: e('native', 'official'),
    textOut: e('native', 'official'),
    imageIn: p.imageIn,
    imageOut: e('unsupported', 'official', 'Nenhum modelo do catálogo gera imagens.'),
    audioIn: e('adapter', 'official', 'O modelo não ouve áudio. Requer ASR externo (áudio vira texto antes do envio).'),
    audioOut: e('adapter', 'official', 'O modelo só gera texto. Voz exige TTS externo.'),
    videoIn: hasVision
      ? e('adapter', 'official', 'Sem vídeo nativo: o app extrai quadros com timestamps e (opcional) transcreve o áudio.')
      : e('unsupported', 'official', 'Sem visão, não há como analisar quadros de vídeo.'),
    toolCalling: p.tools,
    structuredJson: e(
      'native',
      'unverified',
      'A API aceita o campo format (JSON / JSON Schema), mas não há flag por modelo. O app valida a saída com JSON Schema.',
    ),
    thinking: p.thinking,
    params: baseParams(p.ctx),
    availability: 'unknown',
    sources: p.sources,
    checkedAt: SEED_CHECKED_AT,
    drift: [],
  };
}

const noThinkingText = 'Sem a tag "thinking" no catálogo oficial.';

export const SEED_MODELS: ModelCapabilities[] = [
  make({
    id: 'beam',
    displayName: 'Beam (Reflection)',
    ctx: 1_000_000,
    ctxVerification: 'official',
    imageIn: e('unsupported', 'third-party', 'Somente texto (texto entra, texto sai).'),
    tools: e('native', 'third-party'),
    thinking: { ...e('native', 'third-party'), levels: [false, true] },
    sources: [BEAM_X, BEAM_PR],
  }),
  make({
    id: 'gemma4:31b',
    displayName: 'Gemma 4 31B',
    ctx: 262_144,
    ctxVerification: 'official',
    imageIn: e('native', 'official', 'Texto e imagem de entrada. O 31B não tem áudio.'),
    tools: e('native', 'official'),
    thinking: { ...e('native', 'official'), levels: [false, true] },
    sources: [OFFICIAL_TAGS_GEMMA4, GOOGLE_CARD],
  }),
  make({
    id: 'gpt-oss:120b',
    displayName: 'GPT-OSS 120B',
    ctx: 131_072,
    ctxVerification: 'third-party',
    imageIn: e('unsupported', 'official', 'Somente texto.'),
    tools: e('native', 'official'),
    thinking: { ...e('native', 'official', 'Aceita níveis de esforço, não apenas on/off.'), levels: ['low', 'medium', 'high'] },
    sources: [OFFICIAL_CLOUD_SEARCH, MODELS_DEV],
  }),
  make({
    id: 'gpt-oss:20b',
    displayName: 'GPT-OSS 20B',
    ctx: 131_072,
    ctxVerification: 'third-party',
    imageIn: e('unsupported', 'official', 'Somente texto.'),
    tools: e('native', 'official'),
    thinking: { ...e('native', 'official', 'Aceita níveis de esforço, não apenas on/off.'), levels: ['low', 'medium', 'high'] },
    sources: [OFFICIAL_CLOUD_SEARCH, MODELS_DEV],
  }),
  make({
    id: 'nemotron-3-nano:30b',
    displayName: 'Nemotron 3 Nano 30B',
    ctx: 1_000_000,
    ctxVerification: 'third-party',
    imageIn: e('unsupported', 'third-party', 'Somente texto.'),
    tools: e('native', 'third-party'),
    thinking: { ...e('native', 'third-party'), levels: [false, true] },
    sources: [MODELS_DEV],
  }),
  make({
    id: 'nemotron-3-super',
    displayName: 'Nemotron 3 Super',
    ctx: 262_144,
    ctxVerification: 'third-party',
    imageIn: e('unsupported', 'third-party', 'Somente texto.'),
    tools: e('native', 'official'),
    thinking: { level: 'unsupported', verification: 'official', note: noThinkingText, levels: null },
    sources: [OFFICIAL_CLOUD_SEARCH, MODELS_DEV],
  }),
  make({
    id: 'nemotron-3-ultra',
    displayName: 'Nemotron 3 Ultra',
    ctx: 262_144,
    ctxVerification: 'third-party',
    imageIn: e('unsupported', 'third-party', 'Somente texto.'),
    tools: e('native', 'official'),
    thinking: { ...e('native', 'official'), levels: [false, true] },
    sources: [OFFICIAL_CLOUD_SEARCH, MODELS_DEV],
  }),
];

export const CLOUD_DOCS_URL = OFFICIAL_CLOUD_DOCS;
