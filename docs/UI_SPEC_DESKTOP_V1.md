# Ollama Chat Studio — Especificação de interface desktop v1

**Estado:** especificação para implementação. **Não implementada**.
**Data:** 2026-11-01.
**Escopo:** renderer Electron, layout, interação e acessibilidade; serviços Cloud, cofre, IPC e adaptadores existentes permanecem inalterados.
**Referência:** observação visual de um aplicativo desktop de conversação instalado no notebook, em janelas de aproximadamente 1360×768, 900×750 e 740×750 px. Medidas são estimativas visuais, não CSS extraído de terceiros.

## 1. Objetivo, método e restrições

Criar uma experiência desktop própria do Ollama Chat Studio, mais centrada na conversa, sem perder modelos Ollama Cloud, visão, áudio, ASR/TTS, vídeo por quadros, ferramentas e histórico.

Três abordagens complementares:

1. **UI Reverse Engineering:** observar comportamentos públicos da interface, hierarquia, dimensões aproximadas, estados de interação e feedback visual, qualificando a confiança das observações.
2. **Clean-Room UI Reconstruction:** reconstruir princípios de UX com código, tokens, cores, ícones e identidade próprios. **Não** copiar fonte, assets proprietários, logos ou marcas do aplicativo analisado.
3. **Spec-Driven UI Engineering:** implementar e testar somente contra contratos, estados, critérios de aceite e tarefas aqui definidos.

**Fora do escopo:** clone pixel-a-pixel; reproduzir funcionalidades Work/Projetos que não possuem backend; copiar sessões, prompts, arquivos ou dados da conta de referência; inspecionar o código-fonte do app observado.

## 2. Achados da observação — evidências, não promessas de implementação

| ID | Comportamento/estrutura observados | Confiança |
|---|---|---|
| OBS-01 | Trilho de navegação à esquerda (~64 px), sidebar adjacente (~300 px), palco central flexível e menu superior da janela. | Alta |
| OBS-02 | Chat vazio: alternador de modo próximo ao topo, chamada central e compositor arredondado com largura máxima próxima a 800 px. | Alta |
| OBS-03 | Ao digitar texto sintético, o controle final muda de estado voz para enviar. O rascunho foi removido **sem submissão**. | Alta |
| OBS-04 | Menu "+" abre lista contextual de arquivos e outros recursos em superfície arredondada sob o compositor. | Alta |
| OBS-05 | Seletor de modo/esforço abre popover ancorado ao composer, sem navegação de tela. | Alta |
| OBS-06 | Recolher sidebar mantém o trilho visível e recentraliza o palco; restaurá-la recupera a lista. | Alta |
| OBS-07 | Modo Work tem composer e controles distintos: ferramenta, modelo, seleção de projeto e zona inferior. **Não** implica backend equivalente no Ollama Studio. | Alta |
| OBS-08 | Conversa existente mostra header contextual, mensagens Markdown/código, área de rolagem independente, composer inferior e ação flutuante para voltar ao fim. | Alta |
| OBS-09 | Em 900 px a área central reduz e pode quebrar título; em 740 px o compositor assume layout compacto perto da base, embora a sidebar continue presente. | Alta |
| OBS-10 | Itens da sidebar têm estado selecionado, ações ao passar o mouse e rolagem independente; lista longa não move o palco. | Alta |
| OBS-11 | Busca é visível na sidebar, mas seu resultado/modal **não foi validado** na sessão observada. | Parcial |
| OBS-12 | Streaming ao vivo, atalhos globais, leitor de telas e drag-and-drop real não foram observados. | Não validado |

**Limite das evidências:** somente pixels e interações externas. Não houve extração de CSS, código ou ativos de terceiros. As capturas de conta real permanecem locais e fora do Git.

## 3. Inventário do produto atual (fonte: código próprio)

Fontes examinadas no Ollama Studio: src/renderer/App.tsx, styles.css, components/Sidebar.tsx, Composer.tsx, MessageView.tsx, ParamsPanel.tsx, Capabilities.tsx, Dialogs.tsx; contratos src/shared/router.ts e capabilities.ts.

| Área | Estado atual do Ollama Chat Studio v0.1.1 | Gap |
|---|---|---|
| AppShell | Grid de 270 px + palco; quando parâmetros visíveis: 270 px + palco + 300 px | Espaço comprimido para chat, ausência de trilho e colapso responsivo |
| Sidebar | Nova conversa, busca inline, lista, renomear, exportar, excluir | Falta recolher, agrupamento, menu por conversa e responsividade |
| Header | Seletor, chips de capacidades, Tools, Modelos, Configurações e Parâmetros em duas linhas | Opções secundárias dominam o primeiro nível visual |
| Mensagens | Scroller com padding horizontal 8%; MessageView com Markdown/anexos | Área de leitura sem max-width próprio e poucas affordances contextuais |
| Compositor | Texto, anexos, microfone, streaming, validação de modalidade e pipeline | Ergonomia fragmentada; prioridade visual insuficiente |
| Parâmetros | Painel de 300 px aberto inicialmente | Melhor como drawer opcional |
| Cloud e multimodal | Registry, gating, ASR local, TTS Linux, visão, vídeo por quadros, tools | **Preservar** e apresentar capacidades reais sem botões fantasmas |
| Work/Projetos | Sem equivalência funcional comprovada | Não oferecer essas abas antes de APIs/dados reais |

**Problema P0:** em desktop de 1360 px, sidebar (270) e parâmetros (300) disputam largura com o chat; em 740–900 px o palco fica demasiado apertado. Corrigir primeiro a hierarquia e o layout, não construir novos agentes.

## 4. Requisitos — decisões próprias de produto

### P0 — MVP de UI funcional

- **UI-001 — AppShell:** trilho próprio de 56 px, sidebar de 256 px recolhível, palco flexível e drawer opcional de 300 px, fechado por padrão. Sidebar e drawer têm controles independentes.
- **UI-002 — Palco:** leitura com largura máxima de 840 px, centralizada; rolagem do histórico independente; header compacto; composer fixado no fundo quando conversa ativa.
- **UI-003 — EmptyState:** nome e identidade Ollama Chat Studio, orientação curta e compositor centralizado de largura até 800 px. Descrições de modelos ficam em Capacidades, não num parágrafo no centro.
- **UI-004 — ConversationView:** título contextual, mensagens distinguíveis por autor, Markdown/código/anexos, ações copiar/editar/regenerar, scroll-to-bottom visível quando relevante.
- **UI-005 — Composer:** textarea autoexpansível, foco visível, anexos por menu, previews removíveis, mic compatível, seleção Ollama Cloud, enviar só quando válido, parar durante streaming, busy/erro explícitos e preservação do rascunho em falhas.
- **UI-006 — Capability gating:** controles de imagem, áudio, vídeo e tools só habilitam com suporte no Registry/adapter; explicar motivo da indisponibilidade.
- **UI-007 — Sidebar:** nova conversa, busca, histórico, ativo, ações por conversa, scroll próprio, recolhimento/overlay; exclusão continua exigindo confirmação.
- **UI-008 — Parâmetros:** drawer lateral sob demanda; fechar por botão/Escape; manter valores atuais, devolver foco ao controle originador.
- **UI-009 — Acessibilidade:** controles nomeados, foco contrastante, ordem Tab correta, feedback para erro/streaming, alvos >= 40×40 px e redução de movimento; sem depender somente de cor.
- **UI-010 — Compatibilidade:** não mudar APIs do processo main, cofre, IPC seguro, eventos de streaming, confirmações de tools, persistência de mensagens e anexos.

### P1 — futuras funcionalidades dependentes de backend

- **UI-011:** fixar/agrupar conversas somente com persistência própria.
- **UI-012:** Projetos e relação conversa↔projeto somente após migração de dados/CRUD/testes.
- **UI-013:** painel de artefatos e execução de ferramentas, com dados reais, nome e identidade próprios.
- **UI-014:** modo de agentes e workflows com ledger, estado, ferramentas permitidas e HUMAN_GATE para ações externas.
- **UI-015:** busca global paginada com índice e testes.

**Regra:** nunca criar um controle visual que promete uma funcionalidade inexistente.

## 5. Árvore de componentes proposta

~~~text
DesktopApp
└── AppShell
    ├── NavigationRail                [novo, marca própria]
    ├── ConversationSidebar            [evolução do Sidebar atual]
    │   ├── SidebarHeader / NewConversation
    │   ├── ConversationSearch
    │   └── ConversationList / ConversationMenu
    ├── MainStage
    │   ├── ConversationHeader          [modelo, Cloud, ações]
    │   ├── EmptyState | MessageViewport
    │   │   ├── UserMessage
    │   │   ├── AssistantMessage / CodeBlock / Attachment
    │   │   └── Streaming / ScrollToBottom
    │   └── MultimodalComposer          [evolução do Composer atual]
    │       ├── AttachmentMenu / AttachmentTray
    │       ├── TextInput / ModelPopover
    │       └── Microphone / SendOrStop
    └── ContextDrawer                   [evolução do ParamsPanel]
~~~

Manter App.tsx como orquestrador e extrair apenas view/layout para componentes puros. Não reimplementar o Registry, os adaptadores ou o serviço de conversas.

### Máquina de estados do compositor

~~~mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Draft: Digitar ou anexar
    Draft --> Uploading: Processar anexo
    Uploading --> Draft: Concluído
    Uploading --> Error: Falhou
    Draft --> Sending: Enviar válido
    Sending --> Streaming: Run iniciado
    Streaming --> Idle: Concluído
    Streaming --> Interrupted: Parar
    Interrupted --> Draft: Revisar
    Error --> Draft: Corrigir
    Draft --> Recording: Microfone disponível
    Recording --> Transcribing: Encerrar
    Recording --> Draft: Descartar
    Transcribing --> Draft: Texto para revisão
    Transcribing --> Error: ASR falhou
~~~

**Invariantes:** sem envio pela simples escolha de arquivo; anexos não burlam gating; cancelar não cria outra execução; nenhuma ferramenta externa passa sem autorização preexistente.

## 6. Design system próprio proposto

Paleta e medidas **deliberadamente próprias**, inspiradas em legibilidade e não extraídas da referência:

~~~css
:root {
  --ocs-bg: #101318;
  --ocs-surface: #181d25;
  --ocs-surface-hover: #232a35;
  --ocs-overlay: #202734;
  --ocs-divider: #303948;
  --ocs-text: #f0f2f5;
  --ocs-text-muted: #a0abb9;
  --ocs-accent: #77a8ff;
  --ocs-success: #55c999;
  --ocs-warning: #e7af54;
  --ocs-danger: #f27d88;
  --ocs-radius-control: 12px;
  --ocs-radius-composer: 20px;
  --ocs-space-unit: 4px;
  --ocs-rail-width: 56px;
  --ocs-sidebar-width: 256px;
  --ocs-drawer-width: 300px;
  --ocs-stage-content-max: 840px;
  --ocs-composer-max: 800px;
}
~~~

Tipografia: fontes do sistema; corpo 14–16 px; conteúdos essenciais com contraste AA. Ícones licenciados/autorais; identidade Ollama Chat Studio em todos os fluxos.

### Responsive — breakpoints de implementação, NÃO observações do ChatGPT

| Janela | Comportamento desejado |
|---|---|
| ≥ 1280 px | Rail + sidebar + palco; drawer opcional |
| 960–1279 px | Rail + sidebar por preferência; drawer overlay |
| 720–959 px | Rail visível; sidebar inicialmente recolhida, abre overlay |
| < 720 px | Sidebar como overlay; ações compactas; composer, enviar/parar sempre acessíveis |

Testar 1360×768, 900×750 e 740×750, zoom 125%/200% e textos longos; nenhum overflow horizontal global.

## 7. Critérios de aceite

| ID | Dado / Quando | Então |
|---|---|---|
| AC-01 | Inicialização sem conversa | EmptyState sem criação automática de conversa |
| AC-02 | Sidebar aberta/recolhida | Palco e compositor recalculados sem truncamento ou perda de foco |
| AC-03 | Janela 740×750 | Send/Stop, mic aplicável, histórico e composer acessíveis sem overflow global |
| AC-04 | Texto/anexo válido | Enviar habilitado; Shift+Enter quebra linha |
| AC-05 | Streaming em curso | Parar substitui enviar, interrompe run atual e preserva histórico |
| AC-06 | Modelo sem visão recebe imagem | Bloqueio com razão; nenhuma imagem enviada |
| AC-07 | Modelo de visão recebe PNG válido | Preview, remoção, envio pela pipeline existente |
| AC-08 | Microfone/ASR externo | Reconhecível como adaptador; gravação/parar/descartar; transcrição editável |
| AC-09 | Tool externa sensível | Confirmação de ação preservada; nenhum bypass por UI |
| AC-10 | Drawer aberto | Fechar por Escape/botão; manter parâmetros e devolver foco |
| AC-11 | Mensagens e código | Renderização Markdown, copiar/editar, code overflow e scroll-to-bottom |
| AC-12 | Regressões | 113 testes unitários e 19 E2E baseline verdes + novos E2E visuais |
| AC-13 | Teclado/leitor de telas | Labels, ordem Tab, foco e estados dinâmicos discerníveis |
| AC-14 | Chave Cloud ausente | Configuração segura sem expor segredo no renderer |

## 8. Implementação incremental recomendada

- **PR-A — Shell/tokens/responsividade:** app grid, rail, sidebar recolhível, drawer opt-in e EmptyState; teste de janelas 740/900/1360.
- **PR-B — Composer multimodal:** modelos, anexos, mic, estados send/stop, progressivo, preservação da lógica; E2E com dados sintéticos.
- **PR-C — Mensagens/header:** leitura confortável, código, actions, streaming, scroll-to-bottom; testes de não regressão.
- **PR-D — Acessibilidade e refinamento:** teclado, Escape/foco, contraste, zoom 200%, linguagem de erros e screenshots de fixture.
- **PR-E — Projetos/agentes/workspace:** **só após API e esquema próprios**; não anunciar antes.

Cada PR: mudanças limitadas, evidências sem dados pessoais, testes, rollback e resumo de decisões. Não misturar mudança de UI com alteração de API Cloud, segredo, motor ASR/TTS ou automações.

## 9. Riscos, políticas de segurança e privacidade

- **R1:** copiar assets ou marcas de terceiros → implementar com identidade própria e componentes originais.
- **R2:** regressão de capability gating → testes negativos por modelo e modalidade.
- **R3:** falta de espaço no palco → drawer overlay e sidebar recolhível, sobretudo abaixo de 960 px.
- **R4:** falsa equivalência a Work/projetos → não exibir controles sem backend.
- **R5:** bypass de ações de agente → manter confirmações e isolamento Electron.
- **R6:** screenshots com dados privados → não incluir no Git; usar fixtures sintéticas para diffs visuais.
- **R7:** medidas aproximadas de uma versão específica → usar como referência e medir UI própria nos testes.

## 10. Critérios de encerramento e handoff

**Pesquisa e especificação:** observações numeradas, confiança atribuída, contratos do código próprio revisados, P0/P1 separados, estados e testes definidos. **Esta fase está concluída**.

**Implementação:** não iniciada. O agente seguinte deve começar pelo PR-A, usando este documento, o repositório público e as APIs existentes, sem copiar código/ativos da referência. Considerar concluída somente após CI verde, testes visuais no Electron e confirmação de Cloud/visão/ASR/TTS/vídeo/tools.

Nenhuma conversa da conta de referência ou captura bruta foi incluída neste documento.
