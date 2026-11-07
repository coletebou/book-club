import { createHash } from 'node:crypto';
import { type BookDetail, BookDetailSchema, BookSummarySchema, CalendarFeedSchema, type ClubDetail, meetingStops } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALICE_EPUB, type Client, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, openSocket, outsider, setupOwner, uploadBook } from './helpers';

const LIVEKIT_ENV = { LIVEKIT_URL: 'wss://rtc.example.test', LIVEKIT_API_KEY: 'bookclubtest', LIVEKIT_API_SECRET: 'bookclubtest-secret-not-for-real-use' };

/** Friday 13 November 2026, half past seven in the evening in New York (EST, UTC-5). */
const FRIDAY_EVENING = '2026-11-14T00:30:00.000Z';
/** Saturday 14 November 2026, eight in the evening in New York. */
const SATURDAY_EVENING = '2026-11-15T01:00:00.000Z';
const NEW_YORK = 'America/New_York';

describe('meet-ups: when, where and who is coming (D206)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let book: BookDetail;
  let anaId: string;
  let benId: string;

  const put = (c: Client, body: Record<string, unknown>) => c.put(`/api/books/${book.id}/meeting`, body);
  const rsvp = (c: Client, answer: string | null) => c.put(`/api/books/${book.id}/meeting/rsvp`, { answer });
  const stop = (label: string) => meetingStops(book.chapters).find((s) => s.label === label)!;
  const meeting = async (c: Client = owner) => (await bookDetail(c, book.id)).meeting;

  beforeAll(async () => {
    t = await makeTestApp(LIVEKIT_ENV);
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben');
    anaId = (await ana.json<{ user: { id: string } }>(ana.get('/api/me'), 200)).user.id;
    benId = (await ben.json<{ user: { id: string } }>(ben.get('/api/me'), 200)).user.id;
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('a stop with a time: the day is the one the time falls on where it was set, and everyone sees when, how long and where', async () => {
    const updated = BookDetailSchema.parse(
      await ana.json(put(ana, { t: stop('the end of Chapter 2').t, at: FRIDAY_EVENING, tz: NEW_YORK, minutes: 90, place: { kind: 'voice' } }), 200),
    );
    // Half past midnight on Saturday in UTC is Friday evening in New York: the day is Friday.
    expect(updated.meeting).toMatchObject({ label: 'the end of Chapter 2', on: '2026-11-13', at: FRIDAY_EVENING, tz: NEW_YORK, minutes: 90, place: { kind: 'voice', value: '' }, rsvps: [] });
    const library = (await ben.json<unknown[]>(ben.get(`/api/clubs/${club.id}/books`), 200)).map((b) => BookSummarySchema.parse(b));
    expect(library[0]!.meeting).toEqual(updated.meeting);
  });

  it('an offset in the time is the same instant', async () => {
    await ana.json(put(ana, { t: stop('the end of Chapter 2').t, at: '2026-11-13T19:30:00-05:00', tz: NEW_YORK }), 200);
    expect(await meeting()).toMatchObject({ at: FRIDAY_EVENING, on: '2026-11-13', minutes: null });
  });

  it('a place or a video call is kept as given; what the form leaves out is cleared', async () => {
    await ana.json(put(ana, { t: stop('the end of Chapter 2').t, on: '2026-11-13', place: { kind: 'place', value: '  Ana’s, 12 Elm Street  ' } }), 200);
    expect(await meeting()).toMatchObject({ on: '2026-11-13', at: null, tz: null, minutes: null, place: { kind: 'place', value: 'Ana’s, 12 Elm Street' } });
    await ana.json(put(ana, { t: stop('the end of Chapter 2').t, at: FRIDAY_EVENING, tz: NEW_YORK, place: { kind: 'link', value: 'https://meet.example/abc-def' } }), 200);
    expect((await meeting())?.place).toEqual({ kind: 'link', value: 'https://meet.example/abc-def' });
    // Moved by someone who only changes the stop: the time and place go with the old state.
    await ben.json(put(ben, { t: stop('the end of Chapter 3').t }), 200);
    expect(await meeting()).toMatchObject({ label: 'the end of Chapter 3', on: null, at: null, place: null, setBy: { displayName: 'Ben' } });
  });

  it.each([
    ['a time without its time zone', { at: FRIDAY_EVENING }],
    ['a time zone nobody has', { at: FRIDAY_EVENING, tz: 'Mars/Olympus_Mons' }],
    ['a time that is not one', { at: '2026-11-13 19:30', tz: NEW_YORK }],
    ['a day that disagrees with its time', { at: FRIDAY_EVENING, tz: NEW_YORK, on: '2026-11-14' }],
    ['a meet-up of five minutes', { at: FRIDAY_EVENING, tz: NEW_YORK, minutes: 5 }],
    ['a meet-up of a day and a night', { at: FRIDAY_EVENING, tz: NEW_YORK, minutes: 24 * 60 }],
    ['a link that is not a web address', { on: '2026-11-13', place: { kind: 'link', value: 'javascript:alert(1)' } }],
    ['a place with no words', { on: '2026-11-13', place: { kind: 'place', value: '   ' } }],
    ['a place as long as a letter', { on: '2026-11-13', place: { kind: 'place', value: 'x'.repeat(201) } }],
    ['a kind of place there is not', { on: '2026-11-13', place: { kind: 'moon', value: '' } }],
  ])('refuses %s', async (_what, body) => {
    const before = await meeting();
    expect((await put(ana, { t: stop('the end of Chapter 2').t, ...body })).statusCode).toBe(400);
    expect(await meeting()).toEqual(before);
  });

  it('nothing to answer before the meet-up has a day', async () => {
    await ana.json(put(ana, { t: stop('the end of Chapter 2').t }), 200);
    const res = await rsvp(ben, 'yes');
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('no_meetup');
    await ana.delete(`/api/books/${book.id}/meeting`);
    expect((await rsvp(ben, 'yes')).statusCode).toBe(409);
  });

  it('friends answer, change their answer or take it back; everyone sees who is coming, live', async () => {
    await ana.json(put(ana, { t: stop('the end of Chapter 2').t, at: FRIDAY_EVENING, tz: NEW_YORK, place: { kind: 'voice' } }), 200);
    const socket = await openSocket(t, owner);
    try {
      socket.send({ type: 'subscribe', clubId: club.id });
      const answered = BookDetailSchema.parse(await ben.json(rsvp(ben, 'maybe'), 200));
      expect(answered.meeting?.rsvps).toEqual([{ userId: benId, displayName: 'Ben', answer: 'maybe' }]);
      await socket.next('book:changed', (m) => m.bookId === book.id);
    } finally {
      await socket.close();
    }
    await ana.json(rsvp(ana, 'yes'), 200);
    await ben.json(rsvp(ben, 'yes'), 200);
    expect((await meeting())?.rsvps.map((r) => [r.displayName, r.answer])).toEqual([
      ['Ana', 'yes'],
      ['Ben', 'yes'],
    ]);
    await ben.json(rsvp(ben, null), 200);
    expect((await meeting(ben))?.rsvps).toEqual([{ userId: anaId, displayName: 'Ana', answer: 'yes' }]);
    expect((await rsvp(ben, 'perhaps')).statusCode).toBe(400);
  });

  it('a new evening leaves the old answers behind, and the old evening brings them back; a new place keeps them', async () => {
    await ben.json(rsvp(ben, 'no'), 200);
    expect((await meeting())?.rsvps).toHaveLength(2);
    await ana.json(put(ana, { t: stop('the end of Chapter 2').t, at: FRIDAY_EVENING, tz: NEW_YORK, place: { kind: 'link', value: 'https://meet.example/x' } }), 200);
    expect((await meeting())?.rsvps).toHaveLength(2);
    await ana.json(put(ana, { t: stop('the end of Chapter 2').t, at: SATURDAY_EVENING, tz: NEW_YORK }), 200);
    expect((await meeting())?.rsvps).toEqual([]);
    await ana.json(put(ana, { t: stop('the end of Chapter 2').t, at: FRIDAY_EVENING, tz: NEW_YORK }), 200);
    expect((await meeting())?.rsvps.map((r) => r.answer)).toEqual(['yes', 'no']);
    // Answering again is for the meet-up as it stands now.
    await ana.json(put(ana, { t: stop('the end of Chapter 2').t, on: '2026-11-13' }), 200);
    await ben.json(rsvp(ben, 'yes'), 200);
    expect((await meeting())?.rsvps).toEqual([{ userId: benId, displayName: 'Ben', answer: 'yes' }]);
  });

  it('clearing the meet-up clears its answers', async () => {
    expect((await ana.delete(`/api/books/${book.id}/meeting`)).statusCode).toBe(204);
    expect(t.ctx.db.get('SELECT 1 AS x FROM meeting_rsvps WHERE book_id = ?', [book.id])).toBeUndefined();
  });

  it('a friend who leaves the club is no longer among who is coming', async () => {
    await ana.json(put(ana, { t: stop('the end of Chapter 2').t, at: FRIDAY_EVENING, tz: NEW_YORK }), 200);
    const cleo = await joinClub(t, club, 'Cleo');
    await cleo.json(rsvp(cleo, 'yes'), 200);
    expect((await meeting())?.rsvps.map((r) => r.displayName)).toContain('Cleo');
    const cleoId = (await cleo.json<{ user: { id: string } }>(cleo.get('/api/me'), 200)).user.id;
    expect((await owner.delete(`/api/clubs/${club.id}/members/${cleoId}`)).statusCode).toBe(204);
    expect((await meeting())?.rsvps.map((r) => r.displayName)).not.toContain('Cleo');
  });

  it('is the club’s own: an outsider finds no book to answer for or download, nobody signed out may', async () => {
    const stranger = await outsider(t, owner, 'Stu');
    expect((await rsvp(stranger, 'yes')).statusCode).toBe(404);
    expect((await stranger.get(`/api/books/${book.id}/meeting.ics`)).statusCode).toBe(404);
    expect((await rsvp(t.client(), 'yes')).statusCode).toBe(401);
    expect((await t.client().get(`/api/books/${book.id}/meeting.ics`)).statusCode).toBe(401);
  });

  it('downloads as a calendar file: the evening in UTC, how long, reminders, the stop and the place, never a chapter’s title', async () => {
    await ana.json(put(ana, { t: stop('the end of Chapter 2').t, at: FRIDAY_EVENING, tz: NEW_YORK, minutes: 90, place: { kind: 'voice' } }), 200);
    const res = await ben.get(`/api/books/${book.id}/meeting.ics`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['content-disposition']).toContain('attachment');
    const ics = res.body;
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain(`UID:meetup-${book.id}@`);
    expect(unfolded).toContain('DTSTART:20261114T003000Z');
    expect(unfolded).toContain('DTEND:20261114T020000Z');
    expect(unfolded).toContain('SUMMARY:Thursday Readers: Alice');
    expect(unfolded).toContain('DESCRIPTION:Read to the end of Chapter 2 before you meet.\\nIn the club’s voice room: ');
    expect(unfolded).toContain('LOCATION:The club’s voice room in Book Club');
    expect(unfolded).toContain('TRIGGER:-P1D');
    expect(unfolded).toContain('TRIGGER:-PT1H');
    expect(unfolded).not.toContain('Pool of Tears');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  });

  it('a stop with only a day is an all-day reminder to have read that far; without a day there is no file', async () => {
    await ana.json(put(ana, { t: stop('the end of Chapter 2').t, on: '2026-11-13', place: { kind: 'place', value: 'Ana’s; then the pub, maybe' } }), 200);
    const unfolded = (await ben.get(`/api/books/${book.id}/meeting.ics`)).body.replace(/\r\n /g, '');
    expect(unfolded).toContain('DTSTART;VALUE=DATE:20261113');
    expect(unfolded).toContain('DTEND;VALUE=DATE:20261114');
    expect(unfolded).toContain('SUMMARY:Thursday Readers: read the end of Chapter 2 of Alice');
    // Commas, semicolons and backslashes are escaped (RFC 5545 3.3.11).
    expect(unfolded).toContain('LOCATION:Ana’s\\; then the pub\\, maybe');
    await ana.json(put(ana, { t: stop('the end of Chapter 2').t }), 200);
    expect((await ben.get(`/api/books/${book.id}/meeting.ics`)).statusCode).toBe(404);
  });
});

describe('meet-ups where voice is not set up (D206)', () => {
  let t: TestApp;
  afterAll(async () => {
    await closeApp(t);
  });

  it('offers no voice room to meet in', async () => {
    t = await makeTestApp();
    const { owner, club } = await setupOwner(t);
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    const res = await owner.put(`/api/books/${bookId}/meeting`, { t: 0.5, on: '2026-11-13', place: { kind: 'voice' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { fields: Record<string, string> } }>().error.fields.place).toBeTruthy();
    expect((await owner.put(`/api/books/${bookId}/meeting`, { t: 0.5, on: '2026-11-13', place: { kind: 'place', value: 'The library' } })).statusCode).toBe(200);
  });
});

describe('your meet-ups in your calendar (D207)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let book: BookDetail;
  let otherBookId: string;

  const feedOf = async (c: Client) => CalendarFeedSchema.parse(await c.json(c.get('/api/me/calendar'), 200));
  const make = async (c: Client) => CalendarFeedSchema.parse(await c.json(c.post('/api/me/calendar'), 200));
  const pathOf = (url: string) => new URL(url).pathname;

  beforeAll(async () => {
    t = await makeTestApp();
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    // Another club of the owner's, which Ana is not in, with its own meet-up.
    const other = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Sunday Poets' }), 201);
    ({ bookId: otherBookId } = await uploadBook(owner, other.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice again', author: 'Lewis Carroll' }));
    await t.settle();
    book = await bookDetail(owner, bookId);
    const day = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    await owner.json(owner.put(`/api/books/${book.id}/meeting`, { t: 0.5, on: day, place: { kind: 'place', value: 'The library' } }), 200);
    await owner.json(owner.put(`/api/books/${otherBookId}/meeting`, { t: 0.5, on: day }), 200);
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('there is none until asked; asked, its address is given once and opens without a session', async () => {
    expect(await feedOf(ana)).toEqual({ enabled: false, createdAt: null, url: null, webcalUrl: null });
    const made = await make(ana);
    expect(made.enabled).toBe(true);
    expect(made.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/calendar\/[A-Za-z0-9_-]{32}\/meetups\.ics$/);
    expect(made.webcalUrl).toBe(made.url!.replace(/^http:/, 'webcal:'));
    // Asked again, it says it is on, but not where: only the hash is kept.
    expect(await feedOf(ana)).toMatchObject({ enabled: true, url: null, webcalUrl: null });
    const token = pathOf(made.url!).split('/')[3]!;
    expect(t.ctx.db.all<{ token_hash: string }>('SELECT token_hash FROM calendar_feeds')).toEqual([{ token_hash: createHash('sha256').update(token).digest('hex') }]);
    const res = await t.client().get(pathOf(made.url!));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    const unfolded = res.body.replace(/\r\n /g, '');
    expect(unfolded).toContain('X-WR-CALNAME:Book Club meet-ups');
    expect(unfolded).toContain(`UID:meetup-${book.id}@`);
    expect(unfolded).toContain('LOCATION:The library');
  });

  it('lists the meet-ups of the clubs you are in, and no other club’s', async () => {
    const mine = pathOf((await make(owner)).url!);
    const theirs = pathOf((await make(ana)).url!);
    const ownerFeed = (await t.client().get(mine)).body;
    expect(ownerFeed).toContain(`UID:meetup-${book.id}@`);
    expect(ownerFeed).toContain(`UID:meetup-${otherBookId}@`);
    const anaFeed = (await t.client().get(theirs)).body;
    expect(anaFeed).toContain(`UID:meetup-${book.id}@`);
    expect(anaFeed).not.toContain(otherBookId);
  });

  it('a new address ends the old one, and turning it off ends it', async () => {
    const first = pathOf((await make(ana)).url!);
    const second = pathOf((await make(ana)).url!);
    expect((await t.client().get(first)).statusCode).toBe(404);
    expect((await t.client().get(second)).statusCode).toBe(200);
    expect((await ana.delete('/api/me/calendar')).statusCode).toBe(204);
    expect((await t.client().get(second)).statusCode).toBe(404);
    expect((await feedOf(ana)).enabled).toBe(false);
  });

  it('a removed book’s meet-up leaves the feed', async () => {
    const feed = pathOf((await make(owner)).url!);
    expect((await owner.delete(`/api/books/${otherBookId}`)).statusCode).toBe(204);
    expect((await t.client().get(feed)).body).not.toContain(otherBookId);
  });

  it('a made-up address is simply not found', async () => {
    for (const token of ['x', 'A'.repeat(32), `${'A'.repeat(31)}!`, '../../etc/passwd']) {
      expect((await t.client().get(`/api/calendar/${encodeURIComponent(token)}/meetups.ics`)).statusCode).toBe(404);
    }
  });

  it('only you may make, see or turn off yours', async () => {
    expect((await t.client().get('/api/me/calendar')).statusCode).toBe(401);
    expect((await t.client().post('/api/me/calendar')).statusCode).toBe(401);
    expect((await t.client().delete('/api/me/calendar')).statusCode).toBe(401);
  });
});
