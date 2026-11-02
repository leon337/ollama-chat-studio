import { app, BrowserWindow, ipcMain, safeStorage, session, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeConfirm, registerIpc } from './ipc';
import { buildCsp, isAllowedExternalUrl, isAllowedNavigation, isTrustedSender, webPreferences } from './security';
import { createServices } from './services';
import { NativeLinuxTts } from './tts';

const DEV_URL = process.env.STUDIO_DEV_URL; // definido só por scripts/dev.mjs
const RENDERER_DIR = join(__dirname, '..', 'renderer');
const trust = { rendererFileUrlPrefix: pathToFileURL(RENDERER_DIR).href, ...(DEV_URL ? { devUrl: DEV_URL } : {}) };

let mainWindow: BrowserWindow | null = null;
const nativeTts = new NativeLinuxTts((state) => mainWindow?.webContents.send('tts:state', state));
const pendingConfirms = new Map<string, (approved: boolean) => void>();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Ollama Chat Studio',
    webPreferences: webPreferences(join(__dirname, '..', 'preload', 'index.js')),
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    nativeTts.stop();
    for (const resolve of pendingConfirms.values()) resolve(false); // fechar a janela nega ações pendentes
    pendingConfirms.clear();
    mainWindow = null;
  });
  if (DEV_URL) void mainWindow.loadURL(DEV_URL);
  else void mainWindow.loadFile(join(RENDERER_DIR, 'index.html'));
}

function hardenSession(): void {
  const csp = buildCsp({ dev: !!DEV_URL, ...(DEV_URL ? { devOrigin: DEV_URL } : {}) });
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  // Única permissão concedida: microfone (gravação de voz), e só para o nosso próprio renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    cb(permission === 'media' && types.every((t) => t === 'audio') && isTrustedSender(details.requestingUrl, trust));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && isTrustedSender(origin, trust));
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (!isAllowedNavigation(url, trust)) e.preventDefault();
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    app.setName('Ollama Chat Studio');
    hardenSession();
    const openExternal = async (url: string) => {
      if (!isAllowedExternalUrl(url)) throw new Error('URL não permitida.');
      await shell.openExternal(url);
    };
    const services = createServices({
      userDataDir: app.getPath('userData'),
      safeStorage,
      openExternal,
      requestConfirm: makeConfirm(() => mainWindow, pendingConfirms),
    });
    registerIpc({ ipcMain, services, getWindow: () => mainWindow, trust, pendingConfirms, openExternal, nativeTts, version: app.getVersion() });
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
