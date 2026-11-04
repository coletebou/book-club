import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  type AudioLocator,
  type BookProgress,
  type CommentView,
  REACTIONS,
  REACTION_LABELS,
  type Reaction,
  SKIP_BACK_SECONDS,
  SKIP_FORWARD_SECONDS,
  chapterEnd,
  chapterHeading,
  listeningLabel,
  namesChapter,
  numbersOneChapter,
  formatDuration,
  formatPercent,
  locatorToM,
  rangesCoverage,
  tToLocator,
} from '@bookclub/shared';
import { NARROW_PLAYER_PX, useClubCalContext, useNarrow } from '../cal/CalLauncher';
import { openCal } from '../cal/calStore';
import { coverSrc } from '../components/BookCard';
import { ClubBar, barMembers } from '../components/ClubBar';
import { Icon } from '../components/Icon';
import { ChatSheet } from '../live/ChatSheet';
import { PartyBar } from '../live/PartyBar';
import { VoiceBar } from '../live/VoiceBar';
import { type MeetingReachedInfo, meetingReachedInfo } from '../components/Meeting';
import { Splash } from '../components/Splash';
import { useToast } from '../components/Toasts';
import { api, newClientId } from '../lib/api';
import { CUE_HERE_MS, howFarBack, noteCue } from '../lib/further';
import { localPosition } from '../lib/outbox';
import { keys, mergeComment, useBook, useChatUnread, useComments, useListening, useParty, useProgress, useSession } from '../lib/queries';
import { catchUpTo, textFor } from '../lib/two-formats';
import { allowAudioOnly, readAlongFromListen } from './allow-audio-only';
import { useClubPresence } from '../lib/realtime';
import { splitThreads } from '../lib/threads';
import { type ChapterEndInfo, FinishedCard, MarkerSheet, NoteComposer, StopOrChapterEndCard, chapterEndInfo, firstTimeAtEnd } from '../reader/panels';
import { type Heard, followListening } from './arrival';
import { chapterAt, chapterNamedAt, chaptersInTrack, listEntries, trackLabel, trackName, unitIndexAtM } from './tracks';
import { startPosition, tOf, timelineOf, translatePlace } from '../reader/position';
import { useAudio, useAudioState } from './AudioProvider';
import { followAlongChanged } from './follow-along';
import { ReadAlongPanel } from './ReadAlong';
import { PlayPauseButton } from './PlayPauseButton';
import { SpeedButton } from './SpeedControl';
import { type OpeningRate, currentDefaultRate, openingRate } from './speed-memory';
import { atBookStart, chapterStep, chapterStops } from './now-playing';
import { newerSave, placeFromElsewhere } from '../reader/elsewhere';
import { placesSavedHere, savedFromHere } from '../lib/saved-here';
import { keptForLater } from '../lib/kept';

function audioLocatorOf(edition: NonNullable<ReturnType<typeof useAudioState>['edition']>, c: CommentView): AudioLocator | null {
  if (c.editionId === edition.id && c.locator.kind === 'audio') return c.locator;
  const tl = timelineOf(edition);
  if (!tl) return null;
  const l = tToLocator(tl, c.t);
  return l.kind === 'audio' ? l : null;
}

/** /books/:bookId/listen?edition=…&at=t */
export default function ListenPage() {
  const { bookId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const book = useBook(bookId);
  const progress = useProgress(bookId, { fresh: true });
  const allComments = useComments(bookId);
  // Notes have places in the book; the replies under them are shown with their note (D48).
  const threads = useMemo(() => splitThreads(allComments.data ?? []), [allComments.data]);
  const comments = { data: allComments.data ? threads.notes : undefined };
  const session = useSession();
  // Your default speed (D195), for a book you have not chosen one for: wanted before it loads.
  const listeningSettings = useListening(!!session.data?.user);
  /** The speed this page opened its book at, and whether it was the book's own (D195). */
  const openedAt = useRef<({ readonly bookId: string } & OpeningRate) | null>(null);
  // Read when the book loads, never a reason to load again: loading waits for nothing new (D195).
  const listeningRef = useRef({ userId: session.data?.user?.id, settings: listeningSettings.data });
  listeningRef.current = { userId: session.data?.user?.id, settings: listeningSettings.data };
  const presence = useClubPresence(book.data?.clubId);
  // Ask Cal from the player's own header (D170): no floating button here, where it would sit over
  // Play or the scrubber.
  const cal = useClubCalContext();
  // A portrait phone's header has no room left for Chat beside Track list (app.css, D170, D173):
  // there it moves into the player's own content instead (below, by the transport controls),
  // same button, same badge, same ChatSheet — never dropped, just moved where there is room.
  const narrowPlayer = useNarrow(NARROW_PLAYER_PX);
  const audio = useAudio();
  const state = useAudioState();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  /** Whether this visit to the player already went to your newest place (D186). */
  const caughtUp = useRef(false);
  /** Leaving for the book (D194): the player must not load the audiobook again behind it (a late progress refetch would). */
  const leaving = useRef(false);
  const party = useParty(bookId);
  const [composer, setComposer] = useState<AudioLocator | null>(null);
  const [sheet, setSheet] = useState<string[] | null>(null);
  // A link to a note (from the book page or a notification) opens it here, as the readers do.
  const commentParam = params.get('comment');
  useEffect(() => {
    if (!commentParam || !allComments.data?.some((c) => c.id === commentParam)) return;
    const note = allComments.data.find((c) => c.id === commentParam)!;
    setSheet([note.parentId ?? note.id]);
    const next = new URLSearchParams(params);
    next.delete('comment');
    setParams(next, { replace: true });
  }, [commentParam, allComments.data, params, setParams]);
  const [showTracks, setShowTracks] = useState(false);
  // The list opens at the end of the page: bring it into view, or the tap seems to do nothing.
  const tracksRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (showTracks) tracksRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [showTracks]);
  // The club's chat and voice, opened over the player without leaving it (D173): the audiobook
  // keeps playing underneath, same as it does behind the track list above.
  const [chatOpen, setChatOpen] = useState(false);
  const chatUnread = useChatUnread(book.data?.clubId);
  const selfId = session.data?.user?.id;

  const edition = useMemo(() => {
    const audios = book.data?.editions.filter((e) => e.kind === 'audio' && e.status === 'ready') ?? [];
    return audios.find((e) => e.id === params.get('edition')) ?? audios[0];
  }, [book.data, params]);

  // Your place moved on another device while the player here was paused (D70): it goes there, or
  // pressing Play would put the old place back over the newer one. Playing here is listening here.
  const mineSaved = progress.data?.members.find((m) => m.userId === selfId);
  const knownSave = useRef(mineSaved?.updatedAt ?? null);
  useEffect(() => {
    if (!newerSave(mineSaved?.updatedAt, knownSave.current)) return;
    // As in the reader: the first saved place heard of is the one the player opened with.
    const first = knownSave.current === null;
    knownSave.current = mineSaved!.updatedAt;
    if (first) return;
    const here = audio.locator();
    if (!edition || !book.data || state.playing || state.edition?.id !== edition.id || !here) return;
    const found = placeFromElsewhere(mineSaved, tOf(edition, here), placesSavedHere(book.data.id));
    const there = found ? translatePlace(book.data, edition, { t: found.t, kind: mineSaved?.kind }) : null;
    if (!found || there?.kind !== 'audio') return;
    audio.catchUp(there);
    toast.show(`You went on to ${found.label} on another device: the player is there now.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mineSaved?.updatedAt]);

  // The moments of reading, while listening: the end of a chapter (what friends said in it), the
  // end of the book, and passing the place where a friend left a note.
  const [endOfChapter, setEndOfChapter] = useState<ChapterEndInfo | null>(null);
  const [finished, setFinished] = useState<{ finished: boolean; coverage: number } | null>(null);
  /** A friend's note told of as you pass it, or as it opens behind you (`back`: how far, in ms). */
  const [cue, setCue] = useState<{ note: CommentView; back: number | null } | null>(null);
  const cueShown = useRef(false);
  cueShown.current = cue !== null;
  const cued = useRef(new Set<string>());
  const seenEnd = useRef(state.ended?.at ?? null);
  const listening = !!edition && state.edition?.id === edition.id;
  useEffect(() => {
    const ended = state.ended;
    const b = book.data;
    if (!ended || !b || !edition || !listening || ended.at === seenEnd.current) return;
    seenEnd.current = ended.at;
    if (ended.track + 1 < edition.tracks.length) return;
    const mine = qc.getQueryData<BookProgress>(keys.progress(b.id))?.mine;
    if (firstTimeAtEnd(b.id, selfId, mine?.finished ?? false)) setFinished({ finished: mine?.finished ?? false, coverage: rangesCoverage(mine?.readRanges ?? []) });
  }, [state.ended, book.data, edition, listening, qc, selfId]);
  // Friends' notes that opened while you listened (one made in another format opens a little
  // after its place, D63): they are told when they open, however far back their place is by then.
  const seenHidden = useRef(new Set<string>());
  const openedNow = useRef(new Set<string>());
  useEffect(() => {
    for (const c of comments.data ?? []) {
      if (c.hidden) seenHidden.current.add(c.id);
      else if (seenHidden.current.delete(c.id)) openedNow.current.add(c.id);
    }
  }, [comments.data]);
  const urged = useRef(new Set<string>());
  useEffect(() => {
    if (!state.playing || !edition?.geometry || !listening) return;
    const geometry = edition.geometry;
    // Measured in the whole audiobook, so a note just before a track's end is still near after it.
    const nowM = locatorToM(geometry, { kind: 'audio', track: state.track, ms: state.position * 1000 });
    for (const c of comments.data ?? []) {
      if (c.userId === selfId || cued.current.has(c.id)) continue;
      const l = audioLocatorOf(edition, c);
      const near = l ? nowM - locatorToM(geometry, l) : -1;
      if (near < 0) continue;
      // Heard a closed note's place: send what was heard now, as the reader does for a note on
      // the page in front of you, so that it opens (if it can yet) while you are still there.
      // A note ahead of you, placed only roughly (D80), is no place to arrive at.
      if (c.hidden && c.approx) continue;
      if (c.hidden) {
        if (near < CUE_HERE_MS && !urged.current.has(c.id)) {
          urged.current.add(c.id);
          void audio.saveNow();
        }
        continue;
      }
      // Never a note still closed to you: its words would not be there to show. One that opened
      // behind you waits for the cue on screen to go, rather than replace it.
      const how = noteCue(near, openedNow.current.has(c.id));
      if (how === 'here' || (how === 'back' && !cueShown.current)) {
        cued.current.add(c.id);
        setCue({ note: c, back: how === 'back' ? near : null });
        break;
      }
    }
  }, [state.position, state.playing, state.track, edition, listening, comments.data, selfId, audio]);
  useEffect(() => {
    if (!cue) return;
    const timer = setTimeout(() => setCue(null), 10_000);
    return () => clearTimeout(timer);
  }, [cue]);
  // Listening on past a chapter's end (at a track's end, or inside a file with chapters of its
  // own), and past the club's next stop (D53), as reading past them does.
  const [atStop, setAtStop] = useState<MeetingReachedInfo | null>(null);
  const lastHeard = useRef<Heard | null>(null);
  const progressMembers = progress.data?.members;
  useEffect(() => {
    const b = book.data;
    if (!b || !edition?.geometry || !listening) return;
    const here = { kind: 'audio' as const, track: state.track, ms: state.position * 1000 };
    const stop = b.meeting;
    const before = lastHeard.current;
    const moment = {
      t: tOf(edition, here),
      ms: locatorToM(edition.geometry, here),
      at: performance.now(),
      track: state.track,
      playing: state.playing,
      atTrackEnd: state.duration > 0 && state.position >= state.duration - 0.5,
      atTrackStart: state.position === 0,
    };
    const step = followListening(before, moment, stop?.t ?? null, state.rate);
    lastHeard.current = step.from;
    if (step.heard && before) {
      // A unit heard to its end: what friends said in its chapter.
      const was = unitIndexAtM(edition.units, before.ms);
      const is = unitIndexAtM(edition.units, moment.ms);
      const chapter = is > was ? edition.alignment.unitToChapter[is - 1] : null;
      const current = chapter != null ? b.chapters[chapter] : undefined;
      if (current) setEndOfChapter(chapterEndInfo(b.chapters, chapter!, comments.data ?? [], selfId, current.t, chapterEnd(b.chapters, chapter!)));
    }
    if (stop && step.arrived) setAtStop(meetingReachedInfo(stop, progressMembers ?? b.progress, selfId));
  }, [state.position, state.track, state.playing, state.rate, state.duration, book.data, edition, listening, progressMembers, comments.data, selfId]);

  // Load into the shared player once, at the right place (another format's position is translated).
  useEffect(() => {
    if (leaving.current || !book.data || !edition || !(progress.isFetchedAfterMount || progress.isError)) return;
    if (audio.state.edition?.id === edition.id) {
      // Forced alignment finished while this edition was already playing: refresh the snapshot
      // so pages follow the new sync (AudioProvider also watches book detail; this covers the
      // Listen page's own book.data refresh without waiting for that effect).
      if (followAlongChanged(audio.state.edition, edition)) {
        audio.load(book.data, edition, null);
      }
      // Already in the player: a link's place is still gone to, as a visit.
      const atParam = params.get('at');
      if (atParam === null) {
        // Paused since you read on (here or on another device): the player goes to your newest
        // place, or Play would start where you stopped listening, pages behind (D186). Once per
        // visit to the page, and never over a look or a party's shared place.
        if (caughtUp.current || audio.state.playing || audio.state.returnTo || party.data) return;
        caughtUp.current = true;
        const b = book.data;
        void localPosition(bookId).then((local) => {
          const to = catchUpTo(startPosition(b, edition, progress.data, local, null), edition, audio.locator());
          if (!to || audio.state.playing || audio.state.edition?.id !== edition.id) return;
          audio.catchUp(to);
        });
        return;
      }
      const start = startPosition(book.data, edition, progress.data, undefined, Number(atParam));
      if (start.locator?.kind === 'audio') audio.look(start.locator.track, start.locator.ms / 1000);
      const next = new URLSearchParams(params);
      next.delete('at');
      setParams(next, { replace: true });
      return;
    }
    let cancelled = false;
    void localPosition(bookId).then((local) => {
      if (cancelled || !book.data) return;
      const atParam = params.get('at');
      const start = startPosition(book.data, edition, progress.data, local, atParam !== null ? Number(atParam) : null);
      // The place the player opens at is one this device knows (D70): hearing of it is no news.
      if (start.locator?.kind === 'audio') savedFromHere(book.data.id, tOf(edition, start.locator));
      // Opened where you stopped reading: said so, as the book says where you stopped listening (D186).
      if (start.source === 'other-format' && start.locator?.kind === 'audio') {
        caughtUp.current = true;
      }
      const resume = start.resume?.kind === 'audio' ? start.resume : null;
      // The speed it opens at (D195): this book's last, else your default, else 1.0×. Never waits
      // for the default: the best one known now, and the server's below if it differs.
      const opening = openingRate(listeningRef.current.userId, book.data.id, { playback: progress.data?.playback, settings: listeningRef.current.settings });
      openedAt.current = { bookId: book.data.id, ...opening };
      audio.load(book.data, edition, start.locator?.kind === 'audio' ? start.locator : null, { look: start.source === 'link', returnTo: resume, rate: opening.rate });
      // A link's place is used once: a reload continues where you are listening.
      if (atParam !== null) {
        const next = new URLSearchParams(params);
        next.delete('at');
        setParams(next, { replace: true });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [book.data, edition, progress.isFetchedAfterMount, progress.isError, progress.data, audio, bookId, params, setParams, party.data, toast]);

  // Your default from the server, heard after a book with no speed of its own opened (D195): that
  // book plays at it, unless you have already chosen another speed in the meantime.
  const selfDefault = currentDefaultRate(session.data?.user?.id, listeningSettings.data);
  useEffect(() => {
    const opened = openedAt.current;
    if (!opened || opened.own || opened.bookId !== bookId || audio.state.book?.id !== bookId) return;
    if (audio.state.speed !== opened.rate || selfDefault === opened.rate) return;
    openedAt.current = { ...opened, rate: selfDefault };
    // The local engine's: a default is yours alone, never a speed sent to a listening party.
    audio.local.setRate(selfDefault, { fromDefault: true });
  }, [selfDefault, bookId, audio]);

  if (book.isError) {
    return (
      <div className="center-page">
        <h1>This book is not available</h1>
        <Link className="btn" to="/">
          Back to your clubs
        </Link>
      </div>
    );
  }
  if (!book.data) return <Splash label="Opening the audiobook" />;
  if (!edition) {
    return (
      <div className="center-page">
        <h1>No audiobook yet</h1>
        <Link className="btn" to={`/books/${bookId}`}>
          Back to the book
        </Link>
      </div>
    );
  }
  // No audio-only screen by default (D198): books with text open as text with the player docked.
  // Keep at/comment so history, "Listen from here", and note links still land on the right place.
  if (!allowAudioOnly() && book.data.editions.some((e) => e.status === 'ready' && e.kind !== 'audio')) {
    leaving.current = true;
    return <Navigate to={readAlongFromListen(bookId, edition.id, params)} replace />;
  }
  const b = book.data;
  const loaded = state.edition?.id === edition.id;
  const track = edition.tracks[loaded ? state.track : 0];
  const here: AudioLocator = { kind: 'audio', track: loaded ? state.track : 0, ms: Math.round((loaded ? state.position : 0) * 1000) };
  const t = tOf(edition, here);
  // The chapter being heard: in a track of several, the one at this moment of it (FR152).
  const chapterHere = chapterAt(edition, here.track, here.ms);
  // Where you are, as friends see it: the chapter whose track this is, during its announcement too.
  const heardLabel = listeningLabel(b.chapters, t, chapterHere);
  // A track that says it holds several chapters none of which was heard goes by its own name.
  const named = chapterNamedAt(edition, here.track, here.ms);
  const chapterName = named != null ? (b.chapters[named]?.title ?? null) : null;
  // The chapter buttons go where the lock screen's do (D190): chapters, not files, so a single-file
  // M4B's chapters are a tap away too.
  const stops = chapterStops(edition, b.chapters);
  const prevStop = chapterStep(stops, here, -1);
  const nextStop = chapterStep(stops, here, 1);
  const goTo = (stop: { track: number; ms: number } | null) => {
    if (stop) audio.setTrack(stop.track, stop.ms / 1000);
  };
  // Said once (FR157): the track's name beside the author only where it says more than the
  // chapter's (a track of several chapters, a part), never "01 - STORY OF THE DOOR" under it, nor
  // the recording's own count of its files ("Chapter 6" under "IX. The Morlocks", FR161).
  const trackSays =
    chapterName && track?.title && !numbersOneChapter(track.title) && (chaptersInTrack(edition, here.track).length > 0 || !namesChapter(track.title, chapterName))
      ? trackName(edition, here.track)
      : null;
  const members = barMembers(b.id, progress.data?.members ?? b.progress, presence).map((m) =>
    m.userId === selfId && loaded ? { ...m, t, label: heardLabel, live: true, kind: 'audio' } : m,
  );
  const placed = (comments.data ?? [])
    .map((c) => ({ c, l: audioLocatorOf(edition, c) }))
    .filter((p): p is { c: CommentView; l: AudioLocator } => p.l !== null && p.l.track === here.track);
  const duration = loaded && state.duration > 0 ? state.duration : (track?.durationMs ?? 0) / 1000;
  const nearby = (comments.data ?? []).filter((c) => !c.hidden && Math.abs(c.t - t) < 0.01);

  // The book's text, where the narrator is (D197): this full player is a step aside from the book
  // (its track list, listening together), never a mode to be in. The audiobook goes on as it is,
  // docked under the page, and the pages follow the narrator while it plays; its place is saved
  // first, so the book opens there.
  const text = textFor(b.editions, edition);
  const showText = () => {
    if (!text) return;
    leaving.current = true;
    void audio
      .saveNow()
      .catch(() => undefined)
      .finally(() => navigate(`/books/${b.id}/read?edition=${text.id}`));
  };

  const react = async (reaction: Reaction) => {
    try {
      const created = await api.createComment(b.id, { editionId: edition.id, locator: here, reaction, clientId: newClientId() });
      mergeComment(qc, b.id, created);
      toast.show(`${reaction} pinned at ${formatDuration(here.ms)}.`);
    } catch (err) {
      if (keptForLater(err)) toast.show(err.message);
      else toast.show(err instanceof Error ? err.message : 'Could not save the reaction.', 'error');
    }
  };

  return (
    <div className="listen-page" data-testid="listen-page" data-track={here.track} data-ms={here.ms}>
      <header className="reader-header">
        <Link to={`/books/${b.id}`} className="icon-btn" aria-label={`Back to ${b.title}`}>
          <Icon name="back" />
        </Link>
        <div className="reader-title">
          <span className="reader-book">{b.title}</span>
          <span className="reader-chapter">{heardLabel}</span>
        </div>
        <button type="button" className="icon-btn" aria-label="Track list" aria-expanded={showTracks} onClick={() => setShowTracks((v) => !v)} data-testid="toggle-tracks">
          <Icon name="toc" />
        </button>
        {!narrowPlayer ? (
          <button type="button" className="icon-btn chat-sheet-btn" aria-label="Open the club's chat and voice" data-testid="open-chat-sheet" onClick={() => setChatOpen(true)}>
            <Icon name="comment" />
            {chatUnread.data && chatUnread.data.unread > 0 ? (
              <span className="badge" data-testid="chat-unread-badge">
                {chatUnread.data.unread}
              </span>
            ) : null}
          </button>
        ) : null}
        {cal.enabled && cal.clubId ? (
          <button type="button" className="icon-btn" aria-label="Ask Cal" data-testid="cal-launcher" onClick={() => openCal(cal.clubId!, b.id)}>
            <Icon name="sparkle" />
          </button>
        ) : null}
      </header>
      {chatOpen ? <ChatSheet clubId={b.clubId} onClose={() => setChatOpen(false)} /> : null}

      <div className="reader-bar">
        <ClubBar
          readRanges={progress.data?.mine?.readRanges}
          bookId={b.id}
          members={members}
          selfId={selfId}
          chapters={b.chapters}
          comments={comments.data ?? []}
          meeting={b.meeting}
          onComments={(cs) => {
            // One note you have heard: go and hear it (a visit). Notes ahead of you never move you.
            const only = cs.length === 1 && !cs[0]!.hidden ? cs[0]! : null;
            const l = only ? audioLocatorOf(edition, only) : null;
            if (l) audio.look(l.track, l.ms / 1000);
            setSheet(cs.map((c) => c.id));
          }}
        />
        {/* Listening together and talking while you do (D153, D155), on one line under the
            friends' places: part of the page's own bar row, so the player keeps its grid (the
            controls' row stays the one that scrolls) and Play its first screen. */}
        <div className="listen-live">
          <PartyBar bookId={b.id} clubId={b.clubId} editionId={edition.id} />
          <VoiceBar clubId={b.clubId} />
        </div>
      </div>

      <main id="main" className={`listen-main${edition.readAlong ? ' has-readalong' : ''}`}>
        {text ? (
          <div className="listen-formats">
            <button type="button" className="btn btn-small show-text" onClick={showText} data-testid="show-text">
              <Icon name="book" size={16} /> Show the text
            </button>
          </div>
        ) : null}
        <img className="listen-cover" src={coverSrc(b.coverUrl, 640)} width={280} height={420} alt={`Cover of ${b.title}`} />
        <h1 className="listen-title" data-testid="listen-title">{chapterName ? chapterHeading(chapterName) : (trackName(edition, here.track) ?? b.title)}</h1>
        <p className="muted listen-sub" data-testid="listen-sub">
          {trackSays ? `${trackSays} · ` : ''}
          {b.author}
        </p>

        <div className="scrubber">
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.floor(duration))}
            step={1}
            value={Math.floor(loaded ? state.position : 0)}
            // Until this audiobook is in the player, a scrub has nothing of its own to move: it would
            // be undone by the place the player opens at, or move another book's audio still playing.
            disabled={!loaded}
            onChange={(e) => audio.seek(Number(e.target.value))}
            aria-label="Position in this track"
            aria-valuetext={`${formatDuration(here.ms)} of ${formatDuration(duration * 1000)}`}
            data-testid="scrubber"
          />
          <div className="scrubber-marks" aria-hidden="true">
            {placed.map(({ c, l }) => (
              <span key={c.id} className={`scrub-mark${c.hidden ? ' is-hidden' : ''}`} style={{ left: `${Math.min(100, (l.ms / 1000 / Math.max(1, duration)) * 100)}%` }}>
                {c.reaction ?? '•'}
              </span>
            ))}
          </div>
          <div className="scrubber-times small muted">
            <span data-testid="time-current">{formatDuration(here.ms)}</span>
            <span>{formatPercent(t)} of the book</span>
            <span>−{formatDuration(Math.max(0, duration * 1000 - here.ms))}</span>
          </div>
        </div>

        {loaded && state.returnTo ? (
          <button type="button" className="btn btn-small back-chip-inline" data-testid="back-to-reading" onClick={() => audio.back()}>
            <Icon name="back" size={16} /> Back to {listeningLabel(b.chapters, tOf(edition, state.returnTo), chapterAt(edition, state.returnTo.track, state.returnTo.ms))}
          </button>
        ) : null}

        <div className="transport" role="group" aria-label="Playback">
          {/* Until this audiobook is in the player, none of these has anything of its own to move
              (as the scrubber above): they would move another book's audio still in the player. */}
          <button type="button" className="icon-btn" aria-label="Previous chapter" onClick={() => goTo(prevStop)} disabled={!loaded || !prevStop || atBookStart(stops, here)} data-testid="prev-track">
            <Icon name="prev" />
          </button>
          <button type="button" className="icon-btn transport-skip" aria-label={`Back ${SKIP_BACK_SECONDS} seconds`} onClick={() => audio.seekBy(-SKIP_BACK_SECONDS)} disabled={!loaded} data-testid="skip-back">
            <Icon name="back15" />
            <span className="skip-num">{SKIP_BACK_SECONDS}</span>
          </button>
          <PlayPauseButton loaded={loaded} />
          <button type="button" className="icon-btn transport-skip" aria-label={`Forward ${SKIP_FORWARD_SECONDS} seconds`} onClick={() => audio.seekBy(SKIP_FORWARD_SECONDS)} disabled={!loaded} data-testid="skip-forward">
            <Icon name="fwd30" />
            <span className="skip-num">{SKIP_FORWARD_SECONDS}</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Next chapter"
            onClick={() => goTo(nextStop)}
            disabled={!loaded || !nextStop}
            data-testid="next-track"
          >
            <Icon name="next" />
          </button>
        </div>

        <div className="listen-tools">
          {narrowPlayer ? (
            <button type="button" className="btn btn-small" aria-label="Open the club's chat and voice" data-testid="open-chat-sheet" onClick={() => setChatOpen(true)}>
              <Icon name="comment" size={16} /> Chat
              {chatUnread.data && chatUnread.data.unread > 0 ? (
                <span className="badge" data-testid="chat-unread-badge">
                  {chatUnread.data.unread}
                </span>
              ) : null}
            </button>
          ) : null}
          {/* Only once this book is in the player (D195): a speed chosen sooner would be the book
              playing before, and this one would open at its own speed over it. */}
          <SpeedButton bookId={b.id} disabled={!loaded} />
          <label className="speed">
            <span className="visually-hidden">Sleep timer</span>
            <select
              value={state.sleepAtTrackEnd ? 'track' : state.sleepUntil ? 'on' : 'off'}
              onChange={(e) => {
                const v = e.target.value;
                audio.setSleep(v === 'off' ? 'off' : v === 'track' ? 'track' : Number(v));
              }}
              data-testid="sleep"
            >
              <option value="off">Sleep: off</option>
              <option value="15">Sleep in 15 min</option>
              <option value="30">Sleep in 30 min</option>
              <option value="60">Sleep in 60 min</option>
              <option value="track">End of track</option>
              {state.sleepUntil ? <option value="on">Sleep at {new Date(state.sleepUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</option> : null}
            </select>
          </label>
          <button type="button" className="btn btn-small" onClick={() => setComposer(here)} data-testid="add-note">
            <Icon name="quill" size={16} /> Note here
          </button>
        </div>

        <div className="reaction-row" role="group" aria-label="React at this moment">
          {REACTIONS.map((r) => (
            <button key={r} type="button" className="reaction-btn" aria-label={`${REACTION_LABELS[r]} at this moment`} onClick={() => void react(r)}>
              {r}
            </button>
          ))}
        </div>

        {state.error ? (
          <p className="form-error" role="alert">
            {state.error}
          </p>
        ) : null}

        {/* Below the controls: its sentences change length as the narrator reads, and must never
            move Play, or push it off a phone's screen. */}
        <ReadAlongPanel bookId={b.id} edition={edition} track={here.track} ms={here.ms} onSeek={(seconds) => (loaded ? audio.seek(seconds) : audio.setTrack(here.track, seconds, true))} />


        {nearby.length > 0 ? (
          <section className="nearby" aria-label="Notes around this moment">
            <h2 className="section-title">Here in the book</h2>
            <ul>
              {nearby.map((c) => (
                <li key={c.id} className="note" data-testid="nearby-note">
                  <strong>{c.userId === selfId ? 'You' : c.authorName}</strong> {c.reaction ?? ''} {c.hidden ? null : c.text}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {showTracks ? (
          <section aria-labelledby="tracks-title" className="track-list" ref={tracksRef}>
            <h2 id="tracks-title" className="section-title">
              Tracks
            </h2>
            <ol>
              {listEntries(edition, b.chapters).map((entry, i, all) => {
                const next = all[i + 1];
                const current = here.track === entry.track && here.ms >= entry.ms && !(next && next.track === entry.track && here.ms >= next.ms);
                return (
                  <li key={`${entry.track}:${entry.ms}:${entry.depth ?? 0}`} className={entry.depth ? 'track-chapter' : undefined}>
                    {/* A chapter from the list is a look, as from the reader's contents (D58, D72):
                        your place stays, with a way back, until you press Play there. A chapter
                        inside a track goes to its start in the track (FR152). */}
                    <button
                      type="button"
                      className={`track-item${current ? ' is-current' : ''}`}
                      aria-current={current ? 'true' : undefined}
                      data-testid={entry.depth ? 'track-chapter' : 'track-item'}
                      onClick={() => audio.look(entry.track, entry.ms / 1000)}
                    >
                      <span>{entry.title}</span>
                      <span className="faint small">{formatDuration(entry.durationMs)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}
      </main>

      <StopOrChapterEndCard
        atStop={atStop}
        chapterEnd={endOfChapter}
        // Heard now: once that is saved, the notes open.
        onShow={(ids) => void audio.saveNow().then(() => setSheet(ids))}
        onCloseStop={() => setAtStop(null)}
        onCloseChapterEnd={() => setEndOfChapter(null)}
      />
      {cue ? (
        <div className="chapter-end" role="status" data-testid="note-cue">
          <span>
            {cue.note.reaction ?? '💬'} {cue.note.authorName} left a note {cue.back === null ? 'here' : howFarBack(cue.back)}
          </span>
          <span className="row">
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={() => {
                const id = cue.note.id;
                setCue(null);
                // Heard now: once that is saved, the note opens.
                void audio.saveNow().then(() => setSheet([id]));
              }}
            >
              Show
            </button>
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setCue(null)}>
              <Icon name="close" size={18} />
            </button>
          </span>
        </div>
      ) : null}
      {finished ? (
        <FinishedCard
          book={b}
          members={progress.data?.members ?? b.progress}
          selfId={selfId}
          finished={finished.finished}
          coverage={finished.coverage}
          notesClosed={(comments.data ?? []).filter((c) => c.hidden).length}
          onClose={() => setFinished(null)}
        />
      ) : null}
      {composer ? (
        <NoteComposer
          bookId={b.id}
          target={{ quote: null, where: `${formatDuration(composer.ms)} in ${trackLabel(edition, b.chapters, composer.track) ?? 'this track'}`, upTo: tOf(edition, composer) }}
          chapters={b.chapters}
          furthest={Math.max(mineSaved?.furthest ?? 0, progress.data?.mine?.furthest ?? 0)}
          members={progress.data?.members ?? b.progress}
          selfId={selfId}
          onClose={() => setComposer(null)}
          onSubmit={async ({ text, reaction, clientId, aboutHere, mediaIds }) => {
            try {
              const created = await api.createComment(b.id, {
                editionId: edition.id,
                locator: composer,
                ...(text ? { text } : {}),
                ...(reaction ? { reaction } : {}),
                ...(mediaIds.length > 0 ? { mediaIds } : {}),
                clientId,
                ...(aboutHere ? { aboutHere } : {}),
              });
              mergeComment(qc, b.id, created);
            } catch (err) {
              if (!keptForLater(err)) throw err;
              toast.show(err.message);
            }
          }}
        />
      ) : null}
      {sheet ? (
        <MarkerSheet
          comments={(comments.data ?? []).filter((c) => sheet.includes(c.id))}
          replies={threads.replies}
          chapters={b.chapters}
          selfId={selfId}
          onClose={() => setSheet(null)}
          onGo={(c) => {
            const l = audioLocatorOf(edition, c);
            if (l) audio.look(l.track, l.ms / 1000);
            setSheet([c.id]);
          }}
        />
      ) : null}
    </div>
  );
}

