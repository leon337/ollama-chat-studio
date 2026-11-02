import type { ChatParams, UsageInfo } from '../../shared/api';
import { conservativeEntry, type ModelCapabilityRegistry } from '../../shared/registry';
import { planRoute } from '../../shared/router';
import { OllamaError } from '../ollama/errors';
import type { ChatRequest, StreamEvent } from '../ollama/adapter';

// Comparação de modelos (backend pronto; UI dedicada é a Fase 2). Mesmo prompt, N modelos,
// executados em série pelo limitador de concorrência. Sem anexos nem tools por padrão.

export interface CompareDeps {
  adapter: { chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> };
  registry: ModelCapabilityRegistry;
}

export interface CompareResult {
  model: string;
  content: string;
  usage?: UsageInfo;
  skipped?: string;
  error?: { code: string; message: string };
}

export async function compareModels(
  deps: CompareDeps,
  input: { prompt: string; models: string[]; params?: ChatParams; system?: string },
  signal?: AbortSignal,
  onResult?: (r: CompareResult) => void,
): Promise<CompareResult[]> {
  const results: CompareResult[] = [];
  const params = input.params ?? {};
  for (const model of input.models) {
    const caps = deps.registry.get(model) ?? conservativeEntry(model);
    const plan = planRoute({ model: caps, attachments: [], tools: false, json: !!params.json, think: params.think ?? null, numCtx: params.num_ctx ?? null, adapters: { asr: false, tts: false } });
    let r: CompareResult;
    if (!plan.ok) {
      r = { model, content: '', skipped: plan.blocks.map((b) => b.message).join(' ') };
    } else {
      r = { model, content: '' };
      try {
        const req: ChatRequest = {
          model,
          messages: [...(input.system ? [{ role: 'system' as const, content: input.system }] : []), { role: 'user', content: input.prompt }],
          ...(caps.thinking.level === 'native' && params.think != null ? { think: params.think } : {}),
          options: pickOptions(params),
        };
        for await (const ev of deps.adapter.chatStream(req, signal)) {
          if (ev.type === 'delta') r.content += ev.text;
          else if (ev.type === 'done') r.usage = ev.usage;
        }
      } catch (e) {
        if (signal?.aborted) throw e;
        r.error = { code: e instanceof OllamaError ? e.code : 'INTERNAL', message: (e as Error).message };
      }
    }
    results.push(r);
    onResult?.(r);
  }
  return results;
}

function pickOptions(p: ChatParams): NonNullable<ChatRequest['options']> {
  const o: NonNullable<ChatRequest['options']> = {};
  if (p.temperature !== undefined) o.temperature = p.temperature;
  if (p.top_p !== undefined) o.top_p = p.top_p;
  if (p.seed !== undefined) o.seed = p.seed;
  if (p.num_predict !== undefined) o.num_predict = p.num_predict;
  return o;
}
