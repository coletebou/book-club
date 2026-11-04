import type { EpubLocator, Publication } from '@bookclub/shared';
import { SectionFrame } from './frame';
import { type PageGeometry, type ReaderSettings } from './layout';
import { offsetOfPoint, textBetween } from './text';
import { dialogOpen } from '../../lib/dialog';

export interface Relocation {
  readonly section: number;
  /** Zero-based page inside the section. */
  readonly page: number;
  readonly pages: number;
  readonly start: EpubLocator;
  /** Exclusive end: the first character of the next page. */
  readonly end: EpubLocator;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  /**
   * How we got here: page turns are reading; a jump (contents, a link in the book) moves you; a
   * look (going to a friend's note) is a visit you may come back from; following the audiobook
   * (reading along) turns pages with the narrator.
   */
  readonly via: 'open' | 'next' | 'prev' | 'jump' | 'look' | 'relayout' | 'follow';
}

export interface SelectionInfo {
  readonly start: EpubLocator;
  readonly end: EpubLocator;
  readonly text: string;
  /** Selection box in the reading area's coordinates. */
  readonly rect: { left: number; top: number; width: number; height: number };
}

export interface ViewCallbacks {
  onRelocate(r: Relocation): void;
  onSelection(s: SelectionInfo | null): void;
  onTap(zone: 'prev' | 'next' | 'center'): void;
  onExternalLink(href: string): void;
  onError(err: Error): void;
}

/**
 * The paginated EPUB view: one section at a time in a sandboxed iframe as wide as all of its
 * columns, moved sideways one page width at a time inside a clipping viewport.
 */
export class EpubView {
  readonly frame: SectionFrame;
  private section = -1;
  private page = 0;
  /**
   * The character relayouts keep on screen: where the reader last went (the place asked for when
   * opening or going somewhere, else the first character of the page turned to).
   */
  private anchor = 0;
  private busy: Promise<void> = Promise.resolve();
  private detach: (() => void) | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  /**
   * A page-to-page slide (`position(true)`, D183) is in flight: both the page sliding out and the
   * one sliding in are visibly on screen, so a tap landing now may hit a link only passing under
   * the finger (a footnote, a chapter link, placed anywhere a page's columns meet) rather than
   * whichever page the gesture meant to act on. While it is, `attach()` reads a tap as a page-turn
   * tap regardless of what is under it, and its own click listener blocks that link's navigation;
   * `transitionend` clears it once the page settles, a timeout covers a transition that never
   * plays (reduced motion) or never fires it (interrupted by another `position()` first).
   */
  private turning = false;
  private turningTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onTrackTransitionEnd = (e: TransitionEvent): void => {
    if (e.target !== this.track || e.propertyName !== 'transform') return;
    this.turning = false;
    if (this.turningTimer) {
      clearTimeout(this.turningTimer);
      this.turningTimer = null;
    }
  };

  constructor(
    private readonly track: HTMLElement,
    private readonly publication: Publication,
    private geometry: PageGeometry,
    private settings: ReaderSettings,
    private readonly callbacks: ViewCallbacks,
  ) {
    this.frame = new SectionFrame(track, true);
    this.track.addEventListener('transitionend', this.onTrackTransitionEnd);
  }

  get currentSection(): number {
    return this.section;
  }

  get currentPage(): number {
    return this.page;
  }

  sectionUrl(index: number): string {
    const s = this.publication.sections[index]!;
    return `${this.publication.baseUrl}${s.href.split('/').map(encodeURIComponent).join('/')}`;
  }

  private sectionTitle(index: number): string {
    const toc = [...this.publication.toc].reverse().find((e) => e.section <= index && e.chapter !== false);
    return toc ? `Book text: ${toc.chapterTitle ?? toc.title}` : 'Book text';
  }

  /** Serialise navigation so rapid taps never interleave section loads. */
  private run(task: () => Promise<void>): Promise<void> {
    this.busy = this.busy.then(task).catch((err: unknown) => {
      if (err instanceof Error && err.message === 'superseded') return;
      this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    });
    return this.busy;
  }

  private async loadSection(index: number): Promise<void> {
    if (index === this.section && this.frame.doc) return;
    this.detach?.();
    await this.frame.load(this.sectionUrl(index), this.sectionTitle(index), this.publication.sections[index]?.textLength);
    this.section = index;
    await this.frame.layout(this.geometry, this.settings);
    this.attach();
  }

  private position(animate: boolean): void {
    const g = this.geometry;
    this.track.style.transition = animate ? 'transform 180ms ease-out' : 'none';
    this.track.style.transform = `translate3d(${-this.page * (g.width + g.gap)}px, 0, 0)`;
    if (this.turningTimer) {
      clearTimeout(this.turningTimer);
      this.turningTimer = null;
    }
    this.turning = animate;
    // `transitionend` (above) clears this the moment the slide settles; longer than the 180ms it
    // declares, in case a style recalculation delays the event itself rather than the motion.
    if (animate) this.turningTimer = setTimeout(() => (this.turning = false), 260);
  }

  private relocation(via: Relocation['via']): Relocation {
    const [start, end] = this.frame.pageRange(this.page);
    const last = this.publication.sections.length - 1;
    return {
      section: this.section,
      page: this.page,
      pages: this.frame.pages,
      start: { kind: 'epub', section: this.section, offset: start },
      end: { kind: 'epub', section: this.section, offset: end },
      atStart: this.section <= 0 && this.page === 0,
      atEnd: this.section >= last && this.page >= this.frame.pages - 1,
      via,
    };
  }

  private emit(via: Relocation['via'], animate = false, anchor?: number): void {
    this.position(animate);
    const r = this.relocation(via);
    if (via !== 'relayout') this.anchor = anchor ?? r.start.offset;
    if (!this.destroyed) this.callbacks.onRelocate(r);
  }

  display(locator: { section: number; offset: number }, via: Relocation['via'] = 'jump'): Promise<void> {
    return this.run(async () => {
      const section = Math.max(0, Math.min(locator.section, this.publication.sections.length - 1));
      await this.loadSection(section);
      this.page = this.frame.pageOfOffset(locator.offset);
      // A saved place opened at another size keeps that character, not the page's first, so
      // changing the size back returns to the page it was on.
      this.emit(via, false, locator.offset);
    });
  }

  /** Go to an href inside the publication (TOC entries, internal links). */
  displayHref(href: string): Promise<void> {
    const [path, fragment] = href.split('#');
    const index = this.publication.sections.findIndex((s) => s.href === path);
    if (index === -1) return Promise.resolve();
    return this.run(async () => {
      await this.loadSection(index);
      const offset = fragment ? (this.frame.offsetOfId(fragment) ?? 0) : 0;
      this.page = this.frame.pageOfOffset(offset);
      this.emit('jump', false, offset);
    });
  }

  next(): Promise<void> {
    return this.run(async () => {
      if (this.page < this.frame.pages - 1) {
        this.page++;
        this.emit('next', true);
        return;
      }
      if (this.section >= this.publication.sections.length - 1) return;
      await this.loadSection(this.section + 1);
      this.page = 0;
      this.emit('next');
    });
  }

  prev(): Promise<void> {
    return this.run(async () => {
      if (this.page > 0) {
        this.page--;
        this.emit('prev', true);
        return;
      }
      if (this.section <= 0) return;
      await this.loadSection(this.section - 1);
      this.page = this.frame.pages - 1;
      this.emit('prev');
    });
  }

  /** New settings or screen size: re-paginate and keep the first visible character on screen. */
  relayout(geometry: PageGeometry, settings: ReaderSettings): Promise<void> {
    return this.run(async () => {
      if (!this.frame.doc) {
        this.geometry = geometry;
        this.settings = settings;
        return;
      }
      this.geometry = geometry;
      this.settings = settings;
      await this.frame.layout(geometry, settings);
      // Not the current page start: toggling sizes back and forth must not drift backwards.
      this.page = this.frame.pageOfOffset(this.anchor);
      this.emit('relayout');
    });
  }

  /** Rects of a range in the current section (overlay drawing). */
  rects(start: number, end: number): DOMRect[] {
    return this.frame.rects(start, end);
  }

  pageOfOffset(offset: number): number {
    return this.frame.pageOfOffset(offset);
  }

  clearSelection(): void {
    this.frame.doc?.getSelection()?.removeAllRanges();
  }

  private attach(): void {
    const doc = this.frame.doc;
    if (!doc) return;
    const g = () => this.geometry;
    let down: { x: number; y: number; t: number } | null = null;
    // A tap or swipe handled from pointer events: the click that may follow is the same gesture.
    let handledUntil = 0;
    // Where on the visible page a tap landed, measured on screen: `clientX` (the iframe's own
    // coordinates) and the iframe's rect are both read here, in the same tick the pointer event
    // carries them in, so together they still reconstruct the tap's real on-screen position
    // correctly mid-slide (D183) — rect and event agree on the same animation instant either way.
    // What is NOT safe mid-slide is trusting what the tap landed on (onPointerUp, below): both the
    // page leaving and the one arriving are visibly on screen then, so a link from either can be
    // under the finger a moment before its own page is the one settled on screen.
    const tap = (clientX: number) => {
      const geom = g();
      const viewport = (this.track.parentElement ?? this.track).getBoundingClientRect();
      const x = this.frame.iframe.getBoundingClientRect().left + clientX - viewport.left - geom.left;
      this.callbacks.onTap(x < geom.width * 0.3 ? 'prev' : x > geom.width * 0.7 ? 'next' : 'center');
    };
    const inLink = (target: EventTarget | null) => !!(target as Element | null)?.closest?.('a[href]');
    const onPointerDown = (e: PointerEvent) => {
      down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!down || !e.isPrimary) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      const elapsed = Date.now() - down.t;
      down = null;
      if (doc.getSelection()?.toString()) return;
      if (elapsed < 700 && Math.abs(dx) > 50 && Math.abs(dy) < 60) {
        if (dx < 0) void this.next();
        else void this.prev();
        handledUntil = Date.now() + 600;
        return;
      }
      // A tap. WebKit sends no click for a tap on plain text in a frame, so taps are read from
      // pointer events here; links are left to their click — except while a turn is still
      // sliding (D183), where whatever is under the finger is only passing through, and the tap
      // is read as the page-turn it is; the capture-phase click listener below blocks that link's
      // navigation if one follows anyway.
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && elapsed < 500 && e.button === 0 && (this.turning || !inLink(e.target))) {
        handledUntil = Date.now() + 600;
        tap(e.clientX);
      }
    };
    const onPointerCancel = () => {
      down = null;
    };
    // Ahead of onClick (same phase would do; capture makes the intent explicit): a link's own
    // click, reached while its page is still sliding in or out, never navigates (D183) — onPointerUp
    // has already read the same tap as a page turn above.
    const onClickCapture = (e: MouseEvent) => {
      if (this.turning && inLink(e.target)) e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const link = target?.closest?.('a[href]');
      if (link) {
        e.preventDefault();
        // The same gesture already read as a tap above (onPointerUp), turning or not: never
        // navigate for it — covers it even where `turning` itself has already cleared by now
        // (onClickCapture's own check above is the one racing the transition's end, not this one).
        if (Date.now() < handledUntil) return;
        const href = link.getAttribute('href') ?? '';
        if (/^(https?:|mailto:)/i.test(href)) this.callbacks.onExternalLink(href);
        else {
          const base = this.publication.sections[this.section]!.href;
          const resolved = new URL(href, `https://book/${base}`);
          const path = decodeURIComponent(resolved.pathname.slice(1));
          void this.displayHref(resolved.hash ? `${path}${resolved.hash}` : path);
        }
        return;
      }
      if (Date.now() < handledUntil || doc.getSelection()?.toString()) return;
      // A click without a pointer gesture before it (assistive technology, a keyboard).
      tap(e.clientX);
    };
    const onKey = (e: KeyboardEvent) => handleKey(e, this);
    const onSelectionChange = () => {
      if (this.selectionTimer) clearTimeout(this.selectionTimer);
      this.selectionTimer = setTimeout(() => this.reportSelection(), 180);
    };
    doc.addEventListener('pointerdown', onPointerDown);
    doc.addEventListener('pointerup', onPointerUp);
    doc.addEventListener('pointercancel', onPointerCancel);
    doc.addEventListener('click', onClickCapture, true);
    doc.addEventListener('click', onClick);
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('selectionchange', onSelectionChange);
    this.detach = () => {
      doc.removeEventListener('pointerdown', onPointerDown);
      doc.removeEventListener('pointerup', onPointerUp);
      doc.removeEventListener('pointercancel', onPointerCancel);
      doc.removeEventListener('click', onClickCapture, true);
      doc.removeEventListener('click', onClick);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('selectionchange', onSelectionChange);
    };
  }

  private reportSelection(): void {
    const doc = this.frame.doc;
    const index = this.frame.index;
    const sel = doc?.getSelection();
    if (!doc || !index || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
      this.callbacks.onSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const start = offsetOfPoint(doc, range.startContainer, range.startOffset);
    const end = offsetOfPoint(doc, range.endContainer, range.endOffset);
    if (end <= start) {
      this.callbacks.onSelection(null);
      return;
    }
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    const first = rects[0];
    const last = rects[rects.length - 1] ?? first;
    if (!first || !last) {
      this.callbacks.onSelection(null);
      return;
    }
    const g = this.geometry;
    const shift = this.page * (g.width + g.gap) - g.left;
    const top = Math.min(first.top, last.top);
    this.callbacks.onSelection({
      start: { kind: 'epub', section: this.section, offset: start },
      end: { kind: 'epub', section: this.section, offset: end },
      text: textBetween(index, start, end).replace(/\s+/g, ' ').trim(),
      rect: { left: first.left - shift, top, width: Math.max(...rects.map((r) => r.right)) - first.left, height: last.bottom - top },
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.detach?.();
    this.track.removeEventListener('transitionend', this.onTrackTransitionEnd);
    if (this.turningTimer) clearTimeout(this.turningTimer);
    this.frame.destroy();
  }
}

export function handleKey(e: KeyboardEvent, view: Pick<EpubView, 'next' | 'prev'>): void {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || dialogOpen()) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) {
    e.preventDefault();
    void view.next();
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) {
    e.preventDefault();
    void view.prev();
  }
}
