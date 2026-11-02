// Redação de segredos para logs, erros e auditoria. Nunca registre texto bruto de requisições.

const PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]'],
  [/("?(?:api[_-]?key|authorization|token|secret|password)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1"[REDACTED]"'],
  [/\b[a-f0-9]{32}\.[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]'],
];

export function redact(input: string, knownSecrets: string[] = []): string {
  let out = input;
  for (const s of knownSecrets) {
    if (s && s.length >= 6) out = out.split(s).join('[REDACTED]');
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redactDeep(value: unknown, knownSecrets: string[] = []): unknown {
  if (typeof value === 'string') return redact(value, knownSecrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, knownSecrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /^(api[_-]?key|authorization|token|secret|password)$/i.test(k) ? '[REDACTED]' : redactDeep(v, knownSecrets);
    }
    return out;
  }
  return value;
}
