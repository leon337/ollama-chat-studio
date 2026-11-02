import { describe, expect, it } from 'vitest';
import { ModelCapabilityRegistry, parseShowResponse } from '../src/shared/registry';
import { paramsSchema } from '../src/main/ipc-schemas';
import { decodeThinkingChoice, normalizeThinking, thinkingAvailable, thinkingChoiceKey, thinkingOptions, thinkingSummary } from '../src/shared/thinking';

const model = (id: string) => new ModelCapabilityRegistry().get(id)!;

describe('Modelo e nível de raciocínio', () => {
  it('GPT-OSS oferece Leve, Médio e Alto, com padrão nativo', () => {
    const m = model('gpt-oss:20b');
    expect(thinkingOptions(m.thinking).map(o => o.key)).toEqual(['', 'low', 'medium', 'high']);
    expect(thinkingSummary(m, 'high')).toBe('Alto');
    expect(thinkingSummary(m, undefined)).toBe('Padrão');
    expect(decodeThinkingChoice(m, 'medium')).toBe('medium');
    expect(decodeThinkingChoice(m, 'ultra')).toBeUndefined();
  });

  it('modelos booleanos só oferecem Ligado/Desligado', () => {
    const m = model('gemma4:31b');
    expect(thinkingOptions(m.thinking).map(o => o.key)).toEqual(['', 'false', 'true']);
    expect(thinkingSummary(m, true)).toBe('Ligado');
    expect(normalizeThinking(m, false)).toBe(false);
    expect(normalizeThinking(m, 'high')).toBeUndefined();
  });

  it('modelo sem thinking descarta escolha incompatível', () => {
    const m = model('nemotron-3-super');
    expect(thinkingAvailable(m.thinking)).toBe(false);
    expect(thinkingChoiceKey(m, 'high')).toBe('');
    expect(normalizeThinking(m, 'high')).toBeUndefined();
  });

  it('runtime usa apenas níveis que a API anunciou', () => {
    const info = parseShowResponse({
      capabilities: ['completion', 'thinking'],
      model_info: {},
      thinking: { values: ['minimal', 'standard', 'deep'], default: 'standard' },
    });
    const m = new ModelCapabilityRegistry().applyShow('gpt-oss:20b', info);
    expect(thinkingOptions(m.thinking)[0]?.label).toBe('Padrão (standard)');
    expect(decodeThinkingChoice(m, 'deep')).toBe('deep');
    expect(decodeThinkingChoice(m, 'high')).toBeUndefined();
    expect(paramsSchema.safeParse({ think: 'deep' }).success).toBe(true);
    expect(paramsSchema.safeParse({ think: 'INVALID;ARGUMENT' }).success).toBe(false);
  });

  it('um modelo com apenas false não oferece raciocínio configurável', () => {
    const m = new ModelCapabilityRegistry().applyShow('beam', {
      capabilities: ['completion', 'thinking'],
      contextLength: null,
      thinkingValues: [false],
    });
    expect(thinkingAvailable(m.thinking)).toBe(false);
    expect(thinkingSummary(m, undefined)).toBe('Sem controle de raciocínio');
  });
});
