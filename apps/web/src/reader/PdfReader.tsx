import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  type BookProgress,
  type CommentView,
  type PdfLocator,
  type Reaction,
  chapterIndexAt,
  chapterHeading,
  chapterLabel,
  formatPercent,
  rangesCoverage,
} from '@bookclub/shared';
import { useClubCalContext } from '../cal/CalLauncher';
import { openCal } from '../cal/calStore';
import { ClubBar, barMembers } from '../components/ClubBar';
import { Icon } from '../components/Icon';
import { type MeetingReachedInfo, meetingReachedInfo } from '../components/Meeting';
import { MiniPlayer } from '../player/MiniPlayer';
import { useAudioControls } from '../player/audio-controls';
import { ListenHere } from '../player/ListenHere';
import { AlongStart, ReaderDock } from '../player/ReaderDock';
import { useReaderAudio } from './useReaderAudio';
import { editionCacheName, keepOffline, useEditionOffline } from '../lib/offline';
import { MARKER_TARGET, THEMES, type ThemeName } from './epub/layout';
import { loadSettings, saveSettings } from './settings';
import { useToast } from '../components/Toasts';
import { api, newClientId } from '../lib/api';
import { openedBehind, opensWords, readRangesOf, useOpenedBehind } from '../lib/further';
import { usePlacesOnPage } from '../lib/places';
import { useNoteOpener } from '../lib/note-opener';
import { openPdf, pdfjs } from '../lib/pdf';
import { keys, mergeComment, removeComment, useChatUnread } from '../lib/queries';
import { useClubPresence } from '../lib/realtime';
import { ChatSheet } from '../live/ChatSheet';
import { type ReaderProps } from './EpubReader';
import { type ChapterEndInfo, FinishedCard, LookChip, MarkerSheet, NoteComposer, SelectionMenu, StopOrChapterEndCard, TocPanel, chapterEndInfo, firstTimeAtEnd } from './panels';
import { commentLocatorIn, tOf, translatePlace } from './position';
import { useReadingReport } from './useReadingReport';
import { dialogOpen } from '../lib/dialog';
import { keptForLater } from '../lib/kept';
import { placesSavedHere, savedFromHere } from '../lib/saved-here';
import { newerSave, placeFromElsewhere } from './elsewhere';
import { type SeenPage, readPage, readRuns, turnIsReading } from './looks';

/** Locator of a comment inside this PDF edition (comments made in other formats are translated,
 * snapped past a chapter's very start as the reader's own saved place is, D93: position.ts). */
function pdfLocatorOf(book: ReaderProps['book'], edition: ReaderProps['edition'], c: CommentView): PdfLocator | null {
  const l = commentLocatorIn(book, edition, c);
  return l && l.kind === 'pdf' ? l : null;
}

/** A page read during a look (D72): where it lies among the PDF's pages, and its places. */
function pdfPage(page: number): SeenPage<PdfLocator> {
  return { start: page, end: page + 1, from: { kind: 'pdf', page, y: 0 }, to: { kind: 'pdf', page, y: 1 } };
}

/** The most pixels a page's canvas is given (iOS Safari refuses a canvas of more than 16,777,216). */
const MAX_CANVAS_PIXELS = 16_000_000;

/** Book pages from the PDF's own page count; chapters from its outline. */
export default function PdfReader({ book, edition, start, startSource, startAt = null, resume, resumeAt = null, comments, replies, selfId, members, along = null }: ReaderProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  // In state, not a ref: the page is drawn once the document is in, which must re-render.
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const taskRef = useRef<pdfjs.PDFDocumentLoadingTask | null>(null);
  const [page, setPage] = useState(start?.kind === 'pdf' ? start.page : 0);
  // The audiobook from here (D186): Play in the footer starts at this page unless the narrator is on it.
  const pageOnScreen = useMemo(
    () => ({ startT: tOf(edition, { kind: 'pdf', page, y: 0 }), endT: tOf(edition, { kind: 'pdf', page, y: 1 }), start: { kind: 'pdf' as const, page, y: 0 } }),
    [edition, page],
  );
  const readerAudio = useReaderAudio(book, edition, pageOnScreen, along, () => flush(true));
  // The audiobook's controls, unless hidden for this book or every book (D197); playing, never hidden.
  const audioControls = useAudioControls(book.id);
  const offerListen = !!readerAudio.audiobook && !audioControls.hidden;
  // Opened where you stopped in another format: said so (D186).
  // D198: no toast every time the PDF opens (routine resume).
  /** The drawn page's height in CSS pixels: notes closer than a marker is tall share one. */
  const [drawnHeight, setDrawnHeight] = useState(0);
  // Opened at a place inside a page (from another format, or another device's): it stays your
  // place, to the line, until you turn a page; opening is not moving it to the page's top.
  const openedAt = useRef(start?.kind === 'pdf' && startSource !== 'link' ? start : null);
  /**
   * Since when your place has been your place (D196): opened there, when the save it came from was
   * made; then when you turned to the page. The page you opened at, or came back to, is reported
   * with that time, so it never outranks a newer place saved since (the audiobook's, to the second).
   */
  const placeAt = useRef<number | null>(startSource === 'link' ? resumeAt : startAt);
  const [pageCount, setPageCount] = useState(edition.pageCount ?? 0);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState<{ locator: PdfLocator; quote: string | null } | null>(null);
  const [sheet, setSheet] = useState<string[] | null>(null);
  const [toc, setToc] = useState(false);
  // The club's chat and voice, opened over the book without leaving it (D173).
  const [chatOpen, setChatOpen] = useState(false);
  const chatUnread = useChatUnread(book.clubId);
  /** 1 fits the page to the screen; more is zoomed in (the page then pans, and taps do not turn it). */
  const [zoom, setZoom] = useState(1);
  // The reading themes, shared with the EPUB reader: the page itself is tinted to match.
  const [theme, setTheme] = useState<ThemeName>(() => loadSettings().theme);
  const chooseTheme = (next: ThemeName) => {
    setTheme(next);
    saveSettings({ ...loadSettings(), theme: next });
  };
  /** Zoom and theme live in one small panel, as the EPUB reader's settings do: a phone's header has room for four controls. */
  const [viewPanel, setViewPanel] = useState(false);
  const gesture = useRef<{ x: number; y: number; t: number } | null>(null);
  /** A passage selected on the page: its text, its height on the page and its box in the reading area. */
  const [selection, setSelection] = useState<{ text: string; y: number; rect: { left: number; top: number; width: number; height: number } } | null>(null);
  /** When a tap last turned the page: the click that follows it is not a tap on the new page. */
  const turnedAt = useRef(0);
  const presence = useClubPresence(book.clubId);
  // Ask Cal from the reader's own header (D170): no floating button here, where it would sit over
  // the page or the footer's controls.
  const cal = useClubCalContext();
  const { report: reportPage, flush } = useReadingReport(book, edition);
  /** The furthest this screen has counted as read, which the server may not have said back yet. */
  const readHere = useRef(0);
  const editionRef = useRef(edition);
  editionRef.current = edition;
  /** Report a page; a page read (not looked at) is the furthest read here until the server says more. */
  const report = useCallback<typeof reportPage>(
    (start, end, options = {}) => {
      if (!options.look) readHere.current = Math.max(readHere.current, tOf(editionRef.current, end));
      reportPage(start, end, options);
    },
    [reportPage],
  );
  // The moments of the EPUB reader: a chapter's end (what friends said in it) and the book's.
  const [endOfChapter, setEndOfChapter] = useState<ChapterEndInfo | null>(null);
  /** Just read past the club's next stop (D53), and who else is there. */
  const [atStop, setAtStop] = useState<MeetingReachedInfo | null>(null);
  const [finished, setFinished] = useState<{ finished: boolean; coverage: number } | null>(null);
  const checkEnd = useRef(false);
  // A look (a link followed, a note visited, a chapter from the contents) is not reading until
  // you turn a page there.
  const looking = useRef(startSource === 'link');
  const [returnTo, setReturnTo] = useState<number | null>(startSource === 'link' && resume?.kind === 'pdf' ? resume.page : null);
  /** Where you were reading when a look began, to the line: Back returns there, friends see it. */
  const lookFrom = useRef<PdfLocator | null>(null);
  /** The pages read during a look (each turned on from): read too once reading takes over (D72). */
  const lookRead = useRef<readonly SeenPage<PdfLocator>[]>([]);
  /** Reading just took over from a look (D72): the next report (the page-change effect below, for
      the page just turned to) sends at once rather than on the usual debounce, since a friend's
      note on one of the pages just folded in may be about to open. Flagged here, not sent as its
      own urgent report in `go()`, so the look's pages and the page just turned to go to the server
      together, in the one save the effect was already about to make — not as two racing ones. */
  const urgentNextReport = useRef(false);
  /** The furthest point you have read (D72), as the club and the server last said or read here; your place, if further. */
  const furthestRead = useCallback((): number => {
    const member = members.find((m) => m.userId === selfId)?.furthest ?? 0;
    const mine = qc.getQueryData<BookProgress>(keys.progress(book.id))?.mine?.furthest ?? 0;
    const place = returnTo === null ? 0 : tOf(edition, lookFrom.current ?? { kind: 'pdf', page: returnTo, y: 0 });
    return Math.max(member, mine, readHere.current, place);
  }, [members, selfId, qc, book.id, returnTo, edition]);
  // Your place moved on another device while this one stayed open (D70): it is your place here,
  // and the page in front of you a look, until you go there or choose to stay.
  const mineSaved = members.find((m) => m.userId === selfId);
  const knownSave = useRef(mineSaved?.updatedAt ?? null);
  const [elsewhere, setElsewhere] = useState(false);
  useEffect(() => {
    if (start?.kind === 'pdf') savedFromHere(book.id, tOf(edition, start));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!newerSave(mineSaved?.updatedAt, knownSave.current)) return;
    // The first saved place heard of is the one this reader opened with.
    const first = knownSave.current === null;
    knownSave.current = mineSaved!.updatedAt;
    if (first) return;
    const here = tOf(edition, openedAt.current?.page === page ? openedAt.current : { kind: 'pdf', page, y: 0 });
    const found = placeFromElsewhere(mineSaved, here, placesSavedHere(book.id));
    // At a chapter's start in another format, at its start here (D93).
    const there = found ? translatePlace(book, edition, { t: found.t, kind: mineSaved?.kind }) : null;
    if (!found || there?.kind !== 'pdf') return;
    looking.current = true;
    lookRead.current = [];
    lookFrom.current = there;
    setReturnTo(there.page);
    setElsewhere(true);
    toast.show(`You read on to ${found.label} on another device.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mineSaved?.updatedAt]);
  // A friend's note that opens behind the page in front of you, once you are surely past it (D63)
  // or have read as far as its writer had (D69), is told: nothing on the page would show it.
  const tellOpened = useCallback(
    (c: CommentView, was: 'near' | 'held') => {
      if (opensWords(c)) toast.show(openedBehind(c, was, book.chapters), { action: { label: 'Show', run: () => setSheet([c.id]) } });
    },
    [toast, book.chapters],
  );
  useOpenedBehind(comments, readRangesOf(qc, book.id), tellOpened);
  // A toast's "Show" for a note of this book opens its sheet here (D89).
  useNoteOpener(book.id, (id) => {
    if (!comments.some((c) => c.id === id)) return false;
    setSheet([id]);
    return true;
  });
  const look = (target: number) => {
    if (!looking.current) {
      looking.current = true;
      lookFrom.current = openedAt.current && openedAt.current.page === page ? openedAt.current : { kind: 'pdf', page, y: 0 };
      setReturnTo(page);
    }
    // A new look: nothing read in it yet.
    lookRead.current = [];
    setPage(target);
  };

  /** The downloaded file being put in the edition's cache, which keeping the book waits for. */
  const filePut = useRef<Promise<unknown>>(Promise.resolve());

  // Load the whole file once (cached for offline by the service worker).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(edition.fileUrl!, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`The PDF could not be loaded (${res.status}).`);
        // Keep what was just downloaded for offline reading, rather than fetching it again. The
        // copy is taken before the body is read below (a read body cannot be copied any more).
        if ('caches' in window) {
          const copy = res.clone();
          filePut.current = caches.open(editionCacheName(edition.id)).then((cache) => cache.put(edition.fileUrl!, copy)).catch(() => undefined);
        }
        const data = new Uint8Array(await res.arrayBuffer());
        // With the decoders a scan's pages need (D102): without them every page is drawn white.
        const task = openPdf(data);
        taskRef.current = task;
        const doc = await task.promise;
        if (cancelled) return void task.destroy();
        setDoc(doc);
        setPageCount(doc.numPages);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'The PDF could not be opened.');
      }
    })();
    return () => {
      cancelled = true;
      void taskRef.current?.destroy();
      taskRef.current = null;
      setDoc(null);
    };
  }, [edition.fileUrl, edition.id]);

  // Keep the book on this device for offline reading, as the EPUB reader does. The file itself is
  // kept as it downloads (above): once that is in, what is left is small (the file is not fetched
  // a second time).
  const opened = doc !== null;
  const [kept] = useEditionOffline(edition.id);
  useEffect(() => {
    if (opened) void filePut.current.then(() => keepOffline(book, edition, null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, book.id, edition.id]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Render the current page to fit the area, with its text layer for selection.
  useEffect(() => {
    const canvas = canvasRef.current;
    const textLayer = textRef.current;
    if (!doc || !canvas || !textLayer || !size || pageCount === 0) return;
    let cancelled = false;
    let task: pdfjs.RenderTask | null = null;
    let text: pdfjs.TextLayer | null = null;
    void (async () => {
      const p = await doc.getPage(page + 1);
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const scale = Math.min((size.w - 24) / base.width, (size.h - 16) / base.height) * zoom;
      const viewport = p.getViewport({ scale });
      // Sharp on a retina screen, but never past what iOS Safari draws (about 16.7 million pixels a
      // canvas): a page zoomed far in on an iPhone would otherwise draw blank.
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
      // Nothing of the page (or the scale) before stays selectable over the one being drawn.
      textLayer.replaceChildren();
      delete textLayer.dataset.ready;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      setDrawnHeight(Math.floor(viewport.height));
      const ctx = canvas.getContext('2d')!;
      task = p.render({ canvas, canvasContext: ctx, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      await task.promise.catch(() => undefined);
      if (cancelled) return;
      // pdf.js lays its text out in CSS pixels at the page's scale, zoom included (the canvas's
      // device pixel ratio only sharpens the drawing; pdf.js measures with the same ratio itself).
      // That scale is the one variable its stylesheet (the `.pdf-text` rules) needs from the page:
      // pdf.js sets the layer's size from it, and each line's font size and stretch.
      textLayer.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit));
      text = new pdfjs.TextLayer({ textContentSource: p.streamTextContent(), container: textLayer, viewport });
      const done = await text.render().then(
        () => true,
        () => false,
      );
      if (!done || cancelled) return;
      // The empty block selecting needs under the text (below), as pdf.js's viewer adds it.
      const end = document.createElement('div');
      end.className = 'endOfContent';
      textLayer.append(end);
      // All of the page's text is in, over its drawing.
      textLayer.dataset.ready = 'true';
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      text?.cancel();
    };
  }, [doc, page, size, pageCount, zoom]);

  // Selecting as in pdf.js's own viewer (its TextLayerBuilder): while a selection is being made,
  // the layer's empty `endOfContent` block covers the page under the text, so a pointer off the
  // words (past a line's end, between lines) does not carry the selection to the top or the
  // bottom of the page. WebKit needs the block right beside the selection's moving end too;
  // Firefox and Chromium 148 or later do not.
  useEffect(() => {
    const layer = textRef.current;
    if (!layer) return;
    const chromium = Number(/\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1] ?? 0);
    const follow = !/\bFirefox\//.test(navigator.userAgent) && chromium < 148;
    const endOf = () => layer.querySelector<HTMLElement>('.endOfContent');
    const reset = () => {
      const end = endOf();
      if (end) {
        layer.append(end);
        end.style.width = '';
        end.style.height = '';
      }
      layer.classList.remove('selecting');
    };
    let pointerDown = false;
    let previous: Range | null = null;
    const ac = new AbortController();
    const { signal } = ac;
    const released = () => {
      pointerDown = false;
      reset();
    };
    layer.addEventListener('mousedown', () => layer.classList.add('selecting'), { signal });
    document.addEventListener(
      'pointerdown',
      () => {
        pointerDown = true;
      },
      { signal },
    );
    document.addEventListener('pointerup', released, { signal });
    window.addEventListener('blur', released, { signal });
    document.addEventListener(
      'keyup',
      () => {
        if (!pointerDown) reset();
      },
      { signal },
    );
    document.addEventListener(
      'selectionchange',
      () => {
        const sel = document.getSelection();
        if (!sel || sel.rangeCount === 0) return reset();
        let active = false;
        for (let i = 0; i < sel.rangeCount; i++) active ||= sel.getRangeAt(i).intersectsNode(layer);
        if (active) layer.classList.add('selecting');
        else reset();
        if (!follow) return;
        const range = sel.getRangeAt(0);
        // The end that moved since the last change is the one the block goes beside.
        const atStart = previous !== null && (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0 || range.compareBoundaryPoints(Range.START_TO_END, previous) === 0);
        let anchor: Node | null = atStart ? range.startContainer : range.endContainer;
        if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
        if (!atStart && range.endOffset === 0) {
          // Ending at the very start of a node: beside the last node before it with content.
          do {
            while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
            anchor = anchor?.previousSibling ?? null;
          } while (anchor && !anchor.hasChildNodes());
        }
        const end = endOf();
        if (end && anchor?.parentElement?.closest('.pdf-text') === layer) {
          end.style.width = layer.style.width;
          end.style.height = layer.style.height;
          end.style.userSelect = 'text';
          anchor.parentElement.insertBefore(end, atStart ? anchor : anchor.nextSibling);
        }
        previous = range.cloneRange();
      },
      { signal },
    );
    return () => ac.abort();
  }, []);

  // Report the visible page (a whole page counts as read). During a look friends still see you
  // where you are reading.
  useEffect(() => {
    if (pageCount === 0) return;
    if (openedAt.current && openedAt.current.page !== page) openedAt.current = null;
    const reading =
      looking.current && returnTo !== null ? { place: lookFrom.current ?? { kind: 'pdf' as const, page: returnTo, y: 0 } } : openedAt.current ? { place: openedAt.current } : {};
    // A page turned to by reading is your place from now; one opened at, or come back to, since then.
    if (!looking.current && !openedAt.current) placeAt.current = Date.now();
    const urgent = urgentNextReport.current;
    urgentNextReport.current = false;
    report({ kind: 'pdf', page, y: 0 }, { kind: 'pdf', page, y: 1 }, { look: looking.current, urgent, ...reading, placeAt: placeAt.current });
    if (!checkEnd.current) return;
    checkEnd.current = false;
    void flush(true).then(() => {
      const mine = qc.getQueryData<BookProgress>(keys.progress(book.id))?.mine;
      if (firstTimeAtEnd(book.id, selfId, mine?.finished ?? false)) setFinished({ finished: mine?.finished ?? false, coverage: rangesCoverage(mine?.readRanges ?? []) });
    });
  }, [page, pageCount, report, flush, qc, book.id, selfId, returnTo]);

  const go = useCallback(
    (p: number) => {
      const target = Math.max(0, Math.min(pageCount - 1, p));
      // A look that reading on here ends: what was read in it counts as read now (D58, D72).
      let readInLook: readonly SeenPage<PdfLocator>[] = [];
      if (looking.current) {
        const forward = target === page + 1;
        // A page turned on from is a page read in the look.
        if (forward) lookRead.current = readPage(lookRead.current, pdfPage(page));
        // A look ends where reading takes over (D62, D72): past where you have read, only reading
        // on there for a few pages; ahead of your place otherwise, any turn; behind it, only
        // reading forward through it, so flipping back to find a passage keeps the look.
        const reading = turnIsReading({
          forward,
          from: { start: tOf(edition, { kind: 'pdf', page, y: 0 }), end: tOf(edition, { kind: 'pdf', page, y: 1 }) },
          furthest: furthestRead(),
          pagesRead: lookRead.current.length,
          place: returnTo === null ? null : { fromAhead: page > returnTo, toAhead: target > returnTo },
        });
        if (!reading) {
          setPage(target);
          return;
        }
        // Reading on from a look: the pages read in it were read too; sent at once, together with
        // the page just turned to below (urgentNextReport), rather than on the usual debounce — a
        // friend's note on any of those pages may be about to open, and turning pages right on
        // would otherwise keep deferring the save indefinitely.
        readInLook = lookRead.current;
        if (readInLook.length > 0) urgentNextReport.current = true;
        for (const run of readRuns(readInLook)) report(run.from, run.to, { place: { kind: 'pdf', page: target, y: 0 } });
      }
      looking.current = false;
      lookRead.current = [];
      setReturnTo(null);
      setElsewhere(false);
      const chapterOf = (n: number) => chapterIndexAt(book.chapters, tOf(edition, { kind: 'pdf', page: n, y: 0 }));
      if (target === page + 1) {
        const before = chapterOf(page);
        setEndOfChapter(before >= 0 && chapterOf(target) === before + 1 ? chapterEndInfo(book.chapters, before, comments, selfId, book.chapters[before]!.t, book.chapters[before + 1]!.t) : null);
        // Turning onto the page past the club's next stop, as in the EPUB reader: who is there.
        // Reading on from a look reads the pages read in it too.
        const stop = book.meeting;
        const endOf = (n: number) => tOf(edition, { kind: 'pdf', page: n, y: 1 });
        const readFrom = readInLook.length > 0 ? tOf(edition, readInLook[0]!.from) : endOf(page);
        setAtStop(stop && readFrom <= stop.t + 1e-6 && endOf(target) > stop.t + 1e-6 ? meetingReachedInfo(stop, members, selfId) : null);
        // Reading onto the story's last page: once it is saved, the server says if that finished it.
        if (endOf(target) >= 1 - 1e-9) checkEnd.current = true;
      } else {
        setEndOfChapter(null);
        setAtStop(null);
      }
      setPage(target);
    },
    [pageCount, page, book.chapters, book.meeting, members, edition, comments, selfId, report, returnTo, furthestRead],
  );

  /** Back from a look to the page you were reading. */
  const back = () => {
    if (returnTo === null) return;
    const to = returnTo;
    // Back to the very line: it stays your place until you turn a page.
    openedAt.current = lookFrom.current;
    lookFrom.current = null;
    looking.current = false;
    lookRead.current = [];
    setReturnTo(null);
    setElsewhere(false);
    setEndOfChapter(null);
    setAtStop(null);
    setPage(to);
  };

  /** Reading takes over from a look on the page in front of you: it is read, and what you read in the look (D72). */
  const readOnHere = (options: { urgent?: boolean } = {}) => {
    const here = { kind: 'pdf' as const, page, y: 0 };
    for (const run of readRuns(lookRead.current)) report(run.from, run.to, { place: here });
    lookRead.current = [];
    looking.current = false;
    setReturnTo(null);
    setElsewhere(false);
    report(here, { kind: 'pdf', page, y: 1 }, options);
  };

  /** During a look: make the page in front of you your place, and read it (and what you read in the look). */
  const readFromHere = () => readOnHere({ urgent: true });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (composer || sheet || toc || dialogOpen()) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(page + 1);
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(page - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, page, composer, sheet, toc]);

  useEffect(() => {
    const onSel = () => {
      const sel = document.getSelection();
      const layer = textRef.current;
      if (!sel || sel.isCollapsed || !layer || !sel.anchorNode || !layer.contains(sel.anchorNode)) return setSelection(null);
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const box = layer.getBoundingClientRect();
      // The menu is placed in the reading area, which scrolls when the page is zoomed in.
      const area = areaRef.current;
      const at = area?.getBoundingClientRect();
      const inArea = area && at ? { left: rect.left - at.left - area.clientLeft + area.scrollLeft, top: rect.top - at.top - area.clientTop + area.scrollTop, width: rect.width, height: rect.height } : { left: 0, top: 0, width: 0, height: 0 };
      setSelection({ text: sel.toString().replace(/\s+/g, ' ').trim(), y: Math.max(0, Math.min(1, (rect.top - box.top) / box.height)), rect: inArea });
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  const pageSpan = useMemo(() => ({ page }), [page]);
  const exactHere = usePlacesOnPage(book.id, edition.id, pageSpan, comments);
  const placed = useMemo(
    // A note ahead of you comes placed only roughly (D80): on the page in front of you, at the
    // place the server gives for it there; elsewhere it has no line to mark, the club bar shows it.
    () =>
      comments.flatMap((c) => {
        const here = c.hidden && c.approx ? exactHere.get(c.id) : undefined;
        if (c.hidden && c.approx && !here) return [];
        const l = pdfLocatorOf(book, edition, here ? { ...c, ...here } : c);
        return l !== null && l.page === page ? [{ c, l }] : [];
      }),
    [book, comments, edition, page, exactHere],
  );
  // Notes closer than a marker is tall share one, as in the EPUB reader: no two touch targets overlap.
  const markers = useMemo(() => {
    const out: { key: string; y: number; comments: CommentView[] }[] = [];
    for (const { c, l } of [...placed].sort((a, b) => a.l.y - b.l.y)) {
      const last = out[out.length - 1];
      if (last && (l.y - last.y) * drawnHeight < MARKER_TARGET) last.comments.push(c);
      else out.push({ key: c.id, y: l.y, comments: [c] });
    }
    return out;
  }, [placed, drawnHeight]);
  // Your place's percentage, as saved: the line it was opened at on this page, else the page's
  // top; the last page is the whole book.
  const t = page >= pageCount - 1 ? 1 : tOf(edition, openedAt.current?.page === page ? openedAt.current : { kind: 'pdf', page, y: 0 });
  const chapterUnits = edition.units;
  const chapterIndex = chapterUnits.reduce((acc, u, i) => (u.m <= page + 1e-9 ? i : acc), -1);
  const chapterStart = chapterIndex >= 0 ? Math.floor(chapterUnits[chapterIndex]!.m) : null;
  const chapterEnd = chapterIndex >= 0 ? Math.floor(chapterUnits[chapterIndex + 1]?.m ?? pageCount) : null;
  const barList = barMembers(book.id, members, presence).map((m) => (m.userId === selfId ? { ...m, t: tOf(edition, { kind: 'pdf', page, y: 0 }), live: true, kind: 'pdf' } : m));

  const create = async (input: { locator: PdfLocator; quote?: string | null; text?: string; reaction?: Reaction; clientId?: string; aboutHere?: boolean; mediaIds?: string[] }) => {
    // A note written during a look behind your place is pinned where you are looking, and your
    // place stays where you read; ahead of it, writing there is reading there.
    if (looking.current && (returnTo === null || page > returnTo)) readOnHere();
    const created = await api.createComment(book.id, {
      editionId: edition.id,
      locator: input.locator,
      ...(input.quote ? { quote: input.quote.slice(0, 600) } : {}),
      ...(input.text ? { text: input.text } : {}),
      ...(input.reaction ? { reaction: input.reaction } : {}),
      ...(input.mediaIds && input.mediaIds.length > 0 ? { mediaIds: input.mediaIds } : {}),
      clientId: input.clientId ?? newClientId(),
      ...(input.aboutHere ? { aboutHere: true } : {}),
    });
    mergeComment(qc, book.id, created);
  };


  // The footer's own parts, laid out by itself while reading and by the docked player in Both (D194).
  const prevButton = (
    <button type="button" className="icon-btn page-btn" aria-label="Previous page" onClick={() => go(page - 1)} disabled={page <= 0} data-testid="prev-page">
      <Icon name="back" size={20} />
    </button>
  );
  const nextButton = (
    <button type="button" className="icon-btn page-btn" aria-label="Next page" onClick={() => go(page + 1)} disabled={page >= pageCount - 1} data-testid="next-page">
      <Icon name="back" size={20} />
    </button>
  );
  const pageInfo = (
    <div className="page-info" aria-live="polite">
      <span data-testid="page-number" data-page={page + 1} data-total={pageCount}>
        Page {page + 1} of {pageCount || '…'}
      </span>
      {/* On a phone with the audiobook's controls in the footer, the page within the chapter
          makes way, its dot with it, as in the EPUB reader: the footer keeps to one line. */}
      {chapterStart !== null && chapterEnd !== null ? (
        <>
          <span className="page-sep page-sep-chapter" aria-hidden="true">
            ·
          </span>
          <span className="page-chapter" data-testid="chapter-page" data-page={page - chapterStart + 1} data-total={Math.max(1, chapterEnd - chapterStart)}>
            {page - chapterStart + 1} of {Math.max(1, chapterEnd - chapterStart)} in chapter
          </span>
        </>
      ) : null}
      <span className="page-sep" aria-hidden="true">
        ·
      </span>
      <span data-testid="percent" data-value={t.toFixed(6)}>
        {formatPercent(t)}
      </span>
    </div>
  );

  return (
    <div className="reader reader-pdf" data-testid="reader" data-page-index={page} data-offline={kept ? 'kept' : 'no'}>
      <header className="reader-header">
        <Link to={`/books/${book.id}`} className="icon-btn" aria-label={`Back to ${book.title}`}>
          <Icon name="back" />
        </Link>
        <div className="reader-title">
          <span className="reader-book">{book.title}</span>
          <span className="reader-chapter">{chapterIndex >= 0 ? chapterHeading(chapterUnits[chapterIndex]!.title) : chapterLabel(book.chapters, t)}</span>
        </div>
        <button type="button" className="icon-btn" aria-label="Contents" onClick={() => setToc(true)} data-testid="open-toc">
          <Icon name="toc" />
        </button>
        <button type="button" className="icon-btn" aria-label="Zoom and theme" aria-expanded={viewPanel} onClick={() => setViewPanel((v) => !v)} data-testid="pdf-view">
          <Icon name="type" />
        </button>
        <button type="button" className="icon-btn" aria-label="Leave a note on this page" onClick={() => setComposer({ locator: { kind: 'pdf', page, y: 0 }, quote: null })} data-testid="add-note">
          <Icon name="quill" />
        </button>
        <button type="button" className="icon-btn chat-sheet-btn" aria-label="Open the club's chat and voice" data-testid="open-chat-sheet" onClick={() => setChatOpen(true)}>
          <Icon name="comment" />
          {chatUnread.data && chatUnread.data.unread > 0 ? (
            <span className="badge" data-testid="chat-unread-badge">
              {chatUnread.data.unread}
            </span>
          ) : null}
        </button>
        {cal.enabled && cal.clubId ? (
          <button type="button" className="icon-btn" aria-label="Ask Cal" data-testid="cal-launcher" onClick={() => openCal(cal.clubId!, book.id)}>
            <Icon name="sparkle" />
          </button>
        ) : null}
        {viewPanel ? (
          <div className="pdf-view-panel" role="group" aria-label="Zoom and theme" data-testid="pdf-view-panel">
            <div className="zoom" role="group" aria-label="Zoom">
              <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} disabled={zoom <= 1} data-testid="zoom-out">
                −
              </button>
              <span className="small muted" aria-live="polite">
                {Math.round(zoom * 100)} %
              </span>
              <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3.375, z * 1.5))} disabled={zoom >= 3.375} data-testid="zoom-in">
                +
              </button>
            </div>
            <div className="pdf-themes" role="radiogroup" aria-label="Theme">
              {(Object.keys(THEMES) as ThemeName[]).map((name) => (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={theme === name}
                  className={`swatch-btn theme-${name}${theme === name ? ' is-on' : ''}`}
                  style={{ background: THEMES[name].bg, color: THEMES[name].text }}
                  onClick={() => chooseTheme(name)}
                  data-testid={`pdf-theme-${name}`}
                >
                  {THEMES[name].label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </header>
      {chatOpen ? <ChatSheet clubId={book.clubId} onClose={() => setChatOpen(false)} /> : null}
      <div className="reader-bar">
        <ClubBar
          readRanges={readRangesOf(qc, book.id)}
          bookId={book.id}
          members={barList}
          selfId={selfId}
          chapters={book.chapters}
          comments={comments}
          meeting={book.meeting}
          onComments={(cs) => {
            // As in the EPUB reader: one note you may read takes you to its page (a visit) and
            // opens it; notes ahead of you, or a group, open in the sheet without moving you.
            const only = cs.length === 1 ? cs[0]! : null;
            const l = only && !only.hidden ? pdfLocatorOf(book, edition, only) : null;
            if (l) look(l.page);
            setSheet(cs.map((c) => c.id));
          }}
        />
        {/* Over the club bar, not over the page. */}
        {returnTo !== null ? <LookChip label={`page ${returnTo + 1}`} elsewhere={elsewhere} onBack={back} onStay={readFromHere} /> : null}
      </div>
      <div
        className={`reader-area pdf-area${zoom > 1 ? ' is-zoomed' : ''}`}
        ref={areaRef}
        onPointerDown={(e) => {
          gesture.current = e.isPrimary ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
        }}
        onPointerCancel={() => {
          gesture.current = null;
        }}
        onPointerUp={(e) => {
          // Taps on the sides and swipes turn pages, as in the EPUB (not while zoomed in, when a
          // drag pans the page, nor while text is selected for a note).
          const d = gesture.current;
          gesture.current = null;
          if (!d || !e.isPrimary || zoom > 1 || document.getSelection()?.toString()) return;
          if ((e.target as Element).closest('button, a, .selection-menu')) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          const elapsed = Date.now() - d.t;
          if (elapsed < 700 && Math.abs(dx) > 50 && Math.abs(dy) < 60) {
            turnedAt.current = Date.now();
            return go(dx < 0 ? page + 1 : page - 1);
          }
          if (Math.abs(dx) > 10 || Math.abs(dy) > 10 || elapsed > 500) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const x = (e.clientX - rect.left) / rect.width;
          if (x > 0.7 || x < 0.3) {
            turnedAt.current = Date.now();
            go(x > 0.7 ? page + 1 : page - 1);
          }
        }}
        onClickCapture={(e) => {
          // The tap turned the page under the finger: its click must not open a friend's note
          // that the new page has at that spot.
          if (Date.now() - turnedAt.current < 600) {
            e.stopPropagation();
            e.preventDefault();
          }
        }}
      >
        {error ? (
          <p className="reader-error" role="alert">
            {error}
          </p>
        ) : null}
        {/* Reading along asked for, and the browser waiting for a tap (D194): one Play, over the page. */}
        {readerAudio.startTap ? <AlongStart where={chapterIndex >= 0 ? chapterHeading(chapterUnits[chapterIndex]!.title) : chapterLabel(book.chapters, t)} onPlay={readerAudio.play} /> : null}
        <div className={`pdf-page theme-${theme}`}>
          <canvas ref={canvasRef} aria-label={`Page ${page + 1} of ${pageCount}`} role="img" />
          <div ref={textRef} className="textLayer pdf-text" />
          {markers.map((m) => {
            const reactions = [...new Set(m.comments.map((c) => c.reaction).filter(Boolean))];
            const hidden = m.comments.every((c) => c.hidden);
            const who = [...new Set(m.comments.map((c) => (c.userId === selfId ? 'you' : c.authorName)))].join(', ');
            return (
              <button
                key={m.key}
                type="button"
                className={`margin-marker pdf-marker${hidden ? ' is-hidden' : ''}`}
                style={{ top: `${m.y * 100}%` }}
                data-testid="margin-marker"
                data-hidden={hidden ? 'true' : 'false'}
                aria-label={m.comments.length === 1 ? `Note from ${who}` : `${m.comments.length} notes here from ${who}`}
                onClick={() => setSheet(m.comments.map((c) => c.id))}
              >
                {reactions.length > 0 ? reactions.slice(0, 2).join('') : '💬'}
                {m.comments.length > 1 ? <span className="marker-count">{m.comments.length}</span> : null}
              </button>
            );
          })}
        </div>

        {selection && !composer ? (
          // The EPUB reader's menu, measured so that all of it stays on a phone's screen.
          <SelectionMenu
            rect={selection.rect}
            onReact={(r) => {
              void create({ locator: { kind: 'pdf', page, y: selection.y }, quote: selection.text, reaction: r })
                .then(() => toast.show(`${r} pinned here.`))
                .catch((err: unknown) => (keptForLater(err) ? toast.show(err.message) : toast.show(err instanceof Error ? err.message : 'Could not save the reaction.', 'error')));
              document.getSelection()?.removeAllRanges();
            }}
            onNote={() => setComposer({ locator: { kind: 'pdf', page, y: selection.y }, quote: selection.text })}
          />
        ) : null}
      </div>
      <footer className={`reader-footer${readerAudio.docked ? ' is-docked' : ''}`}>
        {/* Over the footer, never over the text of the new chapter. */}
        <StopOrChapterEndCard
          atStop={atStop}
          chapterEnd={endOfChapter}
          onShow={setSheet}
          onCloseStop={() => setAtStop(null)}
          onCloseChapterEnd={() => setEndOfChapter(null)}
        />
        {readerAudio.docked ? (
          <ReaderDock book={book} prev={prevButton} next={nextButton} info={pageInfo} onPlay={readerAudio.play} onStop={readerAudio.stop} onOpenPlayer={readerAudio.openPlayer} />
        ) : (
          <>
            {prevButton}
            {/* The book is the text (D197): the audiobook is played over it, from here. */}
            {offerListen ? <ListenHere onListen={readerAudio.listen} /> : null}
            {/* Another book's audiobook, still in the player: its controls, as before. */}
            <MiniPlayer footer onPlay={readerAudio.play} />
            {pageInfo}
            {nextButton}
          </>
        )}
      </footer>
      {toc ? (
        <TocPanel
          items={chapterUnits.map((u) => ({
            title: u.title,
            depth: 0,
            current: Math.floor(u.m) === chapterStart,
            ahead: u.m > page,
            pageLabel: String(Math.floor(u.m) + 1),
            // A chapter from the contents is a look until you read on there (D41).
            onSelect: () => look(Math.floor(u.m)),
          }))}
          onClose={() => setToc(false)}
        />
      ) : null}
      {composer ? (
        <NoteComposer
          bookId={book.id}
          target={{ quote: composer.quote, where: `page ${composer.locator.page + 1}`, upTo: tOf(edition, { kind: 'pdf', page: composer.locator.page, y: 1 }) }}
          chapters={book.chapters}
          furthest={furthestRead()}
          members={members}
          selfId={selfId}
          onClose={() => setComposer(null)}
          onSubmit={({ text, reaction, clientId, aboutHere, mediaIds }) =>
            create({ locator: composer.locator, quote: composer.quote, ...(text ? { text } : {}), ...(reaction ? { reaction } : {}), mediaIds, clientId, aboutHere })
              .catch((err: unknown) => {
                // Kept on the device with no network: done here, as far as the reader goes.
                if (!keptForLater(err)) throw err;
                toast.show(err.message);
              })
              .then(() => {
                document.getSelection()?.removeAllRanges();
                setSelection(null);
              })
          }
        />
      ) : null}
      {finished ? (
        <FinishedCard
          book={book}
          members={members}
          selfId={selfId}
          finished={finished.finished}
          coverage={finished.coverage}
          notesClosed={comments.filter((c) => c.hidden).length}
          onClose={() => setFinished(null)}
        />
      ) : null}
      {sheet ? (
        <MarkerSheet
          comments={comments.filter((c) => sheet.includes(c.id))}
          replies={replies}
          chapters={book.chapters}
          selfId={selfId}
          // During a look, opening a note is not reading there (D72): its locked notes offer it.
          {...(returnTo !== null ? { onReadHere: () => readFromHere() } : {})}
          onClose={() => setSheet(null)}
          onDelete={(c) =>
            void api
              .deleteComment(c.id)
              .then(() => removeComment(qc, book.id, c.id))
              .catch(() => toast.show('Could not delete the note.', 'error'))
          }
          onGo={(c) => {
            const l = pdfLocatorOf(book, edition, c);
            if (l) look(l.page);
            setSheet([c.id]);
          }}
        />
      ) : null}
    </div>
  );
}
