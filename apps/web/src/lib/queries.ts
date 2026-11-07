import { type QueryClient, QueryClient as Client, useQuery, useQueryClient } from '@tanstack/react-query';
import { appendOlder, newestFirst, oldestHeld, refreshNewest, removeMessage, upsertMessage } from '@bookclub/chat-core';
import { useEffect } from 'react';
import type {
  BookDetail,
  BookProgress,
  BookSummary,
  ChatDnd,
  ChatHistory,
  ChatMessageView,
  ChatThread,
  ChatUnread,
  CommentView,
  MemberProgress,
  NotificationList,
  NotificationView,
  PartyState,
  RevealedComment,
  SessionInfo,
} from '@bookclub/shared';
import { ApiError, api, isOfflineError } from './api';
import { type AnswerOpen, inConversation } from './answer-open';
import { keepRevealed, requote } from './chat-model';

export const keys = {
  session: ['session'] as const,
  clubs: ['clubs'] as const,
  club: (id: string) => ['club', id] as const,
  books: (clubId: string) => ['books', clubId] as const,
  book: (id: string) => ['book', id] as const,
  progress: (bookId: string) => ['progress', bookId] as const,
  comments: (bookId: string) => ['comments', bookId] as const,
  publication: (url: string) => ['publication', url] as const,
  readAlong: (editionId: string, track: number) => ['readalong', editionId, track] as const,
  notifications: ['notifications'] as const,
  /** Your history: one book's, or `all` across books (D191). */
  history: (bookId: string) => ['history', bookId] as const,
  /** `channel` (D199): `general` or a book id; absent, the club's whole stream. */
  chat: (clubId: string, channel?: string) => ['chat', clubId, channel ?? null] as const,
  /** One thread on its own (D200), by its root's id. */
  chatThread: (rootId: string) => ['chatThread', rootId] as const,
  chatUnread: (clubId: string) => ['chatUnread', clubId] as const,
  chatAgents: (clubId: string) => ['chatAgents', clubId] as const,
  chatDnd: ['chatDnd'] as const,
  listening: ['listening'] as const,
  audioControls: ['audio-controls'] as const,
  party: (bookId: string) => ['party', bookId] as const,
};

export function makeQueryClient(): QueryClient {
  return new Client({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 24 * 3600_000,
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
        refetchOnWindowFocus: true,
        networkMode: 'offlineFirst',
      },
      mutations: { networkMode: 'offlineFirst' },
    },
  });
}

const SESSION_SNAPSHOT = 'bookclub:session';

/**
 * Who is signed in, from the server; offline, the last answer this device had (kept in local
 * storage, forgotten with everything else at sign-out). Only what to show depends on it: every
 * change still goes to the server with the session cookie, which decides.
 */
export async function sessionOrSnapshot(): Promise<SessionInfo> {
  try {
    const session = await api.session();
    try {
      if (session.user) localStorage.setItem(SESSION_SNAPSHOT, JSON.stringify(session));
      else localStorage.removeItem(SESSION_SNAPSHOT);
    } catch {
      // private mode: no snapshot
    }
    return session;
  } catch (err) {
    const offline = isOfflineError(err) || (err instanceof ApiError && err.code === 'offline');
    if (!offline) throw err;
    let snapshot: SessionInfo | null;
    try {
      snapshot = JSON.parse(localStorage.getItem(SESSION_SNAPSHOT) ?? 'null') as SessionInfo | null;
    } catch {
      snapshot = null;
    }
    if (snapshot?.user) return snapshot;
    throw err;
  }
}

export const useSession = () => useQuery({ queryKey: keys.session, queryFn: sessionOrSnapshot, staleTime: 60_000 });
export const useClubs = () => useQuery({ queryKey: keys.clubs, queryFn: api.clubs });
export const useClub = (clubId: string | undefined) =>
  useQuery({ queryKey: keys.club(clubId ?? ''), queryFn: () => api.club(clubId!), enabled: !!clubId });
export const useBooks = (clubId: string | undefined) =>
  useQuery({ queryKey: keys.books(clubId ?? ''), queryFn: () => api.books(clubId!), enabled: !!clubId });
/** Whether book detail should keep polling for an in-flight ingest or alignment upgrade. */
export function bookNeedsPoll(
  editions:
    | readonly {
        status: string;
        transcription?: { stage: string } | null;
      }[]
    | undefined,
): number | false {
  if (!editions) return false;
  if (editions.some((e) => e.status === 'processing')) return 1500;
  // Live transcription / alignment progress (optional field from the server): keep checking until
  // it fails or drops off. book:changed is still the primary signal; this covers a missed event
  // while work is known to be in flight. Without a pending signal we do not poll forever.
  if (editions.some((e) => e.transcription && e.transcription.stage !== 'failed')) return 2000;
  return false;
}

export const useBook = (bookId: string | undefined) =>
  useQuery({
    queryKey: keys.book(bookId ?? ''),
    queryFn: () => api.book(bookId!),
    enabled: !!bookId,
    // While an edition is still being processed, or an audiobook is being transcribed / lined up, check back.
    refetchInterval: (q) => bookNeedsPoll(q.state.data?.editions),
  });
/**
 * Reading progress. `fresh` always asks the server again on mount: where to open a book is
 * decided from it, and a cached copy may predate reading done on another device.
 */
export const useProgress = (bookId: string | undefined, options: { fresh?: boolean } = {}) =>
  useQuery({ queryKey: keys.progress(bookId ?? ''), queryFn: () => api.progress(bookId!), enabled: !!bookId, refetchOnMount: options.fresh ? 'always' : true });
/** The sentences one track of an audiobook reads (when it has a read-along). */
const readAlongQuery = (editionId: string, track: number) => ({
  queryKey: keys.readAlong(editionId, track),
  queryFn: () => api.readAlong(editionId, track),
  staleTime: 5 * 60_000,
});

/**
 * One track's read-along, and the next track's fetched ahead (D184): at a track's end the pages
 * follow the narrator on at once, and on with no signal (the service worker keeps what was
 * fetched), rather than wait on a request, or stop for good when it fails offline.
 */
export function useReadAlong(editionId: string | undefined, track: number | undefined) {
  const qc = useQueryClient();
  const enabled = !!editionId && track !== undefined && track >= 0;
  const query = useQuery({ ...readAlongQuery(editionId ?? '', track ?? -1), enabled });
  const loaded = query.isSuccess;
  useEffect(() => {
    if (enabled && loaded) void qc.prefetchQuery(readAlongQuery(editionId, track + 1)).catch(() => undefined);
  }, [qc, enabled, loaded, editionId, track]);
  return query;
}

export const useComments = (bookId: string | undefined) =>
  useQuery({ queryKey: keys.comments(bookId ?? ''), queryFn: () => api.comments(bookId!), enabled: !!bookId });

/* Cache updates from live events ------------------------------------------------------------- */

export function applyMemberProgress(qc: QueryClient, bookId: string, clubId: string, progress: MemberProgress): void {
  qc.setQueryData<BookProgress>(keys.progress(bookId), (old) =>
    old ? { ...old, members: old.members.map((m) => (m.userId === progress.userId ? progress : m)) } : old,
  );
  // Your own progress moved (perhaps on another device): your saved place here is out of date.
  // It is fetched again where it matters, when a book is next opened. (After the update above,
  // which would otherwise mark the entry fresh again.)
  if (qc.getQueryData<{ user: { id: string } | null }>(keys.session)?.user?.id === progress.userId) {
    void qc.invalidateQueries({ queryKey: keys.progress(bookId), refetchType: 'none' });
  }
  const patchSummary = (b: BookSummary): BookSummary =>
    b.id === bookId ? { ...b, progress: b.progress.map((m) => (m.userId === progress.userId ? progress : m)) } : b;
  qc.setQueryData<BookSummary[]>(keys.books(clubId), (old) => old?.map(patchSummary));
  qc.setQueryData<BookDetail>(keys.book(bookId), (old) => (old ? (patchSummary(old) as BookDetail) : old));
}

export function mergeComment(qc: QueryClient, bookId: string, comment: CommentView): void {
  qc.setQueryData<CommentView[]>(keys.comments(bookId), (old) => {
    if (!old) return old;
    const i = old.findIndex((c) => c.id === comment.id);
    // Never downgrade a revealed comment to a hidden marker.
    if (i !== -1 && !old[i]!.hidden && comment.hidden) return old;
    const next = i === -1 ? [...old, comment] : old.map((c, j) => (j === i ? comment : c));
    return next.sort((a, b) => a.t - b.t || a.createdAt.localeCompare(b.createdAt));
  });
}

export const useNotifications = () => useQuery({ queryKey: keys.notifications, queryFn: api.notifications, staleTime: 60_000 });

/** A notification pushed live: first in the list, and unread. */
/**
 * A notification pushed live: new, first in the list and unread; or (D145) the same "got to it"
 * notification bumped with a higher count, which replaces its old entry (and moves to the top)
 * rather than adding a second.
 */
export function addNotification(qc: QueryClient, notification: NotificationView): void {
  qc.setQueryData<NotificationList>(keys.notifications, (old) => {
    if (!old) return old;
    const existing = old.items.find((n) => n.id === notification.id);
    if (existing?.read) return old;
    const items = [notification, ...old.items.filter((n) => n.id !== notification.id)].slice(0, 50);
    const unread = old.unread + (notification.read ? 0 : 1) - (existing ? 1 : 0);
    return { unread, items };
  });
}

export function mergeRevealed(qc: QueryClient, bookId: string, revealed: readonly RevealedComment[]): void {
  const before = qc.getQueryData<CommentView[]>(keys.comments(bookId)) ?? [];
  const selfId = qc.getQueryData<SessionInfo>(keys.session)?.user?.id;
  for (const c of revealed) {
    // An answer held for where its writer had read to (D69), open now that you have read there:
    // said so, as it would otherwise open without a word, to whoever is in its conversation (its
    // note's writer, those who answered it), with whose note it is (D89).
    const was = before.find((x) => x.id === c.id);
    const note = c.parentId ? before.find((x) => x.id === c.parentId) : undefined;
    if (was?.hidden && was.horizon && note && inConversation(note, before, selfId)) {
      window.dispatchEvent(new CustomEvent<AnswerOpen>('bc-answer-open', { detail: { answer: c, note } }));
    }
    mergeComment(qc, bookId, c);
  }
}

export function removeComment(qc: QueryClient, bookId: string, commentId: string): void {
  qc.setQueryData<CommentView[]>(keys.comments(bookId), (old) => old?.filter((c) => c.id !== commentId));
}

/* Live chat (D150-D152) --------------------------------------------------------------------- */

/**
 * One channel's messages (D199): `general`, or a book id; absent, the club's whole stream. A
 * refetch (focus, reconnect) is the truth for the newest page and keeps the older pages "load
 * earlier" brought in (chat-core's `refreshNewest`), so scrolling back is never undone by it.
 */
export function useChat(clubId: string | undefined, channel?: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: keys.chat(clubId ?? '', channel),
    queryFn: async () => {
      const fresh = await api.chat(clubId!, channel ? { channel } : {});
      // What is held is read once the fresh page is here: a push that landed meanwhile counts.
      return refreshNewest(qc.getQueryData<ChatHistory>(keys.chat(clubId!, channel)), fresh);
    },
    enabled: !!clubId,
  });
}

/**
 * A thread as the cache holds it (D200): its root and its replies as one newest-first page, so the
 * same chat-core reducers keep it live as keep a channel; chat-core's `threadOf` reads it back
 * root first, replies oldest first.
 */
export interface ChatThreadCache extends ChatHistory {
  readonly rootId: string;
  /** The channel it is in (D199): `general` or a book id. */
  readonly channel: string;
}

export function toThreadCache(thread: ChatThread): ChatThreadCache {
  return { messages: [thread.root, ...thread.replies].sort(newestFirst), hasMore: thread.hasMore, rootId: thread.root.id, channel: thread.channel };
}

/** One thread on its own (D200), by its root's id. */
export const useChatThread = (rootId: string | null) =>
  useQuery({ queryKey: keys.chatThread(rootId ?? ''), queryFn: async () => toThreadCache(await api.chatThread(rootId!)), enabled: !!rootId });

/** The page before the oldest message held in a channel ("load earlier"), added after it. */
export async function loadOlderChat(qc: QueryClient, clubId: string, channel: string): Promise<void> {
  const key = keys.chat(clubId, channel);
  const held = qc.getQueryData<ChatHistory>(key);
  const oldest = held?.hasMore ? oldestHeld(held) : undefined;
  if (!oldest) return;
  const older = await api.chat(clubId, { channel, before: oldest.id });
  qc.setQueryData<ChatHistory>(key, (current) => (current ? appendOlder(current, older) : current));
}

/** A club's agents (D204): the server's configuration, so they change only with a deploy. */
export const useChatAgents = (clubId: string | undefined) =>
  useQuery({ queryKey: keys.chatAgents(clubId ?? ''), queryFn: () => api.chatAgents(clubId!), enabled: !!clubId, staleTime: 5 * 60_000 });

export const useChatUnread = (clubId: string | undefined) =>
  useQuery({ queryKey: keys.chatUnread(clubId ?? ''), queryFn: () => api.chatUnread(clubId!), enabled: !!clubId, staleTime: 15_000 });

/** The caches a message lives in: the club's whole stream and its own channel (D199). */
const chatKeysFor = (clubId: string, bookId: string | null) => [keys.chat(clubId), keys.chat(clubId, bookId ?? 'general')];

/**
 * A message arrived, was edited, reacted to or turned into a deleted placeholder: into the club's
 * stream, its own channel and its thread, wherever each is held (chat-core's `upsertMessage`). A
 * new reply counts on its root; replies quoting it are re-quoted from its view, which the server
 * gated for this viewer (D200); a revealed copy is never replaced by a hidden one (D150).
 */
export function mergeChatMessage(qc: QueryClient, clubId: string, bookId: string | null, message: ChatMessageView): void {
  const options = { keepExisting: keepRevealed, requote };
  for (const key of chatKeysFor(clubId, bookId)) qc.setQueryData<ChatHistory>(key, (old) => (old ? upsertMessage(old, message, options) : old));
  qc.setQueryData<ChatThreadCache>(keys.chatThread(message.threadId ?? message.id), (old) => (old ? { ...old, ...upsertMessage(old, message, options) } : old));
}

/** A message is gone (D200): out of every list holding it, its root counted one fewer, its quotes told. */
export function removeChatMessage(qc: QueryClient, clubId: string, bookId: string | null, messageId: string, threadId: string | null = null): void {
  for (const key of chatKeysFor(clubId, bookId)) qc.setQueryData<ChatHistory>(key, (old) => (old ? removeMessage(old, messageId, { threadId, requote }) : old));
  if (threadId) qc.setQueryData<ChatThreadCache>(keys.chatThread(threadId), (old) => (old ? { ...old, ...removeMessage(old, messageId, { threadId, requote }) } : old));
  // A root gone for good takes its thread with it.
  else qc.removeQueries({ queryKey: keys.chatThread(messageId), exact: true });
}

/** A chat message just arrived from someone else: bump the club's unread badge by one. */
export function bumpChatUnread(qc: QueryClient, clubId: string, fromSelf: boolean): void {
  if (fromSelf) return;
  qc.setQueryData<ChatUnread>(keys.chatUnread(clubId), (old) => (old ? { ...old, unread: old.unread + 1 } : old));
}

/** Do Not Disturb for chat/mentions (D173): one switch, kept warm by NotificationToasts (mounted
 * for every signed-in page) so the toast it gates can read it straight from the cache. */
/** Your default listening speed (D195), as the server has it. */
export const useListening = (enabled = true) => useQuery({ queryKey: keys.listening, queryFn: () => api.listening(), staleTime: 60_000, enabled });
/** Whether you hide the audiobook's controls by default (D197), as the server has it. */
export const useAudioControlsDefault = (enabled = true) => useQuery({ queryKey: keys.audioControls, queryFn: () => api.audioControls(), staleTime: 60_000, enabled });
export const useChatDnd = () => useQuery({ queryKey: keys.chatDnd, queryFn: () => api.chatDnd(), staleTime: 30_000 });

export async function setChatDndEnabled(qc: QueryClient, enabled: boolean): Promise<void> {
  const saved = await api.setChatDnd(enabled);
  qc.setQueryData<ChatDnd>(keys.chatDnd, saved);
}

/* Listening together (D155-D158) ------------------------------------------------------------ */

const sameParty = (a: PartyState | null | undefined, b: PartyState | null | undefined): a is PartyState =>
  !!a && !!b && a.partyId === b.partyId && a.editionId === b.editionId;

function newestParty(old: PartyState | null | undefined, state: PartyState | null): PartyState | null {
  if (sameParty(old, state)) {
    if (old.revision !== undefined && state!.revision !== undefined ? old.revision > state!.revision : old.updatedAt > state!.updatedAt) return old;
  }
  return state;
}

/** Hub party events seen per book, so an HTTP response can tell that one arrived while it was in flight. */
const partyEvents = new WeakMap<QueryClient, Map<string, number>>();
const partyEventCount = (qc: QueryClient, bookId: string): number => partyEvents.get(qc)?.get(bookId) ?? 0;
function countPartyEvent(qc: QueryClient, bookId: string): void {
  let byBook = partyEvents.get(qc);
  if (!byBook) partyEvents.set(qc, (byBook = new Map<string, number>()));
  byBook.set(bookId, partyEventCount(qc, bookId) + 1);
}

/** What the cache and the hub had said when a party HTTP request (GET, start, join, control) was sent. */
export interface PartyFence {
  readonly before: PartyState | null | undefined;
  readonly events: number;
}

export function partyFence(qc: QueryClient, bookId: string): PartyFence {
  return { before: qc.getQueryData<PartyState | null>(keys.party(bookId)), events: partyEventCount(qc, bookId) };
}

/**
 * An HTTP response is a snapshot from whenever the server answered; the hub is the ordered stream.
 * Undisturbed, the response is the newest word. If a hub event (or another response) changed the
 * party while the request was in flight, the response may only win a same-incarnation revision
 * comparison: an end (explicit null) or a different incarnation is never undone by it.
 */
function fencedParty(current: PartyState | null | undefined, fence: PartyFence, events: number, state: PartyState | null): PartyState | null | undefined {
  if (current === fence.before && events === fence.events) return newestParty(current, state);
  return sameParty(current, state) ? newestParty(current, state) : current;
}

export function partyQueryOptions(qc: QueryClient, bookId: string) {
  const queryKey = keys.party(bookId);
  return {
    queryKey,
    queryFn: async (): Promise<PartyState | null> => {
      const fence = partyFence(qc, bookId);
      const state = await api.party(bookId);
      const kept = fencedParty(qc.getQueryData<PartyState | null>(queryKey), fence, partyEventCount(qc, bookId), state);
      return kept === undefined ? state : kept;
    },
    structuralSharing: (old: unknown, state: unknown) => newestParty(old as PartyState | null | undefined, state as PartyState | null),
  };
}

export function useParty(bookId: string | undefined) {
  const qc = useQueryClient();
  return useQuery({ ...partyQueryOptions(qc, bookId ?? ''), enabled: !!bookId });
}

/**
 * A hub `party:state`: the ordered stream may replace an incarnation or follow an end (a new party
 * started), so only same-incarnation revisions are compared. HTTP responses use `applyPartyResponse`.
 */
export function applyPartyState(qc: QueryClient, bookId: string, state: PartyState): void {
  countPartyEvent(qc, bookId);
  qc.setQueryData<PartyState | null>(keys.party(bookId), (old) => newestParty(old, state));
}

/** A hub `party:ended`. */
export function clearParty(qc: QueryClient, bookId: string): void {
  countPartyEvent(qc, bookId);
  qc.setQueryData<PartyState | null>(keys.party(bookId), null);
}

/** A start/join/control response, fenced by `partyFence` taken before its request. True if it was applied. */
export function applyPartyResponse(qc: QueryClient, bookId: string, fence: PartyFence, state: PartyState): boolean {
  const current = qc.getQueryData<PartyState | null>(keys.party(bookId));
  const next = fencedParty(current, fence, partyEventCount(qc, bookId), state);
  if (next === current) return false;
  qc.setQueryData<PartyState | null>(keys.party(bookId), next);
  return next === state;
}
