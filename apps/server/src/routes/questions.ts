import { CreateMeetupQuestionBodySchema, IdSchema, type MeetupQuestionList } from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { type BookAccess, requireBook } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { RateLimiter } from '../auth/ratelimit';
import { calBudgetSpent } from '../cal/store';
import { NoTextError, questionModelFor, suggestQuestions } from '../cal/questions';
import { type AppContext } from '../context';
import { HttpError, conflict, forbidden, notFound, parse, tooMany } from '../lib/errors';
import { meetingFor } from '../repos/meetings';
import { type QuestionRow, calAsksSince, insertQuestion, questionById, questionsForStop, recordCalAsk, removeQuestion, setVote } from '../repos/questions';
import { gateFor, writerHorizon } from '../services/gating';
import { gatedQuestion, questionAccessFor, questionList } from '../services/questions';

/** How many times a day Cal may be asked for questions for one stop of one book. */
const CAL_ASKS_PER_STOP_PER_DAY = 3;

/**
 * Questions for the meet-up (D209): every member reads the ones open to them, adds their own,
 * votes for the ones they want to talk about, and may ask Cal for some. Everything is the club's
 * own (`requireBook`), and a question's words, votes and existence beyond a count reach only a
 * friend the gate opens it to (services/questions.ts).
 */
export function questionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const askLimiter = new RateLimiter(3, 10 * 60_000);
  const writeLimiter = new RateLimiter(30, 10 * 60_000);

  const list = (access: BookAccess, userId: string): MeetupQuestionList => questionList(ctx, access.book, userId, access.membership.role === 'owner');
  const changed = (access: BookAccess) => ctx.hub.publish(access.club.id, () => ({ type: 'book:changed', clubId: access.club.id, bookId: access.book.id }));

  /** A question of a club the person is in, open to them: anything else is not found. */
  const openQuestion = (questionId: string, userId: string): { access: BookAccess; question: QuestionRow } => {
    const question = questionById(ctx.db, parse(IdSchema, questionId));
    if (!question) throw notFound('Question not found.');
    const access = requireBook(ctx.db, question.book_id, userId);
    if (questionAccessFor(ctx, access.book, userId)(question) !== 'open') throw notFound('Question not found.');
    return { access, question };
  };

  app.get<{ Params: { bookId: string } }>('/api/books/:bookId/questions', async (request) => {
    const user = requireUser(request);
    return list(requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id), user.id);
  });

  /** A friend's own question, for the next stop, carrying where they had read to (D69). */
  app.post<{ Params: { bookId: string } }>('/api/books/:bookId/questions', async (request, reply) => {
    const user = requireUser(request);
    const access = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const body = parse(CreateMeetupQuestionBodySchema, request.body);
    if (!writeLimiter.attempt(user.id)) throw tooMany();
    const meeting = meetingFor(ctx.db, access.book.id);
    if (!meeting) throw conflict('Choose the next stop first: questions are for a meet-up.', 'no_meetup');
    const gate = gateFor(ctx.db, access.book);
    const place = gatedQuestion({ author_id: user.id, t: meeting.t, horizon_edition_id: null, horizon_locator_json: null, horizon_t: null } as QuestionRow, access.book.reference_edition_id);
    const horizon = writerHorizon(ctx.db, gate, access.book, user.id, place);
    insertQuestion(ctx.db, { bookId: access.book.id, t: meeting.t, text: body.text, authorId: user.id, askedBy: null, horizon });
    changed(access);
    return reply.code(201).send(list(access, user.id));
  });

  /** Cal's questions for the next stop, from the text up to it (cal/questions.ts). */
  app.post<{ Params: { bookId: string } }>('/api/books/:bookId/questions/suggest', async (request, reply) => {
    const user = requireUser(request);
    const access = requireBook(ctx.db, parse(IdSchema, request.params.bookId), user.id);
    const model = questionModelFor(ctx);
    if (!model) throw notFound('Cal is not set up on this server.');
    const meeting = meetingFor(ctx.db, access.book.id);
    if (!meeting) throw conflict('Choose the next stop first: questions are for a meet-up.', 'no_meetup');
    if (!askLimiter.attempt(user.id)) throw tooMany('You have asked Cal a few times just now. Try again in a little while.');
    if (calAsksSince(ctx.db, access.book.id, meeting.t, Date.now() - 86_400_000) >= CAL_ASKS_PER_STOP_PER_DAY) {
      throw tooMany(`Cal has suggested questions for this stop ${CAL_ASKS_PER_STOP_PER_DAY} times today. Add your own, or ask again tomorrow.`);
    }
    const spent = calBudgetSpent(ctx.db, access.club.id, { club: ctx.config.CAL_MONTHLY_SPEND_CAP_USD, instance: ctx.config.CAL_INSTANCE_MONTHLY_SPEND_CAP_USD });
    if (spent) throw new HttpError(402, 'spend_cap', spent === 'club' ? 'This club has used its Cal budget for this month.' : 'Cal has used this month’s budget for every club here. It resets on the 1st.');
    // Counted before he answers, whatever he answers: an ask that brings nothing new is still one.
    recordCalAsk(ctx.db, access.book.id, meeting.t, user.id);
    let texts: string[];
    try {
      const existing = questionsForStop(ctx.db, access.book.id, meeting.t).map((q) => q.text);
      texts = await suggestQuestions(ctx, { book: access.book, stopT: meeting.t, userId: user.id, existing, model });
    } catch (err) {
      if (err instanceof NoTextError) throw conflict(err.message, 'not_indexed');
      request.log.warn({ err }, 'cal questions failed');
      throw new HttpError(503, 'cal_unavailable', 'Cal could not suggest questions just now. Try again in a minute.');
    }
    ctx.db.tx(() => {
      for (const text of texts) insertQuestion(ctx.db, { bookId: access.book.id, t: meeting.t, text, authorId: null, askedBy: user.id, horizon: null });
    });
    changed(access);
    return reply.code(201).send(list(access, user.id));
  });

  app.put<{ Params: { questionId: string } }>('/api/questions/:questionId/vote', async (request) => {
    const user = requireUser(request);
    const { access, question } = openQuestion(request.params.questionId, user.id);
    setVote(ctx.db, question.id, user.id, true);
    changed(access);
    return list(access, user.id);
  });

  app.delete<{ Params: { questionId: string } }>('/api/questions/:questionId/vote', async (request) => {
    const user = requireUser(request);
    const { access, question } = openQuestion(request.params.questionId, user.id);
    setVote(ctx.db, question.id, user.id, false);
    changed(access);
    return list(access, user.id);
  });

  /** Removed by whoever wrote it (or asked Cal for it), or by the club's owner. */
  app.delete<{ Params: { questionId: string } }>('/api/questions/:questionId', async (request) => {
    const user = requireUser(request);
    const { access, question } = openQuestion(request.params.questionId, user.id);
    const mine = question.author_id === user.id || (question.author_id === null && question.asked_by === user.id);
    if (!mine && access.membership.role !== 'owner') throw forbidden('Only whoever wrote a question, or the club owner, can remove it.');
    removeQuestion(ctx.db, question.id);
    changed(access);
    return list(access, user.id);
  });
}
