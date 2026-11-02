// Regras puras do adaptador ASR, compartilhadas entre main (aplica) e renderer (habilita/desabilita a UI).

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export type AsrUrlCheck = { ok: true; url: URL; local: boolean } | { ok: false; reason: string };

export function validateAsrUrl(raw: string): AsrUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL inválida.' };
  }
  const local = LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { ok: false, reason: 'Use https (http só é aceito para localhost).' };
  }
  return { ok: true, url, local };
}

export interface AsrSettingsLike {
  enabled: boolean;
  url: string;
  consentExternalAudio: boolean;
}

/** Por que o ASR não está utilizável (null = utilizável). */
export function asrBlockedReason(s: AsrSettingsLike): string | null {
  if (!s.enabled) return 'ASR desligado em Configurações.';
  if (!s.url) return 'Informe a URL do serviço ASR em Configurações.';
  const v = validateAsrUrl(s.url);
  if (!v.ok) return v.reason;
  if (!v.local && !s.consentExternalAudio) return 'O ASR é externo: autorize o envio do áudio em Configurações.';
  return null;
}

export const asrUsable = (s: AsrSettingsLike): boolean => asrBlockedReason(s) === null;
