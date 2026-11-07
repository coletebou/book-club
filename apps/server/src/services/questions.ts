import { type MeetupQuestion, type MeetupQuestionList, hasReached, rangesFurthest, stopLabel } from '@bookclub/shared';
import { type AppContext } from '../context';
import { isoRequired } from '../lib/json';
import { type BookRow, bookChapters } from '../repos/books';
import { meetingFor } from '../repos/meetings';
import { type QuestionRow, type QuestionWithPeople, questionsForStop, votedBy } from '../repos/questions';
import { progressFor, readRanges, readingOf } from '../repos/progress';
import { type Access, type Gated, gateFor } from './gating';

/**
 * What a friend may see of the questions for the next stop (D209). A question opens to a friend once
 * they are there, as the meet-up card counts it (D53: what they have read, not jumped to, reaches
 * the stop), and, from a friend, once they have read as far as its writer had when they wrote it
 * (D69, judged by the same gate as a note's horizon, services/gating.ts). Cal's were written from
 * the text up to the stop alone, so the stop is their only fence. What is not open is only counted,
 * with where the first of them opens: never its words, its writer or its votes.
 */

/** A question as the gate weighs it: at its stop, with its writer's horizon (none for Cal's). */
export function gatedQuestion(q: QuestionRow, referenceEditionId: string | null): Gated {
  return {
    // Nobody is Cal: his questions are never "your own" to anyone.
    user_id: q.author_id ?? '',
    edition_id: q.horizon_edition_id ?? referenceEditionId ?? '',
    locator_json: '',
    end_locator_json: null,
    t: q.t,
    end_t: null,
    horizon_edition_id: q.horizon_edition_id,
    horizon_locator_json: q.horizon_locator_json,
    horizon_t: q.horizon_t,
  };
}

/**
 * Whether one friend may read each question of a book: theirs; ahead of them (not there yet); held
 * (there, but not as far as its writer had read); or open. Built once per request.
 */
export function questionAccessFor(ctx: AppContext, book: BookRow, viewerId: string): (q: QuestionRow) => Access {
  const row = progressFor(ctx.db, viewerId, book.id);
  const progress = { furthest: row ? rangesFurthest(readRanges(row)) : 0, finished: !!row && row.finished_at !== null };
  let gate: ReturnType<typeof gateFor> | null = null;
  let reading: ReturnType<typeof readingOf> | null = null;
  return (q) => {
    if (q.author_id !== null && q.author_id === viewerId) return 'open';
    if (!hasReached(progress, q.t)) return 'ahead';
    if (!q.horizon_edition_id || !q.horizon_locator_json || q.horizon_t === null) return 'open';
    gate ??= gateFor(ctx.db, book);
    reading ??= readingOf(ctx.db, viewerId, book.id);
    const horizon: Gated = { user_id: q.author_id ?? '', edition_id: q.horizon_edition_id, locator_json: q.horizon_locator_json, end_locator_json: null, t: q.horizon_t, end_t: null };
    return gate.access(horizon, viewerId, reading) === 'open' ? 'open' : 'held';
  };
}

function toView(q: QuestionWithPeople, viewerId: string, voted: ReadonlySet<string>, owner: boolean): MeetupQuestion {
  return {
    id: q.id,
    text: q.text,
    author: q.author_id ? { userId: q.author_id, displayName: q.author_name ?? '' } : null,
    askedBy: q.asked_by ? { userId: q.asked_by, displayName: q.asked_by_name ?? '' } : null,
    votes: q.votes,
    voted: voted.has(q.id),
    removable: owner || q.author_id === viewerId || (q.author_id === null && q.asked_by === viewerId),
    createdAt: isoRequired(q.created_at),
  };
}

/** The questions for a book's next stop, as `viewerId` may see them, most wanted first. */
export function questionList(ctx: AppContext, book: BookRow, viewerId: string, owner: boolean): MeetupQuestionList {
  const meeting = meetingFor(ctx.db, book.id);
  if (!meeting) return { stop: null, questions: [], held: { count: 0, opensAt: null } };
  const chapters = bookChapters(book);
  const rows = questionsForStop(ctx.db, book.id, meeting.t);
  const accessOf = questionAccessFor(ctx, book, viewerId);
  const open: QuestionWithPeople[] = [];
  let held = 0;
  let opensAt: string | null = null;
  for (const q of rows) {
    const access = accessOf(q);
    if (access === 'open') {
      open.push(q);
      continue;
    }
    held++;
    // Where it waits for them: the stop, or, there already, where its writer had read to.
    opensAt ??= access === 'held' ? gateFor(ctx.db, book).horizonLabel(gatedQuestion(q, book.reference_edition_id)) : stopLabel(chapters, q.t);
  }
  const voted = votedBy(
    ctx.db,
    viewerId,
    open.map((q) => q.id),
  );
  open.sort((a, b) => b.votes - a.votes || a.created_at - b.created_at || a.id.localeCompare(b.id));
  return {
    stop: { t: meeting.t, label: stopLabel(chapters, meeting.t) },
    questions: open.map((q) => toView(q, viewerId, voted, owner)),
    held: { count: held, opensAt },
  };
}
