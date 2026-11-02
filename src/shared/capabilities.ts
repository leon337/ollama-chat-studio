// Tipos do Model Capability Registry.
//
// Regra de ouro: capacidade NATIVA (o modelo/API faz) é diferente de ADAPTADOR
// (pipeline externo: ASR, TTS, extração de quadros) e de NÃO SUPORTADO.
// Cada entrada diz também QUEM garante a informação (verification).

export type SupportLevel = 'native' | 'adapter' | 'unsupported';

/**
 * official    - página oficial da Ollama (docs / library / tags)
 * third-party - agregador (models.dev etc.) ou documentação do fabricante do modelo
 * runtime     - confirmado agora pela API (/api/show) da conta do usuário
 * unverified  - ainda não confirmado; a UI trata como cautela
 */
export type Verification = 'official' | 'third-party' | 'runtime' | 'unverified';

export interface CapabilityEntry {
  level: SupportLevel;
  verification: Verification;
  note?: string;
}

export interface ThinkingEntry extends CapabilityEntry {
  /** Valores aceitos em `think` (ex.: [false,true] ou ['low','medium','high']). null = desconhecido. */
  levels: Array<boolean | string> | null;
}

export type ParamKey = 'temperature' | 'top_p' | 'seed' | 'num_predict' | 'num_ctx';

export interface ParamSpec {
  key: ParamKey;
  min?: number;
  max?: number;
  verification: Verification;
  note?: string;
}

export type Availability = 'listed' | 'not-listed' | 'unknown';

export interface ModelCapabilities {
  id: string;
  displayName: string;
  provider: 'Ollama Cloud';
  cloud: true;
  contextTokens: number | null;
  contextVerification: Verification;

  textIn: CapabilityEntry;
  textOut: CapabilityEntry;
  imageIn: CapabilityEntry;
  imageOut: CapabilityEntry;
  audioIn: CapabilityEntry; // native = o modelo ouve; adapter = ASR externo vira texto
  audioOut: CapabilityEntry; // adapter = TTS externo
  videoIn: CapabilityEntry; // sempre pipeline (quadros + áudio), nunca nativo sem prova
  toolCalling: CapabilityEntry;
  structuredJson: CapabilityEntry;
  thinking: ThinkingEntry;

  params: ParamSpec[];
  availability: Availability;
  sources: string[];
  checkedAt: string;
  /** Divergências entre o catálogo embutido e o que a API reportou em runtime. */
  drift: string[];
}

/** Resposta normalizada de /api/show. */
export interface ShowInfo {
  capabilities: string[];
  contextLength: number | null;
  thinkingValues: Array<boolean | string> | null;
}
