import { BookSummarySchema } from '@bookclub/shared';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createBook, createEdition, markEditionReady } from '../src/repos/books';
import { setMeeting, setRsvp } from '../src/repos/meetings';
import { saveProgress } from '../src/repos/progress';
import { type Client, type TestApp, closeApp, makeTestApp, setupOwner } from './helpers';

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
