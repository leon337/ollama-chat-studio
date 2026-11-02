import { join } from 'node:path';
import type { AppSettings, VerifyResult } from '../shared/api';
import { ModelCapabilityRegistry } from '../shared/registry';
import { buildAsrAdapter, validateAsrUrl, type AsrAdapter } from './adapters/asr';
import { AttachmentService } from './attachments/service';
import type { extractPdfText } from './attachments/pdf';
import { ChatService } from './chat/service';
import { openDatabase, Store } from './db/store';
import { OllamaCloudAdapter, DEFAULT_BASE_URL } from './ollama/adapter';
import { ConcurrencyLimiter } from './ollama/limiter';
import { SecretStore, type SafeStorageLike } from './secrets';
import { registerBuiltinTools } from './tools/builtin';
import { ToolRegistry } from './tools/registry';
import { ToolRunner, type ConfirmFn } from './tools/runner';

export interface ServicesOptions {
  userDataDir: string;
  safeStorage: SafeStorageLike;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  allowLocalHttp?: boolean;
  dbPath?: string;
  openExternal: (url: string) => Promise<void>;
  requestConfirm: ConfirmFn;
  pdfExtractor?: typeof extractPdfText;
  adapterRetry?: { attempts: number; baseMs: number; maxMs: number };
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_SETTINGS: Omit<AppSettings, 'asr' | 'toolAllowlist'> & { asr: Omit<AppSettings['asr'], 'keyConfigured'> } = {
  maxConcurrent: 1, // conta Free: 1 modelo na nuvem por vez
  asr: { enabled: false, url: '', model: '', consentExternalAudio: false },
};

/** Composition root: monta todos os serviços do main. Independente do Electron para ser testável. */
export function createServices(o: ServicesOptions) {
  const env = o.env ?? process.env;
  const store = new Store(openDatabase(o.dbPath ?? join(o.userDataDir, 'studio.db')));
  const secrets = new SecretStore(o.safeStorage, join(o.userDataDir, 'secrets.bin'), env);
  const asrSecrets = new SecretStore(o.safeStorage, join(o.userDataDir, 'asr-secret.bin'), {});
  const registry = new ModelCapabilityRegistry();

  const readSettings = () => {
    const saved = store.getSetting<Partial<typeof DEFAULT_SETTINGS>>('app', {});
    return { ...DEFAULT_SETTINGS, ...saved, asr: { ...DEFAULT_SETTINGS.asr, ...(saved.asr ?? {}) } };
  };
  const limiter = new ConcurrencyLimiter(readSettings().maxConcurrent);

  const adapter = new OllamaCloudAdapter({
    baseUrl: o.baseUrl ?? env.OLLAMA_CLOUD_BASE_URL ?? DEFAULT_BASE_URL,
    getApiKey: () => secrets.get(),
    limiter,
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.allowLocalHttp ? { allowLocalHttp: true } : {}),
    ...(o.adapterRetry ? { retry: o.adapterRetry } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  });

  const attachments = new AttachmentService(store, join(o.userDataDir, 'attachments'), o.pdfExtractor);

  const toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry);
  const runner = new ToolRunner(toolRegistry, store, o.requestConfirm, (conversationId) => ({
    conversationId,
    store,
    now: () => new Date(),
    openExternal: o.openExternal,
  }));

  const asrAdapter = (): AsrAdapter | null => buildAsrAdapter(readSettings().asr, () => asrSecrets.get(), o.fetchImpl);
  const adapters = () => {
    const asr = asrAdapter();
    return { asr, availability: { asr: !!asr, tts: true } }; // tts: speechSynthesis local do renderer
  };

  const chat = new ChatService({ store, adapter, registry, attachments, runner, toolRegistry, adapters });

  const settings = {
    get(): AppSettings {
      const s = readSettings();
      const all = toolRegistry.list().map((t) => t.name);
      const saved = store.getSetting<string[] | null>('toolAllowlist', null);
      return {
        maxConcurrent: s.maxConcurrent,
        toolAllowlist: saved ? all.filter((n) => saved.includes(n)) : all,
        asr: { ...s.asr, keyConfigured: !!asrSecrets.get() },
      };
    },
    set(patch: { maxConcurrent?: number; toolAllowlist?: string[]; asr?: Partial<AppSettings['asr']> & { apiKey?: string } }): AppSettings {
      const cur = readSettings();
      const next = { ...cur, asr: { ...cur.asr } };
      if (patch.maxConcurrent !== undefined) {
        next.maxConcurrent = patch.maxConcurrent;
        limiter.setMax(patch.maxConcurrent);
      }
      if (patch.toolAllowlist) {
        const known = new Set(toolRegistry.list().map((t) => t.name));
        const unknown = patch.toolAllowlist.filter((n) => !known.has(n));
        if (unknown.length) throw new Error(`Tool desconhecida na allowlist: ${unknown.join(', ')}`);
        store.setSetting('toolAllowlist', patch.toolAllowlist);
      }
      if (patch.asr) {
        const { apiKey, keyConfigured: _k, ...rest } = patch.asr as Record<string, unknown> & { apiKey?: string; keyConfigured?: unknown };
        Object.assign(next.asr, rest);
        if (next.asr.url) {
          const v = validateAsrUrl(next.asr.url);
          if (!v.ok) throw new Error(`URL do ASR: ${v.reason}`);
        }
        if (apiKey !== undefined) {
          if (apiKey === '') asrSecrets.clear();
          else asrSecrets.set(apiKey);
        }
      }
      store.setSetting('app', next);
      return settings.get();
    },
  };

  const models = {
    list: () => registry.list(),
    /** Só metadados (/api/tags e /api/show). Nenhuma inferência, nenhum consumo de franquia de tokens. */
    async verify(): Promise<VerifyResult> {
      const errors: string[] = [];
      let tagsOk = false;
      try {
        registry.applyTags(await adapter.listModels());
        tagsOk = true;
      } catch (e) {
        errors.push(`/api/tags: ${(e as Error).message}`);
        registry.markUnknownAvailability();
      }
      for (const m of registry.list()) {
        try {
          registry.applyShow(m.id, await adapter.showModel(m.id));
        } catch (e) {
          errors.push(`/api/show ${m.id}: ${(e as Error).message}`);
        }
      }
      return { models: registry.list(), tagsOk, errors };
    },
  };

  return { store, secrets, asrSecrets, registry, adapter, attachments, toolRegistry, runner, chat, settings, models, adapters, limiter };
}

export type Services = ReturnType<typeof createServices>;
