import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type MeetupQuestion, type MeetupQuestionList } from '@bookclub/shared';
import { api } from '../lib/api';
import { calApi } from '../lib/cal-api';
import { keys } from '../lib/queries';
import { FormError } from './Form';
import { Icon } from './Icon';

/**
 * What to talk about at the meet-up (D209): the questions for the next stop that are open to you,
 * the ones friends want most first, a way to add yours and to ask Cal for some. A question opens to
 * a friend as a note does: once they have read to the stop, and as far as its writer had read (the
 * server decides, D69); before that it is only counted, with where the first of them opens.
 */
export function MeetupQuestions({ bookId, clubId, selfId }: { bookId: string; clubId: string; selfId: string | undefined }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const list = useQuery({ queryKey: keys.questions(bookId), queryFn: () => api.questions(bookId) });
  const cal = useQuery({ queryKey: ['cal-status', clubId], queryFn: () => calApi.status(clubId), staleTime: 60_000 });
  const put = (next: MeetupQuestionList) => qc.setQueryData(keys.questions(bookId), next);
  const add = useMutation({
    mutationFn: () => api.addQuestion(bookId, draft.trim()),
    onSuccess: (next) => {
      put(next);
      setDraft('');
    },
  });
  const ask = useMutation({ mutationFn: () => api.suggestQuestions(bookId), onSuccess: put });
  const vote = useMutation({ mutationFn: (q: MeetupQuestion) => (q.voted ? api.unvoteQuestion(q.id) : api.voteQuestion(q.id)), onSuccess: put });
  const remove = useMutation({ mutationFn: (q: MeetupQuestion) => api.removeQuestion(q.id), onSuccess: put });
  const data = list.data;
  if (!data?.stop) return null;
  const held = data.held;
  return (
    <section aria-labelledby="questions-title" className="card stack" data-testid="meetup-questions">
      <h2 id="questions-title">To talk about</h2>
      <p className="muted small">Questions for the meet-up, at {data.stop.label}. Vote for the ones you most want to talk over.</p>
      {data.questions.length > 0 ? (
        <ol className="questions">
          {data.questions.map((q) => (
            <li key={q.id} className="question" data-testid="meetup-question">
              <button
                type="button"
                className={`question-vote${q.voted ? ' is-voted' : ''}`}
                aria-pressed={q.voted}
                aria-label={`${q.voted ? 'Take back your vote for' : 'Vote for'}: ${q.text} (${q.votes} ${q.votes === 1 ? 'vote' : 'votes'})`}
                onClick={() => vote.mutate(q)}
                disabled={vote.isPending}
                data-testid="question-vote"
              >
                <span aria-hidden="true">▲</span> {q.votes}
              </button>
              <div className="question-body">
                <p className="question-text">{q.text}</p>
                <p className="faint small">
                  {q.author ? (q.author.userId === selfId ? 'You' : q.author.displayName) : `Cal${q.askedBy ? `, asked by ${q.askedBy.userId === selfId ? 'you' : q.askedBy.displayName}` : ''}`}
                  {q.removable ? (
                    <>
                      {' · '}
                      <button type="button" className="btn btn-ghost btn-small" onClick={() => remove.mutate(q)} disabled={remove.isPending} data-testid="question-remove">
                        Remove
                      </button>
                    </>
                  ) : null}
                </p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="small" data-testid="questions-empty">
          {held.count > 0 ? 'None for you yet.' : 'No questions yet.'}
        </p>
      )}
      {held.count > 0 ? (
        <p className="small muted" data-testid="questions-held">
          <Icon name="lock" size={14} /> {held.count === 1 ? 'One more question opens' : `${held.count} more questions open`} for you at {held.opensAt ?? data.stop.label}.
        </p>
      ) : null}
      <FormError error={add.error ?? ask.error ?? vote.error ?? remove.error} />
      <form
        className="question-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim().length >= 5) add.mutate();
        }}
      >
        <label htmlFor="new-question" className="visually-hidden">
          Your question for the meet-up
        </label>
        <input
          id="new-question"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={400}
          placeholder="Ask the club something…"
          data-testid="question-input"
        />
        <button type="submit" className="btn" disabled={add.isPending || draft.trim().length < 5} data-testid="question-add">
          Add
        </button>
      </form>
      {cal.data?.enabled ? (
        <div>
          <button type="button" className="btn btn-ghost" onClick={() => ask.mutate()} disabled={ask.isPending} data-testid="questions-ask-cal">
            <Icon name="sparkle" size={18} /> {ask.isPending ? 'Cal is reading…' : 'Ask Cal for questions'}
          </button>
          <p className="faint small">He reads only as far as {data.stop.label}, and his questions open for each friend there, as yours do.</p>
        </div>
      ) : null}
    </section>
  );
}
