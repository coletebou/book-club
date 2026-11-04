/** pdf.js's resources, served by the app itself (apps/web/pdfjs-resources.ts). */
declare module 'virtual:pdfjs-resources' {
  /** Where they are: `/assets/pdfjs-<version>/`. */
  export const PDFJS_BASE: string;
  /** Each file pdf.js may fetch, as `<folder>/<name>` ("wasm/openjpeg.wasm"). */
  export const PDFJS_FILES: readonly string[];
}
