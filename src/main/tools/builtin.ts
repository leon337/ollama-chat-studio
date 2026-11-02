import { isAllowedExternalUrl } from '../security';
import { calculate } from './calculator';
import { ToolRegistry } from './registry';

/** Conjunto inicial de tools. Cada uma é deliberadamente pequena e auditável. */
export function registerBuiltinTools(reg: ToolRegistry): void {
  reg.register({
    name: 'get_current_time',
    description: 'Retorna data e hora atuais, opcionalmente em um fuso IANA (ex.: America/Recife).',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: { timezone: { type: 'string', maxLength: 64, description: 'Fuso IANA. Padrão: do sistema.' } },
      additionalProperties: false,
    },
    handler: (args, ctx) => {
      const tz = typeof args.timezone === 'string' ? args.timezone : undefined;
      try {
        const fmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'long', ...(tz ? { timeZone: tz } : {}) });
        return JSON.stringify({ now: fmt.format(ctx.now()), iso: ctx.now().toISOString() });
      } catch {
        return JSON.stringify({ error: 'fuso_invalido' });
      }
    },
  });

  reg.register({
    name: 'calculate',
    description: 'Avalia uma expressão aritmética (+ - * / % ^, parênteses, sqrt, abs, round, min, max, pi, e).',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['expression'],
      additionalProperties: false,
    },
    handler: (args) => {
      try {
        return JSON.stringify({ result: calculate(String(args.expression)) });
      } catch (e) {
        return JSON.stringify({ error: (e as Error).message });
      }
    },
  });

  reg.register({
    name: 'search_history',
    description: 'Busca trechos no histórico local de conversas do usuário (somente leitura).',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 120 },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (args, ctx) => JSON.stringify(ctx.store.searchMessages(String(args.query), typeof args.limit === 'number' ? args.limit : 5)),
  });

  reg.register({
    name: 'save_note',
    description: 'Salva uma nota local no banco do app. Altera dados locais: exige confirmação do usuário.',
    risk: 'write-local',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        content: { type: 'string', minLength: 1, maxLength: 5000 },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    handler: (args, ctx) => JSON.stringify({ saved: true, id: ctx.store.addNote(String(args.title), String(args.content)) }),
  });

  reg.register({
    name: 'open_url',
    description: 'Abre uma URL https no navegador padrão do usuário. Ação externa: exige confirmação a cada uso.',
    risk: 'external',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', minLength: 8, maxLength: 500 } },
      required: ['url'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const url = String(args.url);
      if (!isAllowedExternalUrl(url)) return JSON.stringify({ error: 'url_nao_permitida' });
      await ctx.openExternal(url);
      return JSON.stringify({ opened: true });
    },
  });
}
