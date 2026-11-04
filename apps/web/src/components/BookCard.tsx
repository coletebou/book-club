import { Link } from 'react-router';
import { type BookSummary, type PresenceEntry, formatNames } from '@bookclub/shared';
import { ALONG_RESUME } from '../lib/two-formats';
import { audioControlsHidden } from '../player/audio-controls';
import { ClubBar, barMembers } from './ClubBar';
import { Icon } from './Icon';
import { MeetingLine } from './Meeting';

const KIND_NAMES = { epub: 'EPUB', pdf: 'PDF', audio: 'Audio' } as const;

export function coverSrc(url: string, width: 160 | 320 | 640): string {
  return `${url}${url.includes('?') ? '&' : '?'}w=${width}`;
}

/**
 * The one step a book's card offers (D198): always into the text when the book has any, labelled
 * Continue once you have a place and Open before that. Listening last still opens the text, with
 * the audiobook along. An audiobook alone opens the player. Finished books, and books with nothing
 * ready, offer nothing.
 */
export function cardStep(book: Pick<BookSummary, 'id' | 'kinds' | 'progress'>, selfId: string | undefined): { label: string; to: string; testId: string } | null {
  const mine = book.progress.find((p) => p.userId === selfId);
  if (mine?.finished) return null;
  const hasText = book.kinds.some((k) => k !== 'audio');
  const hasAudio = book.kinds.includes('audio');
  if (!hasText && !hasAudio) return null;
  const placed = !!(mine && (mine.t > 0 || mine.updatedAt !== null));
  const label = placed ? 'Continue' : 'Open';
  const testId = placed ? 'card-continue' : 'card-start';
  if (!hasText) return { label, to: `/books/${book.id}/listen`, testId };
  // Hide-audiobook (per-book or default) skips along, same as the book page's Continue (D198).
  if (placed && mine.kind === 'audio' && !audioControlsHidden(selfId, book.id)) {
    return { label, to: `/books/${book.id}/read?along=${ALONG_RESUME}`, testId };
  }
  return { label, to: `/books/${book.id}/read`, testId };
}

/** A book in the library grid: cover, title, formats and where everyone is. */
export function BookCard({
  book,
  presence,
  selfId,
  eager,
}: {
  book: BookSummary;
  presence: ReadonlyMap<string, PresenceEntry>;
  selfId: string | undefined;
  eager?: boolean;
}) {
  const members = barMembers(book.id, book.progress, presence);
  const readingNow = members.filter((m) => m.live && m.userId !== selfId).map((m) => m.displayName);
  const started = book.progress.filter((p) => p.t > 0 || p.updatedAt).length;
  const finished = book.progress.filter((p) => p.finished).map((p) => (p.userId === selfId ? 'you' : p.displayName));
  const step = cardStep(book, selfId);
  return (
    <li className="book-card" data-testid="book-card" data-book={book.id}>
      <Link to={`/books/${book.id}`} className="book-card-link">
        <img
          className="book-cover"
          src={coverSrc(book.coverUrl, 320)}
          srcSet={`${coverSrc(book.coverUrl, 160)} 160w, ${coverSrc(book.coverUrl, 320)} 320w`}
          sizes="(max-width: 600px) 42vw, 180px"
          width={160}
          height={240}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          fetchPriority={eager ? 'high' : 'auto'}
          decoding="async"
          data-testid="book-cover"
        />
        <span className="book-card-text">
          <span className="book-title">{book.title}</span>
          <span className="book-author">{book.author}</span>
        </span>
      </Link>
      <div className="book-card-meta">
        <span className="kinds" aria-label={`Formats: ${book.kinds.map((k) => KIND_NAMES[k]).join(', ') || 'processing'}`}>
          {book.kinds.map((k) => (
            <span key={k} className="chip">
              {KIND_NAMES[k]}
            </span>
          ))}
        </span>
        {step ? (
          <Link to={step.to} className="btn btn-small btn-primary book-card-continue" data-testid={step.testId}>
            {step.label}
          </Link>
        ) : null}
        <ClubBar bookId={book.id} members={members} selfId={selfId} meeting={book.meeting} compact />
        {book.meeting ? <MeetingLine meeting={book.meeting} progress={book.progress} /> : null}
        <span className="small faint">
          {readingNow.length > 0 ? `${readingNow.join(', ')} reading now` : `${started} of ${book.progress.length} started`}
          {book.commentCount > 0 ? ` · ${book.commentCount} ${book.commentCount === 1 ? 'note' : 'notes'}` : ''}
        </span>
        {finished.length > 0 ? (
          <span className="small finished-line" data-testid="finished-by">
            <Icon name="check" size={14} /> Finished by {formatNames(finished)}
          </span>
        ) : null}
      </div>
    </li>
  );
}
