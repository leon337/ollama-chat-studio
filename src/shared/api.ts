import type { ModelCapabilities } from './capabilities';
import type { AttachmentKind } from './router';

// Contrato IPC tipado entre renderer <-> preload <-> main. O renderer só enxerga
// `window.studio` (métodos nomeados); não existe canal genérico de IPC exposto.

export interface AttachmentRef {
  id: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  meta: {
    pages?: number;
    totalPages?: number;
    chars?: number;
    truncated?: boolean;
    durationSec?: number;
    frames?: Array<{ tSec: number }>;
    transcript?: string;
  };
}

export interface UsageInfo {
  promptTokens?: number;
  completionTokens?: number;
  totalMs?: number;
  ttftMs?: number;
  tokensPerSec?: number;
  doneReason?: string;
}

export interface ToolCallRecord {
  callId: string;
  name: string;
  args: unknown;
  risk: 'read' | 'write-local' | 'external';
  state: 'pending-confirmation' | 'running' | 'denied' | 'done' | 'error';
  result?: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  model?: string;
  createdAt: number;
  attachments: AttachmentRef[];
  toolCalls: ToolCallRecord[];
  usage?: UsageInfo;
  status: 'complete' | 'cancelled' | 'error';
  error?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
}

export interface ChatParams {
  temperature?: number;
  top_p?: number;
  seed?: number;
  num_predict?: number;
  num_ctx?: number;
  think?: boolean | string | null;
  /** true = JSON livre; objeto = JSON Schema. */
  json?: boolean | Record<string, unknown>;
}

export interface SendRequest {
  conversationId: string;
  model: string;
  text: string;
  attachmentIds: string[];
  params: ChatParams;
  toolsEnabled: boolean;
}

export type ChatEvent =
  | { runId: string; conversationId: string; type: 'start'; userMessageId: string }
  | { runId: string; conversationId: string; type: 'delta'; text: string }
  /** Indica que o modelo está raciocinando. O texto do raciocínio NÃO é exibido nem salvo. */
  | { runId: string; conversationId: string; type: 'reasoning'; active: boolean }
  | { runId: string; conversationId: string; type: 'tool'; call: ToolCallRecord }
  | { runId: string; conversationId: string; type: 'done'; messageId: string; usage: UsageInfo }
  | { runId: string; conversationId: string; type: 'error'; code: string; message: string }
  | { runId: string; conversationId: string; type: 'cancelled'; messageId: string | null };

export interface ToolConfirmRequest {
  requestId: string;
  callId: string;
  name: string;
  risk: 'write-local' | 'external';
  args: unknown;
  description: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  risk: 'read' | 'write-local' | 'external';
  schema: unknown;
}

export interface SecretStatus {
  configured: boolean;
  source: 'vault' | 'env' | 'none';
  backend: string | null;
  secure: boolean;
}

export interface AsrSettings {
  enabled: boolean;
  url: string;
  model: string;
  consentExternalAudio: boolean;
  keyConfigured: boolean;
}

export interface AppSettings {
  maxConcurrent: number;
  /** Tools que o modelo pode chamar. O que não está aqui nunca é enviado nem executado. */
  toolAllowlist: string[];
  asr: AsrSettings;
}

export interface AuditRow {
  id: string;
  tool: string;
  risk: string;
  decision: 'auto' | 'approved' | 'denied' | 'blocked';
  outcome: 'ok' | 'error' | 'skipped';
  argsJson: string;
  resultPreview: string | null;
  createdAt: number;
}

export interface VerifyResult {
  models: ModelCapabilities[];
  tagsOk: boolean;
  errors: string[];
}

export interface TranscriptionResult {
  text: string;
  adapter: string;
}

export interface StudioApi {
  app: { info(): Promise<{ version: string; platform: string }> };
  secrets: {
    status(): Promise<SecretStatus>;
    set(key: string): Promise<SecretStatus>;
    clear(): Promise<SecretStatus>;
  };
  models: {
    list(): Promise<ModelCapabilities[]>;
    /** Consome apenas /api/tags e /api/show (metadados). Não executa inferência. */
    verify(): Promise<VerifyResult>;
  };
  conversations: {
    list(query?: string): Promise<ConversationSummary[]>;
    create(model: string): Promise<ConversationSummary>;
    messages(id: string): Promise<StoredMessage[]>;
    rename(id: string, title: string): Promise<void>;
    remove(id: string): Promise<void>;
    exportTo(id: string, format: 'json' | 'md'): Promise<{ path: string | null }>;
  };
  chat: {
    send(req: SendRequest): Promise<{ runId: string }>;
    cancel(runId: string): Promise<void>;
    regenerate(conversationId: string, model: string, params: ChatParams, toolsEnabled: boolean): Promise<{ runId: string }>;
    editResend(messageId: string, text: string, model: string, params: ChatParams, toolsEnabled: boolean): Promise<{ runId: string }>;
  };
  attachments: {
    ingest(input: { name: string; mime: string; bytes: Uint8Array; transcript?: string }): Promise<AttachmentRef>;
    ingestVideo(input: {
      name: string;
      mime: string;
      durationSec: number;
      frames: Array<{ tSec: number; bytes: Uint8Array }>;
      transcript?: string;
    }): Promise<AttachmentRef>;
    bytes(id: string, frameIndex?: number): Promise<Uint8Array>;
  };
  tools: {
    list(): Promise<ToolInfo[]>;
    audit(): Promise<AuditRow[]>;
    confirm(requestId: string, approved: boolean): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: { maxConcurrent?: number; toolAllowlist?: string[]; asr?: Partial<Omit<AppSettings['asr'], 'keyConfigured'>> & { apiKey?: string } }): Promise<AppSettings>;
  };
  audio: { transcribe(input: { bytes: Uint8Array; mime: string }): Promise<TranscriptionResult> };
  tts: {
    status(): Promise<{ available: boolean; backend: 'speech-dispatcher' | 'none' }>;
    speak(text: string): Promise<{ started: boolean }>;
    stop(): Promise<void>;
    onState(cb: (state: { playing: boolean; error?: string }) => void): () => void;
  };
  system: { openExternal(url: string): Promise<void> };
  onChatEvent(cb: (e: ChatEvent) => void): () => void;
  onToolConfirm(cb: (r: ToolConfirmRequest) => void): () => void;
}

declare global {
  interface Window {
    studio: StudioApi;
  }
}
