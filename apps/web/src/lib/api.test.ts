import type { CommentView, CreateCommentBody, ProgressUpdateBody } from '@bookclub/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, DROPPED_RETRY_MS, api, beaconProgress, isOfflineError, newClientId, setPageUser, unauthorizedEvents } from './api';
import { KEPT_MESSAGE } from './pending-notes';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** The URL of a fetch call (the app always passes a string). */
const urlOf = (input: RequestInfo | URL) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

/** Replace `fetch` with one that answers from `answers` in turn (the last one repeats). */
function server(...answers: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: urlOf(input), init: init ?? {} });
    return answers[Math.min(calls.length, answers.length) - 1]!();
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const dropped = () => Promise.reject(new TypeError('Failed to fetch'));
const bodyOf = (call: Call) => (typeof call.init.body === 'string' ? (JSON.parse(call.init.body) as unknown) : call.init.body);
const headersOf = (call: Call) => new Headers(call.init.headers);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('responses', () => {
  it('returns the JSON body of a successful answer', async () => {
    const clubs = [{ id: 'club_123', name: 'Readers', description: '', role: 'owner', memberCount: 3, bookCount: 1 }];
    server(() => json(clubs));
    await expect(api.clubs()).resolves.toEqual(clubs);
  });

  it('resolves a 204 No Content answer to undefined', async () => {
    server(() => new Response(null, { status: 204 }));
    await expect(api.deleteBook('book_123')).resolves.toBeUndefined();
  });

  it('resolves an empty successful body to null rather than failing to parse it', async () => {
    server(() => new Response('', { status: 200 }));
    await expect(api.signOut()).resolves.toBeNull();
  });
});

describe('errors', () => {
  it('turns the server error body into an ApiError with status, code, message and fields', async () => {
    server(() => json({ error: { code: 'validation', message: 'Check the highlighted fields.', fields: { email: 'Enter a valid email address' } } }, 422));
    const err = await api.signUp({ inviteCode: 'abcdefgh', displayName: 'Ana', email: 'nope', password: 'long enough password' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: 'ApiError', status: 422, code: 'validation', message: 'Check the highlighted fields.', fields: { email: 'Enter a valid email address' } });
  });

  it('has no fields when the error body has none', async () => {
    server(() => json({ error: { code: 'not_found', message: 'No such book.' } }, 404));
    await expect(api.book('book_123')).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'No such book.', fields: {} });
  });

  it.each([
    ['an HTML page from a proxy', () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } }), 502],
    ['an empty body', () => new Response('', { status: 500 }), 500],
    ['JSON without an error object', () => json({ ok: false }, 503), 503],
  ])('gives a generic error for %s', async (_label, answer, status) => {
    server(answer);
    await expect(api.clubs()).rejects.toMatchObject({ status, code: 'error', message: `Request failed (${status}).`, fields: {} });
  });

  it('reports a request that never reached the server as ApiError(0, "offline")', async () => {
    server(dropped);
    const err = await api.clubs().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'offline', message: 'You appear to be offline.' });
    expect(isOfflineError(err)).toBe(true);
  });
});

describe('isOfflineError', () => {
  it('is true for a failed fetch and for the offline ApiError', () => {
    expect(isOfflineError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isOfflineError(new TypeError('Load failed'))).toBe(true);
    expect(isOfflineError(new ApiError(0, 'offline', 'You appear to be offline.'))).toBe(true);
  });

  it('is false for answers from the server and for other errors', () => {
    expect(isOfflineError(new ApiError(500, 'error', 'Request failed (500).'))).toBe(false);
    expect(isOfflineError(new ApiError(404, 'not_found', 'No such book.'))).toBe(false);
    expect(isOfflineError(new Error('boom'))).toBe(false);
    expect(isOfflineError('offline')).toBe(false);
    expect(isOfflineError(null)).toBe(false);
  });
});

describe('requests', () => {
  it('sends JSON bodies with the method, an Accept header and same-origin cookies', async () => {
    const { calls } = server(() => json({ user: { id: 'user_123' } }));
    await api.updateMe({ displayName: 'Ana B.' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('/api/me');
    expect(call.init.method).toBe('PATCH');
    expect(call.init.credentials).toBe('same-origin');
    expect(headersOf(call).get('Content-Type')).toBe('application/json');
    expect(headersOf(call).get('Accept')).toBe('application/json');
    expect(bodyOf(call)).toEqual({ displayName: 'Ana B.' });
  });

  it('sends no body, and no Content-Type, with a GET', async () => {
    const { calls } = server(() => json([]));
    await api.clubs();
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.body).toBeUndefined();
    expect(headersOf(calls[0]!).has('Content-Type')).toBe(false);
  });

  it('sends a valid JSON body with a POST that has no payload (the server parses every JSON request)', async () => {
    const { calls } = server(() => new Response(null, { status: 204 }));
    await api.signOut();
    expect(calls[0]!.init.method).toBe('POST');
    expect(headersOf(calls[0]!).get('Content-Type')).toBe('application/json');
    expect(bodyOf(calls[0]!)).toEqual({});
  });

  it('encodes user-supplied parts of URLs', async () => {
    const { calls } = server(() => json([]));
    await api.invitePreview('a/b c?d');
    await api.bookMatches('club_123', 'Alice & Bob', 'Carroll?');
    expect(calls.map((c) => c.url)).toEqual(['/api/invites/a%2Fb%20c%3Fd', '/api/clubs/club_123/book-matches?title=Alice%20%26%20Bob&author=Carroll%3F']);
  });
});

describe('unauthorized answers', () => {
  function listen() {
    const heard = vi.fn();
    unauthorizedEvents.addEventListener('unauthorized', heard);
    return { heard, stop: () => unauthorizedEvents.removeEventListener('unauthorized', heard) };
  }

  it('tell the app to sign in again when a protected endpoint answers 401', async () => {
    const { heard, stop } = listen();
    server(() => json({ error: { code: 'unauthorized', message: 'Sign in first.' } }, 401));
    await expect(api.clubs()).rejects.toMatchObject({ status: 401 });
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });

  it('do not, for the session check or a failed sign-in (those are expected to answer 401)', async () => {
    const { heard, stop } = listen();
    server(() => json({ error: { code: 'unauthorized', message: 'Wrong email or password.' } }, 401));
    await expect(api.session()).rejects.toMatchObject({ status: 401 });
    await expect(api.signIn({ email: 'ana@example.com', password: 'wrong' })).rejects.toMatchObject({ status: 401, message: 'Wrong email or password.' });
    expect(heard).not.toHaveBeenCalled();
    stop();
  });

  it('do not, for other errors', async () => {
    const { heard, stop } = listen();
    server(() => json({ error: { code: 'forbidden', message: 'Not your club.' } }, 403));
    await expect(api.clubs()).rejects.toMatchObject({ status: 403 });
    expect(heard).not.toHaveBeenCalled();
    stop();
  });
});

describe('newClientId', () => {
  it('fits the server rule for client ids (8 to 64 characters) and is URL-safe', () => {
    for (let i = 0; i < 500; i++) {
      const id = newClientId();
      expect(id).toMatch(/^c_[0-9a-z]+$/);
      expect(id.length).toBeGreaterThanOrEqual(8);
      expect(id.length).toBeLessThanOrEqual(64);
    }
  });

  it('never repeats, even for ids made in the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const ids = new Set(Array.from({ length: 10_000 }, () => newClientId()));
    expect(ids.size).toBe(10_000);
  });
});

describe('createComment', () => {
  const body: CreateCommentBody = { editionId: 'ed_epub_1', locator: { kind: 'epub', section: 3, offset: 120 }, text: 'What a line', clientId: 'c_abc123xyz' };
  const created: CommentView = {
    id: 'cm_123456',
    bookId: 'book_123',
    userId: 'user_ana',
    authorName: 'Ana',
    color: '#FF6B6B',
    t: 0.31,
    editionId: 'ed_epub_1',
    kind: 'epub',
    locator: { kind: 'epub', section: 3, offset: 120 },
    reaction: null,
    createdAt: '2026-10-23T12:00:00.000Z',
    hidden: false,
    endLocator: null,
    endT: null,
    quote: null,
    text: 'What a line',
  };
  const serverError = () => json({ error: { code: 'internal', message: 'Something broke.' } }, 503);

  it('retries a dropped connection with the same clientId and returns the comment', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { calls } = server(dropped, () => json(created, 201));
    const sent = api.createComment('book_123', body);
    await vi.advanceTimersByTimeAsync(800);
    await expect(sent).resolves.toEqual(created);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toBe('/api/books/book_123/comments');
      expect(c.init.method).toBe('POST');
      expect(bodyOf(c)).toEqual(body);
    }
  });

  it('retries a server error (5xx) with the same clientId', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { calls } = server(serverError, serverError, () => json(created, 201));
    const sent = api.createComment('book_123', body);
    await vi.advanceTimersByTimeAsync(800 + 1600);
    await expect(sent).resolves.toEqual(created);
    expect(calls.map((c) => (bodyOf(c) as CreateCommentBody).clientId)).toEqual(['c_abc123xyz', 'c_abc123xyz', 'c_abc123xyz']);
  });

  it('waits longer before each retry of a server error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fetchMock } = server(serverError, serverError, () => json(created, 201));
    const sent = api.createComment('book_123', body);
    await vi.advanceTimersByTimeAsync(799);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1599);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(sent).resolves.toEqual(created);
  });

  describe('with no network (fidelity review round 16: "Posting…" for 3 s first)', () => {
    afterEach(() => {
      setPageUser(undefined);
      localStorage.clear();
    });
    const keptNotes = () => JSON.parse(localStorage.getItem('bookclub:pending-notes:user_ana') ?? '[]') as { bookId: string; body: CreateCommentBody }[];

    it('keeps the note on the device at once, sending nothing, when the browser says it is offline', async () => {
      setPageUser('user_ana');
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      const { fetchMock } = server(() => json(created, 201));
      await expect(api.createComment('book_123', body)).rejects.toMatchObject({ status: 0, code: 'kept', message: KEPT_MESSAGE });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(keptNotes()).toEqual([{ bookId: 'book_123', body }]);
    });

    it('tries a dropped connection once more, soon, then keeps the note to pin later', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      setPageUser('user_ana');
      const { fetchMock } = server(dropped);
      const sent = api.createComment('book_123', body);
      const outcome = expect(sent).rejects.toMatchObject({ code: 'kept' });
      await vi.advanceTimersByTimeAsync(DROPPED_RETRY_MS - 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(DROPPED_RETRY_MS).toBeLessThan(1000);
      expect(keptNotes()).toEqual([{ bookId: 'book_123', body }]);
    });

    it('keeps it after the first try when the browser has gone offline meanwhile', async () => {
      setPageUser('user_ana');
      const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
      const { fetchMock } = server(() => {
        onLine.mockReturnValue(false);
        return dropped();
      });
      await expect(api.createComment('book_123', body)).rejects.toMatchObject({ code: 'kept' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('waits for a slow answer however long it takes: a slow network still posts', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      setPageUser('user_ana');
      const { fetchMock } = server(() => new Promise((resolve) => setTimeout(() => resolve(json(created, 201)), 45_000)));
      const sent = api.createComment('book_123', body);
      await vi.advanceTimersByTimeAsync(45_000);
      await expect(sent).resolves.toEqual(created);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(keptNotes()).toEqual([]);
    });

    it('is not kept when it is the outbox sending a kept note (it stays kept as it was)', async () => {
      setPageUser('user_ana');
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      const { fetchMock } = server(dropped);
      await expect(api.createComment('book_123', body, { keep: false })).rejects.toMatchObject({ status: 0, code: 'offline' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(keptNotes()).toEqual([]);
    });
  });

  it('gives up after three attempts with the last error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fetchMock } = server(dropped, serverError, dropped);
    const sent = api.createComment('book_123', body);
    const outcome = expect(sent).rejects.toMatchObject({ status: 0, code: 'offline' });
    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 403, 404, 409, 413, 422, 429])('never retries a refusal (%i)', async (status) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fetchMock } = server(() => json({ error: { code: 'refused', message: 'No.' } }, status), () => json(created, 201));
    const sent = api.createComment('book_123', body);
    const outcome = expect(sent).rejects.toMatchObject({ status });
    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('beaconProgress', () => {
  const progress: ProgressUpdateBody = { editionId: 'ed_epub_1', locator: { kind: 'epub', section: 1, offset: 5 }, readSpans: [], at: 1_700_000_000_000 };

  it('reports false where the browser has no sendBeacon', () => {
    expect('sendBeacon' in navigator).toBe(false);
    expect(beaconProgress('book_123', progress)).toBe(false);
  });

  it('sends the progress as a JSON beacon that survives the page closing, saying whose it is', async () => {
    const sendBeacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
    setPageUser('user_ana');
    try {
      expect(beaconProgress('book_123', progress)).toBe(true);
      expect(sendBeacon).toHaveBeenCalledTimes(1);
      const [url, data] = sendBeacon.mock.calls[0]!;
      // A beacon cannot carry headers: whose reading it is goes in the address.
      expect(url).toBe('/api/books/book_123/progress/beacon?as=user_ana');
      expect(data).toBeInstanceOf(Blob);
      expect((data as Blob).type).toBe('application/json');
      expect(JSON.parse(await (data as Blob).text())).toEqual(progress);
    } finally {
      Reflect.deleteProperty(navigator, 'sendBeacon');
      setPageUser(undefined);
    }
  });

  it('sends nothing while nobody is signed in on the page (or one person is giving way to another)', () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
    setPageUser(null);
    try {
      expect(beaconProgress('book_123', progress)).toBe(false);
      expect(sendBeacon).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, 'sendBeacon');
      setPageUser(undefined);
    }
  });
});

describe('whose page it is', () => {
  afterEach(() => {
    setPageUser(undefined);
    vi.unstubAllGlobals();
  });

  it('every change names the page’s person; reads do not', async () => {
    const { calls } = server(() => json({ mine: null, revealed: [], members: [] }));
    setPageUser('user_ana');
    await api.progress('book_1');
    await api.putProgress('book_1', { editionId: 'ed_1', locator: { kind: 'epub', section: 0, offset: 0 }, readSpans: [], at: 1 });
    await api.deleteComment('c_1').catch(() => undefined);
    const header = (c: Call) => new Headers(c.init.headers).get('X-Bookclub-User');
    expect(calls.map(header)).toEqual([null, 'user_ana', 'user_ana']);
  });

  it('progress queued by one person is sent as theirs, whoever this page now shows', async () => {
    const { calls } = server(() => json({ mine: null, revealed: [] }));
    setPageUser('user_ben');
    await api.putProgress('book_1', { editionId: 'ed_1', locator: { kind: 'epub', section: 0, offset: 0 }, readSpans: [], at: 1 }, 'user_ana');
    expect(new Headers(calls[0]!.init.headers).get('X-Bookclub-User')).toBe('user_ana');
  });

  it('a session that became someone else’s is refused, and the app is told to look again', async () => {
    server(() => json({ error: { code: 'session_changed', message: 'Someone else is signed in on this device now.' } }, 409));
    setPageUser('user_ana');
    const seen = vi.fn();
    unauthorizedEvents.addEventListener('unauthorized', seen);
    try {
      await expect(api.deleteComment('c_1')).rejects.toMatchObject({ status: 409, code: 'session_changed' });
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      unauthorizedEvents.removeEventListener('unauthorized', seen);
    }
  });
});
