// Reads the guideline markdown (fixtures/child-cough/guideline.md) into pages.
// Format: a "Source:" line, an optional "SHA-256:" line (hash of the original PDF),
// then "## Page N" headings followed by text copied verbatim from the PDF.
import { createHash } from 'node:crypto';

export const EXTRACTOR_VERSION = 'md-pages-1';

export interface GuidelineSource {
  title: string;
  url?: string;
  pdfSha256?: string;
  textSha256: string;
  extractorVersion: string;
  pages: Map<number, string>;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Collapse all whitespace so line breaks from PDF copy-paste do not matter. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function parseGuideline(markdown: string): GuidelineSource {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());
  const pages = new Map<number, string>();
  let title = '';
  let url: string | undefined;
  let pdfSha256: string | undefined;
  let current: number | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current !== null) pages.set(current, buffer.join('\n').trim());
    buffer = [];
  };

  for (const line of lines) {
    const page = /^##\s*Page\s+(\d+)\s*$/i.exec(line);
    if (page) {
      flush();
      current = Number(page[1]);
      continue;
    }
    if (current === null) {
      if (!title && line.startsWith('# ')) title = line.slice(2).trim();
      else if (/^Source:/i.test(line)) url = line.replace(/^Source:\s*/i, '').trim() || undefined;
      else if (/^SHA-256:/i.test(line)) pdfSha256 = line.replace(/^SHA-256:\s*/i, '').trim() || undefined;
      continue;
    }
    buffer.push(line);
  }
  flush();

  return { title, url, pdfSha256, textSha256: sha256(markdown), extractorVersion: EXTRACTOR_VERSION, pages };
}
