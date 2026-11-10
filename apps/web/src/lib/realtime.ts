import { useEffect, useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { ClientMessage, Locator, PresenceEntry, ServerMessage, VoiceRoomKind, VoiceRoomState } from '@bookclub/shared';
import {
  addNotification,
  applyMemberProgress,
  applyPartyState,
  bumpChatUnread,
  clearParty,
  keys,
  mergeChatMessage,
  mergeComment,
  removeChatMessage,
  removeComment,
} from './queries';

type Listener = () => void;

/** Every message type the server sends (the compiler keeps this list complete). */
const MESSAGE_TYPES: Record<ServerMessage['type'], true> = {
  hello: true,
  presence: true,
  'presence:update': true,
  progress: true,
  'comment:new': true,
  'comment:deleted': true,
  'book:changed': true,
  'club:changed': true,
  'notification:new': true,
  pong: true,
  error: true,
  'chat:new': true,
  'chat:updated': true,
  'chat:deleted': true,
  'chat:typing': true,
  'chat:notice': true,
  'voice:update': true,
  'party:state': true,
  'party:ended': true,
};

/** Someone is typing (D150): kept a few seconds, then dropped by the next `tick()` (useChatTyping). */
export interface TypingEntry {
  readonly displayName: string;
  readonly until: number;
}

/**
 * Frames come from our own server, whose tests check every message it sends against the shared
 * schema; here a frame that is not JSON or not a known message is dropped. (Validating each one
 * with the schema again would put the whole schema library in the app's first download.)
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    const type = typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : undefined;
    return typeof type === 'string' && Object.hasOwn(MESSAGE_TYPES, type) ? (value as ServerMessage) : null;
  } catch {
    return null;
  }
}

/**
 * One WebSocket per tab. Reconnects with back-off, re-subscribes to the clubs on screen, and turns
 * server events into cache updates. Presence lives in a small external store per club.
 */
export class Realtime {
  private socket: WebSocket | null = null;
  private wanted = new Map<string, number>();
  private presence = new Map<string, Map<string, PresenceEntry>>();
  /** Voice presence (D153-D154), by room name ("club:<clubId>" or "...:adhoc:<id>"). */
  private voice = new Map<string, VoiceRoomState>();
  /** Who is typing (D150), by `${clubId}:` (a member: club-wide) or `${clubId}:${channel}` (an agent at work in one channel, D204), by userId. */
  private typing = new Map<string, Map<string, TypingEntry>>();
  private listeners = new Set<Listener>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reading: Extract<ClientMessage, { type: 'reading' }> | null = null;
  private audible = false;
  private lastReadingSent = 0;
  private pendingReading: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  connected = false;
  private snapshotVersion = 0;
  private everConnected = false;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly qc: QueryClient) {}

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.connect();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
  }

  stop(): void {
    this.enabled = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.socket?.close();
    this.socket = null;
    this.presence.clear();
    this.voice.clear();
    this.emit();
  }

  private onVisibility = () => {
    // Hidden while the audiobook plays (the phone locked, another app) is still listening.
    if (document.visibilityState === 'hidden') {
      if (!this.audible) this.send({ type: 'idle' });
    } else if (this.reading) this.send(this.reading);
    // With no network the browser says when it is back (onOnline): no tries meanwhile.
    if (document.visibilityState === 'visible' && !this.connected && navigator.onLine !== false) this.connect();
  };

  private onOnline = () => {
    if (!this.connected) this.connect();
  };

  /**
   * The browser knows the network is gone long before the socket does (a ping unanswered, up to
   * 35 s): let it go now, so that nobody shows as here meanwhile. Back online, it connects again.
   */
  private onOffline = () => {
    const socket = this.socket;
    if (this.timer) clearTimeout(this.timer);
    if (!socket) return;
    socket.onclose = null;
    socket.close();
    this.dropped();
  };

  private connect(): void {
    if (!this.enabled || (this.socket && this.socket.readyState <= WebSocket.OPEN)) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.connected = true;
      this.retry = 0;
      for (const clubId of this.wanted.keys()) this.send({ type: 'subscribe', clubId });
      if (this.reading && (document.visibilityState !== 'hidden' || this.audible)) this.send(this.reading);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.ping(), 25_000);
      // Back after a gap: whatever happened meanwhile (notes, progress, new books) is fetched.
      if (this.everConnected) {
        void this.qc.invalidateQueries({ predicate: (q) => !['session', 'publication'].includes(String(q.queryKey[0])) });
      }
      this.everConnected = true;
      this.emit();
    };
    socket.onmessage = (event) => {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
      this.onMessage(String(event.data));
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.dropped();
      // 4001: the session ended (signed out, reset, or another tab signed someone else in).
      if (event.code === 4001) void this.qc.invalidateQueries({ queryKey: keys.session });
      if (!this.enabled || event.code === 4001) return;
      const delay = Math.min(15_000, 500 * 2 ** this.retry++) + Math.random() * 300;
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  /** The connection is gone: nobody shows as here until it is back. */
  private dropped(): void {
    this.connected = false;
    this.socket = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
    this.presence.clear();
    this.voice.clear();
    this.emit();
  }

  /**
   * A socket can die without closing (a phone changing networks): if nothing comes back to a
   * ping within ten seconds, give up on it and connect again.
   */
  private ping(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'ping' });
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      if (this.socket !== socket) return;
      socket.onclose = null;
      socket.close();
      this.dropped();
      this.connect();
    }, 10_000);
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private onMessage(raw: string): void {
    const message = parseServerMessage(raw);
    if (!message) return;
    switch (message.type) {
      case 'presence': {
        this.presence.set(message.clubId, new Map(message.members.map((m) => [m.userId, m])));
        this.emit();
        break;
      }
      case 'presence:update': {
        const club = this.presence.get(message.clubId) ?? new Map<string, PresenceEntry>();
        club.set(message.entry.userId, message.entry);
        this.presence.set(message.clubId, new Map(club));
        this.emit();
        break;
      }
      case 'progress':
        applyMemberProgress(this.qc, message.bookId, message.clubId, message.progress);
        break;
      case 'comment:new':
        mergeComment(this.qc, message.bookId, message.comment);
        void this.qc.invalidateQueries({ queryKey: keys.books(message.clubId) });
        break;
      case 'comment:deleted':
        removeComment(this.qc, message.bookId, message.commentId);
        break;
      case 'book:changed':
        // Also what hangs off the book: lining up an audiobook moves its notes and places (D47).
        void this.qc.invalidateQueries({ queryKey: keys.book(message.bookId) });
        void this.qc.invalidateQueries({ queryKey: keys.books(message.clubId) });
        void this.qc.invalidateQueries({ queryKey: keys.comments(message.bookId) });
        void this.qc.invalidateQueries({ queryKey: keys.progress(message.bookId) });
        void this.qc.invalidateQueries({ queryKey: keys.questions(message.bookId) });
        void this.qc.invalidateQueries({ queryKey: ['readalong'] });
        break;
      case 'club:changed':
        void this.qc.invalidateQueries({ queryKey: keys.club(message.clubId) });
        void this.qc.invalidateQueries({ queryKey: keys.clubs });
        void this.qc.invalidateQueries({ queryKey: keys.books(message.clubId) });
        break;
      case 'notification:new':
        addNotification(this.qc, message.notification);
        // Fetched again as well: a fetch of the list in flight, answered before this notification
        // was stored, would otherwise put the bell back a count (and a list not loaded yet would
        // miss it). That fetch is called off first, since one is joined rather than started again
        // while it runs; the server sends this once it has stored it, so a fetch now holds it.
        void this.qc.cancelQueries({ queryKey: keys.notifications }).then(() => this.qc.invalidateQueries({ queryKey: keys.notifications }));
        window.dispatchEvent(new CustomEvent('bc-notification', { detail: message.notification }));
        break;
      case 'chat:new': {
        const selfId = this.qc.getQueryData<{ user: { id: string } | null }>(keys.session)?.user?.id;
        mergeChatMessage(this.qc, message.clubId, message.bookId, message.message);
        bumpChatUnread(this.qc, message.clubId, message.message.author.userId === selfId);
        // Their message is here: whatever they were typing is sent, so they are typing no more there.
        this.stopTyping(message.clubId, message.message.author.userId, message.bookId ?? 'general');
        break;
      }
      case 'chat:updated':
        mergeChatMessage(this.qc, message.clubId, message.bookId, message.message);
        break;
      case 'chat:deleted':
        removeChatMessage(this.qc, message.clubId, message.bookId, message.messageId, message.threadId ?? null);
        break;
      case 'chat:typing': {
        const key = message.channel ? `${message.clubId}:${message.channel}` : `${message.clubId}:${message.bookId ?? ''}`;
        const byUser = new Map(this.typing.get(key));
        byUser.set(message.userId, { displayName: message.displayName, until: message.until });
        this.typing.set(key, byUser);
        this.emit();
        break;
      }
      case 'chat:notice':
        // An agent will not answer what you asked (D204): only you are told, by the chat on screen.
        window.dispatchEvent(new CustomEvent('bc-chat-notice', { detail: message }));
        break;
      case 'voice:update':
        this.voice.set(message.state.roomName, message.state);
        this.emit();
        break;
      case 'party:state':
        applyPartyState(this.qc, message.bookId, message.state);
        break;
      case 'party:ended':
        clearParty(this.qc, message.bookId);
        break;
      default:
        break;
    }
  }

  subscribe(clubId: string): () => void {
    const count = this.wanted.get(clubId) ?? 0;
    this.wanted.set(clubId, count + 1);
    if (count === 0) this.send({ type: 'subscribe', clubId });
    return () => {
      const n = (this.wanted.get(clubId) ?? 1) - 1;
      if (n <= 0) {
        this.wanted.delete(clubId);
        this.send({ type: 'unsubscribe', clubId });
      } else this.wanted.set(clubId, n);
    };
  }

  /**
   * Report the reader's position; throttled to four messages a second, the last one always sent.
   * `audible`: it is the audiobook playing, which goes on with the page hidden (a locked phone).
   */
  setReading(state: { bookId: string; editionId: string; locator: Locator; label: string } | null, options: { audible?: boolean } = {}): void {
    if (!state) {
      this.reading = null;
      this.audible = false;
      if (this.pendingReading) clearTimeout(this.pendingReading);
      this.send({ type: 'idle' });
      return;
    }
    this.reading = { type: 'reading', ...state };
    this.audible = options.audible ?? false;
    const wait = 250 - (Date.now() - this.lastReadingSent);
    if (this.pendingReading) clearTimeout(this.pendingReading);
    const flush = () => {
      this.pendingReading = null;
      this.lastReadingSent = Date.now();
      if (this.reading && (document.visibilityState !== 'hidden' || this.audible)) this.send(this.reading);
    };
    if (wait <= 0) flush();
    else this.pendingReading = setTimeout(flush, wait);
  }

  presenceOf(clubId: string): ReadonlyMap<string, PresenceEntry> {
    return this.presence.get(clubId) ?? EMPTY;
  }

  /** Who is in a voice room right now (D153-D154). */
  voiceOf(roomName: string): VoiceRoomState | null {
    return this.voice.get(roomName) ?? null;
  }

  /** Someone's typing in a club's chat is over (their message arrived in `channel`): drop it at once there, not when it expires. */
  private stopTyping(clubId: string, userId: string, channel: string): void {
    let changed = false;
    for (const key of [`${clubId}:`, `${clubId}:${channel}`]) {
      const byUser = this.typing.get(key);
      if (!byUser?.has(userId)) continue;
      const next = new Map(byUser);
      next.delete(userId);
      this.typing.set(key, next);
      changed = true;
    }
    if (changed) this.emit();
  }

  /** Who is typing in a club's chat (D150), pruned of anyone whose "until" has passed. */
  typingIn(clubId: string, bookId: string | null): ReadonlyMap<string, TypingEntry> {
    const key = `${clubId}:${bookId ?? ''}`;
    const byUser = this.typing.get(key);
    if (!byUser) return EMPTY_TYPING;
    const now = Date.now();
    const live = new Map([...byUser].filter(([, v]) => v.until > now));
    if (live.size !== byUser.size) this.typing.set(key, live);
    return live;
  }

  /** Live chat typing (D150): throttled by the caller (ChatComposer debounces its own calls). */
  sendChatTyping(clubId: string, bookId: string | null): void {
    this.send({ type: 'chat:typing', clubId, bookId });
  }

  sendVoiceJoin(clubId: string, room: VoiceRoomKind, adhocId?: string): void {
    this.send({ type: 'voice:join', clubId, room, adhocId });
  }

  sendVoiceLeave(clubId: string, room: VoiceRoomKind, adhocId?: string): void {
    this.send({ type: 'voice:leave', clubId, room, adhocId });
  }

  sendVoiceSelf(clubId: string, room: VoiceRoomKind, patch: { muted?: boolean; deafened?: boolean; speaking?: boolean; pushToTalk?: boolean }, adhocId?: string): void {
    this.send({ type: 'voice:self', clubId, room, adhocId, ...patch });
  }

  /** Listening together (D158): this device's own mic crossed LiveKit's speaking threshold. */
  sendPartySpeaking(clubId: string, bookId: string, speaking: boolean): void {
    this.send({ type: 'party:speaking', clubId, bookId, speaking });
  }

  version(): number {
    return this.snapshotVersion;
  }

  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.snapshotVersion++;
    for (const l of this.listeners) l();
  }
}

const EMPTY: ReadonlyMap<string, PresenceEntry> = new Map();
const EMPTY_TYPING: ReadonlyMap<string, TypingEntry> = new Map();

let instance: Realtime | null = null;

export function initRealtime(qc: QueryClient): Realtime {
  instance ??= new Realtime(qc);
  return instance;
}

export function realtime(): Realtime | null {
  return instance;
}

/** Subscribe to a club's live events while the component is mounted; returns its presence. */
export function useClubPresence(clubId: string | undefined): ReadonlyMap<string, PresenceEntry> {
  useEffect(() => {
    if (!clubId || !instance) return;
    return instance.subscribe(clubId);
  }, [clubId]);
  useSyncExternalStore(
    (l) => instance?.listen(l) ?? (() => {}),
    () => instance?.version() ?? 0,
  );
  return clubId && instance ? instance.presenceOf(clubId) : EMPTY;
}

export function useRealtimeConnected(): boolean {
  useSyncExternalStore(
    (l) => instance?.listen(l) ?? (() => {}),
    () => instance?.version() ?? 0,
  );
  return instance?.connected ?? false;
}

/** Who is in a voice room right now; the club must already be subscribed (useClubPresence). */
export function useVoicePresence(roomName: string | null): VoiceRoomState | null {
  useSyncExternalStore(
    (l) => instance?.listen(l) ?? (() => {}),
    () => instance?.version() ?? 0,
  );
  return roomName && instance ? instance.voiceOf(roomName) : null;
}

/** Who is typing in a club's chat right now (pruned of anyone whose typing has expired). */
export function useChatTyping(clubId: string | undefined, bookId: string | null): ReadonlyMap<string, TypingEntry> {
  useSyncExternalStore(
    (l) => instance?.listen(l) ?? (() => {}),
    () => instance?.version() ?? 0,
  );
  return clubId && instance ? instance.typingIn(clubId, bookId) : EMPTY_TYPING;
}
