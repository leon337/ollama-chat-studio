import type { AttachmentKind } from '../../shared/router';

// O tipo do arquivo vem dos BYTES (magic numbers), nunca do mime/extensão informado pelo renderer.

export const LIMITS = {
  imageBytes: 10 * 1024 * 1024,
  pdfBytes: 25 * 1024 * 1024,
  textBytes: 1 * 1024 * 1024,
  audioBytes: 25 * 1024 * 1024,
  videoFrames: 16,
  frameBytes: 2 * 1024 * 1024,
  pdfPages: 50,
  pdfChars: 60_000,
  textChars: 60_000,
  perMessage: 10,
} as const;

export interface Sniffed {
  kind: AttachmentKind;
  mime: string;
  ext: string;
}

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Uint8Array, s: string, offset = 0) => [...s].every((c, i) => b[offset + i] === c.charCodeAt(0));

const TEXT_EXT = new Set([
  'txt', 'md', 'csv', 'tsv', 'json', 'log', 'js', 'ts', 'tsx', 'jsx', 'py', 'html', 'css', 'yml', 'yaml', 'xml', 'sql', 'sh', 'ini', 'toml', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php',
]);

export function sniff(bytes: Uint8Array, name: string): Sniffed | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (ascii(bytes, 'GIF8')) return { kind: 'image', mime: 'image/gif', ext: 'gif' };
  if (ascii(bytes, 'RIFF') && ascii(bytes, 'WEBP', 8)) return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  if (ascii(bytes, '%PDF-')) return { kind: 'pdf', mime: 'application/pdf', ext: 'pdf' };
  if (ascii(bytes, 'RIFF') && ascii(bytes, 'WAVE', 8)) return { kind: 'audio', mime: 'audio/wav', ext: 'wav' };
  if (ascii(bytes, 'ID3') || isMp3Frame(bytes)) return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' };
  if (ascii(bytes, 'OggS')) return { kind: 'audio', mime: 'audio/ogg', ext: 'ogg' };
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'audio', mime: 'audio/webm', ext: 'webm' };
  if (ascii(bytes, 'ftyp', 4)) return { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' };

  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (TEXT_EXT.has(ext) && isUtf8Text(bytes)) return { kind: 'text', mime: 'text/plain', ext: ext || 'txt' };
  return null;
}

/** Cabeçalho de quadro MPEG áudio: sincronismo de 11 bits + campos reservados rejeitados. */
function isMp3Frame(b: Uint8Array): boolean {
  if (b.length < 4 || b[0] !== 0xff) return false;
  const b1 = b[1]!;
  const b2 = b[2]!;
  if ((b1 & 0xe0) !== 0xe0) return false; // sync
  if (((b1 >> 3) & 3) === 1) return false; // versão reservada
  if (((b1 >> 1) & 3) === 0) return false; // camada reservada
  if (b2 >> 4 === 0xf) return false; // bitrate inválido
  if (((b2 >> 2) & 3) === 3) return false; // taxa de amostragem reservada
  return true;
}

export function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function sizeLimitFor(kind: AttachmentKind): number {
  switch (kind) {
    case 'image':
      return LIMITS.imageBytes;
    case 'pdf':
      return LIMITS.pdfBytes;
    case 'audio':
      return LIMITS.audioBytes;
    case 'text':
      return LIMITS.textBytes;
    case 'video':
      return LIMITS.frameBytes * LIMITS.videoFrames;
  }
}

/** Nome só para exibição: sem diretórios, sem caracteres de controle. NUNCA usado como caminho. */
export function sanitizeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'arquivo';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (clean || 'arquivo').slice(0, 120);
}
