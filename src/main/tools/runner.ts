import { randomUUID } from 'node:crypto';
import type { ToolCallRecord, ToolConfirmRequest } from '../../shared/api';
import { redact, redactDeep } from '../../shared/redact';
import type { Store } from '../db/store';
import type { ToolContext, ToolRegistry } from './registry';

export type ConfirmFn = (req: ToolConfirmRequest) => Promise<boolean>;

export interface ExecuteInput {
  conversationId: string | null;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  allowlist: ReadonlySet<string>;
}

export interface ExecuteResult {
  /** Conteúdo devolvido ao modelo como mensagem role=tool. */
  content: string;
  record: ToolCallRecord;
}

export interface RunnerOptions {
  timeoutMs?: number;
  maxResultChars?: number;
  /** Se true, risco 'read' roda sem pedir confirmação (padrão). */
  autoApproveRead?: boolean;
}

export class ToolRunner {
  private readonly timeoutMs: number;
  private readonly maxChars: number;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly store: Store,
    private readonly confirm: ConfirmFn,
    private readonly ctxFactory: (conversationId: string | null) => ToolContext,
    opts: RunnerOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxChars = opts.maxResultChars ?? 8_000;
  }

  async execute(input: ExecuteInput, onState: (r: ToolCallRecord) => void = () => {}): Promise<ExecuteResult> {
    const def = this.registry.get(input.name);
    const base = { callId: input.callId, name: input.name, args: redactDeep(input.args) };
    const audit = (
      risk: string,
      decision: 'auto' | 'approved' | 'denied' | 'blocked',
      outcome: 'ok' | 'error' | 'skipped',
      preview?: string,
    ) =>
      this.store.addAudit({
        conversationId: input.conversationId,
        callId: input.callId,
        tool: input.name,
        risk,
        argsJson: JSON.stringify(redactDeep(input.args)),
        decision,
        outcome,
        ...(preview ? { resultPreview: redact(preview).slice(0, 300) } : {}),
      });
    const fail = (risk: ToolCallRecord['risk'], state: ToolCallRecord['state'], error: string, detail?: string): ExecuteResult => {
      const content = JSON.stringify({ error, ...(detail ? { detail } : {}) });
      const record: ToolCallRecord = { ...base, risk, state, result: content };
      onState(record);
      return { content, record };
    };

    // 1) allowlist
    if (!def || !input.allowlist.has(input.name)) {
      audit(def?.risk ?? 'unknown', 'blocked', 'skipped', 'fora da allowlist');
      return fail(def?.risk ?? 'read', 'denied', 'tool_nao_permitida');
    }

    // 2) validação do schema (modelo pode alucinar argumentos)
    const v = this.registry.validate(input.name, input.args);
    if (!v.ok) {
      audit(def.risk, 'blocked', 'skipped', v.errors);
      return fail(def.risk, 'error', 'argumentos_invalidos', v.errors);
    }

    // 3) permissão: read = automático; write-local/external = confirmação humana SEMPRE
    let decision: 'auto' | 'approved' = 'auto';
    if (def.risk !== 'read') {
      onState({ ...base, risk: def.risk, state: 'pending-confirmation' });
      const ok = await this.confirm({
        requestId: randomUUID(),
        callId: input.callId,
        name: def.name,
        risk: def.risk,
        args: redactDeep(input.args),
        description: def.description,
      }).catch(() => false);
      if (!ok) {
        audit(def.risk, 'denied', 'skipped');
        return fail(def.risk, 'denied', 'negado_pelo_usuario');
      }
      decision = 'approved';
    }

    // 4) execução com timeout e teto de tamanho
    onState({ ...base, risk: def.risk, state: 'running' });
    try {
      const out = await withTimeout(Promise.resolve(def.handler(input.args, this.ctxFactory(input.conversationId))), this.timeoutMs);
      const content = out.length > this.maxChars ? `${out.slice(0, this.maxChars)}…[truncado]` : out;
      audit(def.risk, decision, 'ok', content);
      const record: ToolCallRecord = { ...base, risk: def.risk, state: 'done', result: content };
      onState(record);
      return { content, record };
    } catch (e) {
      const msg = redact((e as Error).message ?? 'erro');
      audit(def.risk, decision, 'error', msg);
      return fail(def.risk, 'error', 'falha_na_execucao', msg);
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`tempo esgotado após ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
