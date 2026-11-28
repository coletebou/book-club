import { BookSummarySchema, ClubDetailSchema, type EditionGeometry, type Locator } from '@bookclub/shared';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { booksForClub, createBook, createEdition, deleteEdition, markEditionReady } from '../src/repos/books';
import { removeMember } from '../src/repos/clubs';
import { setMeeting, setRsvp } from '../src/repos/meetings';
import { saveProgress } from '../src/repos/progress';
import { bookSummariesForClub, toBookSummary } from '../src/services/books';
import { removeBook } from '../src/services/removal';
import { type Client, type TestApp, closeApp, joinClub, makeTestApp, setupOwner } from './helpers';

let t: TestApp;
let owner: Client;
let clubId: string;
let ownerId: string;

beforeAll(async () => {
  t = await makeTestApp();
  const setup = await setupOwner(t);
  owner = setup.owner;
  clubId = setup.club.id;
  ownerId = setup.club.members.find((member) => member.role === 'owner')!.userId;
});

afterAll(async () => {
  await closeApp(t);
});

it('reads a larger authenticated library without adding a database round trip for each book', async () => {
  const { db } = t.ctx;
  const addBook = (i: number) => {
    const book = createBook(db, { clubId, createdBy: ownerId, title: `Volume ${i}`, author: 'Library fixture' });
    const edition = createEdition(db, { bookId: book.id, kind: 'audio', createdBy: ownerId, sizeBytes: 100 });
    markEditionReady(db, edition.id, {
      geometry: { kind: 'audio', trackDurationsMs: [1000] },
      units: [{ title: 'Chapter One', m: 0 }],
      sync: { points: [{ m: 0, t: 0 }, { m: 1000, t: 1 }] },
      alignment: { method: 'none', unitToChapter: [] },
      meta: {},
    });
    saveProgress(db, {
      user_id: ownerId, book_id: book.id, edition_id: edition.id, locator_json: '{"kind":"audio","track":0,"ms":250}',
      t: 0.25, label: '', client_at: 1, read_ranges_json: '[[0,0.25]]', furthest: 0.25, coverage: 0.25, finished_at: null,
    });
    setMeeting(db, book.id, ownerId, { t: 0.5, onDay: '2026-12-03' });
    setRsvp(db, book.id, ownerId, 'day:2026-12-03', 'yes');
    return book;
  };
  const read = async () => {
    const get = vi.spyOn(db, 'get');
    const all = vi.spyOn(db, 'all');
    try {
      const response = await owner.json<unknown[]>(owner.get(`/api/clubs/${clubId}/books`), 200);
      return { books: response.map((book) => BookSummarySchema.parse(book)), queries: get.mock.calls.length + all.mock.calls.length };
    } finally {
      get.mockRestore();
      all.mockRestore();
    }
  };

  const first = addBook(1);
  const small = await read();
  expect(small.books).toHaveLength(1);
  expect(small.books[0]).toMatchObject({
    id: first.id,
    kinds: ['audio'],
    progress: [{ userId: ownerId, kind: 'audio', t: 0.25, coverage: 0.25 }],
    meeting: { on: '2026-12-03', rsvps: [{ userId: ownerId, answer: 'yes' }] },
  });

  db.tx(() => {
    for (let i = 2; i <= 100; i++) addBook(i);
  });
  const large = await read();
  expect(large.books).toHaveLength(100);
  expect(large.books.find((book) => book.id === first.id)).toEqual(small.books[0]);
  expect(large.queries).toBe(small.queries);
});

it('matches per-book summaries for a library with mixed editions, progress and meeting answers', async () => {
  const { db } = t.ctx;
  const club = ClubDetailSchema.parse(await owner.json(owner.post('/api/clubs', { name: 'Mixed library' }), 201));
  const member = await joinClub(t, club, 'Morgan Reader');
  const formerMember = await joinClub(t, club, 'Pat Reader');
  const userId = async (client: Client) => (await client.json<{ user: { id: string } }>(client.get('/api/session'), 200)).user.id;
  const memberId = await userId(member);
  const formerMemberId = await userId(formerMember);

  const addBook = (title: string) => createBook(db, { clubId: club.id, createdBy: ownerId, title, author: 'Library fixture' });
  const addEdition = (bookId: string, geometry: EditionGeometry, end: number) => {
    const edition = createEdition(db, { bookId, kind: geometry.kind, createdBy: ownerId, sizeBytes: 100 });
    markEditionReady(db, edition.id, {
      geometry,
      units: [{ title: 'Chapter One', m: 0 }],
      sync: { points: [{ m: 0, t: 0 }, { m: end, t: 1 }] },
      alignment: { method: 'none', unitToChapter: [] },
      meta: {},
    });
    return edition.id;
  };
  const place = (bookId: string, editionId: string, readerId: string, locator: Locator, position: number) => {
    saveProgress(db, {
      user_id: readerId, book_id: bookId, edition_id: editionId, locator_json: JSON.stringify(locator),
      t: position, label: '', client_at: 1, read_ranges_json: JSON.stringify([[0, position]]),
      furthest: position, coverage: position, finished_at: null,
    });
  };

  const mixed = addBook('Mixed formats');
  const audio = addEdition(mixed.id, { kind: 'audio', trackDurationsMs: [1000] }, 1000);
  const pdf = addEdition(mixed.id, { kind: 'pdf', pageCount: 4 }, 4);
  place(mixed.id, audio, ownerId, { kind: 'audio', track: 0, ms: 250 }, 0.25);
  place(mixed.id, pdf, memberId, { kind: 'pdf', page: 3, y: 0 }, 0.75);
  setMeeting(db, mixed.id, ownerId, { t: 0.5, onDay: '2026-12-03' });
  setRsvp(db, mixed.id, ownerId, 'day:2026-12-02', 'no');
  setRsvp(db, mixed.id, memberId, 'day:2026-12-03', 'yes');
  setRsvp(db, mixed.id, formerMemberId, 'day:2026-12-03', 'yes');
  expect(removeMember(db, club.id, formerMemberId)).toBe(true);

  const noMeeting = addBook('Without a meetup');
  const removedEdition = addEdition(noMeeting.id, { kind: 'pdf', pageCount: 4 }, 4);
  place(noMeeting.id, removedEdition, ownerId, { kind: 'pdf', page: 1, y: 0 }, 0.25);
  deleteEdition(db, removedEdition);

  const deleted = addBook('Removed from library');
  const deletedBookEdition = addEdition(deleted.id, { kind: 'pdf', pageCount: 4 }, 4);
  place(deleted.id, deletedBookEdition, ownerId, { kind: 'pdf', page: 2, y: 0 }, 0.5);
  setMeeting(db, deleted.id, ownerId, { t: 0.75, onDay: '2026-12-03' });
  setRsvp(db, deleted.id, ownerId, 'day:2026-12-03', 'yes');
  removeBook(t.ctx, deleted.id, club.id, ownerId);

  const perBook = booksForClub(db, club.id).map((book) => toBookSummary(db, book));
  const batched = bookSummariesForClub(db, club.id);
  expect(batched).toEqual(perBook);
  expect(batched).toHaveLength(2);
  expect(batched.find((book) => book.id === mixed.id)).toMatchObject({
    kinds: expect.arrayContaining(['audio', 'pdf']),
    progress: expect.arrayContaining([
      expect.objectContaining({ userId: ownerId, kind: 'audio', t: 0.25 }),
      expect.objectContaining({ userId: memberId, kind: 'pdf', t: 0.75 }),
    ]),
    meeting: { rsvps: [{ userId: memberId, answer: 'yes' }] },
  });
  expect(batched.find((book) => book.id === noMeeting.id)).toMatchObject({
    kinds: [],
    progress: expect.arrayContaining([
      expect.objectContaining({ userId: ownerId, kind: null, t: 0.25 }),
      expect.objectContaining({ userId: memberId, kind: null, t: 0, updatedAt: null }),
    ]),
    meeting: null,
  });
});
