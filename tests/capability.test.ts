import { describe, expect, it } from 'vitest';
import { SEED_MODELS } from '../src/shared/seed';
import { conservativeEntry, ModelCapabilityRegistry, parseShowResponse } from '../src/shared/registry';
import { attachAccept, planRoute, type AttachmentKind } from '../src/shared/router';

const reg = () => new ModelCapabilityRegistry();
const none = { asr: false, tts: true };
const withAsr = { asr: true, tts: true };
const route = (id: string, o: Partial<Parameters<typeof planRoute>[0]> = {}) =>
  planRoute({ model: reg().get(id)!, attachments: [], tools: false, json: false, adapters: none, ...o });
const codes = (r: ReturnType<typeof planRoute>) => r.blocks.map((b) => b.code);

describe('catálogo inicial', () => {
  it('contém exatamente os 7 modelos pedidos, todos Ollama Cloud', () => {
    expect(SEED_MODELS.map((m) => m.id).sort()).toEqual(
      ['beam', 'gemma4:31b', 'gpt-oss:120b', 'gpt-oss:20b', 'nemotron-3-nano:30b', 'nemotron-3-super', 'nemotron-3-ultra'].sort(),
    );
    expect(SEED_MODELS.every((m) => m.cloud && m.provider === 'Ollama Cloud')).toBe(true);
  });

  it('INVARIANTE: nenhum modelo declara áudio ou vídeo NATIVOS (sem prova nos docs)', () => {
    for (const m of SEED_MODELS) {
      expect(m.audioIn.level, m.id).not.toBe('native');
      expect(m.audioOut.level, m.id).not.toBe('native');
      expect(m.videoIn.level, m.id).not.toBe('native');
      expect(m.imageOut.level, m.id).toBe('unsupported');
    }
  });

  it('visão nativa só no gemma4:31b; os demais não têm', () => {
    const vision = SEED_MODELS.filter((m) => m.imageIn.level === 'native').map((m) => m.id);
    expect(vision).toEqual(['gemma4:31b']);
  });

  it('vídeo vira "adapter" (quadros) só onde há visão; sem visão é unsupported', () => {
    const r = reg();
    expect(r.get('gemma4:31b')!.videoIn.level).toBe('adapter');
    expect(r.get('gpt-oss:120b')!.videoIn.level).toBe('unsupported');
  });

  it('toda entrada traz de onde veio a informação (verification) e fontes', () => {
    for (const m of SEED_MODELS) {
      expect(m.sources.length, m.id).toBeGreaterThan(0);
      expect(['official', 'third-party', 'runtime', 'unverified']).toContain(m.imageIn.verification);
    }
  });
});

describe('capability gating (ModelRouter)', () => {
  it('imagem: bloqueada em modelo sem visão, liberada no gemma4:31b com pipeline nativo', () => {
    const blocked = route('gpt-oss:120b', { attachments: ['image'] });
    expect(blocked.ok).toBe(false);
    expect(codes(blocked)).toContain('VISION_UNSUPPORTED');

    const ok = route('gemma4:31b', { attachments: ['image'] });
    expect(ok.ok).toBe(true);
    expect(ok.pipeline.find((p) => p.id === 'image-native')?.native).toBe(true);
  });

  it('áudio: exige ASR; com ASR aparece como pipeline NÃO nativo', () => {
    expect(codes(route('gemma4:31b', { attachments: ['audio'] }))).toContain('ASR_ADAPTER_MISSING');
    const r = route('gemma4:31b', { attachments: ['audio'], adapters: withAsr });
    expect(r.ok).toBe(true);
    expect(r.pipeline.find((p) => p.id === 'audio-asr')?.native).toBe(false);
  });

  it('vídeo: é pipeline de quadros (não nativo), exige visão e avisa se não há ASR', () => {
    const r = route('gemma4:31b', { attachments: ['video'] });
    expect(r.ok).toBe(true);
    expect(r.pipeline.find((p) => p.id === 'video-frames')?.native).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain('VIDEO_NO_AUDIO_TRANSCRIPT');
    expect(codes(route('beam', { attachments: ['video'] }))).toContain('VIDEO_NEEDS_VISION');
  });

  it('PDF e texto são sempre extraídos pelo app (não nativos)', () => {
    const r = route('beam', { attachments: ['pdf', 'text'] });
    expect(r.ok).toBe(true);
    expect(r.pipeline.every((p) => !p.native)).toBe(true);
  });

  it('thinking: nemotron-3-super não suporta; gpt-oss exige nível; beam aceita booleano', () => {
    expect(codes(route('nemotron-3-super', { think: true }))).toContain('THINK_UNSUPPORTED');
    expect(codes(route('gpt-oss:120b', { think: true }))).toContain('THINK_VALUE_INVALID');
    expect(route('gpt-oss:120b', { think: 'high' }).ok).toBe(true);
    expect(route('beam', { think: true }).ok).toBe(true);
    expect(route('nemotron-3-super', { think: false }).ok).toBe(true); // desligar nunca bloqueia
  });

  it('tool calling e num_ctx são validados', () => {
    expect(route('gpt-oss:20b', { tools: true }).ok).toBe(true);
    expect(codes(route('gpt-oss:20b', { numCtx: 999_999 }))).toContain('CONTEXT_EXCEEDED');
    expect(route('beam', { numCtx: 500_000 }).ok).toBe(true);
  });

  it('modelo desconhecido é conservador: sem visão, sem tools, sem thinking até haver prova', () => {
    const c = conservativeEntry('algum-modelo-novo');
    const p = (extra: object) => planRoute({ model: c, attachments: [], tools: false, json: false, adapters: none, ...extra });
    expect(p({ attachments: ['image'] as AttachmentKind[] }).ok).toBe(false);
    expect(p({ tools: true }).ok).toBe(false);
    expect(p({ think: true }).ok).toBe(false);
    expect(p({}).ok).toBe(true); // texto simples funciona
  });

  it('attachAccept explica o porquê de cada recurso desabilitado', () => {
    const a = attachAccept(reg().get('beam')!, none);
    expect(a.image.enabled).toBe(false);
    expect(a.image.reason).toMatch(/visão/);
    expect(a.audio.reason).toMatch(/ASR/);
    expect(a.pdf.enabled && a.text.enabled).toBe(true);
    expect(attachAccept(reg().get('gemma4:31b')!, withAsr).audio.enabled).toBe(true);
  });
});

describe('prova em runtime (/api/show) e divergências', () => {
  it('parseShowResponse extrai capacidades, contexto e níveis de thinking', () => {
    const info = parseShowResponse({
      capabilities: ['completion', 'tools', 'thinking'],
      model_info: { 'gptoss.context_length': 131072, 'general.architecture': 'gptoss' },
      thinking: { values: ['low', 'medium', 'high'], default: 'medium' },
    });
    expect(info).toEqual({ capabilities: ['completion', 'tools', 'thinking'], contextLength: 131072, thinkingValues: ['low', 'medium', 'high'], thinkingDefault: 'medium' });
    expect(parseShowResponse(null).capabilities).toEqual([]);
  });

  it('se a API contradiz o catálogo, vale a API e a divergência é registrada', () => {
    const r = reg();
    const m = r.applyShow('gemma4:31b', { capabilities: ['completion', 'tools'], contextLength: 131072, thinkingValues: null });
    expect(m.imageIn.level).toBe('unsupported');
    expect(m.imageIn.verification).toBe('runtime');
    expect(m.videoIn.level).toBe('unsupported'); // derivado: sem visão, sem quadros
    expect(m.thinking.level).toBe('unsupported');
    expect(m.contextTokens).toBe(131072);
    expect(m.drift.length).toBeGreaterThanOrEqual(2);
    // e o roteador passa a bloquear imagem
    expect(planRoute({ model: m, attachments: ['image'], tools: false, json: false, adapters: none }).ok).toBe(false);
  });

  it('confirmar capacidade existente marca como runtime sem divergência', () => {
    const r = reg();
    const m = r.applyShow('gpt-oss:120b', { capabilities: ['completion', 'tools', 'thinking'], contextLength: 131072, thinkingValues: ['low', 'medium', 'high'] });
    expect(m.toolCalling.verification).toBe('runtime');
    expect(m.drift).toEqual([]);
    expect(m.availability).toBe('listed');
  });

  it('applyTags marca modelos ausentes da conta como not-listed', () => {
    const r = reg();
    r.applyTags(['gpt-oss:120b', 'beam:cloud']);
    expect(r.get('gpt-oss:120b')!.availability).toBe('listed');
    expect(r.get('beam')!.availability).toBe('listed'); // sufixo :cloud normalizado
    expect(r.get('gemma4:31b')!.availability).toBe('not-listed');
  });
});
