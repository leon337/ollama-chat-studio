import type { AppSettings } from '../../shared/api';
import { validateAsrUrl } from '../../shared/asr';

// Adaptadores ASR/TTS são EXTERNOS ao modelo de linguagem. Aqui ficam identificados como tal.
//  - ASR (áudio -> texto): HttpAsrAdapter, para qualquer servidor compatível com
//    POST multipart {file, model} -> {"text": "..."} (ex.: whisper.cpp server local, ou um serviço de terceiros).
//    DESLIGADO por padrão. Se o endpoint não for local, exige consentimento explícito (o áudio sai do computador).
//  - TTS (texto -> voz): fica no renderer (speechSynthesis do sistema), pois é local e não envia dados.
// Não validado contra um serviço ASR real nesta entrega (ver README: Pendente).

export interface AsrAdapter {
  id: string;
  label: string;
  /** true = o áudio sai deste computador. */
  external: boolean;
  transcribe(bytes: Uint8Array, mime: string, signal?: AbortSignal): Promise<string>;
}

export class AsrError extends Error {}

// Mesma regra usada pela UI (shared/asr.ts) para habilitar/desabilitar mic e áudio.
export { validateAsrUrl };

export class HttpAsrAdapter implements AsrAdapter {
  readonly id = 'http-asr';
  readonly label: string;
  readonly external: boolean;

  constructor(
    private readonly url: URL,
    private readonly model: string,
    private readonly getKey: () => string | undefined,
    local: boolean,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 60_000,
  ) {
    this.external = !local;
    this.label = `ASR HTTP (${url.hostname})${local ? ' · local' : ' · externo'}`;
  }

  async transcribe(bytes: Uint8Array, mime: string, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([bytes as BlobPart], { type: mime }), 'audio');
    if (this.model) form.append('model', this.model);
    const key = this.getKey();
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    signal?.addEventListener('abort', () => ctl.abort(), { once: true });
    try {
      const res = await this.fetchImpl(this.url, { method: 'POST', body: form, headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: ctl.signal });
      if (!res.ok) throw new AsrError(`ASR respondeu ${res.status}.`);
      const json = (await res.json()) as { text?: unknown };
      if (typeof json.text !== 'string') throw new AsrError('Resposta do ASR sem campo "text".');
      return json.text.trim();
    } finally {
      clearTimeout(t);
    }
  }
}

/** Constrói o adaptador a partir das configurações; null se não estiver apto a uso. */
export function buildAsrAdapter(
  s: Omit<AppSettings['asr'], 'keyConfigured'>,
  getKey: () => string | undefined,
  fetchImpl?: typeof fetch,
): AsrAdapter | null {
  if (!s.enabled || !s.url) return null;
  const v = validateAsrUrl(s.url);
  if (!v.ok) return null;
  if (!v.local && !s.consentExternalAudio) return null; // sem consentimento, áudio não sai
  return new HttpAsrAdapter(v.url, s.model, getKey, v.local, fetchImpl);
}
