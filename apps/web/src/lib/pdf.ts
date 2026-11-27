import * as pdfjs from 'pdfjs-dist';
import { pdfjsBase } from './pdf-resources';
import { PDFJS_WORKER_URL } from './pdf-worker';

pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

export { pdfjs };

/**
 * Open a PDF's bytes with pdf.js, given everything it needs to draw any page the server's pdf.js
 * draws (D102): the JPEG 2000 and JBIG2 decoders scanned books are made of (archive.org's, Google
 * Books'), the colour profiles, the standard fonts a PDF may name without embedding them and the
 * character maps of CJK fonts, all from the app itself (lib/pdf-resources.ts). Without them pdf.js
 * draws a scan's every page white. The upload form and the reader both open PDFs here.
 */
export function openPdf(data: Uint8Array): pdfjs.PDFDocumentLoadingTask {
  const base = pdfjsBase();
  return pdfjs.getDocument({
    data,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    standardFontDataUrl: `${base}standard_fonts/`,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
  });
}
