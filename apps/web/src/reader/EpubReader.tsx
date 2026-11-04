import { useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  type BookDetail,
  type Chapter,
  type BookProgress,
  type CommentView,
  type Edition,
  type EpubLocator,
  type Locator,
  type MemberProgress,
  type Publication,
  type Reaction,
  chapterIndexAt,
  beforeStory,
  divisionAt,
  beforeStoryName,
  chapterHeading,
  chapterLabel,
  chapterNameAt,
  formatPercent,
  locatorToM,
  mToLocator,
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
import { useAudioState } from '../player/AudioProvider';
import { type Narration, followTarget, narrationAt, offsetNow, onPage, sentencesOf } from './readalong';
import { useToast } from '../components/Toasts';
import { api, newClientId } from '../lib/api';
import { openedBehind, opensWords, readRangesOf, useOpenedBehind } from '../lib/further';
import { contentsAfterStory, currentEntry, listedContents } from './epub/contents';
import { usePlacesOnPage } from '../lib/places';
import { useNoteOpener } from '../lib/note-opener';
import { flushOutbox } from '../lib/outbox';
import { keepOffline, useEditionOffline } from '../lib/offline';
import { keys, mergeComment, mergeRevealed, removeComment, useChatUnread, useReadAlong } from '../lib/queries';
import { useClubPresence } from '../lib/realtime';
import { ChatSheet } from '../live/ChatSheet';
import { MARKER_TARGET, type PageGeometry, type ReaderSettings, THEMES, layoutSignature, pageGeometry } from './epub/layout';
import { type BookPage, type PageCounts, PageCounter, bookPage, tocPageNumbers } from './epub/pagecount';
import { type Relocation, type SelectionInfo, EpubView, handleKey } from './epub/view';
import { type ChapterEndInfo, type ComposerTarget, FinishedCard, LookChip, MarkerSheet, NoteComposer, SelectionMenu, SettingsPanel, StopOrChapterEndCard, TocPanel, chapterEndInfo, firstTimeAtEnd } from './panels';
import { commentLocatorIn, tOf, translatePlace } from './position';
import { loadSettings, saveSettings } from './settings';
import { useReadingReport } from './useReadingReport';
import { newerSave, placeFromElsewhere } from './elsewhere';
import { placesSavedHere, savedFromHere } from '../lib/saved-here';
import { keptForLater } from '../lib/kept';
import { type SeenPage, pastWhereRead, readPage, readRuns, turnIsReading } from './looks';

/** How much of the passage you stopped at is marked when you open the book there (D186): about a sentence. */
const LANDING_CHARS = 160;

/**
 * The time of a place the reader keeps for the narrator (D196): the oldest there is. It is the
 * player's place, said in this text; the player saves its own, to the millisecond, and a page
 * reported meanwhile (a note on it about to open, the page laid out again) must never outrank it.
 */
const NARRATED_AT = 1;

export interface ReaderProps {
  readonly book: BookDetail;
  readonly edition: Edition;
  readonly start: Locator | null;
  readonly startSource: string;
  /** When the place it opens at was saved (StartPosition.at): what reporting it says (D196). */
  readonly startAt?: number | null;
  /** Opened at a link: where you were reading, to come back to. */
  readonly resume: Locator | null;
  /** When that place to come back to was saved. */
  readonly resumeAt?: number | null;
  /** The book's notes (what has a place); `replies` holds the conversation under each (D48). */
  readonly comments: readonly CommentView[];
  readonly replies: ReadonlyMap<string, CommentView[]>;
  readonly selfId: string | undefined;
  readonly members: readonly MemberProgress[];
  readonly openCommentId: string | null;
  /** Reading along, opened from the book page (D187): the audiobook to load at this page. */
  readonly along?: string | null;
}

/**
 * How far a page is, as a percentage: where it starts, as your place and your marker say, except
 * the page the story ends on, which is the whole book.
 */
export function pagePercentT(start: number, end: number): number {
  return end >= 1 - 1e-9 ? 1 : start;
}

/** A page as the footer names it: the chapter it starts in, and how far it is. */
function placeLabel(chapters: readonly Chapter[], start: number, end: number): string {
  const name = chapterNameAt(chapters, start);
  const percent = formatPercent(pagePercentT(start, end));
  return name ? `${name} · ${percent}` : percent;
}

interface Marker {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly comments: CommentView[];
}

/** Locator of a comment inside this EPUB edition (comments made in other formats are translated,
 * snapped past a chapter's very start as the reader's own saved place is, D93: position.ts). */
function epubLocatorOf(book: BookDetail, edition: Edition, c: CommentView): EpubLocator | null {
  const l = commentLocatorIn(book, edition, c);
  return l && l.kind === 'epub' ? l : null;
}

/** A page read during a look (D72): where it lies among the book's characters, and its places. */
function seenPage(publication: Publication, r: Relocation): SeenPage<EpubLocator> {
  const geometry = { kind: 'epub' as const, sectionLengths: publication.sections.map((s) => s.textLength) };
  return { start: locatorToM(geometry, r.start), end: locatorToM(geometry, r.end), from: r.start, to: r.end };
}

export function EpubReader({ book, edition, publication, start, startSource, startAt = null, resume, resumeAt = null, comments, replies, selfId, members, openCommentId, along = null }: ReaderProps & { publication: Publication }) {
  const qc = useQueryClient();
  const toast = useToast();
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EpubView | null>(null);
  const counterRef = useRef<PageCounter | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(() => loadSettings());
  const [geometry, setGeometry] = useState<PageGeometry | null>(null);
  const [reloc, setReloc] = useState<Relocation | null>(null);
  const [rawCounts, setCounts] = useState<PageCounts | null>(null);
  const [counting, setCounting] = useState<{ done: number; total: number } | null>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [composer, setComposer] = useState<(ComposerTarget & { locator: EpubLocator; endLocator?: EpubLocator }) | null>(null);
  const [panel, setPanel] = useState<'toc' | 'settings' | null>(null);
  const [sheet, setSheet] = useState<string[] | null>(null);
  // The club's chat and voice, opened over the book without leaving it (D173): reading (and any
  // audio already playing) keeps going underneath, exactly as it does behind the TOC/settings
  // panels above — this is a sheet, not a navigation.
  const [chatOpen, setChatOpen] = useState(false);
  const chatUnread = useChatUnread(book.clubId);
  const [chrome, setChrome] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overlayTick, setOverlayTick] = useState(0);
  // Reading along (D46): this book's audiobook is in the player and lined up with this text.
  const audioState = useAudioState();
  const narrating = audioState.book?.id === book.id && audioState.edition?.readAlong?.textEditionId === edition.id ? audioState.edition : null;
  const readAlong = useReadAlong(narrating?.id, narrating ? audioState.track : undefined);
  const sentences = useMemo(() => sentencesOf(readAlong.data), [readAlong.data]);
  const narratedMs = Math.round(audioState.position * 1000);
  // Where the narrator is in the text (D184): a sentence, or not in it yet (the opening credits, a
  // track's announcement, a track of credits), or past it.
  const narration: Narration | null = narrating ? narrationAt(readAlong.data, sentences, narratedMs) : null;
  const narrated = narration?.state === 'reading' ? narration.sentence : undefined;
  /**
   * The pages follow the narrator until you turn one yourself (then a chip offers to follow again,
   * and the narrator reaching the page you are on follows again by itself). Opened at a link (a
   * note, your history) while listening, the pages stay there until you ask (D184).
   */
  const [following, setFollowing] = useState(startSource !== 'link');
  const followingRef = useRef(following);
  followingRef.current = following;
  const followPending = useRef(false);
  /**
   * A look asked for and not yet on screen (the contents, a note): the narrator's next page must not
   * be turned to meanwhile, or it lands after the look and the look ends there, back with the
   * narrator, as if you had never gone (a page turn racing a tap, likelier on a phone's small pages).
   */
  const lookPending = useRef(false);
  /** The narrator's page turn under way, if any: a look waits for it, so the look lands last. */
  const followTurn = useRef<Promise<void> | null>(null);
  const lookTo = useCallback((l: EpubLocator | { section: number; offset: number }) => {
    if (!viewRef.current) return Promise.resolve();
    lookPending.current = true;
    return (followTurn.current ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => viewRef.current?.display(l, 'look'))
      .finally(() => {
        lookPending.current = false;
      });
  }, []);
  const listeningRef = useRef(false);
  listeningRef.current = !!narrating && audioState.playing;
  const [chapterEnd, setChapterEnd] = useState<ChapterEndInfo | null>(null);
  /** Just read past the club's next stop (D53), and who else is there. */
  const [atStop, setAtStop] = useState<MeetingReachedInfo | null>(null);
  const meetingRef = useRef(book.meeting);
  meetingRef.current = book.meeting;
  const membersRef = useRef(members);
  membersRef.current = members;
  /** Reached the end by reading: whether that finished the book (the server decides), and how much was read. */
  const [finished, setFinished] = useState<{ finished: boolean; coverage: number } | null>(null);
  const lastChapter = useRef<number | null>(null);
  // A look: opened at a link, or gone to a friend's note. It does not move your saved place or
  // count as read until you turn a page there; `returnTo` is where you were reading.
  const looking = useRef(startSource === 'link');
  const [returnTo, setReturnTo] = useState<EpubLocator | null>(startSource === 'link' && resume?.kind === 'epub' ? resume : null);
  /** The end of the page you left, so "Back to …" says the percentage the footer said there. */
  const returnEnd = useRef<EpubLocator | null>(null);
  const lastReloc = useRef<Relocation | null>(null);
  /**
   * Your place: where the book opened (opened at a link, which is a look: where it would otherwise
   * have opened), then the start of each page you turn to. Laying the page out again (a font
   * change, the phone turned) or opening the book on another device shows the page around it
   * without moving it back to that page's start, so it never drifts.
   */
  const place = useRef<EpubLocator | null>(startSource === 'link' ? (resume?.kind === 'epub' ? resume : null) : start && start.kind === 'epub' ? start : null);
  /**
   * Since when `place` has been your place (D196): when you came to it here, or, opened there, when
   * the save it was opened from was made. A page laid out again or opened there reports the place
   * with this time, never the moment the report goes out: the place this reader opened at an hour
   * ago must not outrank the narrator's place saved since, while the pages followed them.
   */
  const placeAt = useRef<number | null>(startSource === 'link' ? resumeAt : startAt);
  /** The furthest this screen has counted as read, which the server may not have said back yet. */
  const readHere = useRef(0);
  const presence = useClubPresence(book.clubId);
  // Ask Cal from the reader's own header (D170): no floating button here, where it would sit over
  // the page or the footer's controls.
  const cal = useClubCalContext();
  const { report: reportPage, flush } = useReadingReport(book, edition);
  const editionRef = useRef(edition);
  editionRef.current = edition;
  /** The page counts for this layout, and the publication, as the report below reads them. */
  const countsRef = useRef<PageCounts | null>(null);
  const publicationRef = useRef(publication);
  publicationRef.current = publication;
  /** Report a page; a page read (not looked at) is the furthest read here until the server says more. */
  const report = useCallback<typeof reportPage>(
    (start, end, options = {}) => {
      if (!options.look) readHere.current = Math.max(readHere.current, tOf(editionRef.current, end));
      // The book-wide page this device shows for the page now open, once the pages are counted:
      // your own history says "pages 100–146" as you saw them (D191).
      let pages = options.pages;
      const r = lastReloc.current;
      const counted = countsRef.current;
      if (!pages && r && counted && start.kind === 'epub' && r.start.section === start.section && r.start.offset === start.offset) {
        const shown = bookPage(publicationRef.current, counted, r.section, r.page).page;
        if (shown !== null) pages = [shown, shown];
      }
      // Your place as kept (opened there, laid out again): said with the time you came to it.
      const since = options.place !== undefined && options.place === place.current ? { placeAt: placeAt.current } : {};
      reportPage(start, end, { ...options, ...since, ...(pages ? { pages } : {}) });
    },
    [reportPage],
  );
  /** Whether a page lies ahead of your place (or there is no place to be behind). */
  const lookingAhead = useCallback(
    (r: Relocation): boolean => {
      const kept = place.current;
      return !kept || tOf(edition, r.start) > tOf(edition, kept) + 1e-9;
    },
    [edition],
  );
  /** The pages read during a look (each turned on from): read too once reading takes over (D72). */
  const lookRead = useRef<readonly SeenPage<EpubLocator>[]>([]);
  const selfRef = useRef(selfId);
  selfRef.current = selfId;
  /** The furthest point you have read (D72), as the club and the server last said or read here; your place, if further. */
  const furthestRead = useCallback((): number => {
    const member = membersRef.current.find((m) => m.userId === selfRef.current)?.furthest ?? 0;
    const mine = qc.getQueryData<BookProgress>(keys.progress(book.id))?.mine?.furthest ?? 0;
    return Math.max(member, mine, readHere.current, place.current ? tOf(edition, place.current) : 0);
  }, [qc, book.id, edition]);
  /**
   * Whether a page turn during a look is reading (D62, D72): past where you have read, only
   * reading on there for a few pages is; nearer, any turn ahead of your place is reading on there;
   * behind it (finding a passage) only reading forward through your place is, so flipping back
   * never loses it. With no place to come back to, any page turn is reading.
   */
  const readingTakesOver = useCallback(
    (r: Relocation, before: Relocation | null): boolean => {
      const kept = place.current;
      if (!kept || !before) return true;
      return turnIsReading({
        forward: r.via === 'next',
        from: { start: tOf(edition, before.start), end: tOf(edition, before.end) },
        furthest: furthestRead(),
        pagesRead: lookRead.current.length,
        place: { fromAhead: lookingAhead(before), toAhead: tOf(edition, r.start) > tOf(edition, kept) + 1e-9 },
      });
    },
    [edition, lookingAhead, furthestRead],
  );
  /** The end of a look: what was read in it, which counts as read if reading takes over there. */
  const endLook = useCallback((): readonly SeenPage<EpubLocator>[] => {
    const read = lookRead.current;
    looking.current = false;
    lookRead.current = [];
    setReturnTo(null);
    setElsewhere(false);
    return read;
  }, []);
  /**
   * Follow the narrator again (the chip, Play pressed again, the narrator reaching your page): a
   * look in the way ends, unread (pages looked at while listening are the narrator's, D184).
   * Before this, following again left a look standing, and a look stops following: the chip went
   * away and the pages never moved again.
   */
  const resumeFollowing = useCallback(() => {
    if (looking.current) endLook();
    setFollowing(true);
  }, [endLook]);
  /** Reading takes over from a look on a page: it is your place, and the pages read in the look are read. */
  const readOnHere = (r: Relocation) => {
    const read = endLook();
    place.current = r.start;
    placeAt.current = Date.now();
    for (const run of readRuns(read)) report(run.from, run.to, { place: r.start });
  };
  /** A look ahead of your place becomes reading there (a note opened or written on its page). */
  const readOnFromLook = (r: Relocation): boolean => {
    if (!looking.current) return true;
    if (!lookingAhead(r)) return false;
    readOnHere(r);
    return true;
  };
  /** Your place on a page: where it was kept (the page laid out again, or opened here), else its start. */
  const placeOn = useCallback(
    (r: Relocation): EpubLocator => {
      const kept = place.current;
      if (!kept) return r.start;
      const t = tOf(edition, kept);
      return t >= tOf(edition, r.start) && t <= tOf(edition, r.end) ? kept : r.start;
    },
    [edition],
  );
  // Your place moved on another device while this one stayed open (D70): the newer place is your
  // place, and the page in front of you a look, until you go there or choose to stay. Without it a
  // phone left open at an old page would save that page, and your marker, back over the newer one.
  const mineSaved = members.find((m) => m.userId === selfId);
  const knownSave = useRef(mineSaved?.updatedAt ?? null);
  // The place the book opened at is one this device knows: hearing of it again (a fresher copy of
  // the same saved place, arriving late) is no news.
  useEffect(() => {
    if (start?.kind === 'epub') savedFromHere(book.id, tOf(edition, start));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [elsewhere, setElsewhere] = useState(false);
  useEffect(() => {
    if (!newerSave(mineSaved?.updatedAt, knownSave.current)) return;
    // The first saved place heard of is the one this reader opened with (it may come late, after
    // a place saved here): news is only what comes after it.
    const first = knownSave.current === null;
    knownSave.current = mineSaved!.updatedAt;
    if (first) return;
    const found = placeFromElsewhere(mineSaved, place.current ? tOf(edition, place.current) : null, placesSavedHere(book.id));
    if (!found) return;
    // At a chapter's start in another format, at its start here (D93).
    const there = translatePlace(book, edition, { t: found.t, kind: mineSaved?.kind });
    if (there?.kind !== 'epub') return;
    // That place is another device's save: kept here as of this device's own last place (its time
    // unchanged), so that coming back to it here never outranks the save it came from (D196): the
    // other device's own, perhaps the audiobook's to the millisecond. Reading on from it is new.
    place.current = there;
    looking.current = true;
    lookRead.current = [];
    returnEnd.current = null;
    setReturnTo(there);
    setElsewhere(true);
    toast.show(`You read on to ${found.label} on another device.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mineSaved?.updatedAt]);
  const theme = THEMES[settings.theme];

  // Reading area size → page geometry.
  useEffect(() => {
    const el = viewportRef.current?.parentElement;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setGeometry((prev) => {
        const next = pageGeometry(rect.width, rect.height);
        return prev && prev.width === next.width && prev.height === next.height && prev.gap === next.gap && prev.left === next.left ? prev : next;
      });
    };
    measure();
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(measure, 150);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const commentsRef = useRef(comments);
  commentsRef.current = comments;
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
    if (!commentsRef.current.some((c) => c.id === id)) return false;
    setSheet([id]);
    return true;
  });
  // How many times reading onto the story's end has been answered (shown on the reader, for tests).
  const [endChecks, setEndChecks] = useState(0);
  const reachedEnd = useCallback(async () => {
    await flush(true);
    const mine = qc.getQueryData<BookProgress>(keys.progress(book.id))?.mine;
    if (firstTimeAtEnd(book.id, selfId, mine?.finished ?? false)) setFinished({ finished: mine?.finished ?? false, coverage: rangesCoverage(mine?.readRanges ?? []) });
    setEndChecks((n) => n + 1);
  }, [flush, qc, book.id, selfId]);
  const onRelocate = useCallback(
    (r: Relocation) => {
      const before = lastReloc.current;
      // A look that reading on here ends: what was read in it counts as read now (D58, D72).
      let readInLook: readonly SeenPage<EpubLocator>[] = [];
      if (r.via === 'look' || r.via === 'jump') {
        // Going somewhere (the contents, a note, a link in the book) is a look (D41, D58, D72).
        if (!looking.current) {
          looking.current = true;
          setReturnTo(lastReloc.current?.start ?? null);
          returnEnd.current = lastReloc.current?.end ?? null;
        }
        lookRead.current = [];
      } else if ((r.via === 'next' || r.via === 'prev') && looking.current) {
        // A page turned on from is a page read in the look.
        if (r.via === 'next' && before) lookRead.current = readPage(lookRead.current, seenPage(publication, before));
        if (readingTakesOver(r, before)) readInLook = endLook();
      }
      if (r.via === 'follow') followPending.current = false;
      else if (r.via !== 'relayout' && r.via !== 'open' && listeningRef.current) setFollowing(false);
      if (r.via === 'next' || r.via === 'prev' || r.via === 'jump') setLanding(null);
      lastReloc.current = r;
      setReloc(r);
      setSelection(null);
      setOverlayTick((n) => n + 1);
      // Pages after the story (a licence) are not a place to come back to: the place stays at its end.
      const pastStory = tOf(edition, r.start) >= 1 - 1e-9 && place.current !== null;
      const keep = pastStory || ((r.via === 'open' || r.via === 'relayout') && place.current !== null && place.current.section === r.start.section);
      if (!keep && !looking.current && r.via !== 'follow') {
        place.current = r.start;
        placeAt.current = Date.now();
      }
      // Turned by the narrator, or laid out again while it turns them: the audiobook already says
      // where you are.
      const narrated = r.via === 'follow' || (r.via === 'relayout' && listeningRef.current && followingRef.current);
      // Reading on from a look (the contents, a link, a note): the pages read in it were read too.
      for (const run of readRuns(readInLook)) report(run.from, run.to, { place: place.current ?? r.start });
      // During a look friends still see you where you are reading: it is a glance, not your place.
      const kept = (keep || looking.current) && place.current ? { place: place.current } : {};
      // The page just turned to goes in the very same save as the look's pages above (one request,
      // not two racing ones), sent now rather than on the usual debounce when a look just ended —
      // this is exactly the moment a friend's note on any of those pages may be about to open, and
      // continuing to read right on (turning a page every few hundred milliseconds) would otherwise
      // keep deferring the save indefinitely, since every further page read resets it before it
      // ever fires.
      report(r.start, r.end, { look: looking.current || narrated, urgent: readInLook.length > 0, ...kept });
      // A chapter just ended under the reader's eyes: show what friends said in it.
      const chapter = chapterIndexAt(book.chapters, tOf(edition, r.start));
      const previous = lastChapter.current;
      lastChapter.current = chapter;
      if (r.via === 'next' && previous !== null && chapter === previous + 1 && previous >= 0) {
        setChapterEnd(chapterEndInfo(book.chapters, previous, commentsRef.current, selfId, book.chapters[previous]!.t, book.chapters[chapter]!.t));
      } else if (r.via !== 'relayout') setChapterEnd(null);
      // Turning the page past the club's next stop (as a chapter's end, not a jump): who else is
      // there. Reading on from a look reads the pages read in it too. A stop at the very end of the
      // book is the finished card's moment instead.
      const stop = meetingRef.current;
      const readFrom = readInLook.length > 0 ? tOf(edition, readInLook[0]!.from) : before ? tOf(edition, before.end) : null;
      if (stop && r.via === 'next' && !looking.current && readFrom !== null && readFrom <= stop.t + 1e-6 && tOf(edition, r.end) > stop.t + 1e-6) {
        setAtStop(meetingReachedInfo(stop, membersRef.current, selfId));
      } else if (r.via !== 'relayout') setAtStop(null);
      // Reading onto the last page of the story (not a look, a reopen or a relayout there): send
      // it now and let the server say whether the book is finished (it needs nearly all of it read).
      if (r.via === 'next' && !looking.current && tOf(edition, r.end) >= 1 - 1e-9) void reachedEnd();
    },
    [report, reachedEnd, book.chapters, edition, selfId, readingTakesOver, endLook, publication],
  );

  // Create the view once geometry is known; open at the start position.
  const created = useRef(false);
  useEffect(() => {
    if (!geometry || created.current || !trackRef.current) return;
    created.current = true;
    const view = new EpubView(trackRef.current, publication, geometry, settings, {
      onRelocate,
      onSelection: setSelection,
      onTap: (zone) => {
        if (zone === 'next') void view.next();
        else if (zone === 'prev') void view.prev();
        else setChrome((c) => !c);
      },
      onExternalLink: (href) => window.open(href, '_blank', 'noopener,noreferrer'),
      onError: (err) => setError(err.message),
    });
    viewRef.current = view;
    const geometryForM = { kind: 'epub' as const, sectionLengths: publication.sections.map((s) => s.textLength) };
    const initial = start && start.kind === 'epub' ? start : (mToLocator(geometryForM, publication.story.start) as EpubLocator);
    void view.display(initial, 'open');
    return () => {
      view.destroy();
      viewRef.current = null;
      created.current = false;
    };
    // The view is created once; later geometry/settings changes go through relayout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry !== null]);

  // Geometry or settings changed: re-paginate around the current passage.
  const applied = useRef<{ g: PageGeometry | null; s: ReaderSettings }>({ g: null, s: settings });
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !geometry) return;
    const prev = applied.current;
    applied.current = { g: geometry, s: settings };
    if (prev.g === null) return;
    if (prev.g === geometry && prev.s.fontScale === settings.fontScale && prev.s.lineHeight === settings.lineHeight && prev.s.font === settings.font && prev.s.theme === settings.theme) return;
    void view.relayout(geometry, settings);
  }, [geometry, settings]);

  // Book-wide pages: count every section at this layout (cached per layout signature).
  // Memory hit (D198): paint numbers immediately; recompute only when the layout key changes.
  useEffect(() => {
    if (!geometry || !measureRef.current || !reloc) return;
    const view = viewRef.current;
    if (!view) return;
    const counter = (counterRef.current ??= new PageCounter(measureRef.current, publication, (i) => view.sectionUrl(i)));
    const warm = counter.peek(geometry, settings);
    if (warm) {
      setCounts(warm);
      setCounting(null);
      return;
    }
    let cancelled = false;
    void counter
      .count(geometry, settings, (done, total) => {
        if (!cancelled) setCounting({ done, total });
      })
      .then((result) => {
        if (cancelled || !result) return;
        setCounts(result);
        setCounting(null);
      });
    return () => {
      cancelled = true;
      counter.cancel();
    };
    // Only layout-relevant settings restart counting (theme does not).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, settings.fontScale, settings.lineHeight, settings.font, publication, reloc !== null]);

  // Keyboard paging when focus is on the app (inside the book frame the view handles keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (panel || composer || sheet) return;
      const view = viewRef.current;
      if (view) handleKey(e, view);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, composer, sheet]);

  // Keep the book on this device for offline reading, once the first page is up.
  const [kept] = useEditionOffline(edition.id);
  const opened = reloc !== null;
  useEffect(() => {
    if (opened) void keepOffline(book, edition, publication);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, book.id, edition.id]);

  const changeSettings = (next: ReaderSettings) => {
    setSettings(next);
    saveSettings(next);
  };

  // Comments of this book placed in this edition.
  const pageSpan = useMemo(() => (reloc ? { section: reloc.section, from: reloc.start.offset, to: reloc.end.offset } : null), [reloc]);
  const exactHere = usePlacesOnPage(book.id, edition.id, pageSpan, comments);
  const placed = useMemo(
    // A note ahead of you comes placed only roughly (D80): on the page in front of you, at the
    // place the server gives for it there; elsewhere it has no line to mark, the club bar shows it.
    () =>
      comments.flatMap((c) => {
        const here = c.hidden && c.approx ? exactHere.get(c.id) : undefined;
        if (c.hidden && c.approx && !here) return [];
        const locator = epubLocatorOf(book, edition, here ? { ...c, ...here } : c);
        return locator ? [{ comment: c, locator }] : [];
      }),
    [book, comments, edition, exactHere],
  );

  // Margin markers and underlines for the current section, in the section's coordinates.
  const { markers, underlines } = useMemo(() => {
    const view = viewRef.current;
    const out: Marker[] = [];
    const lines: { key: string; left: number; top: number; width: number }[] = [];
    if (!view || !reloc || !geometry) return { markers: out, underlines: lines };
    // Each note's line, then markers in the right margin; notes closer than a marker is tall
    // share one, so no two touch targets overlap.
    const spots: { column: number; y: number; comment: CommentView }[] = [];
    for (const { comment, locator } of placed) {
      if (locator.section !== reloc.section) continue;
      const rect = view.rects(locator.offset, locator.offset + 1)[0];
      if (!rect) continue;
      const column = Math.floor((rect.left + 1) / (geometry.width + geometry.gap));
      const y = Math.min(Math.max(0, rect.top + rect.height / 2 - MARKER_TARGET / 2), geometry.height - MARKER_TARGET);
      spots.push({ column, y, comment });
      if (!comment.hidden && comment.endLocator && comment.endLocator.kind === 'epub' && comment.editionId === edition.id && comment.endLocator.section === reloc.section) {
        for (const r of view.rects(locator.offset, comment.endLocator.offset)) lines.push({ key: `${comment.id}-${r.left}-${r.top}`, left: r.left, top: r.bottom - 2, width: r.width });
      }
    }
    spots.sort((a, b) => a.column - b.column || a.y - b.y);
    const right = geometry.gap - geometry.left;
    for (const s of spots) {
      const last = out[out.length - 1];
      const x = s.column * (geometry.width + geometry.gap) + geometry.width + Math.max(0, (right - MARKER_TARGET) / 2);
      if (last && last.x === x && s.y - last.y < MARKER_TARGET) last.comments.push(s.comment);
      else out.push({ key: `${s.column}:${Math.round(s.y)}`, x, y: s.y, comments: [s.comment] });
    }
    return { markers: out, underlines: lines };
    // overlayTick re-runs this after every relocation/relayout (DOM geometry changed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, reloc, geometry, overlayTick, edition.id]);

  // The sentence the narrator is reading, marked on the page (in the section's coordinates).
  const narratedMarks = useMemo(() => {
    const view = viewRef.current;
    if (!view || !reloc || !narrated || narrated.section !== reloc.section) return [];
    // One band per line: the rects of a range come per text run (an italic word is its own).
    const lines: { left: number; top: number; right: number; bottom: number }[] = [];
    for (const r of view.rects(narrated.offset, narrated.offset + narrated.length)) {
      if (r.width === 0) continue;
      const line = lines.find((l) => Math.abs(l.top - r.top) < r.height / 2 && r.left < l.right + 40 && r.right > l.left - 40);
      if (line) {
        line.left = Math.min(line.left, r.left);
        line.right = Math.max(line.right, r.right);
        line.top = Math.min(line.top, r.top);
        line.bottom = Math.max(line.bottom, r.bottom);
      } else lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    return lines.map((l) => ({ key: `${l.left}:${l.top}`, left: l.left, top: l.top, width: l.right - l.left, height: l.bottom - l.top }));
    // overlayTick: the page's layout changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrated?.index, narrated?.section, reloc, overlayTick]);

  // Opened where you stopped listening (or reading the other format): the passage is marked for a
  // moment, with a word, so the switch lands on something you recognise (D186). It goes at your
  // first page turn, or after a while.
  const [landing, setLanding] = useState<EpubLocator | null>(startSource === 'other-format' && start?.kind === 'epub' ? start : null);
  useEffect(() => {
    if (!landing) return;
    const id = setTimeout(() => setLanding(null), 8000);
    return () => clearTimeout(id);
  }, [landing]);
  const landingMarks = useMemo(() => {
    const view = viewRef.current;
    if (!view || !reloc || !landing || landing.section !== reloc.section || landing.offset < reloc.start.offset || landing.offset >= reloc.end.offset) return [];
    return view
      .rects(landing.offset, Math.min(landing.offset + LANDING_CHARS, reloc.end.offset))
      .filter((r) => r.width > 0)
      .map((r) => ({ key: `${r.left}:${r.top}`, left: r.left, top: r.top, width: r.width, height: r.height }));
    // overlayTick: the page's layout changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landing, reloc, overlayTick]);
  // D198: no toast every time the reader opens (routine resume).
  // The audiobook from here (D186): Play starts at this page unless the narrator is already on it,
  // and reading along opened from the book page loads it at this page.
  const pageOnScreen = useMemo(() => (reloc ? { startT: tOf(edition, reloc.start), endT: tOf(edition, reloc.end), start: reloc.start } : null), [reloc, edition]);
  const readerAudio = useReaderAudio(book, edition, pageOnScreen, along, () => flush(true));
  // The audiobook's controls, unless you hid them for this book or every book (D197); this book's
  // audiobook playing is never hidden (its controls are how it is stopped).
  const audioControls = useAudioControls(book.id);
  const offerListen = !!readerAudio.audiobook && !audioControls.hidden;

  // Pressing play again means following the narrator again (once it starts, not already playing as
  // the reader opens: a link opened while listening stays where it was opened).
  const playing = !!narrating && audioState.playing;
  const wasPlaying = useRef(playing);
  useEffect(() => {
    if (playing && !wasPlaying.current) resumeFollowing();
    wasPlaying.current = playing;
  }, [playing, resumeFollowing]);
  // Turn to the narrator's page when they read past this one; before the text (the opening
  // credits), to the page where it begins, so it is open when they start (D184).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reloc || !narration || !playing || followPending.current || lookPending.current) return;
    // A page newer than this render's is already on screen (its render is coming): judging by this
    // one, a look just begun would seem to be on the narrator's page and end at once.
    if (reloc !== lastReloc.current) return;
    const target = followTarget(narration);
    if (!target) return;
    const visible = onPage(target, { section: reloc.section, start: reloc.start.offset, end: reloc.end.offset, last: reloc.page >= reloc.pages - 1 });
    if (!following || looking.current) {
      // The narrator has come to the page you turned to: follow on from here.
      if (visible && narration.state === 'reading') resumeFollowing();
      return;
    }
    if (visible) return;
    followPending.current = true;
    const turn = view.display(target, 'follow').finally(() => {
      followPending.current = false;
      if (followTurn.current === turn) followTurn.current = null;
    });
    followTurn.current = turn;
  }, [narration, reloc, playing, following, resumeFollowing]);

  // Reading along, the pages following the narrator: your place is where the narrator is reading,
  // the word as the alignment places it (D196). Kept here, not saved here (the player saves the
  // audiobook's own place, to the millisecond, every few seconds and when it stops). Before this,
  // the place stayed where reading along began while the pages turned with the narrator, and a page
  // laid out again (Read, which takes the dock away; the phone turned; the app back from the
  // background) saved that, as your newest place: a chapter's first page, minutes behind.
  useEffect(() => {
    if (!narrated || !playing || !following || looking.current) return;
    place.current = { kind: 'epub', section: narrated.section, offset: offsetNow(narrated, narratedMs) };
    placeAt.current = NARRATED_AT;
  }, [narrated, narratedMs, playing, following]);

  // A marker on this page means its comment is about to be revealed: send progress now, once per
  // page and set of hidden notes (a note whose passage runs on to the next page stays hidden here).
  const urgentFor = useRef<string | null>(null);
  useEffect(() => {
    if (!reloc || !geometry || looking.current) return;
    const pageMarkers = markers.filter((m) => Math.floor((m.x + MARKER_TARGET / 2) / (geometry.width + geometry.gap)) === reloc.page);
    const hidden = pageMarkers.flatMap((m) => m.comments.filter((c) => c.hidden).map((c) => c.id));
    const key = `${reloc.section}:${reloc.start.offset}:${hidden.join(',')}`;
    if (hidden.length > 0 && key !== urgentFor.current) {
      urgentFor.current = key;
      report(reloc.start, reloc.end, { urgent: true, place: placeOn(reloc) });
    }
  }, [markers, reloc, geometry, report, placeOn]);

  // Deep link to a comment: open its sheet once we are there.
  const openedDeepLink = useRef(false);
  useEffect(() => {
    if (!openCommentId || openedDeepLink.current || !reloc) return;
    if (comments.some((c) => c.id === openCommentId)) {
      openedDeepLink.current = true;
      setSheet([openCommentId]);
    }
  }, [openCommentId, reloc, comments]);

  // Only counts for exactly this layout are ever shown: stale numbers are worse than none.
  const counts = rawCounts && geometry && rawCounts.signature === layoutSignature(geometry, settings) ? rawCounts : null;
  countsRef.current = counts;
  // Your place's percentage, as saved and as the book page says it: the page's start unless the
  // place was kept inside the page (opened there from another format, the page laid out again).
  const t = reloc ? pagePercentT(tOf(edition, placeOn(reloc)), tOf(edition, reloc.end)) : 0;
  const startT = reloc ? tOf(edition, reloc.start) : 0;
  const page: BookPage | null = reloc && counts ? bookPage(publication, counts, reloc.section, reloc.page) : null;
  const barList = barMembers(book.id, members, presence).map((m) => (m.userId === selfId && reloc ? { ...m, t: startT, label: chapterLabel(book.chapters, startT), live: true, kind: 'epub' } : m));

  const createComment = async (input: {
    locator: EpubLocator;
    endLocator?: EpubLocator;
    quote?: string | null;
    text?: string;
    reaction?: Reaction;
    clientId?: string;
    aboutHere?: boolean;
    mediaIds?: string[];
  }) => {
    // A note written during a look behind your place is pinned where you are looking, and your
    // place stays where you read; ahead of it, writing there is reading there.
    if (reloc && looking.current && readOnFromLook(reloc)) report(reloc.start, reloc.end);
    void flush(true);
    const created = await api.createComment(book.id, {
      editionId: edition.id,
      locator: input.locator,
      ...(input.endLocator ? { endLocator: input.endLocator } : {}),
      ...(input.quote ? { quote: input.quote.slice(0, 600) } : {}),
      ...(input.text ? { text: input.text } : {}),
      ...(input.reaction ? { reaction: input.reaction } : {}),
      ...(input.mediaIds && input.mediaIds.length > 0 ? { mediaIds: input.mediaIds } : {}),
      clientId: input.clientId ?? newClientId(),
      ...(input.aboutHere ? { aboutHere: true } : {}),
    });
    mergeComment(qc, book.id, created);
    return created;
  };

  const react = (r: Reaction) => {
    const s = selection;
    if (!s) return;
    viewRef.current?.clearSelection();
    setSelection(null);
    void createComment({ locator: s.start, endLocator: s.end, quote: s.text, reaction: r })
      .then(() => toast.show(`${r} pinned here.`))
      .catch((err: unknown) => (keptForLater(err) ? toast.show(err.message) : toast.show(err instanceof Error ? err.message : 'Could not save the reaction.', 'error')));
  };

  const openSheet = async (ids: string[]) => {
    // Opening a note on the page in front of you reads that page now, even during a look ahead of
    // your place (it becomes your place); behind it, the look stays a look. Far past where you have
    // read (D72) it is a curious tap like any other (a marker sits where a finger turns the page):
    // the look stays, and the note waits for you to read there.
    const far = !!reloc && looking.current && pastWhereRead({ start: tOf(edition, reloc.start), end: tOf(edition, reloc.end) }, furthestRead());
    if (reloc && !far && comments.some((c) => ids.includes(c.id) && c.hidden) && readOnFromLook(reloc)) {
      report(reloc.start, reloc.end, { urgent: true, place: placeOn(reloc) });
      await flushOutbox();
    }
    setSheet(ids);
  };

  /** During a look: make the page in front of you your place, and read it (and what you read in the look). */
  const readFromHere = () => {
    if (!reloc) return;
    readOnHere(reloc);
    report(reloc.start, reloc.end, { urgent: true });
  };

  // Each entry's page, worked out once for the page counts, not on every render: a long contents
  // list made each page turn slow.
  const tocPages = useMemo(() => (counts ? tocPageNumbers(publication, counts) : null), [publication, counts]);
  // The chapters, by the names the club uses (D77), the one you are in by your place in the book;
  // after them, apart, the book's own matter after the story (its colophon, notes: D109).
  const listed = useMemo(() => [...listedContents(publication).map((e) => ({ ...e, after: false })), ...contentsAfterStory(publication).map((e) => ({ ...e, after: true }))], [publication]);
  const currentListed = reloc ? currentEntry(publication, listed, reloc.start) : null;
  const tocItems = listed.map(({ index, entry, title, after }, k) => {
    const entryT = tOf(edition, { kind: 'epub', section: entry.section, offset: entry.offset });
    return {
      title,
      depth: entry.depth,
      current: k === currentListed,
      // What follows the story is no part of it you have yet to read.
      ahead: !after && entryT > startT,
      after,
      pageLabel: tocPages ? String(tocPages[index] ?? '') : undefined,
      // Going to a chapter is a look until you read on there (D41): your place, and a listener's, stay.
      onSelect: () => void lookTo({ section: entry.section, offset: entry.offset }),
    };
  });

  const sheetComments = sheet ? comments.filter((c) => sheet.includes(c.id)) : [];

  // What the header names: before the story by the book's own contents (D81), else the chapter's
  // own title, with its part where the book numbers its chapters afresh in each (D86); past the
  // story's end (a licence, a colophon, notes), no chapter of it, and wholly before its start (a
  // title page, an imprint the book marks), what comes before its first chapter (D109).
  const division = divisionAt(book.chapters, startT);
  const beforeStart = !!reloc && page?.page == null && tOf(edition, reloc.end) <= 1e-9;
  const heading = page?.beforeStory
    ? `Before ${page.beforeStory}`
    : beforeStory(book.chapters, startT) || beforeStart
      ? beforeStoryName(book.chapters)
      : startT >= 1 - 1e-9 && page?.page == null
        ? 'After the story'
        : page?.chapterTitle
          ? `${division ? `${division} · ` : ''}${chapterHeading(page.chapterTitle)}`
          : chapterLabel(book.chapters, startT);

  // The footer's own parts, laid out by itself while reading and by the docked player in Both (D194).
  const prevButton = (
    <button type="button" className="icon-btn page-btn" aria-label="Previous page" onClick={() => void viewRef.current?.prev()} disabled={reloc?.atStart} data-testid="prev-page">
      <Icon name="back" size={20} />
    </button>
  );
  const nextButton = (
    <button type="button" className="icon-btn page-btn" aria-label="Next page" onClick={() => void viewRef.current?.next()} disabled={reloc?.atEnd} data-testid="next-page">
      <Icon name="back" size={20} />
    </button>
  );
  const pageInfo = (
    <div className="page-info" aria-live="polite">
      <span data-testid="page-number" data-page={page?.page ?? ''} data-total={page?.total ?? ''} data-ready={counts ? 'true' : 'false'}>
        {page?.page != null ? `Page ${page.page} of ${page.total}` : counts ? '—' : counting ? `Counting pages… ${Math.round((counting.done / counting.total) * 100)}%` : 'Counting pages…'}
      </span>
      <span className="page-sep" aria-hidden="true">
        ·
      </span>
      {/* Not for a one-page part (a title page): "last page in chapter" would be odd there; nor
          while the pages are still being counted, so that the footer keeps to one line. */}
      {/* Before the first chapter (a cover, a title page) there is no chapter to count in: the
          pages of the file it shares with the chapters after it (Pride and Prejudice's first
          screen, "page 3 of 176") were no unit of the book's. */}
      <span className="page-chapter" data-testid="chapter-page" data-page={page?.chapterPage ?? ''} data-total={page?.chapterPages ?? ''} hidden={!counts || page?.chapterPages == null || page.chapterPages === 1}>
        {page?.chapterPage != null && page.chapterPages != null ? (page.chapterPages - page.chapterPage === 0 ? 'Last page in chapter' : `${page.chapterPage} of ${page.chapterPages} in chapter`) : null}
      </span>
      <span className="page-sep page-sep-chapter" aria-hidden="true" hidden={!counts || page?.chapterPages == null || page.chapterPages === 1}>
        ·
      </span>
      <span data-testid="percent" data-value={t.toFixed(6)}>
        {formatPercent(t)}
      </span>
    </div>
  );

  return (
    <div
      className={`reader reader-epub theme-${settings.theme}${chrome ? '' : ' chrome-hidden'}`}
      // The page's colours, and its accent for what is drawn on it in gold elsewhere (the audiobook's
      // controls in the footer): the light themes' accent is a darker gold.
      style={{ background: theme.bg, color: theme.text, '--reader-accent': theme.link, '--reader-bg': theme.bg } as CSSProperties}
      data-testid="reader"
      data-end-checks={endChecks}
      data-offline={kept ? 'kept' : 'no'}
      data-narrated={narrated && narrating ? `${narrated.section}:${narrated.offset}:${narrated.length}` : ''}
      data-section={reloc?.section ?? ''}
      data-page-in-section={reloc?.page ?? ''}
      data-start={reloc?.start.offset ?? ''}
      data-end={reloc?.end.offset ?? ''}
    >
      <header className="reader-header">
        <Link to={`/books/${book.id}`} className="icon-btn" aria-label={`Back to ${book.title}`}>
          <Icon name="back" />
        </Link>
        <div className="reader-title">
          <span className="reader-book">{book.title}</span>
          <span className="reader-chapter">{heading}</span>
        </div>
        <button type="button" className="icon-btn" aria-label="Contents" onClick={() => setPanel('toc')} data-testid="open-toc">
          <Icon name="toc" />
        </button>
        <button type="button" className="icon-btn" aria-label="Reading settings" onClick={() => setPanel('settings')} data-testid="open-settings">
          <Icon name="type" />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Leave a note on this page"
          data-testid="add-note"
          onClick={() => {
            if (!reloc) return;
            setComposer({ locator: reloc.start, quote: null, where: chapterLabel(book.chapters, startT), upTo: tOf(edition, reloc.end) });
          }}
        >
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
            // One note you may read: go to its passage and open it. Notes ahead of you, or a
            // group of them, open in the sheet without moving you.
            const only = cs.length === 1 ? cs[0]! : null;
            const l = only && !only.hidden ? epubLocatorOf(book, edition, only) : null;
            if (only && l) void lookTo(l).then(() => setSheet([only.id]));
            else void openSheet(cs.map((c) => c.id));
          }}
        />
        {/* Over the club bar, not over the page's first line. */}
        {returnTo ? (
          <LookChip
            label={placeLabel(book.chapters, tOf(edition, returnTo), tOf(edition, returnEnd.current ?? returnTo))}
            elsewhere={elsewhere}
            onBack={() => {
              const to = returnTo;
              endLook();
              // Back where you were, as if opened there: your place stays to the character.
              void viewRef.current?.display(place.current ?? to, 'open');
            }}
            onStay={readFromHere}
            {...(playing ? { onFollow: resumeFollowing } : {})}
          />
        ) : playing && (!following || looking.current) ? (
          <button type="button" className="btn btn-small follow-chip" data-testid="follow-audio" onClick={resumeFollowing}>
            <Icon name="headphones" size={16} /> Follow the narrator
          </button>
        ) : playing && narration?.state === 'before' ? (
          <span className="follow-chip follow-note small" data-testid="narration-before" role="status">
            <Icon name="headphones" size={16} /> Before the text: the narrator begins on this page
          </span>
        ) : null}
      </div>

      <div className="reader-area">
        <div
          ref={viewportRef}
          className="epub-viewport"
          style={geometry ? { width: geometry.width + geometry.gap, height: geometry.height } : undefined}
          onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            const rect = e.currentTarget.getBoundingClientRect();
            if (e.clientX - rect.left < rect.width / 2) void viewRef.current?.prev();
            else void viewRef.current?.next();
          }}
        >
          <div ref={trackRef} className="epub-track" style={geometry ? { left: geometry.left } : undefined}>
            <div className="epub-overlay" aria-hidden={markers.length === 0 ? true : undefined}>
              {landingMarks.map((m) => (
                <span key={`landing-${m.key}`} className="landing-mark" data-testid="landing-mark" style={{ left: m.left, top: m.top, width: m.width, height: m.height }} />
              ))}
              {narratedMarks.map((m) => (
                <span key={m.key} className="readalong-mark" data-testid="readalong-mark" style={{ left: m.left, top: m.top, width: m.width, height: m.height, background: theme.selection }} />
              ))}
              {underlines.map((u) => (
                <span key={u.key} className="epub-underline" style={{ left: u.left, top: u.top, width: u.width, background: theme.mark }} />
              ))}
              {markers.map((m) => {
                const reactions = [...new Set(m.comments.map((c) => c.reaction).filter(Boolean))];
                const hidden = m.comments.every((c) => c.hidden);
                // Markers of the section's other pages slide in with their page; until then they
                // cannot be focused (Tab would scroll the pages ahead into view) or read out.
                const onPage = !!reloc && !!geometry && Math.floor((m.x + MARKER_TARGET / 2) / (geometry.width + geometry.gap)) === reloc.page;
                return (
                  <button
                    key={m.key}
                    type="button"
                    className={`margin-marker${hidden ? ' is-hidden' : ''}`}
                    style={{ left: m.x, top: m.y }}
                    inert={!onPage}
                    data-testid="margin-marker"
                    data-hidden={hidden ? 'true' : 'false'}
                    aria-label={`${m.comments.length} ${m.comments.length === 1 ? 'note' : 'notes'} here from ${[...new Set(m.comments.map((c) => (c.userId === selfId ? 'you' : c.authorName)))].join(', ')}`}
                    onClick={() => void openSheet(m.comments.map((c) => c.id))}
                  >
                    {reactions.length > 0 ? reactions.slice(0, 2).join('') : '💬'}
                    {m.comments.length > 1 ? <span className="marker-count">{m.comments.length}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
          <div ref={measureRef} className="epub-measure-host" aria-hidden="true" />
        </div>
        {selection && !composer ? (
          <SelectionMenu
            rect={{ ...selection.rect, left: selection.rect.left + (viewportRef.current?.offsetLeft ?? 0), top: selection.rect.top + (viewportRef.current?.offsetTop ?? 0) }}
            onReact={react}
            onNote={() => {
              setComposer({
                locator: selection.start,
                endLocator: selection.end,
                quote: selection.text,
                where: chapterLabel(book.chapters, tOf(edition, selection.start)),
                upTo: tOf(edition, reloc?.end ?? selection.end),
              });
              viewRef.current?.clearSelection();
              setSelection(null);
            }}
          />
        ) : null}
        {error ? (
          <div className="reader-error" role="alert">
            {error}
          </div>
        ) : null}
        {/* Reading along asked for, and the browser waiting for a tap (D194): one Play, over the page. */}
        {readerAudio.startTap ? <AlongStart where={heading} onPlay={readerAudio.play} /> : null}
      </div>

      <footer className={`reader-footer${readerAudio.docked ? ' is-docked' : ''}`}>
        {/* Over the footer, never over the text of the new chapter. */}
        <StopOrChapterEndCard
          atStop={atStop}
          chapterEnd={chapterEnd}
          onShow={(ids) => void openSheet(ids)}
          onCloseStop={() => setAtStop(null)}
          onCloseChapterEnd={() => setChapterEnd(null)}
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

      {panel === 'settings' ? (
        <SettingsPanel
          settings={settings}
          onChange={changeSettings}
          onClose={() => setPanel(null)}
          {...(readerAudio.audiobook ? { audio: { book: audioControls.book, byDefault: audioControls.byDefault, onChange: audioControls.setBook } } : {})}
        />
      ) : null}
      {panel === 'toc' ? (
        <TocPanel
          items={tocItems}
          onClose={() => setPanel(null)}
          onReadUpToHere={() => {
            if (!reloc) return;
            void flush(true);
            // The place this saves is this device's own: the club hears of it, this device too (D70).
            savedFromHere(book.id, tOf(edition, reloc.end));
            void api
              .readUpTo(book.id, { editionId: edition.id, locator: reloc.end })
              .then((result) => {
                mergeRevealed(qc, book.id, result.revealed);
                const notes = result.revealed.filter((c) => !c.parentId).length;
                const answers = result.revealed.length - notes;
                const told = [notes > 0 ? `${notes} ${notes === 1 ? 'note' : 'notes'}` : null, answers > 0 ? `${answers} ${answers === 1 ? 'answer' : 'answers'}` : null].filter(Boolean).join(' and ');
                toast.show(told ? `${told} before here ${notes + answers === 1 ? 'is' : 'are'} now open to you.` : 'Marked as read up to here.');
              })
              .catch(() => toast.show('Could not mark as read.', 'error'));
          }}
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
      {composer ? (
        <NoteComposer
          bookId={book.id}
          target={composer}
          chapters={book.chapters}
          furthest={furthestRead()}
          members={members}
          selfId={selfId}
          onClose={() => setComposer(null)}
          onSubmit={async ({ text, reaction, clientId, aboutHere, mediaIds }) => {
            try {
              await createComment({
                locator: composer.locator,
                ...(composer.endLocator ? { endLocator: composer.endLocator } : {}),
                quote: composer.quote,
                ...(text ? { text } : {}),
                ...(reaction ? { reaction } : {}),
                mediaIds,
                clientId,
                aboutHere,
              });
              toast.show('Note pinned here.');
            } catch (err) {
              // Kept on the device with no network: done here, as far as the reader goes.
              if (!keptForLater(err)) throw err;
              toast.show(err.message);
            }
          }}
        />
      ) : null}
      {sheet ? (
        <MarkerSheet
          comments={sheetComments}
          replies={replies}
          chapters={book.chapters}
          selfId={selfId}
          onClose={() => setSheet(null)}
          onDelete={(c) => {
            void api
              .deleteComment(c.id)
              .then(() => {
                removeComment(qc, book.id, c.id);
                setSheet(null);
              })
              .catch(() => toast.show('Could not delete the note.', 'error'));
          }}
          onGo={(c) => {
            const l = epubLocatorOf(book, edition, c);
            if (l) void lookTo(l).then(() => setSheet([c.id]));
          }}
          {...(reloc && looking.current && pastWhereRead({ start: tOf(edition, reloc.start), end: tOf(edition, reloc.end) }, furthestRead()) ? { onReadHere: () => readFromHere() } : {})}
        />
      ) : null}
    </div>
  );
}
