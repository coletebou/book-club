import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { type BookSummary, type ClubSummary, type EditionKind, LIMITS, type PresenceEntry, formatNames } from '@bookclub/shared';
import { coverSrc } from '../components/BookCard';
import { ContinueBanner } from '../components/ContinueBanner';
import { Field, FormError, TextArea } from '../components/Form';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ApiError, api } from '../lib/api';
import { keptBooks } from '../lib/offline';
import { keys, useChatUnread, useClubs, useSession } from '../lib/queries';
import { useClubPresence } from '../lib/realtime';
import { lastRead, orderBooks } from './LibraryPage';

/** The covers a club shows on the home page; the rest are in its library. */
const SHELF = 4;

/** What friends are doing in a book, in words: listening is not reading. */
function doing(kinds: readonly (EditionKind | null)[], one: boolean): string {
  const be = one ? 'is' : 'are';
  if (kinds.every((k) => k === 'audio')) return `${be} listening to`;
  if (kinds.every((k) => k !== 'audio')) return `${be} reading`;
  return `${be} in`;
}

/**
 * A club's line on the home page: who is in one of its books right now (the book most of them are
 * in), else who is reading the book a friend read last. Never you, and nothing when no friend has
 * begun one.
 */
export function clubNow(books: readonly BookSummary[], presence: ReadonlyMap<string, PresenceEntry>, selfId: string | undefined): { text: string; live: boolean } | null {
  const title = (b: BookSummary) => `“${b.title}”`;
  const here = new Map<string, PresenceEntry[]>();
  for (const p of presence.values()) {
    if (p.userId === selfId || !p.reading || !books.some((b) => b.id === p.reading!.bookId)) continue;
    here.set(p.reading.bookId, [...(here.get(p.reading.bookId) ?? []), p]);
  }
  const busiest = books.filter((b) => here.has(b.id)).sort((a, b) => here.get(b.id)!.length - here.get(a.id)!.length)[0];
  if (busiest) {
    const friends = here.get(busiest.id)!;
    const kinds = friends.map((p) => p.reading!.kind);
    return { text: `${formatNames(friends.map((p) => p.displayName))} ${doing(kinds, friends.length === 1)} ${title(busiest)} now`, live: true };
  }
  const readers = (b: BookSummary) => b.progress.filter((p) => p.userId !== selfId && !p.finished && (p.t > 0 || p.updatedAt));
  const lastAt = (b: BookSummary) => Math.max(...readers(b).map((p) => (p.updatedAt ? Date.parse(p.updatedAt) : 0)));
  const current = books.filter((b) => readers(b).length > 0).sort((a, b) => lastAt(b) - lastAt(a))[0];
  if (!current) return null;
  const friends = readers(current);
  return { text: `${formatNames(friends.map((p) => p.displayName))} ${doing(friends.map((p) => p.kind), friends.length === 1)} ${title(current)}`, live: false };
}

/**
 * Home: straight into your club when you have one. With several, the book you read or heard last
 * comes first, one tap from your place in it, whichever club it is in; then each club with its
 * books and who is reading what: opening the app is about reading, not a menu of clubs. Starting
 * a club and joining one with a link or code are always on offer here (every signed-in account may
 * start a club; reversing D52's "an invite first" restriction on upstream accounts was Cole's call).
 */
export function HomePage() {
  const clubs = useClubs();
  const session = useSession();
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  // The club list cannot be had now (offline, and never kept on this device): not "no clubs",
  // and not a blank page while the next try waits for the network.
  if (!clubs.data && clubs.failureReason instanceof ApiError && clubs.failureReason.code === 'offline') return <OfflineHome />;
  if (clubs.isPending) return null;
  if (clubs.isError && !clubs.data) return <ClubsUnavailable onRetry={() => void clubs.refetch()} />;
  const list = clubs.data ?? [];
  if (list.length === 1) return <Navigate to={`/clubs/${list[0]!.id}`} replace />;
  return (
    <section className="stack-lg" aria-labelledby="clubs-title">
      <div className="section-head">
        <h1 id="clubs-title">Your clubs</h1>
        <div className="row">
          <button type="button" className="btn btn-ghost" onClick={() => setJoining(true)}>
            Join with a link
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            Start a club
          </button>
        </div>
      </div>
      {list.length === 0 ? (
        <div className="card empty">
          <p>You are not in a club yet. Start one, or open an invite link a friend sent you.</p>
        </div>
      ) : (
        <ClubsReading clubs={list} selfId={session.data?.user?.id} />
      )}
      {creating ? <CreateClubModal onClose={() => setCreating(false)} /> : null}
      {joining ? <JoinByLinkModal onClose={() => setJoining(false)} /> : null}
    </section>
  );
}

/** From a pasted invite link or a bare code, the code alone: a URL's last `/join/` segment, else the whole thing, trimmed. */
export function inviteCodeFrom(input: string): string {
  const trimmed = input.trim();
  const at = trimmed.lastIndexOf('/join/');
  const tail = at === -1 ? trimmed : trimmed.slice(at + '/join/'.length);
  return (tail.split(/[?#]/)[0] ?? '').trim();
}

/** A short way in from the home page: paste the link a friend sent, or just the code, and go open it. */
function JoinByLinkModal({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState('');
  const navigate = useNavigate();
  const code = inviteCodeFrom(value);
  return (
    <Modal title="Join with a link or code" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (code) void navigate(`/join/${code}`);
        }}
      >
        <Field label="Invite link or code" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://… or the code a friend sent you" autoFocus />
        <button type="submit" className="btn btn-primary" disabled={!code}>
          Continue
        </button>
      </form>
    </Modal>
  );
}

/** Your clubs and their books, with the book you read or heard last on top. */
function ClubsReading({ clubs, selfId }: { clubs: readonly ClubSummary[]; selfId: string | undefined }) {
  // Each club's books, as its library has them (the same cache).
  const shelves = useQueries({ queries: clubs.map((c) => ({ queryKey: keys.books(c.id), queryFn: () => api.books(c.id) })) });
  // Everything appears at once, so nothing moves under the thumb as the clubs' books come in; a
  // club whose books cannot be had now (offline and not kept here, a failure) shows without them.
  if (shelves.some((q) => q.isPending && !q.failureReason)) return <div className="spinner" role="status" aria-label="Loading your clubs" />;
  const last = lastRead(
    shelves.flatMap((q) => q.data ?? []),
    selfId,
  );
  return (
    <>
      {last ? <ContinueBanner book={last.book} mine={last.mine} club={clubs.find((c) => c.id === last.book.clubId)?.name} selfId={selfId} /> : null}
      <ul className="club-list club-list-home">
        {clubs.map((c, i) => (
          <ClubCard key={c.id} club={c} books={shelves[i]?.data} selfId={selfId} />
        ))}
      </ul>
    </>
  );
}

/** A club on the home page: its name, its books' covers (yours first), who is reading what, how
 *  many friends are online now, and unread chat. */
function ClubCard({ club, books, selfId }: { club: ClubSummary; books: readonly BookSummary[] | undefined; selfId: string | undefined }) {
  const presence = useClubPresence(club.id);
  const chatUnread = useChatUnread(club.id);
  const ordered = useMemo(() => orderBooks(books ?? [], selfId), [books, selfId]);
  const now = clubNow(ordered, presence, selfId);
  const more = ordered.length - SHELF;
  const online = [...presence.values()].filter((p) => p.online && p.userId !== selfId).length;
  const unread = chatUnread.data?.unread ?? 0;
  return (
    <li className="card club-card club-home" data-testid="club-card" data-club={club.id}>
      <div className="club-home-top">
        <Link className="club-home-head" to={`/clubs/${club.id}`}>
          <h2>{club.name}</h2>
          <span className="muted small">
            {club.memberCount} {club.memberCount === 1 ? 'reader' : 'readers'} · {club.bookCount} {club.bookCount === 1 ? 'book' : 'books'}
            {club.role === 'owner' ? ' · you run it' : ''}
          </span>
          {online > 0 ? (
            <span className="small club-online" data-testid="club-online">
              <span className="club-online-dot" aria-hidden="true" /> {online} {online === 1 ? 'friend' : 'friends'} online
            </span>
          ) : null}
        </Link>
        {unread > 0 ? (
          <Link className="club-chat-badge" to={`/clubs/${club.id}/chat`} data-testid="club-chat-unread" aria-label={`${unread} unread in ${club.name}'s chat`}>
            <Icon name="comment" size={14} />
            {unread}
          </Link>
        ) : null}
      </div>
      {ordered.length > 0 ? (
        <ul className="club-shelf" aria-label={`Books in ${club.name}`}>
          {ordered.slice(0, SHELF).map((b) => (
            <li key={b.id}>
              <Link to={`/books/${b.id}`} data-testid="shelf-book">
                <img src={coverSrc(b.coverUrl, 160)} alt={b.title} width={56} height={84} decoding="async" />
              </Link>
            </li>
          ))}
          {more > 0 ? (
            <li>
              <Link to={`/clubs/${club.id}`} className="club-shelf-more" aria-label={`${more} more ${more === 1 ? 'book' : 'books'} in ${club.name}`}>
                +{more}
              </Link>
            </li>
          ) : null}
        </ul>
      ) : null}
      {now ? (
        <p className={`small club-now${now.live ? ' is-live' : ''}`} data-testid="club-now">
          {now.text}
        </p>
      ) : null}
    </li>
  );
}

/** Start a club: a name, and a line for what it is about (both can change later). */
export function CreateClubModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api.createClub({ name, ...(description.trim() ? { description } : {}) }),
    onSuccess: async (club) => {
      await qc.invalidateQueries({ queryKey: keys.clubs });
      void navigate(`/clubs/${club.id}`);
    },
  });
  // D176: a cap on clubs owned per person (POST /api/clubs now 409s as `club_limit`). The plain
  // error already reads fine (the server's own words: "You already own N clubs..."); a way
  // forward beside it, and the submit disabled, is what makes it feel like an answer, not a wall.
  const atLimit = create.error instanceof ApiError && create.error.code === 'club_limit';
  return (
    <Modal title="Start a club" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <FormError error={create.error} />
        {atLimit ? (
          <p className="muted small">
            <Link to="/settings">Manage your clubs</Link> to hand one to another member or delete one, then try again.
          </p>
        ) : null}
        <Field label="Club name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={LIMITS.clubName} placeholder="Thursday Readers" disabled={atLimit} />
        <TextArea
          label="What you are reading for (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={LIMITS.clubDescription}
          rows={2}
          placeholder="One chapter a week, over dinner."
          disabled={atLimit}
        />
        <button className="btn btn-primary" type="submit" disabled={create.isPending || !name.trim() || atLimit}>
          Create club
        </button>
      </form>
    </Modal>
  );
}

/** Online, but the club list did not come (the server failed): say so, and offer to try again. */
function ClubsUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="stack" aria-labelledby="clubs-error-title" data-testid="clubs-unavailable">
      <h1 id="clubs-error-title">Your clubs could not be loaded</h1>
      <p className="muted">Something went wrong on the server. Your reading is safe; try again in a moment.</p>
      <div>
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      </div>
    </section>
  );
}

/** Offline, before this device kept the club list: the books it did keep still open. */
function OfflineHome() {
  const [kept, setKept] = useState<{ bookId: string; title: string }[] | null>(null);
  useEffect(() => {
    void keptBooks().then(setKept);
  }, []);
  return (
    <section className="stack" aria-labelledby="offline-title" data-testid="offline-home">
      <h1 id="offline-title">You are offline</h1>
      <p className="muted">Your clubs will be here when you are back online.{kept && kept.length > 0 ? ' The books kept on this device open now:' : ''}</p>
      {kept && kept.length > 0 ? (
        <ul className="club-list">
          {kept.map((k) => (
            <li key={k.bookId}>
              <Link className="card club-card" to={`/books/${k.bookId}`}>
                <h2>{k.title}</h2>
              </Link>
            </li>
          ))}
        </ul>
      ) : kept ? (
        <div className="card empty">
          <p>No books are kept on this device yet: a book you open is kept for the next time you are offline.</p>
        </div>
      ) : null}
    </section>
  );
}
