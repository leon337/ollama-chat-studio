import { LIMITS } from './sniff';

export interface PdfText {
  text: string;
  pages: number;
  totalPages: number;
  truncated: boolean;
}

interface PdfjsLike {
  getDocument(opts: Record<string, unknown>): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>; cleanup(): void }>;
      destroy(): Promise<void>;
    }>;
  };
}

/**
 * Extração controlada de texto: no máximo `maxPages` páginas e `maxChars` caracteres.
 * Isto é um PIPELINE do app (texto extraído), não leitura nativa do PDF pelo modelo.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  limits: { maxPages: number; maxChars: number } = { maxPages: LIMITS.pdfPages, maxChars: LIMITS.pdfChars },
): Promise<PdfText> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs' as string)) as unknown as PdfjsLike;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes), // cópia: o pdf.js desanexa o buffer
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  try {
    const total = doc.numPages;
    const upto = Math.min(total, limits.maxPages);
    let text = '';
    let truncated = total > upto;
    let pages = 0;
    for (let p = 1; p <= upto; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const pageText = content.items.map((i) => (i.str ?? '') + (i.hasEOL ? '\n' : '')).join(' ').replace(/[ \t]+/g, ' ').trim();
      page.cleanup();
      pages = p;
      const block = `\n--- página ${p} ---\n${pageText}`;
      if (text.length + block.length > limits.maxChars) {
        text += block.slice(0, Math.max(0, limits.maxChars - text.length));
        truncated = true;
        break;
      }
      text += block;
    }
    return { text: text.trim(), pages, totalPages: total, truncated };
  } finally {
    await doc.destroy();
  }
}
