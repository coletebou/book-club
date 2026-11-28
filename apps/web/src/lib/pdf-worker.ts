import { version } from 'pdfjs-dist/package.json';

export const PDFJS_BASE = `/assets/pdfjs-${version}/`;
export const PDFJS_WORKER_FILE = 'build/pdf.worker.min.mjs';
export const PDFJS_WORKER_URL = `${PDFJS_BASE}${PDFJS_WORKER_FILE}`;
