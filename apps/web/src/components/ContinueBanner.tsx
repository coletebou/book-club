import { Link } from 'react-router';
import type { BookSummary, MemberProgress } from '@bookclub/shared';
import { ALONG_RESUME } from '../lib/two-formats';
import { audioControlsHidden } from '../player/audio-controls';
import { coverSrc } from './BookCard';

/**
 * The book you read or heard last, one tap from opening the app (D198): always Continue into the
 * text when the book has any (the audiobook along if you were listening and have not hidden it);
 * the player only when the book is an audiobook alone.
 */
export function ContinueBanner({ book, mine, club, selfId }: { book: BookSummary; mine: MemberProgress; club?: string; selfId?: string }) {
  const hasText = book.kinds.some((k) => k !== 'audio');
  const along = hasText && mine.kind === 'audio' && !audioControlsHidden(selfId, book.id);
  const to = !hasText
    ? `/books/${book.id}/listen`
    : along
      ? `/books/${book.id}/read?along=${ALONG_RESUME}`
      : `/books/${book.id}/read`;
  return (
    <Link to={to} className="continue-banner" data-testid="continue-banner">
      <img className="continue-cover" src={coverSrc(book.coverUrl, 160)} alt="" width={40} height={60} />
      <span className="continue-text">
        <span className="continue-title">{book.title}</span>
        <span className="muted small">{[club, mine.label].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="btn btn-small btn-primary">Continue</span>
    </Link>
  );
}
