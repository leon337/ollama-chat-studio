import type {
  Availability,
  CapabilityEntry,
  ModelCapabilities,
  ShowInfo,
  ThinkingEntry,
} from './capabilities';
import { SEED_MODELS } from './seed';

/** Converte a resposta crua de POST /api/show em ShowInfo. Tolerante a campos ausentes. */
export function parseShowResponse(json: unknown): ShowInfo {
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const caps = Array.isArray(o.capabilities) ? o.capabilities.filter((c): c is string => typeof c === 'string') : [];
  let contextLength: number | null = null;
  const info = o.model_info;
  if (info && typeof info === 'object') {
    for (const [k, v] of Object.entries(info as Record<string, unknown>)) {
      if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) contextLength = v;
    }
  }
  let thinkingValues: ShowInfo['thinkingValues'] = null;
  const th = o.thinking;
  if (th && typeof th === 'object' && Array.isArray((th as { values?: unknown }).values)) {
    thinkingValues = (th as { values: unknown[] }).values.filter(
      (v): v is boolean | string => typeof v === 'boolean' || typeof v === 'string',
    );
  }
  const proposedDefault = th && typeof th === 'object' ? (th as { default?: unknown }).default : undefined;
  const thinkingDefault = (typeof proposedDefault === 'boolean' || typeof proposedDefault === 'string') &&
    (thinkingValues?.includes(proposedDefault) ?? false) ? proposedDefault : undefined;
  return {
    capabilities: caps, contextLength, thinkingValues,
    ...(thinkingDefault !== undefined ? { thinkingDefault } : {}),
  };
}

const clone = <T,>(v: T): T => structuredClone(v);

/** Recalcula entradas derivadas (vídeo depende de visão). */
function finalize(m: ModelCapabilities): ModelCapabilities {
  const vision = m.imageIn.level === 'native';
  m.videoIn = vision
    ? {
        level: 'adapter',
        verification: m.imageIn.verification,
        note: 'Sem vídeo nativo: o app extrai quadros com timestamps e (opcional) transcreve o áudio.',
      }
    : { level: 'unsupported', verification: m.imageIn.verification, note: 'Sem visão, não há como analisar quadros de vídeo.' };
  return m;
}

/** Modelo desconhecido: texto apenas, todo o resto fica fechado até haver prova em runtime. */
export function conservativeEntry(id: string): ModelCapabilities {
  const none = (note: string): CapabilityEntry => ({ level: 'unsupported', verification: 'unverified', note });
  const text: CapabilityEntry = { level: 'native', verification: 'unverified' };
  return finalize({
    id,
    displayName: id,
    provider: 'Ollama Cloud',
    cloud: true,
    contextTokens: null,
    contextVerification: 'unverified',
    textIn: text,
    textOut: text,
    imageIn: none('Não confirmado. Use "Verificar capacidades".'),
    imageOut: none('Não confirmado.'),
    audioIn: { level: 'adapter', verification: 'unverified', note: 'Só via ASR externo.' },
    audioOut: { level: 'adapter', verification: 'unverified', note: 'Só via TTS externo.' },
    videoIn: none('Depende de visão.'),
    toolCalling: none('Não confirmado.'),
    structuredJson: { level: 'native', verification: 'unverified', note: 'Campo format da API; sem flag por modelo.' },
    thinking: { ...none('Não confirmado.'), levels: null },
    params: [
      { key: 'temperature', min: 0, max: 2, verification: 'unverified' },
      { key: 'top_p', min: 0, max: 1, verification: 'unverified' },
      { key: 'seed', verification: 'unverified' },
      { key: 'num_predict', min: 1, verification: 'unverified' },
    ],
    availability: 'unknown',
    sources: [],
    checkedAt: new Date().toISOString().slice(0, 10),
    drift: [],
  });
}

export class ModelCapabilityRegistry {
  private models = new Map<string, ModelCapabilities>();

  constructor(seed: ModelCapabilities[] = SEED_MODELS) {
    for (const m of seed) this.models.set(m.id, finalize(clone(m)));
  }

  list(): ModelCapabilities[] {
    return [...this.models.values()].map(clone);
  }

  get(id: string): ModelCapabilities | undefined {
    const m = this.models.get(id);
    return m ? clone(m) : undefined;
  }

  /** Marca a disponibilidade de acordo com GET /api/tags da conta. */
  applyTags(names: string[]): void {
    const listed = new Set(names.map((n) => n.replace(/:cloud$|-cloud$/, '')));
    for (const m of this.models.values()) {
      const avail: Availability = listed.has(m.id) ? 'listed' : 'not-listed';
      m.availability = avail;
    }
  }

  markUnknownAvailability(): void {
    for (const m of this.models.values()) m.availability = 'unknown';
  }

  /** Aplica a resposta de /api/show (prova em runtime) e registra divergências do catálogo. */
  applyShow(id: string, info: ShowInfo): ModelCapabilities {
    const m = this.models.get(id) ?? conservativeEntry(id);
    const drift: string[] = [];
    const has = (c: string) => info.capabilities.includes(c);
    const sync = (label: string, current: CapabilityEntry, present: boolean): CapabilityEntry => {
      const was = current.level === 'native';
      if (current.verification !== 'unverified' && was !== present) {
        drift.push(`${label}: catálogo dizia ${was ? 'nativo' : 'ausente'}, a API informou ${present ? 'nativo' : 'ausente'}.`);
      }
      return { level: present ? 'native' : 'unsupported', verification: 'runtime', ...(current.note ? { note: current.note } : {}) };
    };

    m.imageIn = sync('Visão', m.imageIn, has('vision'));
    m.toolCalling = sync('Tool calling', m.toolCalling, has('tools'));

    const thinkingPresent = has('thinking');
    const thinkingBase = sync('Thinking', m.thinking, thinkingPresent);
    const thinking: ThinkingEntry = {
      ...thinkingBase,
      levels: thinkingPresent ? (info.thinkingValues ?? m.thinking.levels ?? [false, true]) : null,
      ...(thinkingPresent && info.thinkingDefault !== undefined ? { default: info.thinkingDefault } : {}),
    };
    m.thinking = thinking;

    if (info.contextLength) {
      if (m.contextTokens && m.contextTokens !== info.contextLength && m.contextVerification !== 'unverified') {
        drift.push(`Contexto: catálogo ${m.contextTokens}, API ${info.contextLength}.`);
      }
      m.contextTokens = info.contextLength;
      m.contextVerification = 'runtime';
      m.params = m.params.map((p) => (p.key === 'num_ctx' ? { ...p, max: info.contextLength! } : p));
      if (!m.params.some((p) => p.key === 'num_ctx')) {
        m.params.push({ key: 'num_ctx', min: 512, max: info.contextLength, verification: 'runtime' });
      }
    }
    if (has('completion')) {
      m.textIn = { level: 'native', verification: 'runtime' };
      m.textOut = { level: 'native', verification: 'runtime' };
    }
    m.drift = drift;
    m.availability = 'listed';
    m.checkedAt = new Date().toISOString().slice(0, 10);
    this.models.set(id, finalize(m));
    return clone(m);
  }
}
