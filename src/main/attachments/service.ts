import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttachmentRef } from '../../shared/api';
import { formatTimestamp } from '../../shared/media';
import type { Store, StoredAttachment } from '../db/store';
import { extractPdfText, type PdfText } from './pdf';
import { LIMITS, sanitizeName, sizeLimitFor, sniff } from './sniff';

export class AttachmentError extends Error {
  constructor(
    readonly code: 'TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'INVALID' | 'TOO_MANY' | 'PDF_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

interface VideoManifest {
  frames: Array<{ tSec: number; file: string }>;
}

export interface PromptParts {
  text: string;
  images: string[]; // base64
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export class AttachmentService {
  constructor(
    private readonly store: Store,
    private readonly dir: string,
    private readonly pdfExtractor: typeof extractPdfText = extractPdfText,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /** O nome do arquivo em disco é sempre "<sha256>.<ext>": o nome do usuário nunca vira caminho. */
  private writeBlob(hash: string, ext: string, bytes: Uint8Array): string {
    const path = join(this.dir, `${hash}.${ext}`);
    if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 });
    return path;
  }

  async ingest(input: { name: string; mime: string; bytes: Uint8Array; transcript?: string }): Promise<AttachmentRef> {
    const bytes = input.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new AttachmentError('INVALID', 'Arquivo vazio ou inválido.');
    const kind = sniff(bytes, input.name);
    if (!kind) throw new AttachmentError('UNSUPPORTED_TYPE', 'Tipo de arquivo não suportado (verificado pelo conteúdo, não pela extensão).');
    if (bytes.length > sizeLimitFor(kind.kind)) {
      throw new AttachmentError('TOO_LARGE', `Arquivo acima do limite de ${Math.round(sizeLimitFor(kind.kind) / 1024 / 1024)} MB para ${kind.kind}.`);
    }
    const hash = sha256(bytes);
    const path = this.writeBlob(hash, kind.ext, bytes);
    const meta: AttachmentRef['meta'] = {};

    if (kind.kind === 'pdf') {
      let parsed: PdfText;
      try {
        parsed = await this.pdfExtractor(bytes);
      } catch (e) {
        throw new AttachmentError('PDF_FAILED', `Não foi possível extrair texto do PDF: ${(e as Error).message}`);
      }
      writeFileSync(`${path}.txt`, parsed.text, { mode: 0o600 });
      Object.assign(meta, { pages: parsed.pages, totalPages: parsed.totalPages, chars: parsed.text.length, truncated: parsed.truncated });
    } else if (kind.kind === 'text') {
      const full = new TextDecoder().decode(bytes);
      Object.assign(meta, { chars: Math.min(full.length, LIMITS.textChars), truncated: full.length > LIMITS.textChars });
    } else if (kind.kind === 'audio' && input.transcript) {
      meta.transcript = input.transcript.slice(0, 50_000);
    }

    return this.store.insertAttachment({ kind: kind.kind, name: sanitizeName(input.name), mime: kind.mime, size: bytes.length, sha256: hash, path, meta });
  }

  async ingestVideo(input: {
    name: string;
    mime: string;
    durationSec: number;
    frames: Array<{ tSec: number; bytes: Uint8Array }>;
    transcript?: string;
  }): Promise<AttachmentRef> {
    if (input.frames.length === 0) throw new AttachmentError('INVALID', 'Nenhum quadro extraído do vídeo.');
    if (input.frames.length > LIMITS.videoFrames) throw new AttachmentError('TOO_MANY', `Máximo de ${LIMITS.videoFrames} quadros por vídeo.`);
    const manifest: VideoManifest = { frames: [] };
    const hashes: string[] = [];
    for (const f of input.frames) {
      const k = sniff(f.bytes, 'frame');
      if (!k || k.kind !== 'image') throw new AttachmentError('INVALID', 'Quadro de vídeo não é uma imagem válida.');
      if (f.bytes.length > LIMITS.frameBytes) throw new AttachmentError('TOO_LARGE', 'Quadro de vídeo grande demais.');
      if (!(f.tSec >= 0)) throw new AttachmentError('INVALID', 'Timestamp de quadro inválido.');
      const h = sha256(f.bytes);
      hashes.push(h);
      manifest.frames.push({ tSec: f.tSec, file: this.writeBlob(h, k.ext, f.bytes) });
    }
    const hash = createHash('sha256').update(hashes.join('|')).digest('hex');
    const path = join(this.dir, `${hash}.video.json`);
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
    const meta: AttachmentRef['meta'] = {
      durationSec: input.durationSec,
      frames: manifest.frames.map((f) => ({ tSec: f.tSec })),
      ...(input.transcript ? { transcript: input.transcript.slice(0, 50_000) } : {}),
    };
    const size = input.frames.reduce((n, f) => n + f.bytes.length, 0);
    return this.store.insertAttachment({ kind: 'video', name: sanitizeName(input.name), mime: 'video/x-frames', size, sha256: hash, path, meta });
  }

  bytes(id: string, frameIndex = 0): Uint8Array {
    const a = this.mustGet(id);
    if (a.kind === 'video') {
      const m = JSON.parse(readFileSync(a.path, 'utf8')) as VideoManifest;
      const f = m.frames[frameIndex];
      if (!f) throw new AttachmentError('INVALID', 'Quadro inexistente.');
      return new Uint8Array(readFileSync(f.file));
    }
    return new Uint8Array(readFileSync(a.path));
  }

  private mustGet(id: string): StoredAttachment {
    const a = this.store.getAttachment(id);
    if (!a) throw new AttachmentError('INVALID', 'Anexo não encontrado.');
    return a;
  }

  /** Transforma anexos em partes do prompt. Conteúdo de arquivo é DADO, nunca instrução. */
  buildPromptParts(attachments: AttachmentRef[]): PromptParts {
    const blocks: string[] = [];
    const images: string[] = [];
    for (const ref of attachments) {
      const a = this.mustGet(ref.id);
      const name = ref.name.replace(/"/g, "'");
      if (a.kind === 'image') {
        images.push(Buffer.from(readFileSync(a.path)).toString('base64'));
      } else if (a.kind === 'pdf') {
        const txt = readFileSync(`${a.path}.txt`, 'utf8'); // sidecar "<sha>.pdf.txt" gravado no ingest
        blocks.push(fileBlock(name, 'pdf', txt, ref.meta));
      } else if (a.kind === 'text') {
        const full = readFileSync(a.path, 'utf8');
        blocks.push(fileBlock(name, 'texto', full.slice(0, LIMITS.textChars), ref.meta));
      } else if (a.kind === 'audio') {
        if (ref.meta.transcript) blocks.push(`<transcricao arquivo="${name}" fonte="ASR externo, não é entendimento nativo do modelo">\n${escapeTag(ref.meta.transcript, 'transcricao')}\n</transcricao>`);
      } else if (a.kind === 'video') {
        const m = JSON.parse(readFileSync(a.path, 'utf8')) as VideoManifest;
        const stamps = m.frames.map((f) => formatTimestamp(f.tSec)).join(', ');
        for (const f of m.frames) images.push(readFileSync(f.file).toString('base64'));
        blocks.push(`<video arquivo="${name}" duracao="${formatTimestamp(ref.meta.durationSec ?? 0)}" fonte="quadros extraídos pelo app, não é vídeo nativo">\nImagens anexadas, em ordem, correspondem aos instantes: ${stamps}.\n</video>`);
        if (ref.meta.transcript) blocks.push(`<transcricao arquivo="${name}" fonte="ASR externo do áudio do vídeo">\n${escapeTag(ref.meta.transcript, 'transcricao')}\n</transcricao>`);
      }
    }
    return { text: blocks.join('\n\n'), images };
  }

  setTranscript(id: string, transcript: string): void {
    const a = this.mustGet(id);
    const meta = { ...a.meta, transcript: transcript.slice(0, 50_000) };
    this.store.db.prepare('UPDATE attachments SET meta_json = ? WHERE id = ?').run(JSON.stringify(meta), id);
  }

  /** Remove arquivos de disco que não são mais referenciados por nenhum anexo. */
  cleanup(paths: string[]): void {
    for (const p of paths) {
      const still = this.store.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE path = ?').get(p) as { n: number };
      if (still.n > 0) continue;
      for (const f of [p, `${p}.txt`]) if (existsSync(f)) unlinkSync(f);
    }
  }
}

function escapeTag(text: string, tag: string): string {
  return text.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`);
}

function fileBlock(name: string, type: string, content: string, meta: AttachmentRef['meta']): string {
  const attrs = [`nome="${name}"`, `tipo="${type}"`];
  if (meta.pages !== undefined) attrs.push(`paginas="1-${meta.pages} de ${meta.totalPages ?? meta.pages}"`);
  if (meta.truncated) attrs.push('truncado="sim"');
  return `<arquivo ${attrs.join(' ')}>\n${escapeTag(content, 'arquivo')}\n</arquivo>`;
}
