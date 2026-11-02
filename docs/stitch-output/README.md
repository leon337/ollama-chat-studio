# Google Stitch — Ollama Chat Studio Desktop v1

**Design project:** https://stitch.withgoogle.com/u/2/projects/17634028310868890144

**Source UI spec:** ../UI_SPEC_DESKTOP_V1.md

The four HTML files in this directory were **exported from the Google Stitch design workspace**, using the approved public brief and sanitized reference screens. They are design-only prototypes, not executable application source.

| File | Stitch screen |
|---|---|
| 01-empty.html | Estado vazio — desktop |
| 02-conversation.html | Conversa multimodal e streaming |
| 03-compact.html | Janela compacta |
| 04-parameters.html | Painel lateral de parâmetros |

**Implementation:** src/renderer/App.tsx, src/renderer/components/NavigationRail.tsx, src/renderer/styles.css reuse the visual **principles** while keeping the existing Electron IPC architecture, Ollama Cloud runtime, model-capability gates, local ASR/TTS adapters, conversation storage and tool approvals. None of the exported HTML is loaded at runtime.

Stitch emitted mock Ollama localhost GPU/VRAM/telemetry elements and sample code, which are **design placeholders only**, intentionally not incorporated as product capabilities. Stitch's canvas itself used 1280×1024 screen exports; implemented desktop layouts were validated at 1360×768, 900×750 and 740×750.

previews/ contains **automated Electron test screenshots** made using a temporary local profile, not screenshots of a signed-in third-party account. No personal chat content or API credentials are present.

**Smoke validation:** npm run typecheck, npm test, npm run build, npm run e2e, npm run e2e:ui. The last command tests the new shell, sidebar, responsive resizing, parameters, keyboard, multimodal composer constraints, and JS errors without connecting to Cloud.
