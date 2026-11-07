import type {
  AudioControls,
  BookAudioControls,
  HistoryList,
  WidgetSnapshot,
  BookDetail,
  BookMatch,
  BookPlayback,
  BookProgress,
  BookSummary,
  ChatDnd,
  ChatHistory,
  ChatMessageView,
  ChatUnread,
  ClubDetail,
  ClubSummary,
  CommentView,
  Places,
  PlacesQuery,
  CreateChatMessageBody,
  CreateCommentBody,
  CreateReplyBody,
  Edition,
  Import,
  InvitePreview,
  ListeningSettings,
  LiveKitConfig,
  LiveKitTokenRequest,
  LiveKitTokenResponse,
  Locator,
  NoteMediaKind,
  NotificationList,
  PartyControlBody,
  PartyDiagnosticsBody,
  PartyState,
  ProgressUpdateBody,
  ProgressUpdateResult,
  Publication,
  ReadAlongTrack,
  SessionInfo,
  SignInCode,
  UploadedNoteMedia,
  StartPartyBody,
  User,
} from '@bookclub/shared';
import { KEPT_MESSAGE, keepNoteForLater } from './pending-notes';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

/**
 * Fired for any 401 from a protected endpoint, so the shell can send the user to sign in, and when
 * the server says the device's session now belongs to someone else (signed in in another tab).
 */
export const unauthorizedEvents = new EventTarget();

/**
 * Whose page this is: sent with every change, so the server never applies it to someone else.
 * Set by the signed-in area (null while nobody is, or while one person gives way to another);
 * undefined until then.
 */
let pageUser: string | null | undefined;

export function setPageUser(userId: string | null | undefined): void {
  pageUser = userId;
}

export function getPageUser(): string | null | undefined {
  return pageUser;
}

export const EXPECTED_USER_HEADER = 'X-Bookclub-User';

/** "Continue with <name>": the server sends the browser to the upstream's sign-in and back, signed in (D116). */
export const upstreamSignInHref = (next: string): string => `/api/auth/upstream?next=${encodeURIComponent(next)}`;

/** "Continue with Google" in a browser (D178): the server sends it to Google and back, signed in. */
export const googleSignInHref = (next: string): string => `/api/auth/google/start?next=${encodeURIComponent(next)}`;

export const isOfflineError = (err: unknown): boolean => err instanceof TypeError || (err instanceof ApiError && err.status === 0);

/** The browser says it has no network (it can be wrong the other way: online, with nothing getting through). */
export const browserOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

/** How soon a request that never reached the server is tried again, once: a dropped connection that comes straight back. */
export const DROPPED_RETRY_MS = 300;

/** A comment's client id: one per note being written, so sending it again never makes two. */
export function newClientId(): string {
  return `c_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function request<T>(method: string, url: string, body?: unknown, asUser: string | null | undefined = pageUser, signal?: AbortSignal): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && asUser) headers[EXPECTED_USER_HEADER] = asUser;
  try {
    res = await fetch(url, { method, credentials: 'same-origin', headers, ...(signal ? { signal } : {}), body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'offline', 'You appear to be offline.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = parseJson(text);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; fields?: Record<string, string> } } | null)?.error;
    if ((res.status === 401 && !url.startsWith('/api/session') && !url.startsWith('/api/auth/')) || err?.code === 'session_changed') {
      unauthorizedEvents.dispatchEvent(new Event('unauthorized'));
    }
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Request failed (${res.status}).`, err?.fields ?? {});
  }
  return data as T;
}

async function timedPost<T>(url: string, body: unknown): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  try {
    return await request<T>('POST', url, body, pageUser, abort.signal);
  } finally {
    clearTimeout(timer);
  }
}

const get = <T>(url: string) => request<T>('GET', url);
const post = <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {});
const put = <T>(url: string, body: unknown) => request<T>('PUT', url, body);
const patch = <T>(url: string, body: unknown) => request<T>('PATCH', url, body);
const del = (url: string) => request<void>('DELETE', url);

export const api = {
  session: () => get<SessionInfo>('/api/session'),
  setup: (body: { displayName: string; email: string; password: string; clubName?: string }) =>
    post<{ user: User; clubs: ClubSummary[] }>('/api/setup', body),
  signIn: (body: { email: string; password: string }) => post<{ user: User }>('/api/auth/signin', body),
  signUp: (body: { inviteCode: string; displayName: string; email: string; password: string }) =>
    post<{ user: User; clubId: string }>('/api/auth/signup', body),
  /** "Start a club" with no invite (D211), behind `OPEN_SIGNUP`: an account and its first club, signed in. */
  startClub: (body: { displayName: string; email: string; password: string; clubName: string }) =>
    post<{ user: User; clubId: string }>('/api/auth/start', body),
  signOut: () => post<void>('/api/auth/signout'),
  signOutEverywhere: () => post<void>('/api/auth/signout-everywhere'),
  me: () => get<{ user: User; clubs: ClubSummary[] }>('/api/me'),
  updateMe: (body: { displayName: string }) => patch<{ user: User }>('/api/me', body),
  changePassword: (body: { currentPassword: string; newPassword: string }) => post<void>('/api/me/password', body),
  resetPassword: (body: { token: string; newPassword: string }) => post<{ user: User; email: string | null }>('/api/auth/reset', body),
  signInCode: () => post<SignInCode>('/api/auth/codes'),
  signInWithCode: (code: string) => post<{ user: User }>('/api/auth/code', { code }),
  /** Native "Sign in with Apple" (D178): the identity token and raw nonce the app bridge returned. */
  signInApple: (body: { identityToken: string; nonce: string; fullName?: string }) => post<{ user: User }>('/api/auth/apple', body),
  /** The native Google handoff's one-time code and PKCE verifier (D178), redeemed inside the WebView. */
  redeemAppCode: (body: { code: string; verifier: string }) => post<{ user: User }>('/api/auth/app-code', body),

  clubs: () => get<ClubSummary[]>('/api/clubs'),
  createClub: (body: { name: string; description?: string }) => post<ClubDetail>('/api/clubs', body),
  club: (clubId: string) => get<ClubDetail>(`/api/clubs/${clubId}`),
  updateClub: (clubId: string, body: { name?: string; description?: string }) => patch<ClubDetail>(`/api/clubs/${clubId}`, body),
  rotateInvite: (clubId: string) => post<{ code: string; url: string }>(`/api/clubs/${clubId}/invite/rotate`),
  removeMember: (clubId: string, userId: string) => del(`/api/clubs/${clubId}/members/${userId}`),
  disbandClub: (clubId: string) => del(`/api/clubs/${clubId}`),
  setRole: (clubId: string, userId: string, role: 'owner' | 'member') => put<ClubDetail>(`/api/clubs/${clubId}/members/${userId}/role`, { role }),
  resetLink: (clubId: string, userId: string) => post<{ url: string; expiresAt: string }>(`/api/clubs/${clubId}/members/${userId}/reset-link`),
  invitePreview: (code: string) => get<InvitePreview>(`/api/invites/${encodeURIComponent(code)}`),
  acceptInvite: (code: string) => post<{ clubId: string; joined: boolean }>(`/api/invites/${encodeURIComponent(code)}/accept`),

  books: (clubId: string) => get<BookSummary[]>(`/api/clubs/${clubId}/books`),
  book: (bookId: string) => get<BookDetail>(`/api/books/${bookId}`),
  updateBook: (bookId: string, body: { title?: string; author?: string }) => patch<BookDetail>(`/api/books/${bookId}`, body),
  setMeeting: (bookId: string, body: { t: number; on: string | null }) => put<BookDetail>(`/api/books/${bookId}/meeting`, body),
  clearMeeting: (bookId: string) => del(`/api/books/${bookId}/meeting`),
  deleteBook: (bookId: string) => del(`/api/books/${bookId}`),
  deleteEdition: (editionId: string) => del(`/api/editions/${editionId}`),
  /** The owner gives an audiobook a transcript made elsewhere (tools/align): it is lined up with the text. */
  putTranscript: (editionId: string, transcript: unknown) => put<{ status: string }>(`/api/editions/${editionId}/transcript`, transcript),
  deleteTranscript: (editionId: string) => del(`/api/editions/${editionId}/transcript`),
  setAlignment: (editionId: string, unitToChapter: (number | null)[]) => put<Edition>(`/api/editions/${editionId}/alignment`, { unitToChapter }),
  bookMatches: (clubId: string, title: string, author: string) =>
    get<BookMatch[]>(`/api/clubs/${clubId}/book-matches?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}`),
  publication: (url: string) => get<Publication>(url),
  readAlong: (editionId: string, track: number) => get<ReadAlongTrack>(`/api/editions/${editionId}/readalong?track=${track}`),

  progress: (bookId: string) => get<BookProgress>(`/api/books/${bookId}/progress`),
  /** Listening speed (D195): your default, and the last speed you used for one book. */
  listening: () => get<ListeningSettings>('/api/me/listening'),
  setListening: (body: { defaultRate: number; at: number }) => request<ListeningSettings>('PUT', '/api/me/listening', body),
  setBookPlayback: (bookId: string, body: { rate: number; at: number }) => request<BookPlayback>('PUT', `/api/books/${bookId}/playback`, body),
  /** The audiobook's controls in the book (D197): your default, and one book's own choice. */
  audioControls: () => get<AudioControls>('/api/me/audio-controls'),
  setAudioControls: (body: { hidden: boolean; at: number }) => request<AudioControls>('PUT', '/api/me/audio-controls', body),
  setBookAudioControls: (bookId: string, body: { hidden: boolean | null; at: number }) => request<BookAudioControls>('PUT', `/api/books/${bookId}/audio-controls`, body),
  /** `asUser`: whose reading this is (the outbox's entries say), when not this page's person. */
  putProgress: (bookId: string, body: ProgressUpdateBody, asUser?: string) =>
    request<ProgressUpdateResult>('PUT', `/api/books/${bookId}/progress`, body, asUser ?? pageUser),
  readUpTo: (bookId: string, body: { editionId: string; locator: Locator }) => post<ProgressUpdateResult>(`/api/books/${bookId}/progress/read-up-to`, body),

  comments: (bookId: string) => get<CommentView[]>(`/api/books/${bookId}/comments`),
  /** Where on the page in front of you the closed notes it holds are (D80). */
  places: (bookId: string, query: PlacesQuery) => get<Places>(`/api/books/${bookId}/places?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`),
  /**
   * Post a comment, retrying a dropped connection or a server hiccup with the same `clientId`:
   * the server answers a repeat with the comment it already made, so a retry never duplicates.
   * With no network it is kept on the device to pin later (`keep`, lib/pending-notes.ts), and the
   * error says so (code `kept`): at once when the browser says it is offline, and after one quick
   * try more when a request finds out (the outbox pins it as soon as the network is back). A server
   * hiccup is tried twice more, a little later each time. Nothing is ever cut short for taking
   * long: a slow network still posts.
   */
  createComment: async (bookId: string, body: CreateCommentBody, options: { keep?: boolean } = {}): Promise<CommentView> => {
    const sent = { ...body, clientId: body.clientId ?? newClientId() };
    const keeper = options.keep !== false ? pageUser : null;
    const kept = (userId: string) => {
      keepNoteForLater(userId, { bookId, body: sent });
      return new ApiError(0, 'kept', KEPT_MESSAGE);
    };
    if (keeper && browserOffline()) throw kept(keeper);
    for (let attempt = 0; ; attempt++) {
      try {
        return await post<CommentView>(`/api/books/${bookId}/comments`, sent);
      } catch (err) {
        const dropped = isOfflineError(err);
        const again = dropped ? attempt === 0 && !browserOffline() : err instanceof ApiError && err.status >= 500 && attempt < 2;
        if (!again) {
          if (keeper && dropped) throw kept(keeper);
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, dropped ? DROPPED_RETRY_MS : 800 * (attempt + 1)));
      }
    }
  },
  deleteComment: (commentId: string) => del(`/api/comments/${commentId}`),
  /**
   * Upload a voice recording, a photo or a video before the note that will carry it (D140): a
   * bounded multipart request, so there is no resumability to build (these are short clips, not
   * the audiobook-sized files tus is for). The server validates by content and makes it web-safe;
   * by the time this resolves, `status` says whether it worked, with `error` when it did not.
   */
  uploadNoteMedia: async (bookId: string, kind: NoteMediaKind, file: Blob, filename: string): Promise<UploadedNoteMedia> => {
    const body = new FormData();
    body.append('file', file, filename);
    const headers: Record<string, string> = {};
    if (pageUser) headers[EXPECTED_USER_HEADER] = pageUser;
    let res: Response;
    try {
      res = await fetch(`/api/books/${bookId}/media?kind=${kind}`, { method: 'POST', credentials: 'same-origin', headers, body });
    } catch {
      throw new ApiError(0, 'offline', 'You appear to be offline.');
    }
    const text = await res.text();
    const data = parseJson(text);
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Upload failed (${res.status}).`);
    }
    return data as UploadedNoteMedia;
  },
  /** Discard an upload before the note that would carry it is posted (closed the composer, re-recorded). */
  discardNoteMedia: (mediaId: string) => del(`/api/notes-media/${mediaId}`),
  /** Answer a note (or a reply, which answers its note), with one client id per draft. */
  reply: (commentId: string, body: CreateReplyBody) => post<CommentView>(`/api/comments/${commentId}/replies`, body),
  notifications: () => get<NotificationList>('/api/notifications'),
  /** Your own reading and listening history (D191): in one book, or across every book; older with `before`. */
  history: (bookId?: string, before?: number | null) =>
    get<HistoryList>(`${bookId ? `/api/books/${bookId}/history` : '/api/history'}${before ? `?before=${before}` : ''}`),
  forgetHistoryEntry: (id: string) => del(`/api/history/${encodeURIComponent(id)}`),
  forgetBookHistory: (bookId: string) => del(`/api/books/${bookId}/history`),
  /** What the iOS app's widgets show (D188). */
  widget: () => get<WidgetSnapshot>('/api/widget'),
  readNotifications: (ids?: string[]) => post<void>('/api/notifications/read', ids ? { ids } : {}),

  // Live chat (D150-D152).
  chat: (clubId: string, query: { bookId?: string; channel?: string; before?: string; limit?: number } = {}) =>
    get<ChatHistory>(`/api/clubs/${clubId}/chat?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`),
  chatUnread: (clubId: string) => get<ChatUnread>(`/api/clubs/${clubId}/chat/unread`),
  markChatRead: (clubId: string, messageId?: string) => post<void>(`/api/clubs/${clubId}/chat/read`, messageId ? { messageId } : {}),
  postChat: (clubId: string, body: CreateChatMessageBody) => post<ChatMessageView>(`/api/clubs/${clubId}/chat`, { ...body, clientId: body.clientId ?? newClientId() }),
  editChat: (messageId: string, text: string) => patch<ChatMessageView>(`/api/chat/${messageId}`, { text }),
  deleteChat: (messageId: string) => del(`/api/chat/${messageId}`),
  reactChat: (messageId: string, emoji: string) => request<ChatMessageView>('PUT', `/api/chat/${messageId}/reactions`, { emoji }),
  unreactChat: (messageId: string, emoji: string) => request<ChatMessageView>('DELETE', `/api/chat/${messageId}/reactions`, { emoji }),
  chatDnd: () => get<ChatDnd>('/api/chat/dnd'),
  setChatDnd: (enabled: boolean) => request<ChatDnd>('PUT', '/api/chat/dnd', { enabled }),

  // Voice channels (D153).
  livekitConfig: () => get<LiveKitConfig>('/api/livekit/config'),
  livekitToken: (body: LiveKitTokenRequest) => post<LiveKitTokenResponse>('/api/livekit/token', body),

  // Listening together (D155-D158).
  party: (bookId: string) => get<PartyState | null>(`/api/books/${bookId}/party`),
  startParty: (bookId: string, body: StartPartyBody) => post<PartyState>(`/api/books/${bookId}/party/start`, body),
  joinParty: (bookId: string) => post<PartyState>(`/api/books/${bookId}/party/join`),
  leaveParty: (bookId: string) => post<void>(`/api/books/${bookId}/party/leave`),
  partyDiagnostics: (bookId: string, body: PartyDiagnosticsBody) => timedPost<void>(`/api/books/${bookId}/party/diagnostics`, body),
  partyControl: (bookId: string, body: PartyControlBody) => timedPost<PartyState>(`/api/books/${bookId}/party/control`, body),

  createImport: (clubId: string, body: { kind: 'epub' | 'pdf' | 'audio'; files: { name: string; size: number; type: string; role: 'main' | 'track' | 'cover' }[] }) =>
    post<Import>(`/api/clubs/${clubId}/imports`, body),
  getImport: (importId: string) => get<Import>(`/api/imports/${importId}`),
  finalizeImport: (
    importId: string,
    body: { title: string; author: string; bookId?: string; trackOrder?: number[]; trackTitles?: string[] },
  ) => post<{ bookId: string; editionId: string }>(`/api/imports/${importId}/finalize`, body),
  cancelImport: (importId: string) => del(`/api/imports/${importId}`),
};

/** Progress sent as the page is hidden or closed; survives navigation. A beacon cannot carry headers, so whose it is goes in the address. */
export function beaconProgress(bookId: string, body: ProgressUpdateBody): boolean {
  if (typeof navigator === 'undefined' || !navigator.sendBeacon || !pageUser) return false;
  const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
  return navigator.sendBeacon(`/api/books/${bookId}/progress/beacon?as=${encodeURIComponent(pageUser)}`, blob);
}
