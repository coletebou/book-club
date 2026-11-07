import { type RefObject, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { BookSummary, MemberProgress } from '@bookclub/shared';
import { BookCard } from '../components/BookCard';
import { ContinueBanner } from '../components/ContinueBanner';
import { Icon } from '../components/Icon';
import { InstallHint } from '../components/InstallHint';
import { UpNextCard } from '../components/NextBook';
import { PresenceList } from '../components/People';
import { InviteButton } from '../components/InviteButton';
import { api } from '../lib/api';
import { confirmAction } from '../lib/confirm';
import { keys, useBooks, useChatUnread, useClub, useSession } from '../lib/queries';
import { useClubPresence } from '../lib/realtime';

const UploadModal = lazy(() => import('../upload/UploadModal'));

/** Your place in a book you are reading (begun and not finished): where "Read on" opens it. */
export function readingOn(book: BookSummary, selfId: string | undefined): MemberProgress | null {
  const mine = book.progress.find((p) => p.userId === selfId);
  return mine && !mine.finished && mine.updatedAt ? mine : null;
}

/** Of these books (one club's, or several clubs'), the one you read or heard last, and your place in it. */
export function lastRead(books: readonly BookSummary[], selfId: string | undefined): { book: BookSummary; mine: MemberProgress } | null {
  let last: { book: BookSummary; mine: MemberProgress } | null = null;
  let lastAt = -Infinity;
  for (const book of books) {
    const mine = readingOn(book, selfId);
    const at = mine ? Date.parse(mine.updatedAt!) : -Infinity;
    if (mine && at > lastAt) {
      last = { book, mine };
      lastAt = at;
    }
  }
  return last;
}

/** The club's most active book first: whoever read most recently, else the newest. */
export function orderBooks(books: readonly BookSummary[], selfId?: string): BookSummary[] {
  const lastActivity = (b: BookSummary) => Math.max(Date.parse(b.createdAt), ...b.progress.map((p) => (p.updatedAt ? Date.parse(p.updatedAt) : 0)));
  // The books you are reading come first, the one you read last at the top (its "Read on" is
  // then on the first screen): a friend adding a book does not push yours down.
  const yours = (b: BookSummary) => {
    const mine = readingOn(b, selfId);
    return mine ? Date.parse(mine.updatedAt!) : null;
  };
  return [...books].sort((a, b) => {
    const ya = yours(a);
    const yb = yours(b);
    if (ya !== null || yb !== null) return (yb ?? -Infinity) - (ya ?? -Infinity);
    return lastActivity(b) - lastActivity(a);
  });
}

/** Which way a strip that scrolls sideways has more to show: for the fade at its edges. */
function useMoreSideways(ref: RefObject<HTMLElement | null>): 'none' | 'left' | 'right' | 'both' {
  const [more, setMore] = useState<'none' | 'left' | 'right' | 'both'>('none');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setMore(left && right ? 'both' : left ? 'left' : right ? 'right' : 'none');
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    // The strip, and what is in it (members join), change size.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  });
  return more;
}

export function LibraryPage() {
  const { clubId = '' } = useParams();
  const club = useClub(clubId);
  const books = useBooks(clubId);
  const session = useSession();
  const presence = useClubPresence(clubId);
  const [uploading, setUploading] = useState(false);
  const selfId = session.data?.user?.id;
  const ordered = useMemo(() => orderBooks(books.data ?? [], selfId), [books.data, selfId]);
  const resume = lastRead(ordered, selfId);
  const membersRef = useRef<HTMLElement>(null);
  const more = useMoreSideways(membersRef);
  const chatUnread = useChatUnread(clubId);
  const qc = useQueryClient();
  const clearUpNext = useMutation({
    mutationFn: () => api.clearUpNext(clubId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.club(clubId) });
      void qc.invalidateQueries({ queryKey: keys.nextBook(clubId) });
    },
  });

  // Everything appears at once when the club and its books are in: nothing moves under the
  // reader's thumb as parts of the page arrive.
  if (club.isPending || (books.isPending && !club.isError)) {
    return (
      <div className="center-page">
        <div className="spinner" role="status" aria-label="Loading the club" />
      </div>
    );
  }

  if (club.isError) {
    return (
      <div className="center-page">
        <h1>Club not found</h1>
        <p className="muted">It may have been deleted, or you are not a member.</p>
        <Link className="btn" to="/">
          Your clubs
        </Link>
      </div>
    );
  }

  return (
    <div className="library stack-lg">
      <section className="club-head" aria-labelledby="club-title">
        <div className="club-head-text">
          <h1 id="club-title">{club.data?.name ?? ' '}</h1>
          {club.data?.description ? <p className="muted">{club.data.description}</p> : null}
        </div>
        <div className="club-actions">
          <button type="button" className="btn btn-primary" onClick={() => setUploading(true)}>
            <Icon name="upload" size={18} /> Add a book
          </button>
          <Link className="btn btn-ghost" to={`/clubs/${clubId}/chat`} data-testid="open-chat">
            <Icon name="comment" size={18} /> Chat
            {chatUnread.data && chatUnread.data.unread > 0 ? (
              <span className="badge" data-testid="chat-unread-badge">
                {chatUnread.data.unread}
              </span>
            ) : null}
          </Link>
          <Link className="btn btn-ghost" to={`/clubs/${clubId}/next-book`} data-testid="open-next-book">
            <Icon name="flag" size={18} /> Pick the next book
          </Link>
          {club.data?.invite ? <InviteButton url={club.data.invite.url} canRenew={club.data.role === 'owner'} /> : null}
          {club.data ? (
            <Link className="icon-btn" to={`/clubs/${clubId}/settings`} aria-label={club.data.role === 'owner' ? 'Club settings' : 'About this club'}>
              <Icon name="users" />
            </Link>
          ) : null}
        </div>
      </section>

      {/* The winner of the club's last round (D214): a way into the picker, and, for the owner,
          marking it done once the book is in (or that clears itself, D215). */}
      {club.data?.upNext ? (
        <UpNextCard
          clubId={clubId}
          upNext={club.data.upNext}
          canClear={club.data.role === 'owner'}
          onClear={() =>
            void confirmAction({ title: 'Mark Up next as done?', body: 'Clears it for everyone in the club.', confirm: 'Mark done', cancel: 'Keep it' }).then(
              (yes) => yes && clearUpNext.mutate(),
            )
          }
        />
      ) : null}

      {/* The book you read last, one tap from opening the app (INTENT: "He taps the book. It opens
          exactly where he stopped."), on the first screen whatever the phone. */}
      {resume ? <ContinueBanner book={resume.book} mine={resume.mine} selfId={selfId} /> : null}

      {/* A strip that scrolls sideways is a stop for the Tab key, so that the keyboard can scroll
          it too (WCAG 2.1.1); where everyone fits it is none. */}
      {club.data ? (
        <section
          aria-labelledby="members-title"
          className="members-panel"
          ref={membersRef}
          data-more={more}
          data-testid="members-panel"
          tabIndex={more === 'none' ? undefined : 0}
        >
          <h2 id="members-title" className="visually-hidden">
            Members
          </h2>
          <PresenceList members={club.data.members} presence={presence} selfId={selfId} books={books.data ?? []} />
        </section>
      ) : null}

      <section aria-labelledby="books-title">
        <h2 id="books-title" className="section-title">
          Books
        </h2>
        {books.isError ? (
          <div className="card empty" role="alert">
            <p>The books could not be loaded. Check the connection and try again.</p>
          </div>
        ) : ordered.length === 0 ? (
          <div className="card empty">
            <p>No books yet. Add the first one: an EPUB, a PDF, or a folder of audiobook tracks.</p>
          </div>
        ) : (
          <ul className="book-grid">
            {ordered.map((b, i) => (
              <BookCard key={b.id} book={b} presence={presence} selfId={selfId} eager={i < 4} />
            ))}
          </ul>
        )}
      </section>
      <InstallHint />
      {uploading ? (
        <Suspense fallback={null}>
          <UploadModal clubId={clubId} onClose={() => setUploading(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}
