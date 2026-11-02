# Arquitetura — Ollama Chat Studio

## 1. Visão geral

```
┌──────────────── Renderer (React, sandbox, sem Node, sem rede) ────────────────┐
│ App · Sidebar · Composer · MessageView · Capabilities · ParamsPanel · Dialogs │
│ usa src/shared/router.ts para HABILITAR/DESABILITAR controles (só UX)         │
└───────────────▲───────────────────────────────────────────────────────────────┘
                │ window.studio (preload: funções nomeadas, contextBridge)
┌───────────────┴──────────────── Main (Node, confiável) ──────────────────────┐
│ ipc.ts  → valida TUDO com zod + confere remetente                            │
│ ChatService ── planRoute() (MESMA função do renderer = enforcement real)     │
│    ├─ ModelCapabilityRegistry (semente + /api/show em runtime + divergências)│
│    ├─ OllamaCloudAdapter ── ConcurrencyLimiter · retry/backoff · NDJSON      │
│    ├─ AttachmentService (sniff por bytes · pdf.js · ASR adapter)             │
│    ├─ ToolRunner ── ToolRegistry (JSON Schema/allowlist) · confirmação · audit│
│    └─ Store (node:sqlite, migrations, FTS5)                                  │
│ SecretStore (safeStorage; recusa backend basic_text)                         │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ HTTPS + Bearer (a chave só existe aqui)
                          https://ollama.com  (/api/tags · /api/show · /api/chat)
```

Princípio central: **o renderer nunca é a autoridade**. A UI desabilita o que é incompatível, mas quem recusa é o main com a mesma função pura (`planRoute`).

## 2. Registro de capacidades

- Nível: `native` (modelo/API faz) · `adapter` (pipeline do app: ASR, TTS, quadros) · `unsupported`.
- Verificação: `runtime` (confirmado pela API da conta) · `official` · `third-party` · `unverified`.
- Fluxo: catálogo-semente (`seed.ts`, com fonte e data) → `verify()` consulta `/api/tags` + `/api/show` (só metadados, zero tokens) → a API prevalece e as divergências são listadas.
- Regra anti-invenção: o que a API não informa fica `unverified` (ex.: JSON estruturado); modelo desconhecido recebe entrada **conservadora** (só texto).

## 3. Decisões (ADR resumido)

| # | Decisão | Motivo | Custo/risco |
|---|---|---|---|
| 1 | API direta `https://ollama.com` com Bearer | Sem Ollama local, como pedido | `/api/show` e IDs não confirmados ao vivo |
| 2 | `node:sqlite` em vez de better-sqlite3 | Sem compilação nativa (electron-rebuild) no Linux; FTS5 verificado | Módulo **experimental**; exige Node ≥ 22.5 (Electron 39 traz Node 22) |
| 3 | `safeStorage` e recusa de `basic_text` | Segredo nunca em texto puro | No Linux sem chaveiro o app não salva a chave (alternativa: variável de ambiente) |
| 4 | Roteador puro compartilhado | UI e main não divergem | Acoplamento deliberado ao módulo `shared` |
| 5 | Raciocínio (*thinking*) não exibido/salvo | Evitar expor cadeia de pensamento privada; só indicador | Mantido em memória apenas para continuar o laço de tools |
| 6 | Conteúdo de arquivo/transcrição como **dado** delimitado | Reduz injeção de prompt via anexos | Mitigação, não garantia |
| 7 | Tools sem shell/código arbitrário; risco `read`/`write-local`/`external` | Segurança | Ferramentas limitadas ao que está no registro |
| 8 | Confirmação humana com timeout = negar | Ações externas exigem aprovação | Pode irritar em fluxos longos |
| 9 | esbuild (main/preload) + Vite (renderer) | Build simples e rápido | — |
| 10 | pdf.js em `asarUnpack` | Funciona empacotado (validado no E2E) | Pacote maior |

## 4. Riscos conhecidos

1. **Nunca validado contra a nuvem real.** Formatos seguem a documentação; o smoke test único depende da sua autorização.
2. **Fontes de cota/preço divergem** entre si; o app não exibe cota (não há endpoint documentado).
3. **Beam** é recente/“grátis por tempo limitado”; disponibilidade na API direta não confirmada.
4. **`node:sqlite` experimental**: a API pode mudar em versões futuras do Node/Electron.
5. **Mic/vídeo/TTS** dependem do hardware e das vozes do sistema; só a lógica pura foi testada.
6. **Sandbox do Chromium no Linux Mint 22** (user namespaces): ver README.
7. **Injeção de prompt** por anexos/URLs: mitigada por delimitação e confirmação de tools, não eliminada.

## 5. MVP e fases

| Fase | Escopo | Estado |
|---|---|---|
| 0 | Fundação: build, IPC tipado, CSP, cofre, SQLite | ✅ |
| 1 (MVP) | Registro de capacidades, chat com streaming/cancelar/regenerar/editar, histórico+busca, parâmetros | ✅ |
| 2 | Anexos (imagem/PDF/texto), ASR/TTS adaptadores, vídeo por quadros | ✅ lógica e UI; ⚠️ mic/vídeo reais sem teste |
| 3 | Tools + confirmação + auditoria; saída JSON validada | ✅ |
| 4 | Comparação de modelos e workflows multiagente | ✅ backend e testes; ⏳ sem UI |
| 5 | Distribuição (AppImage/.deb, assinatura, atualização) | ⏳ só build `dir` validado |

## 6. Testes

- 109 testes Vitest com **servidor Ollama simulado** (nenhuma chamada real): gating de capacidades, streaming/cancelamento/retry, anexos, tool calling, segurança.
- 19 checagens E2E no Electron real (isolamento, CSP efetiva, IPC malformado, PDF empacotado, cofre, gating na UI).

## 7. Árvore de arquivos

```
.env.example            (sem segredos)
.gitignore
README.md
package.json / package-lock.json / tsconfig.json / vite.config.ts / vitest.config.ts
docs/ARQUITETURA.md
scripts/   build-electron.mjs  dev.mjs  e2e-smoke.cjs
src/shared/    api.ts asr.ts capabilities.ts media.ts redact.ts registry.ts router.ts seed.ts
src/main/
  index.ts ipc.ts ipc-schemas.ts security.ts secrets.ts services.ts pdfjs.d.ts
  ollama/       adapter.ts errors.ts limiter.ts ndjson.ts
  db/           migrations.ts store.ts
  attachments/  pdf.ts service.ts sniff.ts
  adapters/     asr.ts
  tools/        builtin.ts calculator.ts registry.ts runner.ts
  chat/         service.ts compare.ts workflow.ts
src/preload/index.ts
src/renderer/
  index.html main.tsx App.tsx styles.css vite-env.d.ts
  components/   AttachmentView Capabilities Composer Dialogs Markdown MessageView ParamsPanel Sidebar ui (.tsx)
  lib/          audio.ts util.ts video.ts
tests/
  attachments chat capability security streaming tools (.test.ts)
  helpers/      fakes.ts mockServer.ts sqlite-shim.ts
```
