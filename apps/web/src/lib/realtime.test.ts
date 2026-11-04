import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { BookProgress, ClientMessage, CommentView, MemberProgress, NotificationList, NotificationView, PresenceEntry, ServerMessage } from '@bookclub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys } from './queries';
import { Realtime, parseServerMessage } from './realtime';

/* parseServerMessage --------------------------------------------------------------------------- */

const member = (userId: string, over: Partial<PresenceEntry> = {}): PresenceEntry => ({
  userId,
  displayName: userId.replace('user_', ''),
  color: '#4ECDC4',
  online: true,
  reading: null,
  ...over,
});

const progressOf = (userId: string, t: number): MemberProgress => ({
  userId,
  displayName: userId.replace('user_', ''),
  color: '#4ECDC4',
  t,
  furthest: t,
  coverage: t,
  kind: 'epub',
  label: `${Math.round(t * 100)}%`,
  updatedAt: '2026-10-23T12:00:00.000Z',
  finished: false,
});

const comment = (id: string, t: number): CommentView => ({
  id,
  bookId: 'book_123',
  userId: 'user_ana',
  authorName: 'Ana',
  color: '#FF6B6B',
  t,
  editionId: 'ed_epub_1',
  kind: 'epub',
  locator: { kind: 'epub', section: 2, offset: 10 },
  reaction: '😂',
  createdAt: '2026-10-23T12:00:00.000Z',
  hidden: true,
  hasText: true,
});

/** One message of every type the server sends. */
const EVERY_MESSAGE: ServerMessage[] = [
  { type: 'hello', userId: 'user_ana' },
  { type: 'presence', clubId: 'club_123', members: [member('user_ana')] },
  { type: 'presence:update', clubId: 'club_123', entry: member('user_ben') },
  { type: 'progress', clubId: 'club_123', bookId: 'book_123', progress: progressOf('user_ana', 0.4) },
  { type: 'comment:new', clubId: 'club_123', bookId: 'book_123', comment: comment('cm_1', 0.2) },
  { type: 'comment:deleted', clubId: 'club_123', bookId: 'book_123', commentId: 'cm_1' },
  { type: 'book:changed', clubId: 'club_123', bookId: 'book_123' },
  { type: 'club:changed', clubId: 'club_123' },
  { type: 'pong' },
  { type: 'error', message: 'Not a member of that club.' },
];

describe('parseServerMessage', () => {
  it.each(EVERY_MESSAGE.map((m) => [m.type, m] as const))('accepts a %s message', (_type, message) => {
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each(['chat', 'subscribe', 'HELLO', '', 'toString', '__proto__', 'constructor', 'hasOwnProperty'])('drops a message of unknown type %j', (type) => {
    expect(parseServerMessage(JSON.stringify({ type, clubId: 'club_123' }))).toBeNull();
  });

  it.each(['not json', '{"type":"hello"', '', 'undefined', "{'type':'pong'}"])('drops a frame that is not JSON: %j', (raw) => {
    expect(parseServerMessage(raw)).toBeNull();
  });

  it.each(['null', '42', '"pong"', 'true', '["pong"]', '[{"type":"pong"}]', '{}', '{"type":5}', '{"type":null}', '{"kind":"pong"}'])('drops JSON that is not a message object: %s', (raw) => {
    expect(parseServerMessage(raw)).toBeNull();
  });
});

/* Realtime ------------------------------------------------------------------------------------- */

/** A WebSocket the test drives: it opens, delivers frames and drops when told to. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  readonly sent: ClientMessage[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closedByClient = false;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  static get last(): FakeSocket {
    return FakeSocket.all[FakeSocket.all.length - 1]!;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = FakeSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(message: ServerMessage | string): void {
    this.onmessage?.(new MessageEvent('message', { data: typeof message === 'string' ? message : JSON.stringify(message) }));
  }

  drop(code = 1006): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code }));
  }
}

describe('Realtime', () => {
  let qc: QueryClient;
  let rt: Realtime;

  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    qc = new QueryClient();
    rt = new Realtime(qc);
  });

  afterEach(() => {
    rt.stop();
    qc.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Start and open the first connection. */
  function connected(): FakeSocket {
    rt.start();
    const socket = FakeSocket.last;
    socket.open();
    return socket;
  }

  it('connects to /ws on the page host and subscribes to the clubs on screen once open', () => {
    rt.subscribe('club_123');
    rt.start();
    expect(FakeSocket.all.map((s) => s.url)).toEqual(['ws://localhost:3000/ws']);
    expect(rt.connected).toBe(false);
    FakeSocket.last.open();
    expect(rt.connected).toBe(true);
    expect(FakeSocket.last.sent).toEqual([{ type: 'subscribe', clubId: 'club_123' }]);
  });

  it('starts only once', () => {
    rt.start();
    rt.start();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('subscribes once per club however many screens want it, and unsubscribes after the last one goes', () => {
    const socket = connected();
    const first = rt.subscribe('club_123');
    const second = rt.subscribe('club_123');
    expect(socket.sent).toEqual([{ type: 'subscribe', clubId: 'club_123' }]);
    first();
    expect(socket.sent).toHaveLength(1);
    second();
    expect(socket.sent).toEqual([
      { type: 'subscribe', clubId: 'club_123' },
      { type: 'unsubscribe', clubId: 'club_123' },
    ]);
  });

  it('keeps who is here per club and tells listeners when it changes', () => {
    const socket = connected();
    const listener = vi.fn();
    rt.listen(listener);
    const before = rt.version();
    socket.receive({ type: 'presence', clubId: 'club_123', members: [member('user_ana'), member('user_ben', { online: false })] });
    expect([...rt.presenceOf('club_123').keys()]).toEqual(['user_ana', 'user_ben']);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(rt.version()).toBeGreaterThan(before);

    const reading = { bookId: 'book_123', editionId: 'ed_epub_1', kind: 'epub' as const, t: 0.5, label: 'Chapter 3', at: 1 };
    socket.receive({ type: 'presence:update', clubId: 'club_123', entry: member('user_ben', { reading }) });
    expect(rt.presenceOf('club_123').get('user_ben')?.reading).toEqual(reading);
    expect(rt.presenceOf('club_123').get('user_ana')?.online).toBe(true);
    expect(rt.presenceOf('another_club').size).toBe(0);
  });

  it('applies live progress and comments to the cache', () => {
    const socket = connected();
    qc.setQueryData<BookProgress>(keys.progress('book_123'), { mine: null, members: [progressOf('user_ana', 0.1), progressOf('user_ben', 0.2)] });
    qc.setQueryData<CommentView[]>(keys.comments('book_123'), [comment('cm_1', 0.5)]);

    socket.receive({ type: 'progress', clubId: 'club_123', bookId: 'book_123', progress: progressOf('user_ben', 0.7) });
    expect(qc.getQueryData<BookProgress>(keys.progress('book_123'))!.members.map((m) => m.t)).toEqual([0.1, 0.7]);

    socket.receive({ type: 'comment:new', clubId: 'club_123', bookId: 'book_123', comment: comment('cm_2', 0.3) });
    expect(qc.getQueryData<CommentView[]>(keys.comments('book_123'))!.map((c) => c.id)).toEqual(['cm_2', 'cm_1']);

    socket.receive({ type: 'comment:deleted', clubId: 'club_123', bookId: 'book_123', commentId: 'cm_1' });
    expect(qc.getQueryData<CommentView[]>(keys.comments('book_123'))!.map((c) => c.id)).toEqual(['cm_2']);
  });

  it('keeps a notification pushed while the bell’s list is fetched, when that fetch was answered before it was stored', async () => {
    vi.useRealTimers();
    const socket = connected();
    const note = (id: string): NotificationView => ({
      id,
      kind: 'reply',
      bookId: 'book_123',
      bookTitle: 'Alice',
      commentId: `cm_${id}`,
      noteId: 'cm_1',
      clubId: null,
      clubName: null,
      chatMessageId: null,
      actorName: 'Cleo',
      actorColor: '#45B7D1',
      where: 'Chapter 9 · 70%',
      text: null,
      read: false,
      createdAt: '2026-10-25T04:00:00.000Z',
    });
    const before: NotificationList = { unread: 2, items: [note('nt_2'), note('nt_1')] };
    const after: NotificationList = { unread: 3, items: [note('nt_3'), ...before.items] };
    let answerFirst!: (list: NotificationList) => void;
    let fetches = 0;
    // The bell on screen, its list being fetched as the server stores Cleo's answer.
    const bell = new QueryObserver(qc, {
      queryKey: keys.notifications,
      queryFn: () => (++fetches === 1 ? new Promise<NotificationList>((resolve) => (answerFirst = resolve)) : Promise.resolve(after)),
    });
    const stop = bell.subscribe(() => undefined);
    await vi.waitFor(() => expect(fetches).toBe(1));
    socket.receive({ type: 'notification:new', notification: note('nt_3') });
    // The first fetch answers with the list from before it was stored.
    answerFirst(before);
    await vi.waitFor(() => expect(qc.getQueryData<NotificationList>(keys.notifications)?.unread).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(qc.getQueryData<NotificationList>(keys.notifications)).toEqual(after);
    stop();
  });

  it('marks changed books and clubs as stale', () => {
    const socket = connected();
    const hanging = [keys.comments('book_123'), keys.progress('book_123'), keys.readAlong('ed_audio', 0)];
    for (const key of [keys.book('book_123'), keys.books('club_123'), keys.club('club_123'), keys.clubs, keys.book('book_other'), keys.comments('book_other'), ...hanging]) qc.setQueryData(key, {});
    socket.receive({ type: 'book:changed', clubId: 'club_123', bookId: 'book_123' });
    expect(qc.getQueryState(keys.book('book_123'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.books('club_123'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.club('club_123'))?.isInvalidated).toBe(false);
    // What hangs off the book too: lining up an audiobook moves notes, places and sentences.
    for (const key of hanging) expect(qc.getQueryState(key)?.isInvalidated, String(key)).toBe(true);
    expect(qc.getQueryState(keys.comments('book_other'))?.isInvalidated).toBe(false);

    socket.receive({ type: 'club:changed', clubId: 'club_123' });
    expect(qc.getQueryState(keys.club('club_123'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.clubs)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.book('book_other'))?.isInvalidated).toBe(false);
  });

  it('ignores frames that are not messages', () => {
    const socket = connected();
    const listener = vi.fn();
    rt.listen(listener);
    expect(() => socket.receive('garbage')).not.toThrow();
    expect(() => socket.receive('{"type":"chat","text":"hi"}')).not.toThrow();
    expect(() => socket.receive('[1,2,3]')).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(0);
    expect(socket.closedByClient).toBe(false);
  });

  it('shows nobody as here while disconnected, and reconnects with growing back-off', () => {
    const socket = connected();
    socket.receive({ type: 'presence', clubId: 'club_123', members: [member('user_ana')] });
    socket.drop();
    expect(rt.connected).toBe(false);
    expect(rt.presenceOf('club_123').size).toBe(0);

    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);

    FakeSocket.last.drop();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);

    // Once connected again, the back-off starts over.
    FakeSocket.last.open();
    FakeSocket.last.drop();
    vi.advanceTimersByTime(500);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it('never waits more than 15 seconds between attempts', () => {
    connected().drop();
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(15_000);
      FakeSocket.last.drop();
    }
    const count = FakeSocket.all.length;
    vi.advanceTimersByTime(15_000);
    expect(FakeSocket.all).toHaveLength(count + 1);
  });

  it('does not reconnect when the server closed the connection for a signed-out user (4001)', () => {
    connected().drop(4001);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('re-subscribes and refetches what may have changed after a reconnect, but keeps the session and publications', () => {
    rt.subscribe('club_123');
    connected();
    for (const key of [keys.session, keys.publication('/pub.json'), keys.books('club_123'), keys.comments('book_123')]) qc.setQueryData(key, {});
    FakeSocket.last.drop();
    vi.advanceTimersByTime(500);
    FakeSocket.last.open();
    expect(FakeSocket.last.sent).toEqual([{ type: 'subscribe', clubId: 'club_123' }]);
    expect(qc.getQueryState(keys.books('club_123'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.comments('book_123'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.session)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(keys.publication('/pub.json'))?.isInvalidated).toBe(false);
  });

  it('does not refetch anything on the very first connection', () => {
    qc.setQueryData(keys.books('club_123'), {});
    connected();
    expect(qc.getQueryState(keys.books('club_123'))?.isInvalidated).toBe(false);
  });

  it('gives up on a connection that stops answering pings, and connects again', () => {
    const socket = connected();
    vi.advanceTimersByTime(25_000);
    expect(socket.sent).toEqual([{ type: 'ping' }]);
    vi.advanceTimersByTime(9_999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(socket.closedByClient).toBe(true);
    expect(FakeSocket.all).toHaveLength(2);
    expect(rt.connected).toBe(false);
  });

  it('keeps a connection that answers', () => {
    const socket = connected();
    vi.advanceTimersByTime(25_000);
    socket.receive({ type: 'pong' });
    vi.advanceTimersByTime(20_000);
    expect(socket.closedByClient).toBe(false);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('reports the reading position at most four times a second, always sending the latest', () => {
    const socket = connected();
    const at = (offset: number) => ({ bookId: 'book_123', editionId: 'ed_epub_1', locator: { kind: 'epub' as const, section: 1, offset }, label: 'Chapter 1' });
    const readings = () => socket.sent.filter((m) => m.type === 'reading').map((m) => (m.type === 'reading' && m.locator.kind === 'epub' ? m.locator.offset : -1));

    rt.setReading(at(1));
    expect(readings()).toEqual([1]);
    vi.advanceTimersByTime(100);
    rt.setReading(at(2));
    vi.advanceTimersByTime(50);
    rt.setReading(at(3));
    expect(readings()).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(readings()).toEqual([1, 3]);
    vi.advanceTimersByTime(1_000);
    expect(readings()).toEqual([1, 3]);
  });

  it('says idle when the reader leaves, and when the page is hidden, and reading again when it is back', () => {
    const socket = connected();
    rt.setReading({ bookId: 'book_123', editionId: 'ed_epub_1', locator: { kind: 'epub', section: 1, offset: 0 }, label: 'Chapter 1' });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    rt.setReading(null);
    expect(socket.sent.map((m) => m.type)).toEqual(['reading', 'idle', 'reading', 'idle']);
  });

  it('stays listening with the page hidden while the audiobook plays (a locked phone), and says where', () => {
    const socket = connected();
    const at = (ms: number) => ({ bookId: 'book_123', editionId: 'ed_audio_1', locator: { kind: 'audio' as const, track: 2, ms }, label: 'Chapter 3' });
    rt.setReading(at(1_000), { audible: true });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1_000);
    rt.setReading(at(2_000), { audible: true });
    vi.advanceTimersByTime(1_000);
    expect(socket.sent.map((m) => (m.type === 'reading' && m.locator.kind === 'audio' ? m.locator.ms : m.type))).toEqual([1_000, 2_000]);
    // Paused, with the phone still locked: just around.
    rt.setReading(null);
    expect(socket.sent.at(-1)?.type).toBe('idle');
    visibility.mockReturnValue('visible');
  });

  it('stops for good: closes the socket, forgets presence and never reconnects', () => {
    const socket = connected();
    socket.receive({ type: 'presence', clubId: 'club_123', members: [member('user_ana')] });
    rt.stop();
    expect(socket.closedByClient).toBe(true);
    expect(rt.presenceOf('club_123').size).toBe(0);
    socket.drop();
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('lets go of the socket at once when the browser goes offline, forgetting presence, and connects again online', () => {
    const socket = connected();
    socket.receive({ type: 'presence', clubId: 'club_123', members: [member('user_ana')] });
    expect(rt.presenceOf('club_123').size).toBe(1);
    window.dispatchEvent(new Event('offline'));
    expect(socket.closedByClient).toBe(true);
    expect(rt.connected).toBe(false);
    expect(rt.presenceOf('club_123').size).toBe(0);
    // No retries while offline, not even when the page is looked at again: the browser says when
    // the network is back.
    const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    vi.advanceTimersByTime(60_000);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.all).toHaveLength(1);
    offline.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.all).toHaveLength(2);
    offline.mockRestore();
  });

  it('connects again at once when the browser comes back online', () => {
    connected().drop();
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.all).toHaveLength(2);
  });
});
