# Ollama Chat Studio

Cliente desktop (Electron + React + TypeScript + Vite) para explorar os modelos **Ollama Cloud** da sua conta.
A inferência roda na nuvem da Ollama; **nenhum Ollama local é necessário**.

Diferencial: um **Registro de Capacidades** que separa, para cada modelo, o que é **nativo**, o que depende de **adaptador externo** (ASR, TTS, extração de quadros) e o que **não é suportado**. A interface só habilita o que é compatível e explica o porquê do resto.

> Documentos relacionados: [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) (arquitetura, decisões, riscos, fases, árvore de arquivos).

---

## Status honesto (leia antes de usar)

| Item | Situação |
|---|---|
| 109 testes unitários/integração (servidor Ollama **simulado**) | ✅ passando |
| 19 checagens E2E no **Electron real** (dist e binário empacotado) | ✅ passando |
| `tsc` estrito, build de produção | ✅ limpo |
| Chamada real à Ollama Cloud (chat, `/api/tags`, `/api/show`) | ⚠️ **nunca executada**: sem chave e sem autorização. Formatos seguem a documentação oficial. |
| Microfone, extração de quadros de vídeo, waveform no app | ⚠️ lógica pura testada; **uso real (mic/vídeo) não testado** (o ambiente de build não tem microfone nem vídeo) |
| Adaptador ASR contra serviço real | ⚠️ testado só com servidor falso |
| TTS | ⚠️ usa as vozes do sistema; no Linux costuma ser preciso instalar `speech-dispatcher` |
| Instalação no seu notebook | ❌ não feita (sem acesso ao seu computador) |
| `.AppImage` / `.deb` | ⚠️ configurados, **mas só o build "dir" (descompactado) foi gerado e testado** |

---

## Modelos e capacidades (valores iniciais, consultados em 2026-10-31)

Fontes: páginas oficiais da Ollama (`ollama.com/library/gemma4/tags`, `ollama.com/search?c=cloud`, docs), o anúncio oficial do Beam e o agregador models.dev. **Cada marca na interface mostra a fonte**; o botão **“Verificar capacidades na minha conta”** consulta `/api/tags` e `/api/show` (só metadados, **sem inferência, sem gastar tokens**) e a API passa a valer sobre o catálogo, listando divergências.

| Modelo | Visão | Tools | Thinking | Contexto | Observação |
|---|---|---|---|---|---|
| `beam` | não | sim | on/off | 1M | texto → texto; grátis por tempo limitado (anúncio da Ollama, 16/10/2026) |
| `gemma4:31b` | **sim** | sim | on/off | 256K | o 31B **não** tem áudio (o áudio do Gemma 4 é só E2B/E4B) |
| `gpt-oss:120b` | não | sim | low/medium/high | 128K | |
| `gpt-oss:20b` | não | sim | low/medium/high | 128K | faixa de uso “baixa” |
| `nemotron-3-nano:30b` | não | sim | on/off | 1M | |
| `nemotron-3-super` | não | sim | **não** | 256K | |
| `nemotron-3-ultra` | não | sim | on/off | 256K | |

**Nenhum modelo da lista tem áudio ou vídeo nativos** (não há prova na documentação consultada), então:

- **Áudio/voz** → ASR **externo** transforma em texto; resposta falada → TTS **do sistema**. Identificado como adaptador na interface.
- **Vídeo** → *pipeline*: quadros JPEG com timestamps (+ transcrição opcional do áudio), só para modelos com visão. Identificado como “não é vídeo nativo”.
- **PDF/texto** → texto extraído pelo app (limites: 50 páginas / 60 mil caracteres), marcado como dado, não instrução.

> Saída JSON/estruturada: a API aceita o campo `format`, mas não há flag por modelo; fica “não verificado” e o app valida a resposta contra o schema.

---

## Instalar e rodar no Linux Mint (passo a passo)

Pré-requisito: **Node 22 ou superior** (os testes usam o SQLite embutido do Node 22). O `apt` do Mint costuma trazer Node antigo, então use o `nvm`.

Cole o bloco **inteiro** no terminal (as linhas com `#` são explicações e podem ficar):

```bash
# 1) Instala o nvm (gerenciador de versões do Node). curl baixa o script; "| bash" executa.
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# 2) Recarrega o terminal para o comando "nvm" existir nesta sessão.
source ~/.bashrc

# 3) Instala e ativa o Node 22.
nvm install 22

# 4) Confere: deve mostrar v22.x.x
node -v

# 5) Entra na pasta do projeto (ajuste o caminho para onde você descompactou).
cd ~/projetos/ollama-chat-studio

# 6) Baixa as dependências listadas no package.json (cria a pasta node_modules).
npm install

# 7) Roda os testes (servidor simulado: NÃO usa internet nem gasta franquia).
npm test

# 8) Compila e abre o app.
npm start
```

No **VS Code**: `code .` dentro da pasta abre o projeto; `Ctrl+'` abre o terminal integrado, onde você roda os mesmos comandos.

Modo desenvolvimento (recarrega ao salvar): `npm run dev`.

### Se aparecer erro de “sandbox” no Linux

O Linux Mint 22 (base Ubuntu 24.04) restringe *user namespaces*, e o Electron instalado via npm pode reclamar do `chrome-sandbox`. Correção para o ambiente de desenvolvimento:

```bash
# Dá ao helper de sandbox o dono root e a permissão setuid, como o Electron exige.
sudo chown root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Evite `--no-sandbox` em uso normal: ele desliga uma camada de proteção (só usamos nos testes dentro do contêiner de build, que roda como root).

---

## Configurar a chave (sem expô-la)

1. Crie uma chave em <https://ollama.com/settings/keys>.
2. Abra **Configurações** no app, cole a chave e clique em **Salvar**.
3. A chave é cifrada com o cofre do sistema (Electron `safeStorage`; no Linux usa o chaveiro via libsecret). Ela **nunca** volta para a tela, não vai para o renderer, para logs ou para arquivos em texto puro.

**Linux sem chaveiro:** o app **recusa** gravar a chave (em vez de usar o modo `basic_text`, que é praticamente texto puro). Solução: `sudo apt install gnome-keyring libsecret-1-0`, reinicie a sessão, ou use a variável de ambiente só naquele terminal:

```bash
# A chave fica só na memória deste terminal; nada é gravado em arquivo.
export OLLAMA_API_KEY="cole-aqui"
npm start
```

O `.env.example` existe só como documentação e **não contém segredo**; o app não lê arquivo `.env`.

---

## Smoke test real (um só, pequeno, só com a sua autorização)

Nada nos testes automáticos toca a nuvem. Quando **você** autorizar, o roteiro mínimo e barato é:

1. Configure a chave e abra **Capacidades → Verificar capacidades** (só metadados: **zero tokens**).
2. Escolha `gpt-oss:20b` (faixa de uso “baixa”) e envie **uma** mensagem curta (“diga oi”).

Se `/api/show` ou o nome de algum modelo divergir na API direta, a verificação mostra exatamente o que falhou.

---

## Comandos úteis

| Comando | O que faz |
|---|---|
| `npm test` | 109 testes (Vitest) com servidor Ollama simulado |
| `npm run typecheck` | TypeScript estrito |
| `npm run build` | typecheck + main/preload (esbuild) + renderer (Vite) |
| `npm run e2e` | abre o **Electron real** (sob Xvfb se não houver tela) e faz 19 checagens; `STUDIO_EXECUTABLE=release/linux-unpacked/ollama-chat-studio npm run e2e` testa o binário empacotado |
| `npm run dist:dir` | gera o app descompactado em `release/linux-unpacked` (validado) |
| `npm run dist` | gera AppImage e .deb (**não validado**; o .deb baixa ferramentas extras) |

---

## Segurança (resumo)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`; CSP sem `unsafe-eval` e sem inline em scripts (verificada **no Electron real**: inline e `eval` são bloqueados); renderer sem acesso à rede (`connect-src 'self'`).
- IPC mínimo: preload expõe só funções nomeadas; todo payload é validado com zod estrito; o main só aceita IPC do próprio renderer.
- Anexos: tipo decidido pelos **bytes** (magic numbers), nunca pela extensão; arquivo salvo como `<sha256>.<ext>` (o nome do usuário nunca vira caminho); limites de tamanho.
- Agentes: sem shell nem código arbitrário. Cada tool tem JSON Schema estrito, passa por allowlist e validação; `write-local` e `external` **sempre** pedem confirmação (sem resposta em 2 min = negar). Toda chamada vai para uma trilha de auditoria com argumentos redigidos.
- O texto do raciocínio (*thinking*) do modelo **não é exibido nem salvo**; só um indicador “Raciocinando…”.
- Rede: retry com backoff e jitter só para 429/5xx/rede; espera longa (cota esgotada) devolve o erro na hora; timeout de conexão e de ociosidade; cancelamento fecha a conexão; fila local respeita a concorrência da conta (Free = 1).

---

## Concluído × pendente

**Concluído:** registro de capacidades (semente + verificação em runtime + divergências); roteador e gating compartilhados entre UI e main; adaptador Ollama Cloud (stream NDJSON, tools, thinking, `format`, uso/latência); chat com streaming, cancelar, regenerar, editar/reenviar (histórico preservado), Markdown + código; histórico SQLite com migrations, busca FTS5, exportação MD/JSON; anexos (imagem, PDF, texto, áudio via ASR, vídeo via quadros); Tool Registry + confirmação + auditoria; cofre de segredos; backend de **comparação de modelos** e **workflow multiagente** (testados).

**Pendente (ordem sugerida):**
1. Smoke real na nuvem (autorização sua) e ajuste de nomes/capacidades se a API divergir.
2. Teste manual de microfone, vídeo e waveform no seu notebook; instalar `speech-dispatcher` para TTS.
3. UI para comparação lado a lado e para editar workflows (o backend já existe).
4. Teste de ASR contra um serviço real (por exemplo, whisper.cpp server local).
5. Gerar e testar AppImage/.deb; assinatura/atualização automática.
6. Testes de componentes React (hoje a UI é coberta pelo E2E, não por testes unitários de componente).
7. Exibir cota/uso da conta, **se** a Ollama expuser isso por API (não encontrei endpoint documentado; as fontes sobre limites divergem entre si, então confira a página oficial de preços).

---

## Salvar no GitHub (seus padrões)

```bash
# Vai para a pasta do projeto.
cd ~/projetos/ollama-chat-studio

# Inicia o repositório git (só na primeira vez).
git init -b main

# Prepara todos os arquivos (o .gitignore já exclui node_modules, dist, release e segredos).
git add .

# Cria o commit com mensagem descritiva.
git commit -m "feat: Ollama Chat Studio v0.1.0 - registro de capacidades, chat multimodal, tools com confirmação, SQLite e testes"

# Conecta ao seu repositório (troque pela URL real do SEU repositório).
git remote add origin git@github.com:SEU_USUARIO/ollama-chat-studio.git

# Envia definindo o upstream (sempre antes do primeiro push).
git push --set-upstream origin main
```

## v0.1.1 — TTS nativo Linux e ASR local opcional

- O Electron usa speech-dispatcher (/usr/bin/spd-say) como fallback TTS local, com IPC tipado, conteúdo via stdin, sem shell, limite de 4.000 caracteres e parada de reprodução. Nenhuma mensagem é enviada para um serviço TTS externo.
- Requer speech-dispatcher e speech-dispatcher-espeak-ng, mais saída de áudio funcional. O botão Ouvir é habilitado quando uma voz Chromium ou o backend local estiver disponível; nenhum comando arbitrário é aceito.
- ASR continua sendo adaptador externo ao LLM. Um servidor whisper.cpp local pode ser configurado em http://127.0.0.1:18081/inference (habilitar ASR em Configurações). O texto reconhecido é oferecido para revisão antes do envio ao modelo.
- O serviço de usuário opcional ollama-studio-asr.service roda Whisper Small Q5 somente em 127.0.0.1, sem enviar áudio a terceiros. Controles: systemctl --user status ollama-studio-asr.service; systemctl --user stop ollama-studio-asr.service; systemctl --user disable --now ollama-studio-asr.service.
- Limitação: Whisper Small Q5 pode errar transcrições em voz sintética. Revise o texto e considere a latência no CPU antigo.
- Regressões: npm test. Teste TTS isolado: node scripts/e2e-mestre-tts-native.cjs; teste ASR real com serviço ativo: node scripts/e2e-mestre-asr-q5.cjs.
