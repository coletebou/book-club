#!/usr/bin/env node
// Build fixtures/books/alice.pdf from the Project Gutenberg plain text (eBook #11, public domain):
// an A5 book with a title page, one chapter per section, page numbers, document info
// (title, author) and an outline (bookmarks) entry per chapter. With --no-outline, the same book
// without bookmarks, as many PDFs come: the server finds its chapters from their headings (D74).
//
// Usage: node scripts/fixtures/make-alice-pdf.mjs [out.pdf] [--no-outline]
import { createWriteStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = path.join(root, 'fixtures/text/alice-gutenberg-11.txt');
const args = process.argv.slice(2);
const withOutline = !args.includes('--no-outline');
const out = args.find((a) => !a.startsWith('--')) ?? path.join(root, 'fixtures/books/alice.pdf');

const text = readFileSync(source, 'utf8').replace(/\r\n?/g, '\n');
const start = text.indexOf('\n', text.indexOf('*** START OF THE PROJECT GUTENBERG EBOOK'));
const end = text.indexOf('*** END OF THE PROJECT GUTENBERG EBOOK');
const body = text.slice(start, end);

const lines = body.split('\n');
const chapters = [];
for (let i = 0; i < lines.length; i++) {
  if (/^CHAPTER [IVXLC]+\.$/.test(lines[i].trim()) && lines[i].trim() === lines[i]) {
    chapters.push({ heading: lines[i].trim(), title: lines[i + 1].trim(), startLine: i + 2 });
  }
}
if (chapters.length !== 12) throw new Error(`expected 12 chapters, found ${chapters.length}`);
for (let c = 0; c < chapters.length; c++) {
  const endLine = c + 1 < chapters.length ? chapters[c + 1].startLine - 2 : lines.length;
  const raw = lines.slice(chapters[c].startLine, endLine).join('\n');
  chapters[c].paragraphs = raw
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').map((l) => l.trim()).join(' ').replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
}

const fixed = new Date(Date.UTC(2026, 9, 23, 12, 0, 0));
const doc = new PDFDocument({
  size: 'A5',
  margins: { top: 56, bottom: 64, left: 52, right: 52 },
  autoFirstPage: false,
  bufferPages: true,
  pdfVersion: '1.7',
  info: {
    Title: "Alice's Adventures in Wonderland",
    Author: 'Lewis Carroll',
    Subject: 'Generated from Project Gutenberg eBook #11 (public domain) for Book Club tests',
    Keywords: 'Alice, Wonderland, Lewis Carroll, public domain',
    Creator: 'book-club-v2 fixtures',
    Producer: 'PDFKit',
    CreationDate: fixed,
    ModDate: fixed,
  },
});
doc.pipe(createWriteStream(out));

// Title page: dark field with a gold title, so a rendered first page makes a real cover.
doc.addPage();
const { width, height } = doc.page;
doc.rect(0, 0, width, height).fill('#15130f');
doc.rect(36, 36, width - 72, height - 72).lineWidth(1.5).stroke('#c9a84c');
doc.fillColor('#c9a84c').font('Times-Bold').fontSize(30).text("Alice's Adventures", 52, height * 0.3, { width: width - 104, align: 'center' });
doc.text('in Wonderland', { width: width - 104, align: 'center' });
doc.moveDown(1.2).font('Times-Italic').fontSize(16).fillColor('#efe6cf').text('Lewis Carroll', { width: width - 104, align: 'center' });
doc.font('Times-Roman').fontSize(9).fillColor('#a89f8a').text('Project Gutenberg eBook #11 · public domain', 52, height - 90, { width: width - 104, align: 'center' });

for (const chapter of chapters) {
  doc.addPage();
  if (withOutline) doc.outline.addItem(`${chapter.heading} ${chapter.title}`);
  doc.fillColor('#111111').font('Times-Bold').fontSize(13).text(chapter.heading, { align: 'center' });
  doc.font('Times-Bold').fontSize(17).text(chapter.title, { align: 'center' });
  doc.moveDown(1.2);
  doc.font('Times-Roman').fontSize(11);
  const paragraph = { align: 'justify', indent: 14, lineGap: 2, paragraphGap: 5 };
  for (const p of chapter.paragraphs) {
    // Gutenberg's plain text marks italics _like this_: set them in italics, not as underscores.
    const parts = p.split('_');
    if (parts.length % 2 === 0 || parts.length === 1) {
      doc.font('Times-Roman').text(p, paragraph);
      continue;
    }
    const pieces = parts.map((text, i) => ({ text, italic: i % 2 === 1 })).filter((piece) => piece.text.length > 0);
    // PDFKit drops the space a continued run starts with ("_very_ remarkable" came out
    // "veryremarkable"): each run ends with the space instead.
    for (let i = 0; i + 1 < pieces.length; i++) {
      if (/^\s/.test(pieces[i + 1].text)) {
        pieces[i].text = `${pieces[i].text} `;
        pieces[i + 1].text = pieces[i + 1].text.trimStart();
      }
    }
    pieces.forEach((piece, i) => {
      doc.font(piece.italic ? 'Times-Italic' : 'Times-Roman').text(piece.text, { ...paragraph, continued: i < pieces.length - 1 });
    });
    doc.font('Times-Roman');
  }
}

// Page numbers on every page but the title page.
const range = doc.bufferedPageRange();
for (let i = range.start + 1; i < range.start + range.count; i++) {
  doc.switchToPage(i);
  const bottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.font('Times-Roman').fontSize(9).fillColor('#555555').text(String(i + 1), 0, doc.page.height - 40, { width: doc.page.width, align: 'center' });
  doc.page.margins.bottom = bottom;
}
doc.end();
console.log(`wrote ${out}: ${range.count} pages, ${chapters.length} chapters`);
