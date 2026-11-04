import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { THREAD_TITLE_MAX, threadTitle } from '../src/cal/store';
import { createBook } from '../src/repos/books';
import { type Client, type TestApp, closeApp, joinClub, makeTestApp, setupOwner } from './helpers';

/**
 * Threads with Cal (D183): one person keeps many conversations with Cal in a club, each with its
 * own history, listed most recent first and titled by its first question. They are private: no
 * one else in the club can list, read, write to or delete them. The spoiler scope is the asker's
 * standing setting, never a per-question flag in the request.
 */

interface ThreadSummary {
  id: string;
  title: string;
  bookId: string | null;
  bookTitle: string | null;
  createdAt: string;
  updatedAt: string;
}
interface ThreadDetail {
  id: string;
  title: string;
  messages: { role: 'user' | 'assistant'; wholeSeries: boolean; content: { type: string; text?: string }[] }[];
}

describe('threadTitle (D183)', () => {
  it('keeps a short question as it is, with its whitespace folded', () => {
    expect(threadTitle('  Who is   the Cheshire\nCat? ')).toBe('Who is the Cheshire Cat?');
  });

  it('cuts a long question at a word boundary, with an ellipsis, within the limit', () => {
    const q = 'Why does the Queen of Hearts keep shouting off with their heads at everyone she meets in the garden?';
    const title = threadTitle(q);
    expect(title.length).toBeLessThanOrEqual(THREAD_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    expect(q.startsWith(title.slice(0, -1))).toBe(true);
    // Ends on a whole word, not part of one.
    expect(q[title.length - 1]).toBe(' ');
  });

  it('cuts one very long word where it must', () => {
    const title = threadTitle('x'.repeat(200));
    expect(title).toBe(`${'x'.repeat(THREAD_TITLE_MAX - 1)}…`);
  });
});

describe('threads with Cal (D183)', () => {
  let t: TestApp;
  let owner: Client;
  let bea: Client;
  let clubId: string;
  let otherClubBookId: string;
  let bookId: string;

  const ask = async (who: Client, threadId: string, text: string, extra: Record<string, unknown> = {}) => {
    const res = await who.post(`/api/cal/conversations/${threadId}/messages`, { text, ...extra });
    return res;
  };
  const newThread = (who: Client, body: Record<string, unknown> = {}) => who.json<ThreadSummary>(who.post(`/api/clubs/${clubId}/cal/conversations`, body), 201);
  const list = (who: Client) => who.json<ThreadSummary[]>(who.get(`/api/clubs/${clubId}/cal/conversations`), 200);
  const detail = (who: Client, id: string) => who.json<ThreadDetail>(who.get(`/api/cal/conversations/${id}`), 200);

  beforeAll(async () => {
    t = await makeTestApp({ CAL_TEST_FAKE_MODEL: 'true', CAL_EMBEDDING_PROVIDER: 'fake', CAL_RATE_LIMIT_PER_MINUTE: '1000' });
    const setup = await setupOwner(t, 'Alice', 'Rabbit Hole');
    owner = setup.owner;
    clubId = setup.club.id;
    bea = await joinClub(t, setup.club, 'Bea');
    const ownerId = (await owner.json<{ user: { id: string } }>(owner.get('/api/me'), 200)).user.id;
    bookId = createBook(t.ctx.db, { clubId, title: 'Through the Looking-Glass', author: 'Lewis Carroll', createdBy: ownerId }).id;
    const other = await owner.json<{ id: string }>(owner.post('/api/clubs', { name: 'Elsewhere' }), 201);
    otherClubBookId = createBook(t.ctx.db, { clubId: other.id, title: 'Elsewhere Book', author: 'Someone', createdBy: ownerId }).id;
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('keeps each thread’s own history, lists them most recent first, titled by their first question, and leaves out empty ones', async () => {
    const a = await newThread(owner);
    expect(a.title).toBe('');
    expect((await ask(owner, a.id, 'What does the White Rabbit say?')).statusCode).toBe(200);

    const b = await newThread(owner, { bookId });
    expect(b.bookTitle).toBe('Through the Looking-Glass');
    expect((await ask(owner, b.id, 'Who is the Cheshire Cat?')).statusCode).toBe(200);

    // A new chat that was never asked anything is not a thread to list.
    await newThread(owner);

    let threads = await list(owner);
    expect(threads.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(threads.map((x) => x.title)).toEqual(['Who is the Cheshire Cat?', 'What does the White Rabbit say?']);
    expect(threads[0]!.bookTitle).toBe('Through the Looking-Glass');
    expect(threads[1]!.bookTitle).toBeNull();
    for (const x of threads) expect(Date.parse(x.createdAt)).toBeLessThanOrEqual(Date.parse(x.updatedAt));

    // A second question goes to the thread it was asked in, which then comes first; its title stays its first question.
    expect((await ask(owner, a.id, 'And the Queen?')).statusCode).toBe(200);
    threads = await list(owner);
    expect(threads.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(threads[0]!.title).toBe('What does the White Rabbit say?');

    const historyA = await detail(owner, a.id);
    expect(historyA.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(historyA.messages.filter((m) => m.role === 'user').map((m) => m.content[0]!.text)).toEqual(['What does the White Rabbit say?', 'And the Queen?']);
    const historyB = await detail(owner, b.id);
    expect(historyB.messages.filter((m) => m.role === 'user').map((m) => m.content[0]!.text)).toEqual(['Who is the Cheshire Cat?']);
  });

  it('a long first question becomes a short title', async () => {
    const thread = await newThread(owner);
    await ask(owner, thread.id, 'Why does the Queen of Hearts keep shouting off with their heads at everyone she meets in the garden?');
    const listed = (await list(owner)).find((x) => x.id === thread.id)!;
    expect(listed.title.length).toBeLessThanOrEqual(THREAD_TITLE_MAX);
    expect(listed.title.endsWith('…')).toBe(true);
  });

  it('threads are private: another member of the club cannot list, read, write to, rename or delete them', async () => {
    const mine = (await list(owner))[0]!;
    expect(await list(bea)).toEqual([]);
    expect((await bea.get(`/api/cal/conversations/${mine.id}`)).statusCode).toBe(404);
    expect((await ask(bea, mine.id, 'Let me in')).statusCode).toBe(404);
    expect((await bea.patch(`/api/cal/conversations/${mine.id}`, { title: 'Mine now' })).statusCode).toBe(404);
    expect((await bea.delete(`/api/cal/conversations/${mine.id}`)).statusCode).toBe(404);
    // Still there, unchanged, for its owner.
    expect((await detail(owner, mine.id)).title).toBe(mine.title);

    // Bea's own thread is hers alone, too.
    const hers = await newThread(bea);
    await ask(bea, hers.id, 'Is the Hatter mad?');
    expect((await list(bea)).map((x) => x.id)).toEqual([hers.id]);
    expect((await list(owner)).map((x) => x.id)).not.toContain(hers.id);
  });

  it('a thread is about one of this club’s own books, or none', async () => {
    expect((await owner.post(`/api/clubs/${clubId}/cal/conversations`, { bookId: otherClubBookId })).statusCode).toBe(404);
  });

  it('the spoiler scope is the standing setting for every message; a per-question flag in the request is not obeyed', async () => {
    const thread = await newThread(owner);
    await ask(owner, thread.id, 'First, with the default scope');
    await ask(owner, thread.id, 'An old client asking for the whole series', { wholeSeries: true });
    await owner.json(owner.put('/api/cal/settings', { wholeSeries: true }), 200);
    await ask(owner, thread.id, 'Now with the whole series on in settings');
    await owner.json(owner.put('/api/cal/settings', { wholeSeries: false }), 200);

    const { messages } = await detail(owner, thread.id);
    const userScopes = messages.filter((m) => m.role === 'user').map((m) => m.wholeSeries);
    const replyScopes = messages.filter((m) => m.role === 'assistant').map((m) => m.wholeSeries);
    expect(userScopes).toEqual([false, false, true]);
    expect(replyScopes).toEqual([false, false, true]);
  });

  it('deleting a thread removes it and only it', async () => {
    const before = await list(owner);
    const gone = before[1]!;
    expect((await owner.delete(`/api/cal/conversations/${gone.id}`)).statusCode).toBe(204);
    const after = await list(owner);
    expect(after.map((x) => x.id)).toEqual(before.filter((x) => x.id !== gone.id).map((x) => x.id));
    expect((await owner.get(`/api/cal/conversations/${gone.id}`)).statusCode).toBe(404);
  });
});
