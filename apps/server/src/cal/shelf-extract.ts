import { decodeText, parsePackage, unzipEpub, findOpfPath, bodyTextWithBreaks, looksLikeZip } from '@bookclub/epub';
import { type ChunkAtom } from '@bookclub/shared';
import { openPdf } from '../ingest/pdf';

/** Atoms (paragraphs) of plain text, positioned purely by their order (shelf material has no timeline place, D163). */
export function textAtoms(text: string): ChunkAtom[] {
  const atoms: ChunkAtom[] = [];
  let m = 0;
  for (const para of text.split(/\n{2,}/)) {
    const trimmed = para.trim();
    if (trimmed.length > 0) atoms.push({ text: trimmed, m, mEnd: m + trimmed.length });
    m += para.length + 2;
  }
  return atoms;
}

/** Atoms of an EPUB fed to Cal's shelf: every spine document's text, in reading order. No sanitising or rendering is needed — this text is never served as HTML, only read as plain text. */
export function epubShelfAtoms(bytes: Uint8Array): ChunkAtom[] {
  if (!looksLikeZip(bytes)) throw new Error('That does not look like an EPUB file.');
  const container = unzipEpub(bytes);
  const opfPath = findOpfPath(container);
  const pkg = parsePackage(container, opfPath);
  const atoms: ChunkAtom[] = [];
  let m = 0;
  for (const item of pkg.spine) {
    const data = container.get(item.path);
    if (!data) continue;
    const { text, breaks } = bodyTextWithBreaks(decodeText(data));
    let from = 0;
    for (const to of breaks) {
      const piece = text.slice(from, to).trim();
      if (piece.length > 0) atoms.push({ text: piece, m: m + from, mEnd: m + to });
      from = to;
    }
    m += text.length + 1;
  }
  return atoms;
}

/**
 * Plain text from an arbitrary web page's HTML: a regex-based strip, not a full Readability pass
 * (no new dependency for it) — good enough for an article or a wiki page fed to Cal's shelf.
 * `<script>`/`<style>` content is dropped before tags are stripped, so neither ever reaches text.
 */
export function htmlToText(html: string): string {
  const withoutScripts = html.replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const withBreaks = withoutScripts.replace(/<\/(p|div|br|li|h[1-6]|tr|section|article|blockquote)\s*>/gi, '\n\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, ' ');
  const decoded = stripped
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
  return decoded
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Text extracted from a PDF fed to Cal's shelf: every page's text items joined in reading order. */
export async function pdfShelfAtoms(file: string): Promise<ChunkAtom[]> {
  const task = await openPdf(file);
  const doc = await task.promise;
  const atoms: ChunkAtom[] = [];
  let m = 0;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      try {
        const content = await page.getTextContent();
        const text = content.items.map((item) => ('str' in item ? (item as { str: string }).str : '')).join(' ');
        const trimmed = text.replace(/\s+/g, ' ').trim();
        if (trimmed.length > 0) {
          atoms.push({ text: trimmed, m, mEnd: m + trimmed.length });
          m += trimmed.length + 1;
        }
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await task.destroy();
  }
  return atoms;
}
