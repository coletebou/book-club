#!/usr/bin/env node
// Build fixtures/books/jekyll-1886-scan-sample.pdf: seven pages of the Internet Archive's PDF of
// the 1886 Longmans "Strange Case of Dr Jekyll and Mr Hyde" (Harvard's copy, scanned by Google;
// public domain), https://archive.org/details/bub_gb_xZHv4CWgWaEC, as such scans come: each page
// a JPEG 2000 picture, a JPEG 2000 foreground under a JBIG2 mask, and the OCR's text laid over them
// unseen, in Courier (not embedded). Its pages, objects and document info are copied as they are,
// renumbered: the cover, the contents, the first page of the story (a newspaper cutting pasted
// over its top), a page with a running head only, and three chapters' first pages, one of them
// with its heading read by the OCR as "JIENRY JEKYLUS FULL STATEMENT / OF TUE CASE,".
//
// Usage: node scripts/fixtures/make-scan-sample.mjs <bub_gb_xZHv4CWgWaEC.pdf> [out.pdf]
// (https://archive.org/download/bub_gb_xZHv4CWgWaEC/bub_gb_xZHv4CWgWaEC.pdf, 3,728,640 bytes,
// SHA-256 298fef21eefbda0436fa2aa700a412b63f51862db4c48aa210af646f19cc326b on 2026-10-25.)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [source, out = path.join(root, 'fixtures/books/jekyll-1886-scan-sample.pdf')] = process.argv.slice(2);
if (!source) throw new Error('usage: make-scan-sample.mjs <bub_gb_xZHv4CWgWaEC.pdf> [out.pdf]');
/** The pages copied, by their index in the scan (0 is its cover). */
const PAGES = [0, 7, 8, 14, 21, 60, 111];
const SHA256 = '298fef21eefbda0436fa2aa700a412b63f51862db4c48aa210af646f19cc326b';

const bytes = readFileSync(source);
const sha = createHash('sha256').update(bytes).digest('hex');
if (sha !== SHA256) throw new Error(`${source} is not the scan this sample is made from (SHA-256 ${sha})`);
const text = bytes.toString('latin1');

/** Every object of the file: its dictionary or value as written, and its stream's bytes. */
const objects = new Map();
for (const m of text.matchAll(/(?:^|[\r\n])(\d+) 0 obj\b/g)) {
  const id = Number(m[1]);
  const start = m.index + m[0].length;
  const end = text.indexOf('endobj', start);
  const head = text.slice(start, end);
  const stream = /^([\s\S]*?)\bstream\r?\n/.exec(head);
  if (!stream) {
    objects.set(id, { dict: head.trim(), data: null });
    continue;
  }
  const dict = stream[1].trim();
  const length = Number(/\/Length (\d+)(?! \d+ R)/.exec(dict)?.[1]);
  if (!Number.isInteger(length)) throw new Error(`object ${id}: a stream without a direct length`);
  const from = start + stream[0].length;
  objects.set(id, { dict, data: bytes.subarray(from, from + length) });
}
const refsIn = (s) => [...s.matchAll(/(\d+) 0 R/g)].map((r) => Number(r[1]));

// The first trailer of a linearised file names the catalog and the document info.
const trailer = /trailer\s*<<([\s\S]*?)>>\s*startxref/.exec(text)[1];
const catalog = objects.get(Number(/\/Root (\d+) 0 R/.exec(trailer)[1])).dict;
const info = objects.get(Number(/\/Info (\d+) 0 R/.exec(trailer)[1])).dict;

/** The pages in order, each with what it inherits from the page tree. */
const pages = [];
const walk = (id, inherited) => {
  const { dict } = objects.get(id);
  const own = { ...inherited };
  for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
    const value = new RegExp(`/${key}\\s*(\\[[^\\]]*\\]|\\d+ 0 R|\\d+)`).exec(dict);
    if (value) own[key] = value[1];
  }
  if (/\/Type\s*\/Page\b/.test(dict)) return void pages.push({ id, inherited });
  for (const kid of refsIn(/\/Kids\s*\[([^\]]*)\]/.exec(dict)[1])) walk(kid, own);
};
walk(Number(/\/Pages (\d+) 0 R/.exec(catalog)[1]), {});
if (pages.length !== 153) throw new Error(`expected 153 pages, found ${pages.length}`);

// Each chosen page and everything it reaches (not its parent), numbered afresh from 3.
const number = new Map();
const order = [];
const visit = (id) => {
  if (number.has(id)) return;
  number.set(id, 3 + order.length);
  order.push(id);
  const { dict } = objects.get(id);
  for (const ref of refsIn(dict.replace(/\/Parent \d+ 0 R/, ''))) visit(ref);
};
for (const index of PAGES) visit(pages[index].id);
const renumber = (dict) => dict.replace(/(\d+) 0 R/g, (_, id) => `${number.get(Number(id))} 0 R`);

const chunks = [Buffer.from('%PDF-1.5\n%\xec\xf5\xf2\xe1\n', 'latin1')];
let size = chunks[0].length;
const offsets = [];
const write = (id, dict, data = null) => {
  offsets[id] = size;
  const parts = [`${id} 0 obj\n${dict}\n`, ...(data ? ['stream\n', data, '\nendstream\n'] : []), 'endobj\n'];
  for (const part of parts) {
    const b = typeof part === 'string' ? Buffer.from(part, 'latin1') : part;
    chunks.push(b);
    size += b.length;
  }
};
const pageIds = PAGES.map((index) => number.get(pages[index].id));
write(1, '<</Type/Catalog/Pages 2 0 R>>');
write(2, `<</Type/Pages/Count ${pageIds.length}/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]>>`);
for (const id of order) {
  const { dict, data } = objects.get(id);
  const page = pages.find((p) => p.id === id);
  let copy = renumber(dict.replace(/\/Parent \d+ 0 R/, '/Parent 2 0 R'));
  // What a page inherited from the scan's page tree is its own here.
  if (page) for (const [key, value] of Object.entries(page.inherited)) if (!new RegExp(`/${key}\\b`).test(copy)) copy = copy.replace(/>>\s*$/, `/${key} ${renumber(value)}>>`);
  write(number.get(id), copy, data);
}
const infoId = 3 + order.length;
write(infoId, info);
const count = infoId + 1;
let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
for (let id = 1; id < count; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
xref += `trailer\n<</Size ${count}/Root 1 0 R/Info ${infoId} 0 R>>\nstartxref\n${size}\n%%EOF\n`;
chunks.push(Buffer.from(xref, 'latin1'));
const pdf = Buffer.concat(chunks);
writeFileSync(out, pdf);
console.log(`${path.relative(root, out)}: ${PAGES.length} pages of the scan, ${order.length} objects, ${Math.round(pdf.length / 1024)} KB`);
