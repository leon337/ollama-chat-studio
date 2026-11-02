import { contextBridge, ipcRenderer } from 'electron';
import type { ChatEvent, StudioApi, ToolConfirmRequest } from '../shared/api';

// Ponte tipada: expõe apenas funções nomeadas. Nada de ipcRenderer cru no renderer.
const call = <T>(channel: string, payload?: unknown): Promise<T> => ipcRenderer.invoke(channel, payload) as Promise<T>;

const api: StudioApi = {
  app: { info: () => call('app:info') },
  secrets: {
    status: () => call('secrets:status'),
    set: (key) => call('secrets:set', key),
    clear: () => call('secrets:clear'),
  },
  models: { list: () => call('models:list'), verify: () => call('models:verify') },
  conversations: {
    list: (q) => call('conversations:list', q),
    create: (model) => call('conversations:create', model),
    messages: (id) => call('conversations:messages', id),
    rename: (id, title) => call('conversations:rename', { id, title }),
    remove: (id) => call('conversations:remove', id),
    exportTo: (id, format) => call('conversations:export', { id, format }),
  },
  chat: {
    send: (req) => call('chat:send', req),
    cancel: (runId) => call('chat:cancel', runId),
    regenerate: (conversationId, model, params, toolsEnabled) => call('chat:regenerate', { conversationId, model, params, toolsEnabled }),
    editResend: (messageId, text, model, params, toolsEnabled) => call('chat:editResend', { messageId, text, model, params, toolsEnabled }),
  },
  attachments: {
    ingest: (i) => call('attachments:ingest', i),
    ingestVideo: (i) => call('attachments:ingestVideo', i),
    bytes: (id, frameIndex) => call('attachments:bytes', { id, frameIndex }),
  },
  tools: { list: () => call('tools:list'), audit: () => call('tools:audit'), confirm: (requestId, approved) => call('tools:confirm', { requestId, approved }) },
  settings: { get: () => call('settings:get'), set: (patch) => call('settings:set', patch) },
  audio: { transcribe: (i) => call('audio:transcribe', i) },
  tts: {
    status: () => call('tts:status'),
    speak: (text) => call('tts:speak', text),
    stop: () => call('tts:stop'),
    onState(cb) {
      const h = (_: unknown, state: { playing: boolean; error?: string }) => cb(state);
      ipcRenderer.on('tts:state', h);
      return () => ipcRenderer.removeListener('tts:state', h);
    },
  },
  system: { openExternal: (url) => call('system:openExternal', url) },
  onChatEvent(cb) {
    const h = (_: unknown, e: ChatEvent) => cb(e);
    ipcRenderer.on('chat:event', h);
    return () => ipcRenderer.removeListener('chat:event', h);
  },
  onToolConfirm(cb) {
    const h = (_: unknown, r: ToolConfirmRequest) => cb(r);
    ipcRenderer.on('tool:confirm', h);
    return () => ipcRenderer.removeListener('tool:confirm', h);
  },
};

contextBridge.exposeInMainWorld('studio', api);
