// O vite-node remove o prefixo de "node:sqlite" (módulo que só existe com prefixo) e falha.
// Este shim pega o módulo nativo direto do Node. Só é usado nos testes (alias em vitest.config.ts).
const sqlite = (process as unknown as { getBuiltinModule(id: string): typeof import('node:sqlite') }).getBuiltinModule('node:sqlite');
export const DatabaseSync = sqlite.DatabaseSync;
export const StatementSync = sqlite.StatementSync;
