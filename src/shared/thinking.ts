import type { ChatParams } from './api';
import type { ModelCapabilities, ThinkingEntry } from './capabilities';

export type ThinkingChoice = NonNullable<ChatParams['think']>;
export interface ThinkingOption { key: string; label: string }

export const thinkingAvailable = (entry: ThinkingEntry): boolean =>
  entry.level === 'native' && !(entry.levels?.length === 1 && entry.levels[0] === false);

export function thinkingOptions(entry: ThinkingEntry): ThinkingOption[] {
  if (!thinkingAvailable(entry)) return [{ key: '', label: 'Indisponível' }];
  const values = entry.levels ?? [false, true];
  const d = entry.default;
  const defaultLabel = d === undefined ? 'Padrão do modelo' : 'Padrão (' + thinkingValueLabel(d) + ')';
  return [
    { key: '', label: defaultLabel },
    ...values.map((value) => ({ key: String(value), label: thinkingValueLabel(value) })),
  ];
}

export function thinkingValueLabel(value: boolean | string): string {
  if (value === true) return 'Ligado';
  if (value === false) return 'Desligado';
  return ({ low: 'Leve', medium: 'Médio', high: 'Alto' } as Record<string, string>)[value] ?? value;
}

export function thinkingChoiceKey(model: ModelCapabilities, choice: ChatParams['think']): string {
  if (!thinkingAvailable(model.thinking) || choice == null) return '';
  const values = model.thinking.levels ?? [false, true];
  return values.includes(choice) ? String(choice) : '';
}

export function decodeThinkingChoice(model: ModelCapabilities, key: string): ThinkingChoice | undefined {
  if (!thinkingAvailable(model.thinking) || key === '') return undefined;
  const found = (model.thinking.levels ?? [false, true]).find((value) => String(value) === key);
  return found;
}

export function normalizeThinking(model: ModelCapabilities, choice: ChatParams['think']): ThinkingChoice | undefined {
  return decodeThinkingChoice(model, choice == null ? '' : String(choice));
}

export function thinkingSummary(model: ModelCapabilities, choice: ChatParams['think']): string {
  if (!thinkingAvailable(model.thinking)) return 'Sem controle de raciocínio';
  const key = thinkingChoiceKey(model, choice);
  return key ? thinkingValueLabel(decodeThinkingChoice(model, key)!) : 'Padrão';
}
