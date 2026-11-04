import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { Edition } from '@bookclub/shared';
import { Splash } from '../components/Splash';
import { api } from '../lib/api';
import { type LocalPosition } from '../lib/db';
import { localPosition } from '../lib/outbox';
import { keys, useBook, useComments, useProgress, useSession } from '../lib/queries';
import { splitThreads } from '../lib/threads';
import { resolveAlong } from '../lib/two-formats';
import { type StartPosition, startPosition } from './position';
import { EpubReader } from './EpubReader';

const PdfReader = lazy(() => import('./PdfReader'));

export function pickEdition(editions: readonly Edition[], wanted: string | null, lastUsed: string | null | undefined): Edition | undefined {
  const readable = editions.filter((e) => e.status === 'ready' && e.kind !== 'audio');
  return readable.find((e) => e.id === wanted) ?? readable.find((e) => e.id === lastUsed) ?? readable.find((e) => e.kind === 'epub') ?? readable[0];
}

/** /books/:bookId/read?edition=…&at=t&comment=id&along=audioEditionId */
export default function ReaderPage() {
  const { bookId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const book = useBook(bookId);
  const progress = useProgress(bookId, { fresh: true });
  const comments = useComments(bookId);
  const session = useSession();
  // Stable while the comments are: the reader re-places its markers (and may report progress to
  // reveal one) whenever this changes, so a new array on every render would loop.
  const threads = useMemo(() => splitThreads(comments.data ?? []), [comments.data]);
  const [local, setLocal] = useState<LocalPosition | undefined | null>(null);
  useEffect(() => {
    void localPosition(bookId).then((p) => setLocal(p));
  }, [bookId]);

  const edition = book.data ? pickEdition(book.data.editions, params.get('edition'), progress.data?.mine?.editionId) : undefined;
  const publication = useQuery({
    queryKey: keys.publication(edition?.publicationUrl ?? ''),
    queryFn: () => api.publication(edition!.publicationUrl!),
    enabled: !!edition?.publicationUrl,
    staleTime: Infinity,
  });

  // The start position is decided once, when everything it depends on has arrived. A link's
  // place (`at`, `comment`) is used once and then dropped from the address, so a reload opens
  // where you are reading, not at the link again.
  const [start, setStart] = useState<(StartPosition & { commentId: string | null; along: string | null }) | null>(null);
  const atParam = params.get('at');
  const ready = !!book.data && !!edition && local !== null && (progress.isFetchedAfterMount || progress.isError);
  useEffect(() => {
    if (!ready || start || !book.data || !edition) return;
    setStart({ ...startPosition(book.data, edition, progress.data, local ?? undefined, atParam !== null ? Number(atParam) : null), commentId: params.get('comment'), along: resolveAlong(book.data.editions, edition, params.get('along')) });
    if (params.has('at') || params.has('comment') || params.has('along')) {
      const next = new URLSearchParams(params);
      next.delete('at');
      next.delete('comment');
      next.delete('along');
      setParams(next, { replace: true });
    }
  }, [ready, start, book.data, edition, progress.data, local, atParam, params, setParams]);

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
  if (book.data && !edition) {
    return (
      <div className="center-page">
        <h1>Nothing to read yet</h1>
        <p className="muted">This book has no EPUB or PDF ready.</p>
        <Link className="btn" to={`/books/${bookId}`}>
          Back to the book
        </Link>
      </div>
    );
  }
  if (!book.data || !edition || !start || (edition.kind === 'epub' && !publication.data)) {
    return <Splash label="Opening the book" />;
  }
  const common = {
    book: book.data,
    edition,
    start: start.locator,
    startSource: start.source,
    startAt: start.at,
    resume: start.resume ?? null,
    resumeAt: start.resumeAt ?? null,
    comments: threads.notes,
    replies: threads.replies,
    selfId: session.data?.user?.id,
    members: progress.data?.members ?? book.data.progress,
    // A link to a reply opens its note, with the conversation under it.
    openCommentId: (start.commentId && (comments.data ?? []).find((c) => c.id === start.commentId)?.parentId) || start.commentId,
    // Reading along opened from the book page (D187): the audiobook to load at the page.
    along: start.along,
  };
  if (edition.kind === 'pdf') {
    return (
      <Suspense fallback={<Splash label="Opening the PDF" />}>
        <PdfReader {...common} />
      </Suspense>
    );
  }
  return <EpubReader {...common} publication={publication.data!} />;
}
