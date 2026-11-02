import Ajv, { type ValidateFunction } from 'ajv';
import type { Store } from '../db/store';
import type { ToolSpec } from '../ollama/adapter';

// Tool Registry: toda tool tem JSON Schema ESTRITO, nível de risco declarado e handler
// restrito ao ToolContext. Não existe tool de shell/código arbitrário: o contexto
// não oferece acesso a fs, child_process nem rede (exceto o gancho openExternal, que exige confirmação).

export type Risk = 'read' | 'write-local' | 'external';

export interface ToolContext {
  conversationId: string | null;
  store: Store;
  now: () => Date;
  openExternal: (url: string) => Promise<void>;
}

export interface ToolDef {
  name: string;
  description: string;
  risk: Risk;
  /** JSON Schema do objeto de argumentos (type: object, additionalProperties: false). */
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
}

const NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;

export class ToolRegistry {
  private ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: false, useDefaults: false });
  private tools = new Map<string, { def: ToolDef; validate: ValidateFunction }>();

  register(def: ToolDef): void {
    if (!NAME_RE.test(def.name)) throw new Error(`Nome de tool inválido: ${def.name}`);
    if (this.tools.has(def.name)) throw new Error(`Tool duplicada: ${def.name}`);
    if (!['read', 'write-local', 'external'].includes(def.risk)) throw new Error('Risco da tool não declarado.');
    const p = def.parameters;
    if (p.type !== 'object' || p.additionalProperties !== false) {
      throw new Error('Schema da tool deve ser type "object" com additionalProperties: false.');
    }
    this.tools.set(def.name, { def, validate: this.ajv.compile(p) });
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)?.def;
  }

  list(): ToolDef[] {
    return [...this.tools.values()].map((t) => t.def);
  }

  validate(name: string, args: unknown): { ok: true } | { ok: false; errors: string } {
    const t = this.tools.get(name);
    if (!t) return { ok: false, errors: 'tool desconhecida' };
    if (t.validate(args)) return { ok: true };
    return { ok: false, errors: this.ajv.errorsText(t.validate.errors, { dataVar: 'args' }) };
  }

  /** Especificações enviadas ao modelo: somente tools da allowlist. */
  specs(allowlist: Iterable<string>): ToolSpec[] {
    const allowed = new Set(allowlist);
    return this.list()
      .filter((t) => allowed.has(t.name))
      .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
}
