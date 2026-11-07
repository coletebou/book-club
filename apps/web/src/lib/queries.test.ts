import { QueryClient } from '@tanstack/react-query';
import type { BookDetail, BookProgress, BookSummary, ChatHistory, ChatMessageView, CommentView, MemberProgress, RevealedComment, SessionInfo } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import type { AnswerOpen } from './answer-open';
import { applyMemberProgress, bookNeedsPoll, keys, makeQueryClient, mergeChatMessage, mergeComment, mergeRevealed, removeChatMessage, removeComment, sessionOrSnapshot } from './queries';

const BOOK = 'book_alice';
const CLUB = 'club_123';

const base = { bookId: BOOK, userId: 'user_ana', authorName: 'Ana', color: '#FF6B6B', editionId: 'ed_epub', kind: 'epub' as const, locator: { kind: 'epub' as const, section: 1, offset: 0 }, reaction: null };
const shown = (id: string, t: number, createdAt = '2026-10-23T10:00:00.000Z', text = `text of ${id}`): RevealedComment => ({
  ...base,
  id,
  t,
  createdAt,
  hidden: false,
  endLocator: null,
  endT: null,
  quote: null,
  text,
});
const marker = (id: string, t: number, createdAt = '2026-10-23T10:00:00.000Z'): CommentView => ({ ...base, id, t, createdAt, hidden: true, hasText: true });

const comments = (qc: QueryClient) => qc.getQueryData<CommentView[]>(keys.comments(BOOK));

afterEach(() => vi.unstubAllGlobals());

describe('mergeComment', () => {
  it('adds a new note at its place on the timeline (then by time written)', () => {
    const qc = new QueryClient();
    qc.setQueryData<CommentView[]>(keys.comments(BOOK), [shown('cm_1', 0.1), shown('cm_3', 0.5)]);
    mergeComment(qc, BOOK, marker('cm_2', 0.3));
    mergeComment(qc, BOOK, shown('cm_0', 0.5, '2026-10-23T09:00:00.000Z'));
    expect(comments(qc)!.map((c) => c.id)).toEqual(['cm_1', 'cm_2', 'cm_0', 'cm_3']);
  });

  it('reveals a hidden marker once its text arrives', () => {
    const qc = new QueryClient();
    qc.setQueryData<CommentView[]>(keys.comments(BOOK), [marker('cm_1', 0.4)]);
    mergeComment(qc, BOOK, shown('cm_1', 0.4));
    expect(comments(qc)).toEqual([shown('cm_1', 0.4)]);
  });

  it('never turns a note already revealed back into a spoiler-free marker (a late live event)', () => {
    const qc = new QueryClient();
    qc.setQueryData<CommentView[]>(keys.comments(BOOK), [shown('cm_1', 0.4)]);
    mergeComment(qc, BOOK, marker('cm_1', 0.4));
    expect(comments(qc)).toEqual([shown('cm_1', 0.4)]);
  });

  it('updates a revealed note with a newer revealed copy', () => {
    const qc = new QueryClient();
    qc.setQueryData<CommentView[]>(keys.comments(BOOK), [shown('cm_1', 0.4, undefined, 'old')]);
    mergeComment(qc, BOOK, shown('cm_1', 0.4, undefined, 'edited'));
    expect(comments(qc)![0]).toMatchObject({ text: 'edited' });
  });

  it('does nothing for a book whose notes are not loaded (they are fetched when it opens)', () => {
    const qc = new QueryClient();
    mergeComment(qc, BOOK, shown('cm_1', 0.4));
    expect(comments(qc)).toBeUndefined();
  });

  it('does not change the cached array in place', () => {
    const qc = new QueryClient();
    const before = [shown('cm_1', 0.1)];
    qc.setQueryData<CommentView[]>(keys.comments(BOOK), before);
    mergeComment(qc, BOOK, shown('cm_2', 0.2));
    expect(before.map((c) => c.id)).toEqual(['cm_1']);
  });
});

describe('mergeRevealed and removeComment', () => {
  it('reveal every note a progress report unlocked', () => {
    const qc = new QueryClient();
    qc.setQueryData<CommentView[]>(keys.comments(BOOK), [marker('cm_1', 0.2), marker('cm_2', 0.3), marker('cm_3', 0.9)]);
    mergeRevealed(qc, BOOK, [shown('cm_2', 0.3), shown('cm_1', 0.2)]);
    expect(comments(qc)!.map((c) => [c.id, c.hidden])).toEqual([
      ['cm_1', false],
      ['cm_2', false],
      ['cm_3', true],
    ]);
  });

  // Fidelity review round 15 (D89): it was said to everyone it opened for, conversation or not,
  // without saying which; now only to those in its conversation, with its note.
  it('say so when an answer that waited for where its writer had read to opens (D69), only to those in its conversation', () => {
    // Cole's note; Ana's answer, held for where she had read to; Dee answered the note too.
    const note: CommentView = { ...shown('cm_note', 0.2), userId: 'user_cole', authorName: 'Cole' };
    const held = { ...marker('cm_answer', 0.2), parentId: 'cm_note', horizon: 'Chapter 6' } as CommentView;
    const dee: CommentView = { ...shown('cm_dee', 0.2), userId: 'user_dee', authorName: 'Dee', parentId: 'cm_note' };
    const told = (selfId: string) => {
      const qc = new QueryClient();
      qc.setQueryData<SessionInfo>(keys.session, { user: { id: selfId, displayName: selfId, email: null, color: '#000', source: 'local' }, setupRequired: false, upstream: null });
      qc.setQueryData<CommentView[]>(keys.comments(BOOK), [note, held, dee, marker('cm_other', 0.3)]);
      const heard: [string, string][] = [];
      const listen = (e: Event) => {
        const { answer, note: about } = (e as CustomEvent<AnswerOpen>).detail;
        heard.push([answer.id, about.id]);
      };
      window.addEventListener('bc-answer-open', listen);
      mergeRevealed(qc, BOOK, [{ ...shown('cm_answer', 0.2), parentId: 'cm_note' }, shown('cm_other', 0.3)]);
      window.removeEventListener('bc-answer-open', listen);
      // Open for whoever it opened for, told or not.
      expect(comments(qc)!.find((c) => c.id === 'cm_answer')).toMatchObject({ hidden: false });
      return heard;
    };
    expect(told('user_cole')).toEqual([['cm_answer', 'cm_note']]);
    expect(told('user_dee')).toEqual([['cm_answer', 'cm_note']]);
    expect(told('user_dora')).toEqual([]);
  });

  it('remove a deleted note, and leave unloaded books alone', () => {
    const qc = new QueryClient();
    qc.setQueryData<CommentView[]>(keys.comments(BOOK), [shown('cm_1', 0.2), shown('cm_2', 0.3)]);
    removeComment(qc, BOOK, 'cm_1');
    removeComment(qc, BOOK, 'cm_missing');
    removeComment(qc, 'book_other', 'cm_2');
    expect(comments(qc)!.map((c) => c.id)).toEqual(['cm_2']);
    expect(qc.getQueryData(keys.comments('book_other'))).toBeUndefined();
  });
});

describe('mergeChatMessage and removeChatMessage', () => {
  const author = { userId: 'user_ana', displayName: 'Ana', color: '#FF6B6B' };
  const chatMsg = (id: string, overrides: Partial<ChatMessageView> = {}): ChatMessageView => ({
    id,
    clubId: CLUB,
    bookId: null,
    parentId: null,
    author,
    createdAt: '2026-10-23T10:00:00.000Z',
    editedAt: null,
    reactions: [],
    mine: true,
    hidden: false,
    deleted: false,
    text: `text of ${id}`,
    spoilerLabel: null,
    ...overrides,
  });
  const whole = (qc: QueryClient) => qc.getQueryData<ChatHistory>(keys.chat(CLUB))?.messages;
  const general = (qc: QueryClient) => qc.getQueryData<ChatHistory>(keys.chat(CLUB, 'general'))?.messages;

  it('a live push (chat:new) prepends to both the whole stream and its own channel (D199)', () => {
    const qc = new QueryClient();
    qc.setQueryData<ChatHistory>(keys.chat(CLUB), { messages: [chatMsg('m1')], hasMore: false });
    qc.setQueryData<ChatHistory>(keys.chat(CLUB, 'general'), { messages: [chatMsg('m1')], hasMore: false });
    mergeChatMessage(qc, CLUB, null, chatMsg('m2'));
    expect(whole(qc)!.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(general(qc)!.map((m) => m.id)).toEqual(['m2', 'm1']);
  });

  it('an edit or a reaction (chat:updated) replaces the same message in place, never downgrading a revealed one back to hidden', () => {
    const qc = new QueryClient();
    qc.setQueryData<ChatHistory>(keys.chat(CLUB), { messages: [chatMsg('m1', { text: 'old' })], hasMore: false });
    mergeChatMessage(qc, CLUB, null, chatMsg('m1', { text: 'edited' }));
    expect(whole(qc)![0]).toMatchObject({ text: 'edited' });
    const hiddenAgain: ChatMessageView = { id: 'm1', clubId: CLUB, bookId: null, parentId: null, author, createdAt: '2026-10-23T10:00:00.000Z', editedAt: null, reactions: [], mine: true, hidden: true, spoilerLabel: 'Spoiler' };
    mergeChatMessage(qc, CLUB, null, hiddenAgain);
    expect(whole(qc)![0]).toMatchObject({ hidden: false, text: 'edited' });
  });

  it('does nothing for a channel not loaded (fetched when it opens)', () => {
    const qc = new QueryClient();
    mergeChatMessage(qc, CLUB, null, chatMsg('m1'));
    expect(whole(qc)).toBeUndefined();
  });

  // The fix for a flaky delete (D173): the deleter's own view no longer waits on `chat:deleted`'s
  // round trip to see it gone, so this is exactly what ChatPanel.tsx's `remove` now calls at once.
  it('a delete (chat:deleted) drops the message from both caches, regardless of replies, leaving the other message and an unloaded club alone', () => {
    const qc = new QueryClient();
    qc.setQueryData<ChatHistory>(keys.chat(CLUB), { messages: [chatMsg('m1'), chatMsg('m2')], hasMore: false });
    qc.setQueryData<ChatHistory>(keys.chat(CLUB, 'general'), { messages: [chatMsg('m1'), chatMsg('m2')], hasMore: false });
    removeChatMessage(qc, CLUB, null, 'm1');
    removeChatMessage(qc, CLUB, null, 'm_missing');
    expect(whole(qc)!.map((m) => m.id)).toEqual(['m2']);
    expect(general(qc)!.map((m) => m.id)).toEqual(['m2']);
    expect(qc.getQueryData(keys.chat('club_other'))).toBeUndefined();
  });
});

describe('applyMemberProgress', () => {
  const progress = (userId: string, t: number): MemberProgress => ({
    userId,
    displayName: userId,
    color: '#4ECDC4',
    t,
    furthest: t,
    coverage: t,
    kind: 'epub',
    label: `${t}`,
    updatedAt: '2026-10-23T10:00:00.000Z',
    finished: false,
  });
  const summary = (id: string, members: MemberProgress[]): BookSummary => ({
    id,
    clubId: CLUB,
    title: id,
    author: 'Someone',
    coverUrl: `/api/books/${id}/cover?v=1`,
    hasCover: false,
    kinds: ['epub'],
    createdAt: '2026-10-01T00:00:00.000Z',
    addedBy: 'user_ana',
    commentCount: 0, meeting: null,
    progress: members,
  });

  function cached(selfId: string) {
    const qc = new QueryClient();
    qc.setQueryData<SessionInfo>(keys.session, { user: { id: selfId, displayName: 'Me', email: null, color: '#000', source: 'local' }, setupRequired: false, upstream: null });
    qc.setQueryData<BookProgress>(keys.progress(BOOK), { mine: null, members: [progress('user_ana', 0.1), progress('user_ben', 0.2)] });
    qc.setQueryData<BookSummary[]>(keys.books(CLUB), [summary(BOOK, [progress('user_ana', 0.1), progress('user_ben', 0.2)]), summary('book_other', [progress('user_ben', 0.9)])]);
    qc.setQueryData<BookDetail>(keys.book(BOOK), { ...summary(BOOK, [progress('user_ben', 0.2)]), chapters: [], editions: [], referenceEditionId: null });
    return qc;
  }

  it("moves a member's marker everywhere the book is shown: the reader, the library and the book page", () => {
    const qc = cached('user_ana');
    applyMemberProgress(qc, BOOK, CLUB, progress('user_ben', 0.7));
    expect(qc.getQueryData<BookProgress>(keys.progress(BOOK))!.members.map((m) => [m.userId, m.t])).toEqual([
      ['user_ana', 0.1],
      ['user_ben', 0.7],
    ]);
    const books = qc.getQueryData<BookSummary[]>(keys.books(CLUB))!;
    expect(books[0]!.progress.map((m) => m.t)).toEqual([0.1, 0.7]);
    expect(books[1]!.progress.map((m) => m.t)).toEqual([0.9]); // another book: untouched
    expect(qc.getQueryData<BookDetail>(keys.book(BOOK))!.progress.map((m) => m.t)).toEqual([0.7]);
  });

  // BUG (lib/queries.ts, applyMemberProgress): for my own progress it first invalidates
  // keys.progress(bookId) (refetchType 'none'), then calls setQueryData on that same key to patch
  // the members list. TanStack's setQueryData dispatches a success that resets isInvalidated to
  // false (and dataUpdatedAt to now: query-core successState), so the invalidation is undone at
  // once. BookPage reads `mine` through useProgress(bookId) without `fresh`, so after I read on
  // another device it keeps showing my old place ("You are at …", "Continue reading") and does
  // not refetch on mount while the cache is fresh, which every club member's live progress event
  // renews for another 30 s. Invalidating after the setQueryData calls would keep the mark.
  it('marks my own saved place out of date when it moved on another device, without refetching it now', () => {
    const qc = cached('user_ben');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    applyMemberProgress(qc, BOOK, CLUB, progress('user_ben', 0.7));
    expect(qc.getQueryState(keys.progress(BOOK))?.isInvalidated).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves my saved place alone when it is someone else's progress", () => {
    const qc = cached('user_ana');
    applyMemberProgress(qc, BOOK, CLUB, progress('user_ben', 0.7));
    expect(qc.getQueryState(keys.progress(BOOK))?.isInvalidated).toBe(false);
  });

  it('does nothing for views that are not loaded', () => {
    const qc = new QueryClient();
    applyMemberProgress(qc, BOOK, CLUB, progress('user_ben', 0.7));
    expect(qc.getQueryData(keys.progress(BOOK))).toBeUndefined();
    expect(qc.getQueryData(keys.books(CLUB))).toBeUndefined();
    expect(qc.getQueryData(keys.book(BOOK))).toBeUndefined();
  });
});

describe('makeQueryClient', () => {
  async function attempts(error: unknown): Promise<number> {
    const qc = makeQueryClient();
    let calls = 0;
    await qc
      .fetchQuery({
        queryKey: ['probe'],
        queryFn: () => {
          calls++;
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        },
        retryDelay: 0,
      })
      .catch(() => undefined);
    qc.clear();
    return calls;
  }

  it.each([400, 401, 403, 404, 409, 422])('never retries a refusal (%i)', async (status) => {
    expect(await attempts(new ApiError(status, 'refused', 'No.'))).toBe(1);
  });

  it.each([
    ['a server error', new ApiError(503, 'error', 'Request failed (503).')],
    ['being offline', new ApiError(0, 'offline', 'You appear to be offline.')],
    ['any other failure', new TypeError('Failed to fetch')],
  ])('retries %s twice', async (_what, error) => {
    expect(await attempts(error)).toBe(3);
  });

  it('keeps answers for a day, so an offline device still shows its books', () => {
    const options = makeQueryClient().getDefaultOptions().queries!;
    expect(options.gcTime).toBe(24 * 3600_000);
    expect(options.networkMode).toBe('offlineFirst');
  });
});

describe('sessionOrSnapshot (who is signed in, offline too)', () => {
  const ana: SessionInfo = { user: { id: 'user_ana', displayName: 'Ana', email: 'ana@example.com', color: '#FF6B6B', source: 'local' }, setupRequired: false, upstream: null };
  const answer = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))));
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('remembers the last answer, and gives it when the device is offline', async () => {
    answer(ana);
    expect(await sessionOrSnapshot()).toEqual(ana);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await sessionOrSnapshot()).toEqual(ana);
    // The service worker's own offline answer counts as offline too.
    answer({ error: { code: 'offline', message: 'You are offline.' } }, 503);
    expect(await sessionOrSnapshot()).toEqual(ana);
  });

  it('forgets it when nobody is signed in, and is offline like anything else without one', async () => {
    answer(ana);
    await sessionOrSnapshot();
    answer({ user: null, setupRequired: false, upstream: null });
    expect((await sessionOrSnapshot()).user).toBeNull();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(sessionOrSnapshot()).rejects.toMatchObject({ code: 'offline' });
  });

  it('never stands in for a server that answered with an error', async () => {
    answer(ana);
    await sessionOrSnapshot();
    answer({ error: { code: 'error', message: 'Broken' } }, 500);
    await expect(sessionOrSnapshot()).rejects.toMatchObject({ status: 500 });
  });
});


describe('bookNeedsPoll', () => {
  it('polls while an edition is still processing', () => {
    expect(bookNeedsPoll([{ status: 'processing' }])).toBe(1500);
    expect(bookNeedsPoll([{ status: 'ready' }, { status: 'processing' }])).toBe(1500);
  });

  it('polls while live transcription progress is present and not failed', () => {
    expect(bookNeedsPoll([{ status: 'ready', transcription: { stage: 'transcribing' } }])).toBe(2000);
    expect(bookNeedsPoll([{ status: 'ready', transcription: { stage: 'failed' } }])).toBe(false);
  });

  it('does not poll forever when a ready audiobook merely lacks forced alignment', () => {
    expect(
      bookNeedsPoll([
        { status: 'ready' },
        { status: 'ready', transcription: null },
      ]),
    ).toBe(false);
    expect(bookNeedsPoll(undefined)).toBe(false);
  });
});
