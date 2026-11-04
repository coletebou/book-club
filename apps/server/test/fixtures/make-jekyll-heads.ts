/**
 * Writes jekyll-1886-heads.json beside this file: the top of every page of the Internet Archive's
 * scan of the 1886 Jekyll and Hyde (scripts/fixtures/make-scan-sample.mjs says where it is from),
 * as the server reads it (readPageHeads): each page's body size and its first lines, the OCR's
 * words and the sizes they are set in. chapters-found.test.ts looks for the book's chapters in it.
 *   pnpm --filter @bookclub/server exec tsx test/fixtures/make-jekyll-heads.ts <bub_gb_xZHv4CWgWaEC.pdf>
 */
import { writeFileSync } from 'node:fs';
import { readPageHeads } from '../../src/ingest/pdf';

const scan = process.argv[2];
if (!scan) throw new Error('usage: make-jekyll-heads.ts <bub_gb_xZHv4CWgWaEC.pdf>');
const heads = await readPageHeads(scan);
const pages = heads.map((h) => [h.body, h.lines.map((l) => [l.text, l.size])]);
writeFileSync(new URL('./jekyll-1886-heads.json', import.meta.url), `${JSON.stringify({ source: 'https://archive.org/details/bub_gb_xZHv4CWgWaEC', pages })}\n`);
console.warn(`${pages.length} pages`);
