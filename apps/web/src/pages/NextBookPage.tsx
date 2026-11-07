import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { NextBookState } from '@bookclub/shared';
import { Icon } from '../components/Icon';
import { CloseRoundControl, HistoryList, NominationCard, NominationForm, formFromNomination } from '../components/NextBook';
import { useToast } from '../components/Toasts';
import { api } from '../lib/api';
import { confirmAction } from '../lib/confirm';
import { keys, useClub, useNextBook, useSession } from '../lib/queries';
import { useClubPresence } from '../lib/realtime';

const ImportShelfModal = lazy(() => import('../components/ImportShelfModal'));

/**
 * Picking the next book (D214): nominate, approval-vote, one open round at a time, and the
 * club's Up next, with a way to import a Goodreads or StoryGraph to-read shelf (D216).
 */
export function NextBookPage() {
  const { clubId = '' } = useParams();
  const club = useClub(clubId);
  const session = useSession();
  const nextBook = useNextBook(clubId);
  // Subscribes this tab to the club's hub channel (live nominations, votes, rounds, Up next: D214),
  // the same way the chat page's voice bar does when it has nothing of its own to show for it.
  useClubPresence(clubId);
  const qc = useQueryClient();
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // Remounts the nominate form on a successful submit, so a second nomination starts blank
  // rather than keeping the first one's author, link and pitch.
  const [formKey, setFormKey] = useState(0);

  const selfId = session.data?.user?.id;
  const isOwner = club.data?.role === 'owner';
  const setState = (s: NextBookState) => qc.setQueryData(keys.nextBook(clubId), s);

  const nominate = useMutation({
    mutationFn: (body: Parameters<typeof api.nominate>[1]) => api.nominate(clubId, body),
    onSuccess: (s) => {
      setState(s);
      setFormKey((k) => k + 1);
    },
  });
  const edit = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateNomination>[1] }) => api.updateNomination(id, body),
    onSuccess: (s) => {
      setState(s);
      setEditingId(null);
    },
  });
  const withdraw = useMutation({ mutationFn: (id: string) => api.withdrawNomination(id), onSuccess: () => void nextBook.refetch() });
  const vote = useMutation({ mutationFn: (id: string) => api.voteFor(id), onSuccess: setState });
  const unvote = useMutation({ mutationFn: (id: string) => api.unvoteFor(id), onSuccess: setState });
  const openRound = useMutation({ mutationFn: () => api.openRound(clubId), onSuccess: setState });
  const closeRound = useMutation({
    mutationFn: ({ roundId, winnerNominationId }: { roundId: string; winnerNominationId?: string }) => api.closeRound(clubId, roundId, winnerNominationId),
    onSuccess: setState,
  });
  const clearUpNext = useMutation({ mutationFn: () => api.clearUpNext(clubId), onSuccess: () => void nextBook.refetch() });

  // Said live, by a toast, not a persisted notification (D217): nothing here is spoiler-gated, so
  // there is nothing the bell's machinery would add that the picker does not already show. Every
  // member looking at the picker gets this the same way (D214), whether their own close just
  // landed or a `club:changed` push just told them someone else's did; `loadedOnce` keeps the
  // page's very first load (and a stale one it already had Up next for) from toasting.
  const loadedOnce = useRef(false);
  const seenUpNextId = useRef<string | null>(null);
  useEffect(() => {
    if (!nextBook.data) return;
    const current = nextBook.data.upNext;
    if (loadedOnce.current && current && current.nominationId !== seenUpNextId.current) {
      toast.show(`${current.title} won the vote — it’s Up next.`);
    }
    loadedOnce.current = true;
    seenUpNextId.current = current?.nominationId ?? null;
  }, [nextBook.data, toast]);

  if (nextBook.isPending || club.isPending) {
    return (
      <div className="center-page">
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }
  if (nextBook.isError || !nextBook.data) {
    return (
      <div className="center-page">
        <p>The next-book picker could not be loaded. Check the connection and try again.</p>
      </div>
    );
  }
  const state = nextBook.data;
  const round = state.round;

  const askWithdraw = (nominationId: string, mine: boolean) =>
    void confirmAction({
      title: mine ? 'Withdraw this nomination?' : 'Remove this nomination?',
      body: 'It goes for everyone looking at this round.',
      confirm: mine ? 'Withdraw' : 'Remove',
      cancel: 'Keep it',
    }).then((yes) => yes && withdraw.mutate(nominationId));

  return (
    <div className="stack-lg next-book-page">
      <Link to={`/clubs/${clubId}`} className="back-link">
        <Icon name="back" size={18} /> {club.data?.name ?? 'Club'}
      </Link>
      <h1>Pick the next book</h1>
      <p className="muted">
        Nominate a book, vote for any you would read, and close the round when you are ready. A pitch is about a book nobody here has read yet, so none of
        this is hidden from anyone.
      </p>

      {state.upNext ? (
        <section className="card up-next" data-testid="up-next-detail" aria-label="Up next">
          <div className="up-next-head">
            <Icon name="flag" size={18} />
            <div>
              <p className="up-next-label">Up next</p>
              <h2>{state.upNext.title}</h2>
              {state.upNext.author ? <p className="muted">{state.upNext.author}</p> : null}
              {state.upNext.pitch ? <p>{state.upNext.pitch}</p> : null}
              {state.upNext.link ? (
                <a href={state.upNext.link} target="_blank" rel="noreferrer noopener">
                  More about this book
                </a>
              ) : null}
            </div>
          </div>
          {isOwner ? (
            <button
              type="button"
              className="btn btn-ghost"
              data-testid="up-next-clear"
              onClick={() =>
                void confirmAction({ title: 'Mark Up next as done?', body: 'Clears it for everyone in the club.', confirm: 'Mark done', cancel: 'Keep it' }).then(
                  (yes) => yes && clearUpNext.mutate(),
                )
              }
            >
              Mark as done
            </button>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="round-title" className="stack">
        <div className="section-head">
          <h2 id="round-title" className="section-title">
            {round ? 'Nominate and vote' : 'Nothing nominated yet'}
          </h2>
          <button type="button" className="btn" data-testid="import-shelf" onClick={() => setImporting(true)}>
            <Icon name="upload" size={16} /> Import a to-read shelf
          </button>
        </div>

        <NominationForm key={formKey} submitLabel="Nominate" busy={nominate.isPending} error={nominate.error} onSubmit={(body) => nominate.mutate(body)} />

        {round ? (
          <>
            {round.nominations.length === 0 ? <p className="muted">Nobody has nominated anything yet.</p> : null}
            <ul className="nomination-list stack-sm" data-testid="nomination-list">
              {round.nominations.map((n) =>
                editingId === n.id ? (
                  <li key={n.id} className="nomination-card card is-editing">
                    <NominationForm
                      initial={formFromNomination(n)}
                      submitLabel="Save"
                      busy={edit.isPending}
                      error={edit.error}
                      onSubmit={(body) => edit.mutate({ id: n.id, body })}
                      onCancel={() => setEditingId(null)}
                    />
                  </li>
                ) : (
                  <NominationCard
                    key={n.id}
                    nomination={n}
                    voteBusy={(vote.isPending && vote.variables === n.id) || (unvote.isPending && unvote.variables === n.id)}
                    canEdit={n.createdBy.userId === selfId}
                    canRemove={n.createdBy.userId === selfId || isOwner}
                    onToggleVote={() => (n.votedByMe ? unvote.mutate(n.id) : vote.mutate(n.id))}
                    onStartEdit={() => setEditingId(n.id)}
                    onWithdraw={() => askWithdraw(n.id, n.createdBy.userId === selfId)}
                  />
                ),
              )}
            </ul>
            {isOwner || round.openedBy.userId === selfId ? (
              <CloseRoundControl
                round={round}
                busy={closeRound.isPending}
                error={closeRound.error}
                onClose={(winnerNominationId) => closeRound.mutate({ roundId: round.id, winnerNominationId })}
              />
            ) : (
              <p className="muted small">Only the club owner, or whoever opened this round, can close it.</p>
            )}
          </>
        ) : (
          <p className="muted">
            Nominating a book above starts a round.{' '}
            <button type="button" className="btn btn-ghost" data-testid="open-round" onClick={() => openRound.mutate()} disabled={openRound.isPending}>
              Or open one with nothing nominated yet.
            </button>
          </p>
        )}
      </section>

      <HistoryList history={state.history} />

      {importing ? (
        <Suspense fallback={null}>
          <ImportShelfModal clubId={clubId} onClose={() => setImporting(false)} onImported={(s) => setState(s)} />
        </Suspense>
      ) : null}
    </div>
  );
}
