import pdfjsPackage from 'pdfjs-dist/package.json' with { type: 'json' };

export const PDFJS_BASE = `/assets/pdfjs-${pdfjsPackage.version}/`;
export const PDFJS_MODULE_FILE = 'build/pdf.min.mjs';
export const PDFJS_WORKER_FILE = 'build/pdf.worker.min.mjs';
export const PDFJS_MODULE_URL = `${PDFJS_BASE}${PDFJS_MODULE_FILE}`;
export const PDFJS_WORKER_URL = `${PDFJS_BASE}${PDFJS_WORKER_FILE}`;
