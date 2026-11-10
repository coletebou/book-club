import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { LIMITS, type CreateNominationBody, type Nomination, type Round, type UpNext, formatNames, formatWhen, topVoted } from '@bookclub/shared';
import { Field, FormError, TextArea } from './Form';
import { Icon } from './Icon';

/**
 * Picking the next book (D214): nominate, approval-vote, one open round at a time, and the
 * club's Up next. Presentational pieces and their pure helpers, kept apart from data fetching
 * (pages/NextBookPage.tsx) so the shapes here are easy to test on their own.
 */

export function voterSummary(voters: readonly { displayName: string }[]): string {
  return voters.length === 0 ? 'No votes yet' : `Voted by ${formatNames(voters.map((v) => v.displayName))}`;
}

/** The nomination ids tied for the most votes in a round: more than one means closing needs a choice (D214). */
export function tiedForMostVotes(round: Round): string[] {
  return topVoted(round.nominations.map((n) => ({ id: n.id, votes: n.votes })));
}

export interface NominationFormValues {
  readonly title: string;
  readonly author: string;
  readonly link: string;
  readonly pitch: string;
}

const EMPTY_FORM: NominationFormValues = { title: '', author: '', link: '', pitch: '' };

export function formFromNomination(n: Nomination): NominationFormValues {
  return { title: n.title, author: n.author ?? '', link: n.link ?? '', pitch: n.pitch ?? '' };
}

/** The nominate / edit form: one shape for both, since editing changes the same four fields. */
export function NominationForm({
  initial = EMPTY_FORM,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: NominationFormValues;
  submitLabel: string;
  busy: boolean;
  error?: unknown;
  onSubmit: (values: CreateNominationBody) => void;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState(initial);
  return (
    <form
      className="nomination-form stack"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit({
          title: values.title,
          author: values.author.trim() || undefined,
          link: values.link.trim() || undefined,
          pitch: values.pitch.trim() || undefined,
        });
      }}
    >
      <Field
        label="Title"
        value={values.title}
        onChange={(e) => setValues((v) => ({ ...v, title: e.target.value }))}
        maxLength={LIMITS.bookTitle}
        required
        disabled={busy}
        data-testid="nomination-title"
      />
      <Field
        label="Author (optional)"
        value={values.author}
        onChange={(e) => setValues((v) => ({ ...v, author: e.target.value }))}
        maxLength={LIMITS.bookAuthor}
        disabled={busy}
        data-testid="nomination-author"
      />
      <Field
        label="Link (optional)"
        type="url"
        placeholder="https://www.goodreads.com/book/show/…"
        value={values.link}
        onChange={(e) => setValues((v) => ({ ...v, link: e.target.value }))}
        maxLength={LIMITS.nominationLink}
        hint="Goodreads, StoryGraph, Open Library, or anywhere else about it."
        disabled={busy}
        data-testid="nomination-link"
      />
      <TextArea
        label="Why we should read it (optional)"
        value={values.pitch}
        onChange={(e) => setValues((v) => ({ ...v, pitch: e.target.value }))}
        maxLength={LIMITS.nominationPitch}
        rows={3}
        disabled={busy}
        data-testid="nomination-pitch"
      />
      <FormError error={error} />
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy || values.title.trim() === ''} data-testid="nomination-submit">
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** Closing an open round (D214): a single leader needs no choice; a tie needs one, among the tied. */
export function CloseRoundControl({ round, busy, error, onClose }: { round: Round; busy: boolean; error?: unknown; onClose: (winnerNominationId?: string) => void }) {
  const tied = tiedForMostVotes(round);
  const needsChoice = tied.length > 1;
  const [chosen, setChosen] = useState<string>('');
  return (
    <div className="close-round stack" data-testid="close-round">
      {needsChoice ? (
        <>
          <p className="muted small">These are tied for the most votes. Choose one to close the round:</p>
          <fieldset className="stack-sm">
            {tied.map((id) => {
              const nomination = round.nominations.find((n) => n.id === id)!;
              return (
                <label key={id} className="row">
                  <input type="radio" name="tie-break" value={id} checked={chosen === id} onChange={() => setChosen(id)} />
                  {nomination.title}
                </label>
              );
            })}
          </fieldset>
        </>
      ) : null}
      <FormError error={error} />
      <button
        type="button"
        className="btn btn-primary"
        data-testid="close-round-submit"
        disabled={busy || round.nominations.length === 0 || (needsChoice && !chosen)}
        onClick={() => onClose(needsChoice ? chosen : undefined)}
      >
        {busy ? 'Closing…' : 'Close the round'}
      </button>
    </div>
  );
}

export function NominationCard({
  nomination,
  voteBusy,
  canEdit,
  canRemove,
  onToggleVote,
  onStartEdit,
  onWithdraw,
}: {
  nomination: Nomination;
  /** This nomination's own vote toggle is mid-flight: disabled so a second tap cannot race it. */
  voteBusy: boolean;
  /** The nominator editing their own, only while the round is still open. */
  canEdit: boolean;
  /** The nominator withdrawing their own, or the owner removing any, only while open. */
  canRemove: boolean;
  onToggleVote: () => void;
  onStartEdit: () => void;
  onWithdraw: () => void;
}) {
  return (
    <li className="nomination-card card" data-testid="nomination" data-voted={nomination.votedByMe}>
      <div className="nomination-head">
        <h3>{nomination.title}</h3>
        {nomination.author ? <p className="muted small">{nomination.author}</p> : null}
      </div>
      {nomination.link ? (
        <a className="nomination-link" href={nomination.link} target="_blank" rel="noreferrer noopener" data-testid="nomination-link-out">
          <Icon name="link" size={14} /> More about this book
        </a>
      ) : null}
      {nomination.pitch ? <p className="nomination-pitch">{nomination.pitch}</p> : null}
      <div className="nomination-foot">
        <button
          type="button"
          className={`btn vote-btn${nomination.votedByMe ? ' is-voted' : ''}`}
          aria-pressed={nomination.votedByMe}
          disabled={voteBusy}
          onClick={onToggleVote}
          data-testid="vote-toggle"
        >
          <Icon name="check" size={14} /> {nomination.votedByMe ? 'Voted' : 'Vote'} · {nomination.votes}
        </button>
        <span className="muted small" title={voterSummary(nomination.voters)}>
          {voterSummary(nomination.voters)}
        </span>
        <span className="muted small nomination-by">Nominated by {nomination.createdBy.displayName}</span>
        {canEdit ? (
          <button type="button" className="btn btn-ghost" onClick={onStartEdit} data-testid="nomination-edit">
            <Icon name="edit" size={14} /> Edit
          </button>
        ) : null}
        {canRemove ? (
          <button type="button" className="btn btn-ghost" onClick={onWithdraw} data-testid="nomination-withdraw">
            <Icon name="trash" size={14} /> {canEdit ? 'Withdraw' : 'Remove'}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** The club's Up next (D214): shown on the library page with a way into the picker. */
export function UpNextCard({ clubId, upNext, canClear, onClear }: { clubId: string; upNext: UpNext; canClear: boolean; onClear: () => void }) {
  return (
    <section className="card up-next" data-testid="up-next" aria-label="Up next">
      <div className="up-next-head">
        <Icon name="flag" size={18} />
        <div>
          <p className="up-next-label">Up next</p>
          <h3>{upNext.title}</h3>
          {upNext.author ? <p className="muted small">{upNext.author}</p> : null}
        </div>
      </div>
      <div className="row">
        <Link className="btn" to={`/clubs/${clubId}/next-book`} data-testid="up-next-open-picker">
          Open the picker
        </Link>
        {canClear ? (
          <button type="button" className="btn btn-ghost" onClick={onClear} data-testid="up-next-clear">
            Mark as done
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function HistoryList({ history }: { history: readonly Round[] }) {
  if (history.length === 0) return null;
  return (
    <section aria-labelledby="history-title" className="stack-sm">
      <h2 id="history-title" className="section-title">
        Past rounds
      </h2>
      <ul className="history-list" data-testid="round-history">
        {history.map((round) => {
          const winner = round.winnerNominationId ? round.nominations.find((n) => n.id === round.winnerNominationId) : undefined;
          return (
            <li key={round.id} className="history-item" data-testid="history-item">
              {winner ? (
                <span>
                  <strong>{winner.title}</strong> won{winner.author ? ` (${winner.author})` : ''}
                </span>
              ) : (
                <span className="muted">Nothing was nominated</span>
              )}
              <span className="muted small"> · closed by {round.closedBy?.displayName ?? 'someone'} · {round.closedAt ? formatWhen(round.closedAt) : ''}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
