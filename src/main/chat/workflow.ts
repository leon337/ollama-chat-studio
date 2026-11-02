import type { UsageInfo } from '../../shared/api';
import { conservativeEntry, type ModelCapabilityRegistry } from '../../shared/registry';
import { planRoute } from '../../shared/router';
import type { ChatRequest, StreamEvent } from '../ollama/adapter';

// Workflow multiagente (base): passos sequenciais, cada um com seu modelo e papel (system prompt).
// Templates aceitam {{input}} e {{steps.<id>}} (apenas passos ANTERIORES). Sem tools neste nível:
// ações externas continuam passando só pelo ToolRunner (confirmação humana). UI: Fase 2.

export interface WorkflowStep {
  id: string;
  model: string;
  role: string;
  prompt: string;
}
export interface WorkflowSpec {
  name: string;
  steps: WorkflowStep[];
}
export interface WorkflowDeps {
  adapter: { chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> };
  registry: ModelCapabilityRegistry;
}
export interface WorkflowResult {
  outputs: Record<string, string>;
  usage: Record<string, UsageInfo | undefined>;
}

const REF = /\{\{\s*(input|steps\.([a-z0-9_-]+))\s*\}\}/gi;

export function validateWorkflow(spec: WorkflowSpec): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  if (!spec.steps.length) errors.push('O workflow precisa de ao menos um passo.');
  for (const s of spec.steps) {
    if (!/^[a-z0-9_-]{1,32}$/i.test(s.id)) errors.push(`Id de passo inválido: "${s.id}".`);
    if (seen.has(s.id)) errors.push(`Id duplicado: "${s.id}".`);
    for (const m of s.prompt.matchAll(REF)) {
      const ref = m[2];
      if (ref && !seen.has(ref)) errors.push(`O passo "${s.id}" referencia "${ref}", que não existe antes dele.`);
    }
    seen.add(s.id);
  }
  return errors;
}

export async function runWorkflow(deps: WorkflowDeps, spec: WorkflowSpec, input: string, signal?: AbortSignal): Promise<WorkflowResult> {
  const errors = validateWorkflow(spec);
  if (errors.length) throw new Error(`Workflow inválido: ${errors.join(' ')}`);
  const outputs: Record<string, string> = {};
  const usage: WorkflowResult['usage'] = {};
  for (const step of spec.steps) {
    const caps = deps.registry.get(step.model) ?? conservativeEntry(step.model);
    const plan = planRoute({ model: caps, attachments: [], tools: false, json: false, adapters: { asr: false, tts: false } });
    if (!plan.ok) throw new Error(`Passo "${step.id}": ${plan.blocks.map((b) => b.message).join(' ')}`);
    const prompt = step.prompt.replace(REF, (_m, which: string, id?: string) => (which.toLowerCase() === 'input' ? input : (outputs[id!] ?? '')));
    let text = '';
    for await (const ev of deps.adapter.chatStream({ model: step.model, messages: [{ role: 'system', content: step.role }, { role: 'user', content: prompt }] }, signal)) {
      if (ev.type === 'delta') text += ev.text;
      else if (ev.type === 'done') usage[step.id] = ev.usage;
    }
    outputs[step.id] = text;
  }
  return { outputs, usage };
}
