// Políticas de segurança PURAS (sem importar electron) para poderem ser testadas.
// A fiação com o Electron fica em index.ts.

export function buildCsp(opts: { dev: boolean; devOrigin?: string }): string {
  // O renderer NÃO fala com a internet: tudo passa pelo main via IPC (connect-src 'self').
  const dev = opts.dev ? ` ${opts.devOrigin ?? 'http://localhost:5173'} ws://localhost:5173` : '';
  return [
    "default-src 'self'",
    `script-src 'self'${opts.dev ? " 'unsafe-inline'" : ''}`, // inline só em dev (Vite React refresh)
    "style-src 'self' 'unsafe-inline'", // estilos inline do React; sem execução de código
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src 'self'${dev}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function webPreferences(preloadPath: string) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
  } as const;
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/i;

/** URLs que o app aceita abrir no navegador do sistema: https, sem credenciais, sem host local/privado. */
export function isAllowedExternalUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (PRIVATE_HOST.test(u.hostname)) return false;
  return true;
}

/** Só aceita IPC vindo do nosso próprio renderer (file do bundle ou o dev server). */
export function isTrustedSender(senderUrl: string, opts: { rendererFileUrlPrefix: string; devUrl?: string }): boolean {
  if (opts.devUrl && senderUrl.startsWith(opts.devUrl)) return true;
  return senderUrl.startsWith(opts.rendererFileUrlPrefix);
}

export function isAllowedNavigation(targetUrl: string, opts: { rendererFileUrlPrefix: string; devUrl?: string }): boolean {
  return isTrustedSender(targetUrl, opts);
}
