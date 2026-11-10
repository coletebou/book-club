import { type CalendarFeed } from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { publicOrigin, requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { newToken, sha256Hex } from '../lib/crypto';
import { iso } from '../lib/json';
import { notFound } from '../lib/errors';
import { type BookRow, bookChapters } from '../repos/books';
import { calendarFeedOf, calendarFeedUser, meetingsForFeed, removeCalendarFeed, replaceCalendarFeed } from '../repos/meetings';
import { icsCalendar, meetupEvent } from '../services/calendar';

/** How far back the feed still lists meet-ups: a month, so last week's stays on the calendar. */
const FEED_PAST_DAYS = 31;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

/**
 * A private calendar feed per person (D207): the meet-ups of every club they are in, for a calendar
 * app to subscribe to, which keeps it up to date as meet-ups move and reminds them itself. Its
 * address is a key, like an invite link: shown once when it is made (only its hash is kept), and
 * replacing or turning it off ends the old one.
 */
export function calendarRoutes(app: FastifyInstance, ctx: AppContext): void {
  const feed = (userId: string): CalendarFeed => {
    const row = calendarFeedOf(ctx.db, userId);
    return { enabled: !!row, createdAt: iso(row?.created_at), url: null, webcalUrl: null };
  };

  app.get('/api/me/calendar', async (request): Promise<CalendarFeed> => feed(requireUser(request).id));

  /** A new address (the old one, if any, stops working), given back this once. */
  app.post('/api/me/calendar', async (request): Promise<CalendarFeed> => {
    const user = requireUser(request);
    const token = newToken(24);
    replaceCalendarFeed(ctx.db, user.id, sha256Hex(token));
    const url = `${publicOrigin(ctx, request)}/api/calendar/${token}/meetups.ics`;
    return { ...feed(user.id), url, webcalUrl: url.replace(/^https?:/, 'webcal:') };
  });

  app.delete('/api/me/calendar', async (request, reply) => {
    removeCalendarFeed(ctx.db, requireUser(request).id);
    return reply.code(204).send();
  });

  /** The feed itself: no session (a calendar app has none), the token in its address instead. */
  app.get<{ Params: { token: string } }>('/api/calendar/:token/meetups.ics', async (request, reply) => {
    const token = request.params.token;
    const userId = TOKEN.test(token) ? calendarFeedUser(ctx.db, sha256Hex(token)) : undefined;
    if (!userId) throw notFound('No such calendar.');
    const origin = publicOrigin(ctx, request);
    const host = new URL(origin).host;
    const since = new Date(Date.now() - FEED_PAST_DAYS * 86_400_000).toISOString().slice(0, 10);
    const events = meetingsForFeed(ctx.db, userId, since).map((row) =>
      meetupEvent(
        {
          meeting: row,
          bookId: row.book_id,
          bookTitle: row.book_title,
          chapters: bookChapters({ chapters_json: row.chapters_json } as BookRow),
          clubId: row.club_id,
          clubName: row.club_name,
        },
        origin,
        host,
      ),
    );
    return reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Cache-Control', 'private, no-store')
      .send(icsCalendar(events, 'Book Club meet-ups'));
  });
}
