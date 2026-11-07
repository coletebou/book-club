import { type BookDetail, type ClubDetail, type MeetupQuestionList, MeetupQuestionListSchema, meetingStops, tToLocator } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { excerptToStop, parseQuestions } from '../src/cal/questions';
import { bookById } from '../src/repos/books';
import { ALICE_EPUB, type Client, type TestApp, bookDetail, closeApp, fileFrom, joinClub, makeTestApp, outsider, setupOwner, uploadBook } from './helpers';

describe('questions for the meet-up (D209)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let ana: Client;
  let ben: Client;
  let book: BookDetail;
  let editionId: string;

  const list = async (c: Client) => MeetupQuestionListSchema.parse(await c.json(c.get(`/api/books/${book.id}/questions`), 200));
  const add = (c: Client, text: string) => c.post(`/api/books/${book.id}/questions`, { text });
  const stop = (label: string) => meetingStops(book.chapters).find((s) => s.label === label)!;
  /** Someone has read (not jumped) from the start of the EPUB to `to` on the book's timeline. */
  const readTo = async (c: Client, to: number) => {
    const epub = book.editions.find((e) => e.id === editionId)!;
    const locator = tToLocator({ geometry: epub.geometry!, sync: epub.sync! }, to);
    await c.json(c.post(`/api/books/${book.id}/progress/read-up-to`, { editionId, locator }), 200);
  };
  const texts = (l: MeetupQuestionList) => l.questions.map((q) => q.text);

  beforeAll(async () => {
    t = await makeTestApp({ CAL_TEST_FAKE_MODEL: 'true' });
    ({ owner, club } = await setupOwner(t));
    ana = await joinClub(t, club, 'Ana');
    ben = await joinClub(t, club, 'Ben');
    const up = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, up.bookId);
    editionId = up.editionId;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('there are none, and nowhere to put one, before the club has a next stop', async () => {
    expect(await list(ana)).toEqual({ stop: null, questions: [], held: { count: 0, opensAt: null } });
    const res = await add(ana, 'What do we think of the White Rabbit?');
    expect(res.statusCode).toBe(409);
    expect((await ana.post(`/api/books/${book.id}/questions/suggest`)).statusCode).toBe(409);
  });

  it('a question opens to a friend once they have read to the stop; until then it is only counted', async () => {
    await owner.json(owner.put(`/api/books/${book.id}/meeting`, { t: stop('the end of Chapter 2').t, on: '2026-11-13' }), 200);
    await readTo(ana, stop('the end of Chapter 2').t);
    expect((await add(ana, 'Why does Alice keep changing size, do you think?')).statusCode).toBe(201);
    // Ana wrote it: hers, always.
    const mine = await list(ana);
    expect(mine.stop?.label).toBe('the end of Chapter 2');
    expect(mine.questions).toHaveLength(1);
    expect(mine.questions[0]).toMatchObject({ text: 'Why does Alice keep changing size, do you think?', votes: 0, voted: false, removable: true });
    expect(mine.questions[0]!.author?.displayName).toBe('Ana');
    // Ben has not read that far: a count and where it opens, never its words or its writer.
    const his = await list(ben);
    expect(his.questions).toEqual([]);
    expect(his.held).toEqual({ count: 1, opensAt: 'the end of Chapter 2' });
    expect(JSON.stringify(his)).not.toContain('changing size');
    expect(JSON.stringify(his)).not.toContain('Ana');
    // Read that far, it is his to see and vote for.
    await readTo(ben, stop('the end of Chapter 2').t);
    expect(texts(await list(ben))).toEqual(['Why does Alice keep changing size, do you think?']);
  });

  it('a friend who has read further than the stop holds their question until you have read as far as they had (D69)', async () => {
    await readTo(owner, stop('the end of Chapter 4').t);
    expect((await add(owner, 'Was the Caterpillar kind to her, or cruel?')).statusCode).toBe(201);
    const ben2 = await list(ben);
    expect(texts(ben2)).not.toContain('Was the Caterpillar kind to her, or cruel?');
    expect(ben2.held.count).toBe(1);
    expect(ben2.held.opensAt).toMatch(/Chapter (4|5)/);
    await readTo(ben, stop('the end of Chapter 4').t);
    expect(texts(await list(ben))).toContain('Was the Caterpillar kind to her, or cruel?');
  });

  it('votes put the most wanted first; a friend votes once, and may take it back', async () => {
    const q = (await list(ben)).questions.find((x) => x.text.startsWith('Was the Caterpillar'))!;
    await ben.json(ben.put(`/api/questions/${q.id}/vote`, {}), 200);
    await ana.json(ana.put(`/api/questions/${q.id}/vote`, {}), 200).catch(() => undefined);
    await ben.json(ben.put(`/api/questions/${q.id}/vote`, {}), 200);
    const now = await list(ben);
    expect(now.questions[0]).toMatchObject({ id: q.id, votes: 1, voted: true });
    await ben.json(ben.delete(`/api/questions/${q.id}/vote`), 200);
    expect((await list(ben)).questions.find((x) => x.id === q.id)).toMatchObject({ votes: 0, voted: false });
  });

  it('a question not open to you cannot be voted for or removed: to you it is not there', async () => {
    // Ana has read only to the stop; the owner's question is held for her.
    const held = (await list(owner)).questions.find((x) => x.text.startsWith('Was the Caterpillar'))!;
    expect((await ana.put(`/api/questions/${held.id}/vote`, {})).statusCode).toBe(404);
    expect((await ana.delete(`/api/questions/${held.id}`)).statusCode).toBe(404);
  });

  it('only whoever wrote it, or the owner, removes a question; its words go', async () => {
    const anas = (await list(ben)).questions.find((x) => x.author?.displayName === 'Ana')!;
    expect((await ben.delete(`/api/questions/${anas.id}`)).statusCode).toBe(403);
    expect(texts(await ana.json<MeetupQuestionList>(ana.delete(`/api/questions/${anas.id}`), 200))).not.toContain(anas.text);
    const gone = t.ctx.db.get<{ text: string; deleted_at: number | null }>('SELECT text, deleted_at FROM meetup_questions WHERE id = ?', [anas.id])!;
    expect(gone.text).toBe('');
    expect(gone.deleted_at).toBeGreaterThan(0);
  });

  it('Cal reads only to the stop, and his questions open as a friend’s do; asked too often, he says so', async () => {
    const before = (await list(ben)).questions.length;
    const after = MeetupQuestionListSchema.parse(await ben.json(ben.post(`/api/books/${book.id}/questions/suggest`), 201));
    const cal = after.questions.filter((q) => q.author === null);
    expect(cal.length).toBeGreaterThan(0);
    expect(after.questions.length).toBe(before + cal.length);
    for (const q of cal) {
      expect(q.askedBy?.displayName).toBe('Ben');
      expect(q.removable).toBe(true);
    }
    // His excerpt ends at the stop: no chunk that ends after it.
    const excerpt = excerptToStop(t.ctx, bookById(t.ctx.db, book.id)!, stop('the end of Chapter 2').t);
    expect(excerpt.length).toBeGreaterThan(1000);
    // Late Chapter II is in it; nothing of Chapter III is (only its title, in the book's contents),
    // even though Cal's passages run across chapters: the one that does is left out whole.
    const flat = excerpt.replace(/\s+/g, ' ');
    expect(flat).toContain('Don’t let me hear the name again!');
    expect(flat).not.toContain('queer-looking party that assembled on the bank');
    expect(flat).not.toContain('dripping wet, cross, and uncomfortable');
    // Someone who has not read to the stop sees them only as a count.
    const cleo = await joinClub(t, club, 'Cleo');
    const hers = await list(cleo);
    expect(hers.questions).toEqual([]);
    expect(hers.held.count).toBeGreaterThanOrEqual(cal.length);
    // Three asks a day per stop, then a plain no.
    await ben.json(ben.post(`/api/books/${book.id}/questions/suggest`), 201);
    await ana.json(ana.post(`/api/books/${book.id}/questions/suggest`), 201);
    const fourth = await ana.post(`/api/books/${book.id}/questions/suggest`);
    expect(fourth.statusCode).toBe(429);
    // Logged against the club's Cal budget, like every other turn of his.
    expect(t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM cal_cost_log WHERE club_id = ? AND kind = 'chat'", [club.id])?.n).toBeGreaterThanOrEqual(3);
  });

  it('a new stop starts a new list; the old one stays with its stop', async () => {
    await owner.json(owner.put(`/api/books/${book.id}/meeting`, { t: stop('the end of Chapter 6').t }), 200);
    const fresh = await list(ben);
    expect(fresh.stop?.label).toBe('the end of Chapter 6');
    expect(fresh.questions).toEqual([]);
    // Back to the stop they were asked for: there they are again.
    await owner.json(owner.put(`/api/books/${book.id}/meeting`, { t: stop('the end of Chapter 2').t }), 200);
    expect(texts(await list(ben))).toContain('Was the Caterpillar kind to her, or cruel?');
  });

  it('is the club’s own: an outsider finds no book, nobody signed out gets in', async () => {
    const stranger = await outsider(t, owner, 'Stu');
    expect((await stranger.get(`/api/books/${book.id}/questions`)).statusCode).toBe(404);
    expect((await add(stranger, 'Anyone there at all?')).statusCode).toBe(404);
    const any = (await list(owner)).questions[0]!;
    expect((await stranger.put(`/api/questions/${any.id}/vote`, {})).statusCode).toBe(404);
    expect((await t.client().get(`/api/books/${book.id}/questions`)).statusCode).toBe(401);
    expect((await add(ben, 'Hm')).statusCode).toBe(400);
  });
});

describe('Cal’s reply, read as questions (D209)', () => {
  it('keeps questions only, without numbers or bullets, new and not too long', () => {
    const reply = ['1. Why does Alice follow the Rabbit at all?', '- What is the Caterpillar for?', 'Here are your questions:', '• Is the Duchess cruel or just loud?', 'Why does Alice follow the Rabbit at all?', `${'x'.repeat(420)}?`, 'Q4: Who is the hero here?'].join('\n');
    expect(parseQuestions(reply, ['Is the duchess cruel or just loud?'])).toEqual(['Why does Alice follow the Rabbit at all?', 'What is the Caterpillar for?', 'Who is the hero here?']);
    expect(parseQuestions(reply, [], 1)).toHaveLength(1);
  });
});
