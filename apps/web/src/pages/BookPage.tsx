import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Suspense, lazy, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { type BookDetail, type CommentView, type Edition, type MyProgress, type TranscriptionStatus, chapterLabel, formatBytes, formatDuration, locatorToT } from '@bookclub/shared';
import { coverSrc } from '../components/BookCard';
import { ClubBar, barMembers, placeText } from '../components/ClubBar';
import { MeetingCard } from '../components/Meeting';
import { MeetupQuestions } from '../components/MeetupQuestions';
import { Discussion } from '../components/Discussion';
import { Field, FormError } from '../components/Form';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toasts';
import { api } from '../lib/api';
import { confirmAction } from '../lib/confirm';
import { removeEditionOffline, saveEditionOffline, useEditionOffline } from '../lib/offline';
import { keys, removeComment, useBook, useClub, useComments, useProgress, useSession } from '../lib/queries';
import { useClubPresence } from '../lib/realtime';
import { placedBetween } from '../lib/matching';
import { splitThreads } from '../lib/threads';
import { type LocalPosition } from '../lib/db';
import { localPosition } from '../lib/outbox';
import { markArrival, noteLinkFrom, noteLinkTarget } from '../lib/note-link';
import { alongStart, elsewhereThan, formatActions } from '../lib/two-formats';
import { useAudio } from '../player/AudioProvider';
import { useAudioControls } from '../player/audio-controls';
import { timelineOf } from '../reader/position';

const UploadModal = lazy(() => import('../upload/UploadModal'));
const AlignmentModal = lazy(() => import('./AlignmentModal'));
const MarkerSheet = lazy(() => import('../reader/panels').then((m) => ({ default: m.MarkerSheet })));

export function editionHref(book: { id: string }, edition: Edition): string {
  return edition.kind === 'audio' ? `/books/${book.id}/listen?edition=${edition.id}` : `/books/${book.id}/read?edition=${edition.id}`;
}

/** Each format's icon; what its button says is formatActions' (D187). */
const ICON: Record<Edition['kind'], 'book' | 'page' | 'headphones'> = { epub: 'book', pdf: 'page', audio: 'headphones' };

function editionDetail(e: Edition): string {
  if (e.kind === 'audio') return `${e.tracks.length} tracks · ${formatDuration(e.durationMs ?? 0)}${e.readAlong ? ' · reads along' : ''}`;
  if (e.kind === 'pdf') return `${e.pageCount ?? 0} pages · ${formatBytes(e.sizeBytes)}`;
  return formatBytes(e.sizeBytes);
}

const TRANSCRIPTION_STAGE_LABEL: Record<TranscriptionStatus['stage'], string> = {
  queued: 'Waiting to transcribe…',
  uploading: 'Sending audio to the GPU…',
  transcribing_gpu: 'Transcribing on the GPU…',
  transcribing_cpu: 'Transcribing on this host…',
  aligning: 'Lining up with the text…',
  failed: 'Transcription failed',
};

/** "about 2 min left", "about 45 sec left", "about 1 h left". */
export function formatEta(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `about ${Math.max(1, sec)} sec left`;
  const min = Math.round(sec / 60);
  if (min < 60) return `about ${min} min left`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `about ${h} h left` : `about ${h} h ${rem} min left`;
}

function TranscriptionProgress({ status }: { status: TranscriptionStatus }) {
  const label = TRANSCRIPTION_STAGE_LABEL[status.stage];
  const pct = status.fraction != null ? Math.round(status.fraction * 100) : null;
  const tracks =
    status.tracksDone != null && status.tracksTotal != null
      ? `${status.tracksDone} of ${status.tracksTotal} tracks`
      : null;
  return (
    <div className="transcription-progress" data-testid="transcription-progress" data-stage={status.stage} role="status">
      <div className="transcription-meta small muted">
        <span>
          <span className="spinner spinner-inline" aria-hidden="true" /> {label}
        </span>
        {pct != null ? <span>{pct}%</span> : null}
        {tracks ? <span>{tracks}</span> : null}
        {status.etaMs != null && status.stage !== 'failed' && status.stage !== 'aligning' ? <span>{formatEta(status.etaMs)}</span> : null}
      </div>
      {status.fraction != null ? <progress value={status.fraction} max={1} aria-label={label} /> : <progress aria-label={label} />}
      {status.stage === 'failed' && status.message ? <p className="small error-text">{status.message}</p> : null}
    </div>
  );
}

/**
 * Your place as the book page shows it: the server's, unless this device has a newer one it has
 * not sent yet (read offline): then that, so the page never contradicts what you just read.
 */
function newerLocalPlace(book: BookDetail, mine: MyProgress | null | undefined, local: LocalPosition | undefined): MyProgress | null | undefined {
  if (!local || (mine && mine.at >= local.at)) return mine;
  const edition = book.editions.find((e) => e.id === local.editionId);
  const tl = edition ? timelineOf(edition) : null;
  if (!edition || !tl) return mine;
  const t = locatorToT(tl, local.locator);
  return { editionId: edition.id, locator: local.locator, t, label: chapterLabel(book.chapters, t), readRanges: mine?.readRanges ?? [], furthest: Math.max(mine?.furthest ?? 0, t), finished: mine?.finished ?? false, at: local.at };
}

export function BookPage() {
  const { bookId = '' } = useParams();
  const progress = useProgress(bookId);
  const [local, setLocal] = useState<LocalPosition | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void localPosition(bookId).then((p) => {
      if (live) setLocal(p);
    });
    return () => {
      live = false;
    };
  }, [bookId, progress.dataUpdatedAt]);
  const allComments = useComments(bookId);
  const threads = useMemo(() => splitThreads(allComments.data ?? []), [allComments.data]);
  const comments = { data: allComments.data ? threads.notes : undefined };
  // A link to a note (a notification): once it is on the page, which needs both the book and the
  // discussion (whichever arrives last), and only once per link, the note, or the answer in its
  // conversation the link is to, is brought into view, marked and given the focus.
  const location = useLocation();
  const book = useBook(bookId);
  const arrived = useRef<string | null>(null);
  useEffect(() => {
    const link = noteLinkFrom(location.hash, location.state);
    if (!link || !allComments.data || !book.data || arrived.current === location.key + location.hash) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const el = noteLinkTarget(link);
      if (el) {
        arrived.current = location.key + location.hash;
        markArrival(el);
      } else if (tries++ < 30) frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [location.hash, location.key, location.state, allComments.data, book.data]);
  const session = useSession();
  const club = useClub(book.data?.clubId);
  const presence = useClubPresence(book.data?.clubId);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const audio = useAudio();
  // The audiobook's controls, hidden for this book or every book (D197).
  const audioControls = useAudioControls(bookId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [aligning, setAligning] = useState<Edition | null>(null);
  const [bookSettings, setBookSettings] = useState(false);
  const [sheet, setSheet] = useState<string[] | null>(null);
  const selfId = session.data?.user?.id;

  const deleteComment = useMutation({
    mutationFn: (c: CommentView) => api.deleteComment(c.id),
    onSuccess: (_d, c) => removeComment(qc, bookId, c.id),
    onError: () => toast.show('Could not delete the note.', 'error'),
  });

  if (book.isError) {
    return (
      <div className="center-page">
        <h1>Book not found</h1>
        <Link className="btn" to="/">
          Back to your clubs
        </Link>
      </div>
    );
  }
  if (!book.data) return <div className="spinner" role="status" aria-label="Loading book" />;
  const b = book.data;
  const mine = newerLocalPlace(b, progress.data?.mine, local);
  const members = barMembers(b.id, progress.data?.members ?? b.progress, presence);
  const isOwner = club.data?.role === 'owner';
  const canManage = isOwner || b.addedBy === selfId;
  const ready = b.editions.filter((e) => e.status === 'ready');
  const hasText = ready.some((e) => e.kind !== 'audio');
  const hasAudio = ready.some((e) => e.kind === 'audio');
  /** Listening, from the tap that asks for it (D194, D197): the audiobook loaded at your place and playing before the book opens. */
  const startListening = (audiobook: Edition) => {
    const at = alongStart(b, audiobook, mine);
    // Paused somewhere else (heard yesterday, read on since): to your place first.
    if (at && audio.state.edition?.id === audiobook.id && !audio.state.playing && elsewhereThan(audiobook, audio.locator(), at)) audio.catchUp(at);
    audio.load(b, audiobook, at, { play: true });
  };

  const openComment = (c: CommentView) => {
    // In the format you read (or listen) in, at the note's place: a reader is not sent to the
    // player for a note a listener made. Someone with no place yet gets the note's own format.
    const own = mine?.editionId ? ready.find((e) => e.id === mine.editionId) : undefined;
    const edition = own ?? ready.find((e) => e.id === c.editionId) ?? ready[0];
    if (edition) void navigate(`${editionHref(b, edition)}&at=${c.t.toFixed(6)}&comment=${c.id}`);
  };

  return (
    <article className="book-page stack-lg" aria-labelledby="book-title">
      <Link to={`/clubs/${b.clubId}`} className="back-link">
        <Icon name="back" size={18} /> {club.data?.name ?? 'Library'}
      </Link>
      <header className="book-hero">
        <img className="book-hero-cover" src={coverSrc(b.coverUrl, 640)} width={200} height={300} alt={`Cover of ${b.title}`} fetchPriority="high" />
        <div className="book-hero-text">
          <h1 id="book-title">{b.title}</h1>
          <p className="book-hero-author">{b.author}</p>
          {mine && mine.t > 0 ? (
            <p className="muted small" data-testid="my-position">
              {mine.finished ? 'You have finished it' : `You are at ${mine.label || chapterLabel(b.chapters, mine.t)}`}
            </p>
          ) : null}
        </div>
        <div className="book-hero-actions">
          <div className="format-actions">
            {/* One way in (D198): Continue (or Open) into the text; listening last also starts the audiobook. */}
            {formatActions(b, ready, mine, { audioHidden: audioControls.hidden }).map(({ edition: e, label, primary, along }) =>
              along ? (
                <Link
                  key={`continue-${e.id}-${along.id}`}
                  className={`btn${primary ? ' btn-primary' : ''}`}
                  to={`/books/${b.id}/read?edition=${e.id}&along=${along.id}`}
                  onClick={() => startListening(along)}
                  data-testid="open-continue"
                >
                  <Icon name="book" size={18} />
                  {label}
                </Link>
              ) : (
                <Link key={e.id} className={`btn${primary ? ' btn-primary' : ''}`} to={editionHref(b, e)} data-testid="open-continue">
                  <Icon name={ICON[e.kind]} size={18} />
                  {label}
                </Link>
              ),
            )}
            <button type="button" className="btn btn-ghost" onClick={() => setBookSettings(true)} data-testid="open-book-settings" aria-label="Book settings">
              <Icon name="settings" size={18} />
            </button>
          </div>
          <div className="book-tools">
            <Link className="btn btn-small btn-ghost" to={`/books/${b.id}/history`} data-testid="open-history">
              <Icon name="history" size={16} /> Your history
            </Link>
            {canManage ? (
              <>
                <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(true)}>
                  <Icon name="edit" size={16} /> Edit
                </button>
                <RemoveBookButton book={b} />
              </>
            ) : null}
          </div>
        </div>
      </header>

      <section aria-labelledby="where-title" className="card">
        <h2 id="where-title">Where everyone is</h2>
        <ClubBar
          readRanges={progress.data?.mine?.readRanges}
          bookId={b.id}
          members={members}
          selfId={selfId}
          chapters={b.chapters}
          comments={comments.data ?? []}
          meeting={b.meeting}
          // A note you may read opens at its passage; notes ahead of you never move you there.
          onComments={(cs) => (cs.length === 1 && !cs[0]!.hidden ? openComment(cs[0]!) : setSheet(cs.map((c) => c.id)))}
        />
        <ul className="member-progress">
          {members.map((m) => (
            <li key={m.userId} data-testid="member-progress" data-user={m.userId}>
              <span className="dot" style={{ background: m.color }} aria-hidden="true" />
              <span>{m.userId === selfId ? 'You' : m.displayName}</span>
              <span className="muted small">
                {m.finished && !m.live ? null : placeText(m)}
                {m.live ? ` · ${m.kind === 'audio' ? 'listening' : 'reading'} now` : ''}
              </span>
              {m.finished ? <span className="chip chip-gold">Finished</span> : null}
            </li>
          ))}
        </ul>
      </section>

      <MeetingCard book={b} progress={progress.data?.members ?? b.progress} selfId={selfId} />
      {b.meeting ? <MeetupQuestions bookId={b.id} clubId={b.clubId} selfId={selfId} /> : null}

      <section aria-labelledby="notes-title">
        <h2 id="notes-title" className="section-title">
          Notes and reactions
        </h2>
        <Discussion
          comments={comments.data ?? []}
          replies={threads.replies}
          chapters={b.chapters}
          selfId={selfId}
          canModerate={isOwner}
          onOpen={openComment}
          onDelete={(c) => deleteComment.mutate(c)}
        />
      </section>

      {adding ? (
        <Suspense fallback={null}>
          <UploadModal clubId={b.clubId} bookId={b.id} onClose={() => setAdding(false)} />
        </Suspense>
      ) : null}
      {editing ? <EditBookModal book={b} onClose={() => setEditing(false)} /> : null}
      {sheet ? (
        <Suspense fallback={null}>
          <MarkerSheet comments={(comments.data ?? []).filter((c) => sheet.includes(c.id))} replies={threads.replies} canModerate={isOwner} chapters={b.chapters} selfId={selfId} onClose={() => setSheet(null)} onGo={openComment} />
        </Suspense>
      ) : null}
      {bookSettings ? (
        <BookSettingsModal
          book={b}
          canManage={canManage}
          isOwner={isOwner}
          hasText={hasText}
          hasAudio={hasAudio}
          audioControls={audioControls}
          onAddFormat={() => {
            setBookSettings(false);
            setAdding(true);
          }}
          onAlign={(e) => {
            setBookSettings(false);
            setAligning(e);
          }}
          onClose={() => setBookSettings(false)}
        />
      ) : null}
      {aligning ? (
        <Suspense fallback={null}>
          <AlignmentModal book={b} edition={aligning} onClose={() => setAligning(null)} />
        </Suspense>
      ) : null}
    </article>
  );
}


/** Formats, hide-audiobook, and add-a-format (D198): off the book page's primary Continue. */
function BookSettingsModal({
  book,
  canManage,
  isOwner,
  hasText,
  hasAudio,
  audioControls,
  onAddFormat,
  onAlign,
  onClose,
}: {
  book: BookDetail;
  canManage: boolean;
  isOwner: boolean;
  hasText: boolean;
  hasAudio: boolean;
  audioControls: ReturnType<typeof useAudioControls>;
  onAddFormat: () => void;
  onAlign: (e: Edition) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Book settings" onClose={onClose}>
      <div className="stack" data-testid="book-settings">
        {hasText && hasAudio ? (
          <label className="setting-check">
            <input
              type="checkbox"
              checked={audioControls.hidden}
              onChange={(e) => audioControls.setBook(e.target.checked === audioControls.byDefault ? null : e.target.checked)}
              data-testid="book-hide-audio"
            />
            <span>
              Hide the audiobook in this book
              <span className="small muted setting-hint">Continue opens the text without starting the audiobook. Your default for every book is in Settings.</span>
            </span>
          </label>
        ) : null}
        <div>
          <h3 className="section-title">Formats</h3>
          <EditionList book={book} canManage={canManage} isOwner={isOwner} onAlign={onAlign} />
        </div>
        <button type="button" className="btn" onClick={onAddFormat} data-testid="add-format">
          <Icon name="plus" size={16} /> Add a format
        </button>
      </div>
    </Modal>
  );
}

function EditionList({ book, canManage, isOwner, onAlign }: { book: BookDetail; canManage: boolean; isOwner: boolean; onAlign: (e: Edition) => void }) {
  return (
    <ul className="edition-list" aria-label="Formats">
      {book.editions.map((e) => (
        <EditionRow key={e.id} book={book} edition={e} canManage={canManage} isOwner={isOwner} onAlign={onAlign} />
      ))}
    </ul>
  );
}

function EditionRow({ book, edition, canManage, isOwner, onAlign }: { book: BookDetail; edition: Edition; canManage: boolean; isOwner: boolean; onAlign: (e: Edition) => void }) {
  const [saved] = useEditionOffline(edition.id);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const toggleOffline = async () => {
    try {
      if (saved) {
        await removeEditionOffline(edition.id);
        toast.show('Removed from this device.');
      } else {
        setBusy('0%');
        const publication = edition.publicationUrl ? await api.publication(edition.publicationUrl) : null;
        await saveEditionOffline(book, edition, publication, (p) => setBusy(`${Math.round((p.done / p.total) * 100)}%`));
        toast.show('Saved for offline reading.');
      }
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not save offline.', 'error');
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    const what = edition.kind === 'audio' ? 'audiobook' : edition.kind.toUpperCase();
    if (!(await confirmAction({ title: `Delete the ${what} of “${book.title}”?`, body: 'The book and its notes stay.', confirm: 'Delete', cancel: 'Keep', danger: true }))) return;
    try {
      await api.deleteEdition(edition.id);
      await removeEditionOffline(edition.id);
      await qc.invalidateQueries({ queryKey: keys.book(book.id) });
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not delete this format.', 'error');
    }
  };
  // Reading along: a transcript of the audiobook (made with tools/align, or by any recogniser that
  // writes the same format) lines it up with the book's text sentence by sentence (D46).
  const transcriptInput = useRef<HTMLInputElement>(null);
  const hasText = book.editions.some((e) => e.kind === 'epub' && e.status === 'ready');
  const addTranscript = async (file: File) => {
    let doc: unknown;
    try {
      doc = JSON.parse(await file.text());
    } catch {
      toast.show('That file is not a transcript: choose the .json a speech recogniser wrote.', 'error');
      return;
    }
    try {
      await api.putTranscript(edition.id, doc);
      toast.show('Transcript added: lining the audiobook up with the text now.');
      await qc.invalidateQueries({ queryKey: keys.book(book.id) });
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not add the transcript.', 'error');
    }
  };
  const removeTranscript = async () => {
    if (!(await confirmAction({ title: 'Remove the transcript?', body: 'The audiobook goes back to following the book by chapters.', confirm: 'Remove', cancel: 'Keep', danger: true }))) return;
    try {
      await api.deleteTranscript(edition.id);
      await qc.invalidateQueries({ queryKey: keys.book(book.id) });
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not remove the transcript.', 'error');
    }
  };
  const label = edition.kind === 'epub' ? 'EPUB' : edition.kind === 'pdf' ? 'PDF' : 'Audiobook';
  // A format its chapters could not be matched in (an audiobook in parts, a PDF without bookmarks or
  // headings) follows the book from start to end only, and notes across formats wait for it (D73,
  // D74): its owner is told, and can match it by hand if it has more than one unit to match.
  const straightLine = isOwner && edition.status === 'ready' && edition.alignment.method === 'none';
  const matchable = edition.units.length > 1;
  // Some of its units matched to chapters, others placed between them (D77): its owner is told too.
  const between = isOwner && edition.status === 'ready' ? placedBetween(edition) : 0;
  const unitWord = edition.kind === 'audio' ? (between === 1 ? 'track' : 'tracks') : edition.kind === 'pdf' ? (between === 1 ? 'bookmark' : 'bookmarks') : between === 1 ? 'entry of its contents' : 'entries of its contents';
  return (
    <li className="edition-row" data-testid="edition" data-kind={edition.kind} data-status={edition.status}>
      <span className="chip">{label}</span>
      {edition.status === 'processing' ? (
        <span className="small muted" role="status">
          <span className="spinner spinner-inline" aria-hidden="true" /> Preparing…
        </span>
      ) : edition.status === 'failed' ? (
        <span className="small error-text">Could not be read: {edition.error}</span>
      ) : (
        <span className="small muted">{editionDetail(edition)}</span>
      )}
      {edition.kind === 'audio' && edition.transcription && !edition.readAlong ? <TranscriptionProgress status={edition.transcription} /> : null}
      <span className="edition-actions">
        {edition.status === 'ready' ? (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => void toggleOffline()} aria-pressed={saved} data-testid="offline-toggle" disabled={busy !== null}>
            <Icon name={saved ? 'check' : 'download'} size={16} /> {busy ?? (saved ? 'On this device' : 'Save offline')}
          </button>
        ) : null}
        {canManage ? (
          <FormatMenu
            label={label}
            onAlign={isOwner && edition.status === 'ready' && edition.alignment.method !== 'reference' && matchable ? () => onAlign(edition) : null}
            onTranscript={
              // The club owner's: a transcript lines up every member's audiobook (the server agrees).
              isOwner && edition.kind === 'audio' && edition.status === 'ready' && hasText
                ? edition.readAlong
                  ? { label: 'Remove the transcript', run: () => void removeTranscript() }
                  : { label: 'Add a transcript…', run: () => transcriptInput.current?.click() }
                : null
            }
            onDelete={() => void remove()}
          />
        ) : null}
        {isOwner && edition.kind === 'audio' ? (
          <input
            ref={transcriptInput}
            type="file"
            accept=".json,application/json"
            className="visually-hidden"
            aria-label="A transcript of the audiobook (JSON)"
            data-testid="transcript-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void addTranscript(file);
            }}
          />
        ) : null}
      </span>
      {straightLine ? (
        <p className="small muted" data-testid="straight-line" style={{ flexBasis: '100%', gridColumn: '1 / -1', margin: 0 }}>
          Lined up with the book from start to end only, not chapter by chapter
          {edition.kind === 'pdf' && edition.units.length === 0 ? ' (it has no bookmarks, and no chapter headings were found at the top of its pages)' : ''}
          : notes across formats open later.{' '}
          {matchable ? (
            <button type="button" className="btn btn-small btn-ghost" onClick={() => onAlign(edition)}>
              Match to chapters
            </button>
          ) : null}
        </p>
      ) : null}
      {between > 0 ? (
        <p className="small muted" data-testid="placed-between" style={{ flexBasis: '100%', gridColumn: '1 / -1', margin: 0 }}>
          {between} of {edition.units.length} {unitWord} matched no chapter and {between === 1 ? 'is' : 'are'} placed between the ones that did: notes across formats may open later there.{' '}
          <button type="button" className="btn btn-small btn-ghost" onClick={() => onAlign(edition)}>
            Match to chapters
          </button>
        </p>
      ) : null}
    </li>
  );
}

/**
 * The owner's (and uploader's) tools for one format, behind one button so the row stays about
 * reading: match tracks or contents to chapters, delete the format.
 */
function FormatMenu({
  label,
  onAlign,
  onTranscript,
  onDelete,
}: {
  label: string;
  onAlign: (() => void) | null;
  /** An audiobook: add (or remove) the transcript it reads along with. */
  onTranscript: { label: string; run: () => void } | null;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const close = () => setOpen(false);
  return (
    <span
      className="format-menu"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) close();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <button type="button" className="icon-btn" aria-label={`More for the ${label}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} data-testid="format-menu">
        <Icon name="menu" size={18} />
      </button>
      {open ? (
        <span className="format-menu-list" id={id}>
          {onAlign ? (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => {
                close();
                onAlign();
              }}
            >
              Match to chapters
            </button>
          ) : null}
          {onTranscript ? (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => {
                close();
                onTranscript.run();
              }}
            >
              {onTranscript.label}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-small btn-ghost btn-danger"
            onClick={() => {
              close();
              onDelete();
            }}
          >
            <Icon name="trash" size={16} /> Delete the {label}
          </button>
        </span>
      ) : null}
    </span>
  );
}

/** Take the book out of the club (D179): one confirmation, straight from the book's page. */
function useRemoveBook(book: BookDetail) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api.deleteBook(book.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.books(book.clubId) });
      void navigate(`/clubs/${book.clubId}`, { replace: true });
    },
  });
}

const confirmRemoveBook = (book: BookDetail) =>
  confirmAction({ title: `Remove “${book.title}” from the club?`, body: 'Its formats and notes go with it, for everyone in the club.', confirm: 'Remove', cancel: 'Keep', danger: true });

function RemoveBookButton({ book }: { book: BookDetail }) {
  const remove = useRemoveBook(book);
  const toast = useToast();
  return (
    <button
      type="button"
      className="btn btn-small btn-ghost btn-danger"
      data-testid="remove-book"
      disabled={remove.isPending}
      onClick={() =>
        void confirmRemoveBook(book).then(
          (yes) =>
            yes &&
            remove.mutate(undefined, { onError: (err) => toast.show(err instanceof Error ? err.message : 'Could not remove the book.', 'error') }),
        )
      }
    >
      <Icon name="trash" size={16} /> Remove book
    </button>
  );
}

function EditBookModal({ book, onClose }: { book: BookDetail; onClose: () => void }) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.updateBook(book.id, { title, author }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.book(book.id) });
      onClose();
    },
  });
  const remove = useRemoveBook(book);
  return (
    <Modal
      title="Edit book"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() =>
              void confirmRemoveBook(book).then((yes) => yes && remove.mutate())
            }
          >
            Remove book
          </button>
          <button type="button" className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <FormError error={save.error ?? remove.error} />
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Field label="Author" value={author} onChange={(e) => setAuthor(e.target.value)} />
      </div>
    </Modal>
  );
}
