import { type PageGeometry, type ReaderSettings, pageAtX, pagesFromWidth, readerCss } from './layout';
import { type TextIndex, buildTextIndex, pointAt, rangeFor } from './text';

/**
 * One section of an EPUB laid out as pages. Used twice with identical styles: the visible frame
 * the reader sees, and a hidden frame that measures every section for book-wide page numbers.
 * Because both use the same geometry, the same CSS and `html { width: page width }` (so the
 * layout never depends on the iframe's own width), they produce the same pages.
 */
export class SectionFrame {
  readonly iframe: HTMLIFrameElement;
  doc: Document | null = null;
  index: TextIndex | null = null;
  url: string | null = null;
  pages = 1;
  private geometry: PageGeometry | null = null;
  private loadToken = 0;
  /** Settles a load still under way when the frame goes away. */
  private abandon: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly visible: boolean,
  ) {
    const iframe = document.createElement('iframe');
    // Both frames are sandboxed the same way: allow-scripts lets the app's own listeners fire in
    // WebKit (D27), and without it WebKit cannot load a section into the frame from the service
    // worker (an offline book counted its pages forever). The section's CSP still forbids every
    // script in it.
    iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    iframe.setAttribute('scrolling', 'no');
    iframe.setAttribute('tabindex', visible ? '0' : '-1');
    iframe.className = visible ? 'epub-frame' : 'epub-measure';
    if (!visible) {
      iframe.setAttribute('aria-hidden', 'true');
      iframe.title = 'Pagination';
    }
    parent.appendChild(iframe);
    this.iframe = iframe;
  }

  /**
   * Load a section document (from its server URL, so its CSP applies). A frame fires `load` for
   * an error answer too (a 401's JSON, the service worker's empty 504 when offline), so the
   * document must be the section itself: served as XHTML, with text when the section has text.
   */
  load(url: string, title: string, textLength?: number): Promise<Document> {
    const token = ++this.loadToken;
    this.iframe.title = this.visible ? title : 'Pagination';
    return new Promise((resolve, reject) => {
      const onLoad = () => {
        cleanup();
        if (token !== this.loadToken) return reject(new Error('superseded'));
        const doc = this.iframe.contentDocument;
        if (!doc || !doc.documentElement) return reject(new Error('The section could not be opened.'));
        if (doc.documentElement.nodeName.toLowerCase() === 'parsererror' || doc.getElementsByTagName('parsererror').length > 0) {
          return reject(new Error('The section is not valid XHTML.'));
        }
        const index = buildTextIndex(doc);
        if (doc.contentType !== 'application/xhtml+xml' || (textLength !== undefined && textLength > 0 && index.length === 0)) {
          return reject(new Error('This part of the book could not be loaded. Check the connection and try again.'));
        }
        this.doc = doc;
        this.url = url;
        this.index = index;
        resolve(doc);
      };
      const onError = () => {
        cleanup();
        reject(new Error('The section could not be loaded.'));
      };
      const cleanup = () => {
        this.abandon = null;
        this.iframe.removeEventListener('load', onLoad);
        this.iframe.removeEventListener('error', onError);
      };
      this.abandon?.();
      this.abandon = () => {
        cleanup();
        reject(new Error('superseded'));
      };
      this.iframe.addEventListener('load', onLoad);
      this.iframe.addEventListener('error', onError);
      this.iframe.src = url;
    });
  }

  /**
   * Apply geometry and settings, then count pages. Async since D122: the stylesheet just
   * written may ask this section's text for a self-hosted font (EB Garamond) it has never
   * rendered before, which `font-display: swap` shows a fallback for until it loads — were
   * `scrollWidth` read before that swap, two measurements of the same page (e.g. before and
   * after a reload, D86's numbering tests) could land on different character boundaries
   * depending only on how far the font download had got. Awaiting `doc.fonts.ready` (already
   * resolved, almost always, once the font is cached after the first section) makes the
   * measurement wait for the font this stylesheet asked for, not the one it is still showing.
   */
  async layout(g: PageGeometry, s: ReaderSettings): Promise<number> {
    const doc = this.doc;
    if (!doc) return 1;
    this.geometry = g;
    let style = doc.getElementById('bc-reader-style') as HTMLStyleElement | null;
    if (!style) {
      style = doc.createElement('style');
      style.id = 'bc-reader-style';
      (doc.head ?? doc.documentElement).appendChild(style);
    }
    style.textContent = readerCss(g, s);
    this.iframe.style.height = `${g.height}px`;
    // Measure with a one-page-wide viewport; the layout itself is fixed by html's width.
    this.iframe.style.width = `${g.width}px`;
    try {
      await doc.fonts?.ready;
    } catch {
      // Font loading failed outright: measure with whatever is actually painted.
    }
    if (doc !== this.doc) return this.pages; // superseded while waiting
    const total = doc.documentElement.scrollWidth;
    this.pages = pagesFromWidth(total, g);
    if (this.visible) this.iframe.style.width = `${this.pages * (g.width + g.gap)}px`;
    return this.pages;
  }

  /** x of the character at an offset, or null when it has no box (collapsed whitespace). */
  private xOf(offset: number): number | null {
    const doc = this.doc;
    const index = this.index;
    if (!doc || !index) return null;
    const point = pointAt(index, offset);
    if (!point) return null;
    const range = doc.createRange();
    const end = Math.min(point.node.data.length, point.offset + 1);
    if (end === point.offset) return null;
    range.setStart(point.node, point.offset);
    range.setEnd(point.node, end);
    const rects = range.getClientRects();
    const rect = rects[0];
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return rect.left + Math.min(rect.width, 4) / 2;
  }

  /** Page holding a text offset: the first character at or after it that has a box. */
  pageOfOffset(offset: number): number {
    const index = this.index;
    const g = this.geometry;
    if (!index || !g || index.length === 0) return 0;
    const limit = Math.min(index.length, offset + 400);
    for (let o = Math.max(0, offset); o < limit; o++) {
      const x = this.xOf(o);
      if (x !== null) return Math.min(this.pages - 1, pageAtX(x, g));
    }
    // Nothing visible after the offset (end of section): look backwards.
    for (let o = Math.min(offset, index.length - 1); o >= Math.max(0, offset - 400); o--) {
      const x = this.xOf(o);
      if (x !== null) return Math.min(this.pages - 1, pageAtX(x, g));
    }
    return 0;
  }

  /** First text offset on page p (binary search: pages grow with offsets). */
  pageStart(p: number): number {
    const index = this.index;
    if (!index || p <= 0) return 0;
    if (p >= this.pages) return index.length;
    let lo = 0;
    let hi = index.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.pageOfOffset(mid) >= p) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /** [start, end) offsets visible on page p. */
  pageRange(p: number): [number, number] {
    return [this.pageStart(p), p + 1 >= this.pages ? (this.index?.length ?? 0) : this.pageStart(p + 1)];
  }

  /** Client rects of a text range, in the section's coordinate space. */
  rects(start: number, end: number): DOMRect[] {
    if (!this.doc || !this.index) return [];
    const range = rangeFor(this.doc, this.index, start, Math.max(start + 1, end));
    return range ? [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0) : [];
  }

  /** Text offset of an element id (TOC fragments, internal links). */
  offsetOfId(id: string): number | null {
    const doc = this.doc;
    if (!doc) return null;
    const el = doc.getElementById(id);
    if (!el || !doc.body) return null;
    const range = doc.createRange();
    range.setStart(doc.body, 0);
    range.setEndBefore(el);
    return range.toString().length;
  }

  destroy(): void {
    this.loadToken++;
    this.abandon?.();
    this.iframe.remove();
    this.doc = null;
    this.index = null;
  }
}
