import { QueryClient } from '@tanstack/react-query';
import type { CommentView, CreateCommentBody, SessionInfo } from '@bookclub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setPageUser } from './api';
import { bindOutbox, flushPendingNotes } from './outbox';
import { KEPT_MESSAGE, forgetPendingNote, keepNoteForLater, pendingNotes } from './pending-notes';
import { keys } from './queries';

const BOOK = 'book_alice';
const body = (clientId: string, reaction = '😂'): CreateCommentBody & { clientId: string } => ({
  editionId: 'ed_epub',
  locator: { kind: 'epub', section: 2, offset: 10 },
  reaction: reaction as CreateCommentBody['reaction'],
  clientId,
});
const view = (id: string): CommentView => ({
  id,
  bookId: BOOK,
  userId: 'user_ana',
  authorName: 'Ana',
  color: '#FF6B6B',
  t: 0.2,
  editionId: 'ed_epub',
  kind: 'epub',
  locator: { kind: 'epub', section: 2, offset: 10 },
  reaction: '😂',
  createdAt: '2026-10-24T11:00:00.000Z',
  hidden: false,
  endLocator: null,
  endT: null,
  quote: null,
  text: null,
});

let qc: QueryClient;
beforeEach(() => {
  localStorage.clear();
  qc = new QueryClient();
  qc.setQueryData<SessionInfo>(keys.session, { user: { id: 'user_ana', displayName: 'Ana', email: 'ana@example.com', color: '#FF6B6B', source: 'local' }, setupRequired: false, upstream: null });
  qc.setQueryData<CommentView[]>(keys.comments(BOOK), []);
  bindOutbox(qc);
  setPageUser('user_ana');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setPageUser(undefined);
});

describe('notes kept on the device', () => {
  it('are kept once each, per person, until forgotten', () => {
    keepNoteForLater('user_ana', { bookId: BOOK, body: body('c1') });
    keepNoteForLater('user_ana', { bookId: BOOK, body: body('c1') });
    keepNoteForLater('user_ana', { bookId: BOOK, body: body('c2', '😢') });
    expect(pendingNotes('user_ana').map((n) => n.body.clientId)).toEqual(['c1', 'c2']);
    expect(pendingNotes('user_ben')).toEqual([]);
    forgetPendingNote('user_ana', 'c1');
    expect(pendingNotes('user_ana').map((n) => n.body.clientId)).toEqual(['c2']);
  });

  it('a note made with no network is kept, with its client id, and the reader is told so', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    const made = api.createComment(BOOK, { editionId: 'ed_epub', locator: { kind: 'epub', section: 2, offset: 10 }, reaction: '😂' });
    const outcome = made.catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    const err = await outcome;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'kept', message: KEPT_MESSAGE });
    const kept = pendingNotes('user_ana');
    expect(kept).toHaveLength(1);
    expect(kept[0]!.body.clientId).toMatch(/.+/);
  });

  it('are pinned once the network is back, each with its own client id, and show in the book', async () => {
    keepNoteForLater('user_ana', { bookId: BOOK, body: body('c1') });
    keepNoteForLater('user_ana', { bookId: BOOK, body: body('c2', '😢') });
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const b = JSON.parse(init!.body as string) as { clientId: string };
        sent.push(b.clientId);
        return new Response(JSON.stringify(view(`cm_${b.clientId}`)), { status: 201, headers: { 'content-type': 'application/json' } });
      }),
    );
    expect(await flushPendingNotes()).toBe(2);
    expect(sent).toEqual(['c1', 'c2']);
    expect(pendingNotes('user_ana')).toEqual([]);
    expect(qc.getQueryData<CommentView[]>(keys.comments(BOOK))!.map((c) => c.id)).toEqual(['cm_c1', 'cm_c2']);
  });

  it('stay kept while there is still no network, and one the server refuses is let go', async () => {
    keepNoteForLater('user_ana', { bookId: BOOK, body: body('gone') });
    keepNoteForLater('user_ana', { bookId: BOOK, body: body('later') });
    let online = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const b = JSON.parse(init!.body as string) as { clientId: string };
        if (!online) throw new TypeError('Failed to fetch');
        if (b.clientId === 'gone') return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Book not found.' } }), { status: 404, headers: { 'content-type': 'application/json' } });
        online = false;
        throw new TypeError('Failed to fetch');
      }),
    );
    vi.useFakeTimers();
    const flushed = flushPendingNotes();
    await vi.runAllTimersAsync();
    expect(await flushed).toBe(0);
    expect(pendingNotes('user_ana').map((n) => n.body.clientId)).toEqual(['later']);
  });
});
