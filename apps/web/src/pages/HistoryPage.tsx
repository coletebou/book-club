import { useInfiniteQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router';
import type { HistoryEntry, HistoryList } from '@bookclub/shared';
import { coverSrc } from '../components/BookCard';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { api } from '../lib/api';
import { confirmAction } from '../lib/confirm';
import { type HistoryBookDetail, entryHref, entryMeta, entryTitle, groupByDay, totalsLabel, totalsOf } from '../lib/history';
import { keys } from '../lib/queries';

/**
 * Your own reading and listening history (D191): /history across every book, /books/:id/history
 * for one. Line items by day, with each day's totals and the whole list's; a line opens the book
 * where that stretch began, in the format it was in (a look, with a way back: D58), and offers the
 * other format at the same place. Only ever your own: nobody else's history is shown, or kept for
 * you to see.
 */
export function HistoryPage() {
  const { bookId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const history = useInfiniteQuery({
    queryKey: keys.history(bookId ?? 'all'),
    queryFn: ({ pageParam }) => api.history(bookId, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last: HistoryList) => last.next,
  });
  const entries = useMemo(() => history.data?.pages.flatMap((p) => p.entries) ?? [], [history.data]);
  const listed = useMemo(() => {
    const map = new Map<string, HistoryList['books'][number]>();
    for (const p of history.data?.pages ?? []) for (const b of p.books) map.set(b.id, b);
    return map;
  }, [history.data]);
  // The books' chapters and formats (for "ch. 7–8", audio times and the other format), as the book page has them.
  const details = useQueries({
    queries: [...listed.keys()].map((id) => ({ queryKey: keys.book(id), queryFn: () => api.book(id), staleTime: 60_000 })),
  });
  const books = useMemo(() => {
    const map = new Map<string, HistoryBookDetail>();
    for (const [id, b] of listed) map.set(id, b);
    for (const d of details) {
      const detail = d.data;
      if (detail) map.set(detail.id, { ...listed.get(detail.id)!, chapters: detail.chapters, editions: detail.editions });
    }
    return map;
  }, [listed, details]);
  const days = useMemo(() => groupByDay(entries, Date.now()), [entries]);
  const totals = totalsLabel(totalsOf(entries));
  const book = bookId ? books.get(bookId) : undefined;

  const refresh = () => qc.invalidateQueries({ queryKey: ['history'] });
  const forget = async (entry: HistoryEntry) => {
    const yes = await confirmAction({ title: 'Forget this from your history?', body: 'Only the line goes: your place and what you have read stay as they are.', confirm: 'Forget', danger: true });
    if (!yes) return;
    await api.forgetHistoryEntry(entry.id);
    await refresh();
    toast.show('Forgotten.');
  };
  const forgetAll = async () => {
    if (!bookId) return;
    const yes = await confirmAction({ title: 'Forget all your history of this book?', body: 'Your place and what you have read stay as they are.', confirm: 'Forget it all', danger: true });
    if (!yes) return;
    await api.forgetBookHistory(bookId);
    await refresh();
    toast.show('Your history of this book is forgotten.');
  };

  return (
    <div className="stack-lg history" data-testid="history-page">
      <header className="history-head">
        {bookId ? (
          <Link className="btn btn-small btn-ghost" to={`/books/${bookId}`}>
            <Icon name="back" size={16} /> {book?.title ?? 'The book'}
          </Link>
        ) : null}
        <h1>{bookId ? 'Your history' : 'Your reading history'}</h1>
        <p className="muted small">
          {bookId ? 'What you read and heard of this book, and when.' : 'What you read and heard, and when.'} Only you see this.
        </p>
        {totals ? (
          <p className="history-total" data-testid="history-total">
            {totals}
          </p>
        ) : null}
      </header>

      {history.isPending ? <p className="muted">Loading…</p> : null}
      {history.isError ? <p className="error">Your history could not be loaded. Check your connection and try again.</p> : null}
      {history.isSuccess && entries.length === 0 ? (
        <p className="muted" data-testid="history-empty">
          Nothing yet. Read a few pages or listen for a minute and it shows here.
        </p>
      ) : null}

      {days.map((day) => (
        <section key={day.key} className="card history-day" aria-labelledby={`day-${day.key}`} data-testid="history-day">
          <h2 id={`day-${day.key}`} className="history-day-title">
            <span>{day.label}</span>
            <span className="small muted" data-testid="history-day-total">
              {totalsLabel(day.totals)}
            </span>
          </h2>
          <ul className="history-list">
            {day.entries.map((entry) => {
              const b = books.get(entry.bookId);
              const href = entryHref(entry, 'same', b);
              const other = entryHref(entry, 'other', b);
              const listened = entry.kind === 'audio';
              return (
                <li key={entry.id} className="history-entry" data-testid="history-entry" data-kind={entry.kind}>
                  {!bookId && b ? <img className="history-cover" src={coverSrc(b.coverUrl, 160)} alt="" width={36} height={54} loading="lazy" /> : null}
                  <Link className="history-go" to={href ?? `/books/${entry.bookId}`} data-testid="history-open">
                    <Icon name={listened ? 'headphones' : 'book'} size={18} />
                    <span className="history-text">
                      {!bookId && b ? <span className="history-book small muted">{b.title}</span> : null}
                      <span className="history-title" data-testid="history-title">
                        {entryTitle(entry, b)}
                      </span>
                      <span className="history-meta small muted" data-testid="history-meta">
                        {entryMeta(entry)}
                      </span>
                    </span>
                  </Link>
                  <span className="history-actions">
                    {other ? (
                      <Link className="btn btn-small btn-ghost" to={other} aria-label={listened ? 'Read from here' : 'Listen from here'} data-testid="history-other">
                        <Icon name={listened ? 'book' : 'headphones'} size={16} />
                        <span className="history-other-label">{listened ? 'Read' : 'Listen'}</span>
                      </Link>
                    ) : null}
                    <button type="button" className="icon-btn" aria-label="Forget this" onClick={() => void forget(entry)} data-testid="history-forget">
                      <Icon name="trash" size={16} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {history.hasNextPage ? (
        <button type="button" className="btn" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage} data-testid="history-older">
          {history.isFetchingNextPage ? 'Loading…' : 'Show older'}
        </button>
      ) : null}
      {bookId && entries.length > 0 ? (
        <button type="button" className="btn btn-small btn-ghost history-forget-all" onClick={() => void forgetAll()} data-testid="history-forget-all">
          Forget all your history of this book
        </button>
      ) : null}
    </div>
  );
}
