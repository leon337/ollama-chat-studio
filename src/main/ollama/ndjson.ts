import { OllamaError } from './errors';

/**
 * Lê um corpo NDJSON (um objeto JSON por linha) de um ReadableStream, tolerando
 * linhas partidas entre pedaços. `onActivity` é chamado a cada pedaço (watchdog de ociosidade).
 */
export async function* readNdjson(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) yield parseLine(line);
      }
    }
    buffer += decoder.decode();
    const rest = buffer.trim();
    if (rest) yield parseLine(rest);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* já encerrado */
    }
  }
}

function parseLine(line: string): Record<string, unknown> {
  try {
    const obj = JSON.parse(line) as unknown;
    if (obj && typeof obj === 'object') return obj as Record<string, unknown>;
  } catch {
    /* cai no erro abaixo */
  }
  throw new OllamaError('PROTOCOL', 'Resposta de streaming inválida (linha não-JSON).');
}
