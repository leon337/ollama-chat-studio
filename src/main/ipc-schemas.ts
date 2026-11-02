import { z } from 'zod';

// Todo payload vindo do renderer é NÃO CONFIÁVEL: validado com zod estrito antes de qualquer uso.

const id = z.string().min(1).max(64);
const MAX_BYTES = 30 * 1024 * 1024;
const bytes = z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= MAX_BYTES, 'tamanho de arquivo inválido');

export const paramsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    seed: z.number().int().optional(),
    num_predict: z.number().int().min(1).max(1_000_000).optional(),
    num_ctx: z.number().int().min(512).max(2_000_000).optional(),
    think: z.union([z.boolean(), z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'nível de raciocínio inválido'), z.null()]).optional(),
    json: z.union([z.boolean(), z.record(z.unknown())]).optional(),
  })
  .strict();

export const sendSchema = z
  .object({
    conversationId: id,
    model: z.string().min(1).max(100),
    text: z.string().max(200_000),
    attachmentIds: z.array(id).max(10),
    params: paramsSchema,
    toolsEnabled: z.boolean(),
  })
  .strict();

export const regenerateSchema = z.object({ conversationId: id, model: z.string().min(1).max(100), params: paramsSchema, toolsEnabled: z.boolean() }).strict();
export const editResendSchema = z
  .object({ messageId: id, text: z.string().max(200_000), model: z.string().min(1).max(100), params: paramsSchema, toolsEnabled: z.boolean() })
  .strict();

export const ingestSchema = z.object({ name: z.string().min(1).max(300), mime: z.string().max(100), bytes, transcript: z.string().max(60_000).optional() }).strict();
export const ingestVideoSchema = z
  .object({
    name: z.string().min(1).max(300),
    mime: z.string().max(100),
    durationSec: z.number().min(0).max(24 * 3600),
    frames: z.array(z.object({ tSec: z.number().min(0), bytes }).strict()).min(1).max(16),
    transcript: z.string().max(60_000).optional(),
  })
  .strict();
export const attachmentBytesSchema = z.object({ id, frameIndex: z.number().int().min(0).max(15).optional() }).strict();
export const transcribeSchema = z.object({ bytes, mime: z.string().max(100) }).strict();

export const secretSchema = z.string().min(8).max(512).regex(/^\S+$/, 'a chave não pode conter espaços');
export const urlSchema = z.string().min(8).max(2000);
export const titleSchema = z.object({ id, title: z.string().min(1).max(120) }).strict();
export const exportSchema = z.object({ id, format: z.enum(['json', 'md']) }).strict();
export const querySchema = z.string().max(200).optional();
export const modelNameSchema = z.string().min(1).max(100);

export const settingsPatchSchema = z
  .object({
    maxConcurrent: z.number().int().min(1).max(10).optional(),
    toolAllowlist: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,40}$/)).max(50).optional(),
    asr: z
      .object({
        enabled: z.boolean().optional(),
        url: z.string().max(500).optional(),
        model: z.string().max(100).optional(),
        consentExternalAudio: z.boolean().optional(),
        apiKey: z.string().max(512).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const confirmSchema = z.object({ requestId: id, approved: z.boolean() }).strict();

export const ttsTextSchema = z.string().min(1).max(4000);
