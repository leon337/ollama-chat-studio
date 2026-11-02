import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { AuditRow, ChatEvent, ToolConfirmRequest, ToolInfo } from '../shared/api';
import {
  attachmentBytesSchema,
  confirmSchema,
  editResendSchema,
  exportSchema,
  ingestSchema,
  ingestVideoSchema,
  modelNameSchema,
  querySchema,
  regenerateSchema,
  secretSchema,
  sendSchema,
  settingsPatchSchema,
  titleSchema,
  transcribeSchema,
  urlSchema,
  ttsTextSchema,
} from './ipc-schemas';
import { isAllowedExternalUrl, isTrustedSender } from './security';
import type { Services } from './services';
import type { NativeLinuxTts } from './tts';

export interface IpcContext {
  ipcMain: IpcMain;
  services: Services;
  getWindow: () => BrowserWindow | null;
  trust: { rendererFileUrlPrefix: string; devUrl?: string };
  pendingConfirms: Map<string, (approved: boolean) => void>;
  openExternal: (url: string) => Promise<void>;
  version: string;
  nativeTts: NativeLinuxTts;
}

/** Registra todos os handlers. Superfície mínima: um canal por operação, todos validados. */
export function registerIpc(ctx: IpcContext): void {
  const { ipcMain, services: s } = ctx;

  const handle = <S extends z.ZodTypeAny, R>(channel: string, schema: S | null, fn: (input: z.infer<S>) => R | Promise<R>) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
      const url = event.senderFrame?.url ?? '';
      if (!isTrustedSender(url, ctx.trust)) throw new Error('Origem do IPC não confiável.');
      const input = schema ? schema.parse(payload) : undefined;
      return fn(input as z.infer<S>);
    });
  };
  const emit = (e: ChatEvent) => ctx.getWindow()?.webContents.send('chat:event', e);

  handle('app:info', null, () => ({ version: ctx.version, platform: process.platform }));

  handle('secrets:status', null, () => s.secrets.status());
  handle('secrets:set', secretSchema, (key) => {
    s.secrets.set(key);
    return s.secrets.status();
  });
  handle('secrets:clear', null, () => {
    s.secrets.clear();
    return s.secrets.status();
  });

  handle('models:list', null, () => s.models.list());
  handle('models:verify', null, () => s.models.verify());

  handle('conversations:list', querySchema, (q) => s.store.listConversations(q));
  handle('conversations:create', modelNameSchema, (model) => s.store.createConversation(model));
  handle('conversations:messages', z.string().min(1).max(64), (id) => s.store.listMessages(id));
  handle('conversations:rename', titleSchema, ({ id, title }) => s.store.renameConversation(id, title));
  handle('conversations:remove', z.string().min(1).max(64), (id) => {
    s.attachments.cleanup(s.store.deleteConversation(id));
  });
  handle('conversations:export', exportSchema, async ({ id, format }) => {
    const win = ctx.getWindow();
    const opts = { defaultPath: `conversa.${format}`, filters: [{ name: format === 'md' ? 'Markdown' : 'JSON', extensions: [format] }] };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return { path: null };
    writeFileSync(r.filePath, s.store.exportConversation(id, format), 'utf8');
    return { path: r.filePath };
  });

  handle('chat:send', sendSchema, (req) => s.chat.send(req, emit));
  handle('chat:cancel', z.string().min(1).max(64), (runId) => s.chat.cancel(runId));
  handle('chat:regenerate', regenerateSchema, (r) => s.chat.regenerate(r.conversationId, r.model, r.params, r.toolsEnabled, emit));
  handle('chat:editResend', editResendSchema, (r) => s.chat.editResend(r.messageId, r.text, r.model, r.params, r.toolsEnabled, emit));

  handle('attachments:ingest', ingestSchema, (i) => s.attachments.ingest({ name: i.name, mime: i.mime, bytes: i.bytes, ...(i.transcript ? { transcript: i.transcript } : {}) }));
  handle('attachments:ingestVideo', ingestVideoSchema, (i) =>
    s.attachments.ingestVideo({ name: i.name, mime: i.mime, durationSec: i.durationSec, frames: i.frames, ...(i.transcript ? { transcript: i.transcript } : {}) }),
  );
  handle('attachments:bytes', attachmentBytesSchema, ({ id, frameIndex }) => s.attachments.bytes(id, frameIndex ?? 0));

  handle('tools:list', null, (): ToolInfo[] => s.toolRegistry.list().map((t) => ({ name: t.name, description: t.description, risk: t.risk, schema: t.parameters })));
  handle('tools:audit', null, (): AuditRow[] =>
    s.store.listAudit(100).map((r) => ({
      id: r.id as string,
      tool: r.tool as string,
      risk: r.risk as string,
      decision: r.decision as AuditRow['decision'],
      outcome: r.outcome as AuditRow['outcome'],
      argsJson: r.args_json as string,
      resultPreview: (r.result_preview as string | null) ?? null,
      createdAt: r.created_at as number,
    })),
  );
  handle('tools:confirm', confirmSchema, ({ requestId, approved }) => {
    ctx.pendingConfirms.get(requestId)?.(approved);
    ctx.pendingConfirms.delete(requestId);
  });

  handle('settings:get', null, () => s.settings.get());
  handle('settings:set', settingsPatchSchema, (patch) => s.settings.set(patch));

  handle('tts:status', null, () => ctx.nativeTts.status());
  handle('tts:speak', ttsTextSchema, (text) => ctx.nativeTts.speak(text));
  handle('tts:stop', null, () => ctx.nativeTts.stop());

  handle('audio:transcribe', transcribeSchema, async ({ bytes, mime }) => {
    const { asr } = s.adapters();
    if (!asr) throw new Error('Nenhum adaptador ASR configurado/consentido.');
    return { text: await asr.transcribe(bytes, mime), adapter: asr.label };
  });

  handle('system:openExternal', urlSchema, async (url) => {
    if (!isAllowedExternalUrl(url)) throw new Error('URL não permitida (apenas https público).');
    await ctx.openExternal(url);
  });
}

/** Confirmação humana para tools de risco: pergunta ao renderer e espera (com timeout = negar). */
export function makeConfirm(
  getWindow: () => BrowserWindow | null,
  pending: Map<string, (approved: boolean) => void>,
  timeoutMs = 120_000,
) {
  return (req: ToolConfirmRequest): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const win = getWindow();
      if (!win) return resolve(false);
      const timer = setTimeout(() => {
        pending.delete(req.requestId);
        resolve(false);
      }, timeoutMs);
      pending.set(req.requestId, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      win.webContents.send('tool:confirm', req);
    });
}
