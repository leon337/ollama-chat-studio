import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent, ToolConfirmRequest } from '../../src/shared/api';
import type { SafeStorageLike } from '../../src/main/secrets';
import { createServices, type ServicesOptions } from '../../src/main/services';
import type { MockOllama } from './mockServer';

export const TEST_KEY = 'abcd1234ef567890abcd1234ef567890.TopSecretTokenValue123';

/** safeStorage falso e reversível, que deixa um marcador no blob para provar que não é texto puro. */
export class FakeSafeStorage implements SafeStorageLike {
  constructor(
    private available = true,
    private backend: string | undefined = 'gnome_libsecret',
  ) {}
  isEncryptionAvailable() {
    return this.available;
  }
  encryptString(plain: string) {
    return Buffer.from('ENC1:' + Buffer.from(plain, 'utf8').reverse().toString('base64'));
  }
  decryptString(enc: Buffer) {
    const s = enc.toString('utf8');
    if (!s.startsWith('ENC1:')) throw new Error('blob inválido');
    return Buffer.from(s.slice(5), 'base64').reverse().toString('utf8');
  }
  getSelectedStorageBackend() {
    return this.backend ?? 'unknown';
  }
}

export interface Harness {
  s: ReturnType<typeof createServices>;
  dir: string;
  events: ChatEvent[];
  confirms: ToolConfirmRequest[];
  emit: (e: ChatEvent) => void;
  setConfirm: (fn: (r: ToolConfirmRequest) => boolean | Promise<boolean>) => void;
  opened: string[];
  waitForEnd: (runId: string) => Promise<ChatEvent>;
}

export function makeHarness(mock: MockOllama, over: Partial<ServicesOptions> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ocs-test-'));
  const events: ChatEvent[] = [];
  const confirms: ToolConfirmRequest[] = [];
  const opened: string[] = [];
  let confirmFn: (r: ToolConfirmRequest) => boolean | Promise<boolean> = () => true;
  const s = createServices({
    userDataDir: dir,
    dbPath: ':memory:',
    safeStorage: new FakeSafeStorage(),
    env: {},
    baseUrl: mock.baseUrl,
    allowLocalHttp: true,
    adapterRetry: { attempts: 1, baseMs: 1, maxMs: 5 },
    sleep: async () => {},
    openExternal: async (u) => void opened.push(u),
    requestConfirm: async (r) => {
      confirms.push(r);
      return confirmFn(r);
    },
    ...over,
  });
  s.secrets.set(TEST_KEY);
  const emit = (e: ChatEvent) => void events.push(e);
  const waitForEnd = async (runId: string): Promise<ChatEvent> => {
    const t0 = Date.now();
    for (;;) {
      const e = events.find((x) => x.runId === runId && ['done', 'error', 'cancelled'].includes(x.type));
      if (e) return e;
      if (Date.now() - t0 > 5000) throw new Error('waitForEnd: tempo esgotado');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { s, dir, events, confirms, emit, setConfirm: (f) => (confirmFn = f), opened, waitForEnd };
}
