import {
  type ClientMessage,
  ClientMessageSchema,
  type PresenceEntry,
  type ReadingState,
  type ServerMessage,
  type VoiceParticipant,
  type VoiceRoomKind,
  locatorToT,
  voiceRoomName,
} from '@bookclub/shared';
import { type FastifyBaseLogger } from 'fastify';
import { type WebSocket } from 'ws';
import { type Db } from '../db/db';
import { bookById, editionById, editionTimeline } from '../repos/books';
import { membership, members } from '../repos/clubs';
import { chapterLabel } from '../services/labels';
import { bookChapters } from '../repos/books';
import { type PartyManager } from './party';

interface VoiceSelfState {
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  pushToTalk: boolean;
}

interface Conn {
  readonly id: number;
  readonly userId: string;
  /** Hash of the session the socket was opened with: when it ends, so does the socket. */
  readonly session: string | null;
  readonly socket: WebSocket;
  readonly clubs: Set<string>;
  reading: (ReadingState & { clubId: string }) | null;
  lastReading: number;
  alive: boolean;
  /** Voice rooms (D153-D154) this connection has joined: room name -> this user's own mic state. */
  readonly voice: Map<string, VoiceSelfState>;
}

const READING_MIN_INTERVAL_MS = 100;
const DEFAULT_VOICE_SELF: VoiceSelfState = { muted: false, deafened: false, speaking: false, pushToTalk: false };

/** A room name is always "club:<clubId>" or "club:<clubId>:adhoc:<id>" (services/livekit.ts); club
 *  ids never contain ':' (IdSchema), so the second segment is always the club. */
function clubIdFromRoom(roomName: string): string {
  return roomName.split(':')[1] ?? roomName;
}

/**
 * Presence and live updates. State is in memory: one process serves the whole club, and
 * presence is ephemeral by nature. Every message a socket receives is scoped to clubs its user
 * belongs to; comment pushes are rendered per recipient so spoiler gating holds over WebSocket too.
 */
export class Hub {
  private readonly conns = new Set<Conn>();
  private nextId = 1;
  private heartbeat: NodeJS.Timeout | null = null;
  /**
   * Listening parties (D155): set once, right after construction (app.ts), so that 'party:speaking'
   * messages can be routed without the two classes needing each other at construction time (the
   * party manager broadcasts through this hub, so it is built after it).
   */
  private parties: PartyManager | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
  ) {}

  setParties(parties: PartyManager): void {
    this.parties = parties;
  }

  start(intervalMs = 20_000): void {
    this.heartbeat = setInterval(() => this.beat(), intervalMs);
    this.heartbeat.unref();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.conns) c.socket.terminate();
    this.conns.clear();
  }

  get size(): number {
    return this.conns.size;
  }

  private beat(): void {
    this.revalidate();
    for (const c of this.conns) {
      if (!c.alive) {
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.socket.ping();
      } catch {
        c.socket.terminate();
      }
    }
  }

  attach(socket: WebSocket, userId: string, session: string | null = null): void {
    const conn: Conn = { id: this.nextId++, userId, session, socket, clubs: new Set(), reading: null, lastReading: 0, alive: true, voice: new Map() };
    this.conns.add(conn);
    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('message', (data) => {
      conn.alive = true;
      const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
      this.onMessage(conn, text);
    });
    socket.on('close', () => this.detach(conn));
    socket.on('error', () => this.detach(conn));
    this.send(conn, { type: 'hello', userId });
  }

  private detach(conn: Conn): void {
    if (!this.conns.delete(conn)) return;
    for (const clubId of conn.clubs) this.announce(clubId, conn.userId);
    // A socket that vanished without saying "voice:leave" (a crash, a killed tab): leave for it.
    for (const roomName of conn.voice.keys()) this.voiceAnnounce(roomName);
  }

  private send(conn: Conn, message: ServerMessage): void {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(message));
  }

  private onMessage(conn: Conn, raw: string): void {
    let parsed: ClientMessage;
    try {
      const result = ClientMessageSchema.safeParse(JSON.parse(raw));
      if (!result.success) throw new Error('invalid message');
      parsed = result.data;
    } catch {
      this.send(conn, { type: 'error', message: 'Invalid message.' });
      return;
    }
    switch (parsed.type) {
      case 'subscribe':
        this.subscribe(conn, parsed.clubId);
        break;
      case 'unsubscribe':
        conn.clubs.delete(parsed.clubId);
        break;
      case 'reading':
        this.reading(conn, parsed);
        break;
      case 'idle':
        this.idle(conn);
        break;
      case 'ping':
        this.send(conn, { type: 'pong' });
        break;
      case 'chat:typing':
        this.chatTyping(conn, parsed.clubId, parsed.bookId ?? null);
        break;
      case 'voice:join':
        this.voiceJoin(conn, parsed.clubId, parsed.room, parsed.adhocId);
        break;
      case 'voice:leave':
        this.voiceLeave(conn, parsed.clubId, parsed.room, parsed.adhocId);
        break;
      case 'voice:self':
        this.voiceSelf(conn, parsed.clubId, parsed.room, parsed.adhocId, {
          muted: parsed.muted,
          deafened: parsed.deafened,
          speaking: parsed.speaking,
          pushToTalk: parsed.pushToTalk,
        });
        break;
      case 'party:speaking':
        if (membership(this.db, parsed.clubId, conn.userId)) this.parties?.speaking(parsed.clubId, parsed.bookId, conn.userId, parsed.speaking);
        break;
    }
  }

  /** Live chat typing (D150): ephemeral, never stored, rebroadcast to the club's other subscribers. */
  private chatTyping(conn: Conn, clubId: string, bookId: string | null): void {
    const member = members(this.db, clubId).find((m) => m.userId === conn.userId);
    if (!member) return;
    this.publish(clubId, (userId) => (userId === conn.userId ? null : { type: 'chat:typing', clubId, bookId, userId: conn.userId, displayName: member.displayName, until: Date.now() + 5000 }));
  }

  private voiceJoin(conn: Conn, clubId: string, room: VoiceRoomKind, adhocId: string | undefined): void {
    if (!membership(this.db, clubId, conn.userId)) {
      this.send(conn, { type: 'error', message: 'Club not found.' });
      return;
    }
    const name = voiceRoomName(clubId, room, adhocId);
    conn.voice.set(name, { ...DEFAULT_VOICE_SELF });
    this.voiceAnnounce(name);
  }

  private voiceLeave(conn: Conn, clubId: string, room: VoiceRoomKind, adhocId: string | undefined): void {
    const name = voiceRoomName(clubId, room, adhocId);
    if (conn.voice.delete(name)) this.voiceAnnounce(name);
  }

  private voiceSelf(
    conn: Conn,
    clubId: string,
    room: VoiceRoomKind,
    adhocId: string | undefined,
    patch: { muted?: boolean; deafened?: boolean; speaking?: boolean; pushToTalk?: boolean },
  ): void {
    const name = voiceRoomName(clubId, room, adhocId);
    const current = conn.voice.get(name);
    if (!current) return;
    conn.voice.set(name, { ...current, ...patch });
    this.voiceAnnounce(name);
  }

  /** Who is in a voice room right now, across every connection that joined it (usually one each). */
  private voiceSnapshot(roomName: string): VoiceParticipant[] {
    const byUser = new Map<string, VoiceParticipant>();
    for (const c of this.conns) {
      const self = c.voice.get(roomName);
      if (!self) continue;
      const member = members(this.db, clubIdFromRoom(roomName)).find((m) => m.userId === c.userId);
      byUser.set(c.userId, {
        userId: c.userId,
        displayName: member?.displayName ?? c.userId,
        color: member?.color ?? '#888888',
        muted: self.muted,
        deafened: self.deafened,
        speaking: self.speaking,
        pushToTalk: self.pushToTalk,
      });
    }
    return [...byUser.values()];
  }

  /**
   * LiveKit's webhook, optional (D154): a participant it confirms is gone, even before our own
   * socket's ping/pong (up to 35 s) notices a network partition the RTC connection saw sooner.
   * Idempotent: a participant who left normally (voice:leave, or the socket closing) is already
   * gone from every room, so this is a no-op for them.
   */
  forceVoiceLeave(roomName: string, userId: string): void {
    let changed = false;
    for (const c of this.conns) if (c.userId === userId && c.voice.delete(roomName)) changed = true;
    if (changed) this.voiceAnnounce(roomName);
  }

  private voiceAnnounce(roomName: string): void {
    const clubId = clubIdFromRoom(roomName);
    const participants = this.voiceSnapshot(roomName);
    this.publish(clubId, () => ({ type: 'voice:update', clubId, state: { clubId, roomName, participants } }));
  }

  private subscribe(conn: Conn, clubId: string): void {
    if (!membership(this.db, clubId, conn.userId)) {
      this.send(conn, { type: 'error', message: 'Club not found.' });
      return;
    }
    const first = !this.userSubscribed(clubId, conn.userId);
    conn.clubs.add(clubId);
    this.send(conn, { type: 'presence', clubId, members: this.snapshot(clubId) });
    if (first) this.announce(clubId, conn.userId);
  }

  private reading(conn: Conn, msg: Extract<ClientMessage, { type: 'reading' }>): void {
    const now = Date.now();
    if (now - conn.lastReading < READING_MIN_INTERVAL_MS) return;
    conn.lastReading = now;
    const book = bookById(this.db, msg.bookId);
    const edition = editionById(this.db, msg.editionId);
    if (!book || !edition || edition.book_id !== book.id || !membership(this.db, book.club_id, conn.userId)) {
      this.send(conn, { type: 'error', message: 'Book not found.' });
      return;
    }
    const timeline = editionTimeline(edition);
    if (!timeline || timeline.geometry.kind !== msg.locator.kind) return;
    const t = locatorToT(timeline, msg.locator);
    conn.reading = {
      clubId: book.club_id,
      bookId: book.id,
      editionId: edition.id,
      kind: edition.kind,
      t,
      label: chapterLabel(bookChapters(book), t),
      at: now,
    };
    this.announce(book.club_id, conn.userId);
  }

  private idle(conn: Conn): void {
    if (!conn.reading) return;
    const clubId = conn.reading.clubId;
    conn.reading = null;
    this.announce(clubId, conn.userId);
  }

  private userSubscribed(clubId: string, userId: string): boolean {
    for (const c of this.conns) if (c.userId === userId && c.clubs.has(clubId)) return true;
    return false;
  }

  private entryFor(clubId: string, userId: string, displayName: string, color: string): PresenceEntry {
    let online = false;
    let reading: ReadingState | null = null;
    for (const c of this.conns) {
      if (c.userId !== userId) continue;
      online = true;
      if (c.reading && c.reading.clubId === clubId && (!reading || c.reading.at > reading.at)) {
        const { clubId: _club, ...state } = c.reading;
        reading = state;
      }
    }
    return { userId, displayName, color, online, reading };
  }

  snapshot(clubId: string): PresenceEntry[] {
    return members(this.db, clubId).map((m) => this.entryFor(clubId, m.userId, m.displayName, m.color));
  }

  /** Tell a club's subscribers about one member's presence. */
  announce(clubId: string, userId: string): void {
    const member = members(this.db, clubId).find((m) => m.userId === userId);
    if (!member) return;
    const entry = this.entryFor(clubId, userId, member.displayName, member.color);
    this.publish(clubId, () => ({ type: 'presence:update', clubId, entry }));
  }

  /** Send a message, rendered per recipient (return null to skip someone), to a club's subscribers. */
  publish(clubId: string, render: (userId: string) => ServerMessage | null): void {
    const cache = new Map<string, ServerMessage | null>();
    for (const c of this.conns) {
      if (!c.clubs.has(clubId)) continue;
      if (!cache.has(c.userId)) cache.set(c.userId, render(c.userId));
      const msg = cache.get(c.userId);
      if (msg) this.send(c, msg);
    }
  }

  /** Send a message to every connection of one person (their notifications). */
  sendToUser(userId: string, message: ServerMessage): void {
    for (const c of this.conns) if (c.userId === userId) this.send(c, message);
  }

  /** A member left or was removed: stop sending them the club's events. */
  revoke(clubId: string, userId: string): void {
    for (const c of this.conns) {
      if (c.userId !== userId) continue;
      c.clubs.delete(clubId);
      if (c.reading?.clubId === clubId) c.reading = null;
    }
    this.publish(clubId, () => ({ type: 'club:changed', clubId }));
  }

  /**
   * Every voice room name this user's connections currently say they are in (PR #13 security
   * review): `revoke` above only stops app events, never the real LiveKit RTC session, so a
   * caller removing a member needs this to actually end it (services/livekit.ts's
   * `disconnectParticipant`) — for the ad hoc rooms this hub has ever heard about; the club's own
   * room is always worth trying regardless, since a participant can be connected to LiveKit
   * without this hub's own presence ever having been told so.
   */
  voiceRoomsFor(userId: string): string[] {
    const names = new Set<string>();
    for (const c of this.conns) {
      if (c.userId !== userId) continue;
      for (const name of c.voice.keys()) names.add(name);
    }
    return [...names];
  }

  /** Sign-out everywhere / account removal: close the user's sockets. */
  disconnectUser(userId: string): void {
    for (const c of [...this.conns]) if (c.userId === userId) c.socket.close(4001, 'signed out');
  }

  /**
   * Close every socket whose session has ended (signed out, expired, revoked by a password change
   * or a reset): a stolen cookie's socket must not keep receiving the club's notes.
   */
  revalidate(): void {
    for (const c of [...this.conns]) {
      if (c.session && !this.db.get('SELECT 1 AS x FROM sessions WHERE id_hash = ? AND expires_at > ?', [c.session, Date.now()])) {
        c.socket.close(4001, 'signed out');
        this.detach(c);
      }
    }
  }

  readingStateOf(userId: string): ReadingState | null {
    let best: ReadingState | null = null;
    for (const c of this.conns) {
      if (c.userId === userId && c.reading && (!best || c.reading.at > best.at)) {
        const { clubId: _club, ...state } = c.reading;
        best = state;
      }
    }
    return best;
  }

  debug(): { conns: number } {
    this.log.debug({ conns: this.conns.size }, 'hub');
    return { conns: this.conns.size };
  }
}
