import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BookDetail, BookDetailSchema, type CommentView, type Publication, PublicationSchema } from '@bookclub/shared';
import { ALICE_EPUB, type Client, type TestApp, bookDetail, fileFrom, joinClub, makeTestApp, setupOwner, uploadBook } from './helpers';

describe('vertical slice: sign in, club, upload, read, comment', () => {
  let t: TestApp;
  let owner: Client;
  let ana: Client;
  let clubId: string;
  let book: BookDetail;
  let pub: Publication;

  beforeAll(async () => {
    t = await makeTestApp();
    const setup = await setupOwner(t);
    owner = setup.owner;
    clubId = setup.club.id;
    ana = await joinClub(t, setup.club, 'Ana');
    const { bookId } = await uploadBook(owner, clubId, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], {
      title: "Alice's Adventures in Wonderland",
      author: 'Lewis Carroll',
    });
    await t.settle();
    book = await bookDetail(owner, bookId);
    pub = await owner.json<Publication>(owner.get(book.editions[0]!.publicationUrl!), 200);
  });

  afterAll(async () => {
    await t.close();
  });

  it('ingests the EPUB into a ready edition with its chapters on the timeline', () => {
    expect(BookDetailSchema.parse(book)).toBeTruthy();
    expect(book.editions).toHaveLength(1);
    expect(book.editions[0]!.status).toBe('ready');
    // Title page, edition notice and Contents, then the twelve chapters; the licence is outside the story.
    expect(book.chapters).toHaveLength(15);
    expect(book.chapters.filter((c) => c.title.startsWith('CHAPTER'))).toHaveLength(12);
    expect(book.chapters[0]!.t).toBeLessThan(0.001);
    expect(book.chapters.some((c) => /LICENSE/.test(c.title))).toBe(false);
    expect(book.referenceEditionId).toBe(book.editions[0]!.id);
    expect(book.hasCover).toBe(true);
  });

  it('serves the publication manifest and normalised sections', async () => {
    expect(PublicationSchema.parse(pub).sections).toHaveLength(15);
    const ch1 = await owner.get(`${pub.baseUrl}${pub.sections[2]!.href}`);
    expect(ch1.statusCode).toBe(200);
    expect(ch1.headers['content-type']).toContain('application/xhtml+xml');
    expect(ch1.headers['content-security-policy']).toContain("default-src 'none'");
    expect(ch1.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(ch1.body).toContain('Alice was beginning to get very tired');
  });

  it('a member comments at a position and a friend who has not read it gets only a marker', async () => {
    const edition = book.editions[0]!;
    const created = await owner.json<CommentView>(
      owner.post(`/api/books/${book.id}/comments`, {
        editionId: edition.id,
        locator: { kind: 'epub', section: 5, offset: 120 },
        quote: 'Curiouser and curiouser!',
        text: 'This is where it gets weird',
        reaction: '🤯',
      }),
      201,
    );
    expect(created.hidden).toBe(false);
    const forAna = await ana.json<CommentView[]>(ana.get(`/api/books/${book.id}/comments`), 200);
    expect(forAna).toHaveLength(1);
    expect(forAna[0]).toMatchObject({ hidden: true, reaction: '🤯', hasText: true, authorName: 'Cole' });
    expect(JSON.stringify(forAna)).not.toContain('weird');
    expect(JSON.stringify(forAna)).not.toContain('Curiouser');
  });

  it('reading up to the passage reveals it', async () => {
    const edition = book.editions[0]!;
    const res = await ana.json<{ revealed: CommentView[] }>(
      ana.put(`/api/books/${book.id}/progress`, {
        editionId: edition.id,
        locator: { kind: 'epub', section: 5, offset: 0 },
        readSpans: [{ from: { kind: 'epub', section: 5, offset: 0 }, to: { kind: 'epub', section: 5, offset: 900 } }],
        at: Date.now(),
      }),
      200,
    );
    expect(res.revealed).toHaveLength(1);
    expect(res.revealed[0]).toMatchObject({ hidden: false, text: 'This is where it gets weird' });
  });
});
