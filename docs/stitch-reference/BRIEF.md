# Stitch — design visual do Ollama Chat Studio

**Código-fonte público:** https://github.com/leon337/ollama-chat-studio
**Especificação de UX:** https://github.com/leon337/ollama-chat-studio/blob/main/docs/UI_SPEC_DESKTOP_V1.md
**Plataforma:** Electron, React, TypeScript e CSS próprios; desktop 1360x768, 900x750 e 740x750.

Gerar 4 telas de aplicação desktop, com marca própria Ollama Chat Studio:
1. Tela inicial vazia: trilho de navegação, sidebar recolhível, seletor de modelos Cloud e compositor.
2. Conversa multimodal: respostas Markdown, imagem anexada, controles copiar/editar/regenerar, microfone, streaming/parar.
3. Janela compacta: sidebar recolhida, layout responsivo sem perda de acessibilidade.
4. Painel contextual de parâmetros: drawer lateral com temperatura/top-p/contexto/raciocínio/tools.

Usar a paleta própria #101318 (fundo), #181d25 (superfícies), #77a8ff (ação), #55c999 (sucesso) e #f0f2f5 (texto), fonte do sistema, contraste WCAG AA, radii 12/20.
Não copiar marcas nem ativos de terceiros. Não atribuir capacidades não implementadas de Work, Projetos ou agentes. Visão somente em modelos suportados; ASR é adaptador externo; TTS Linux local; vídeo como quadros. Preservar segurança, gating e approvals já existentes.

**Referências seguras:**
- 01-estado-vazio.png
- 02-conversa-multimodal.png
- 03-janela-compacta.png
- 04-parametros-opcionais.png
- 05-app-atual-anonimizado.png

Entregar telas e código HTML/CSS exportável, com screen IDs e URL de projeto Stitch.
