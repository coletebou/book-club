import { randomUUID } from 'node:crypto';
import {
  AutoPauseEngine,
  DEFAULT_PARTY_SETTINGS,
  type PartyControlBody,
  type PartySettings,
  type PartyState,
  projectPosition,
} from '@bookclub/shared';
import { type FastifyBaseLogger } from 'fastify';
import { RateLimiter } from '../auth/ratelimit';
import { type Hub } from './hub';

/**
 * Listening together (D155-D158): one shared playback state per book, owned by this process and
 * broadcast over the existing hub — presence's own primitive — rather than a new persistence or
 * coordination layer (a party is as ephemeral as presence; see migration 015's note). Position,
 * playing and rate are the server's canonical clock; each client reconciles locally with
 * `projectPosition`/`driftCorrection` (packages/shared/src/live/party.ts), which do not live here
 * so the sync math is tested without a server at all.
 */

interface Runtime {
  partyId: string;
  revision: number;
  clockRevision: number;
  speakingStates: Map<string, boolean>;
  clubId: string;
  bookId: string;
  editionId: string;
  hostId: string;
  track: number;
  position: number;
  playing: boolean;
  rate: number;
  updatedAt: number;
  settings: PartySettings;
  paused: PartyState['paused'];
  members: Map<string, { displayName: string; color: string; joinedAt: number }>;
  autoPause: AutoPauseEngine;
}

export type ControlResult = { readonly ok: true; readonly state: PartyState } | { readonly ok: false; readonly reason: 'not_found' | 'forbidden' };

/**
 * How often the auto-resume countdown is checked and a safety resync is broadcast. Started
 * unconditionally (app.ts), unlike the hub's heartbeat, which only matters for dead-connection
 * detection: a party's auto-resume is product correctness, needed in every run mode tests use.
 */
const RESYNC_MS = 500;

export class PartyManager {
  private readonly parties = new Map<string, Runtime>();
  private readonly diagnosticLimit = new RateLimiter(120, 60_000);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly hub: Hub,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), RESYNC_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.parties.clear();
  }

  private key(clubId: string, bookId: string): string {
    return `${clubId}:${bookId}`;
  }

  get(clubId: string, bookId: string): PartyState | null {
    const r = this.parties.get(this.key(clubId, bookId));
    return r ? toState(r) : null;
  }

  startParty(clubId: string, bookId: string, editionId: string, hostId: string, hostName: string, hostColor: string, settings?: Partial<PartySettings>): PartyState {
    const key = this.key(clubId, bookId);
    const existing = this.parties.get(key);
    if (existing) {
      existing.members.set(hostId, { displayName: hostName, color: hostColor, joinedAt: existing.members.get(hostId)?.joinedAt ?? Date.now() });
      existing.revision++;
      this.diagnostic('join', existing, { userId: hostId });
      this.broadcast(existing);
      return toState(existing);
    }
    const now = Date.now();
    const merged = { ...DEFAULT_PARTY_SETTINGS, ...settings };
    const runtime: Runtime = {
      partyId: randomUUID(),
      revision: 1,
      clockRevision: 0,
      speakingStates: new Map(),
      clubId,
      bookId,
      editionId,
      hostId,
      track: 0,
      position: 0,
      playing: false,
      rate: 1,
      updatedAt: now,
      settings: merged,
      paused: { reason: 'join', by: null },
      members: new Map([[hostId, { displayName: hostName, color: hostColor, joinedAt: now }]]),
      autoPause: new AutoPauseEngine(() => runtime.settings),
    };
    this.parties.set(key, runtime);
    this.diagnostic('start', runtime, { userId: hostId, settings: merged });
    this.broadcast(runtime);
    return toState(runtime);
  }

  join(clubId: string, bookId: string, userId: string, displayName: string, color: string): PartyState | null {
    const runtime = this.parties.get(this.key(clubId, bookId));
    if (!runtime) return null;
    if (!runtime.members.has(userId)) runtime.members.set(userId, { displayName, color, joinedAt: Date.now() });
    runtime.revision++;
    this.diagnostic('join', runtime, { userId });
    this.broadcast(runtime);
    return toState(runtime);
  }

  /**
   * Leaving does not end the party for everyone else; the party ends when its last member leaves.
   * The host leaving hands the role to whoever has been in the party longest, so host-only
   * controls (and the host's own id) never keep pointing at someone no longer in it (PR #13
   * review: a departed host must not go on controlling a party they rejoined no part of).
   */
  leave(clubId: string, bookId: string, userId: string): void {
    const key = this.key(clubId, bookId);
    const runtime = this.parties.get(key);
    if (!runtime || !runtime.members.delete(userId)) return;
    runtime.autoPause.speaking(userId, '', false, Date.now());
    runtime.speakingStates.delete(userId);
    runtime.revision++;
    this.diagnostic('leave', runtime, { userId });
    if (runtime.members.size === 0) {
      this.parties.delete(key);
      this.hub.publish(clubId, () => ({ type: 'party:ended', clubId, bookId }));
      return;
    }
    if (runtime.hostId === userId) runtime.hostId = nextHost(runtime.members);
    this.broadcast(runtime);
  }

  control(clubId: string, bookId: string, userId: string, body: PartyControlBody): ControlResult {
    const runtime = this.parties.get(this.key(clubId, bookId));
    if (!runtime || (body.partyId !== undefined && body.partyId !== runtime.partyId)) return { ok: false, reason: 'not_found' };
    // Only someone currently in the party may drive it at all (PR #13 review): without this, a
    // member who left keeps `userId === runtime.hostId` true forever and can go on controlling
    // the party, host-only or not, without ever rejoining.
    if (!runtime.members.has(userId)) {
      this.diagnostic('control-denied', runtime, { userId, action: body.action });
      return { ok: false, reason: 'forbidden' };
    }
    const isHost = userId === runtime.hostId;
    if (body.action === 'settings' ? !isHost : runtime.settings.hostOnlyControls && !isHost) {
      this.diagnostic('control-denied', runtime, { userId, action: body.action });
      return { ok: false, reason: 'forbidden' };
    }
    if (body.expectedClockRevision !== undefined && body.expectedClockRevision !== runtime.clockRevision) {
      this.diagnostic('end-superseded', runtime, { userId });
      return { ok: true, state: toState(runtime) };
    }
    const now = Date.now();
    switch (body.action) {
      case 'play':
        runtime.clockRevision++;
        // Recompute first: calling play while already playing (a double click, two members at
        // once) must not freeze the position at its old value for the gap until this call.
        runtime.position = projectPosition(runtime, now);
        runtime.playing = true;
        runtime.updatedAt = now;
        runtime.paused = null;
        // A fresh start: any speaking tracked from before this (someone mid-sentence when the
        // host paused) never gets to trip auto-pause the instant play resumes.
        runtime.autoPause.reset();
        runtime.speakingStates.clear();
        break;
      case 'pause':
        runtime.clockRevision++;
        runtime.position = projectPosition(runtime, now);
        runtime.playing = false;
        runtime.updatedAt = now;
        runtime.paused = { reason: 'manual', by: runtime.members.get(userId)?.displayName ?? null };
        // Nothing to interrupt while manually paused (D158): see AutoPauseEngine.reset's own note.
        runtime.autoPause.reset();
        runtime.speakingStates.clear();
        break;
      case 'seek':
        // Several listeners may finish the same old track at different times. Only the first
        // automatic advancement wins; a late end event must not rewind the next track.
        if (body.fromTrack !== undefined && body.fromTrack !== runtime.track) {
          this.diagnostic('advance-superseded', runtime, { userId });
          return { ok: true, state: toState(runtime) };
        }
        runtime.clockRevision++;
        runtime.track = body.track;
        runtime.position = body.position;
        runtime.updatedAt = now;
        runtime.paused = null;
        runtime.autoPause.reset();
        runtime.speakingStates.clear();
        break;
      case 'rate':
        runtime.clockRevision++;
        runtime.position = projectPosition(runtime, now);
        runtime.rate = body.rate;
        runtime.updatedAt = now;
        break;
      case 'resume':
        this.resume(runtime, now);
        break;
      case 'settings':
        runtime.settings = { ...runtime.settings, ...body.settings };
        break;
    }
    runtime.revision++;
    this.diagnostic('control', runtime, { userId, action: body.action, ...(body.action === 'settings' ? { settings: runtime.settings } : {}) });
    this.broadcast(runtime);
    return { ok: true, state: toState(runtime) };
  }

  /**
   * A participant's own mic crossed LiveKit's speaking threshold (fed fake events in tests).
   * LiveKit's own event fires once per transition, not repeatedly while someone keeps talking, so
   * unbroken speech that never sends a second event still trips this through `tick`'s periodic
   * re-check (`AutoPauseEngine.tick`) — this call alone is what starts the clock on it.
   */
  speaking(clubId: string, bookId: string, userId: string, speaking: boolean): void {
    const runtime = this.parties.get(this.key(clubId, bookId));
    // Nothing to interrupt while the party itself is not playing (a manual pause, or one that
    // never started): see AutoPauseEngine.reset's note on why this guard matters.
    if (!runtime || !runtime.members.has(userId) || !this.active(runtime)) return;
    if (runtime.speakingStates.get(userId) === speaking) return;
    runtime.speakingStates.set(userId, speaking);
    this.diagnostic('speaking', runtime, { userId, speaking });
    const name = runtime.members.get(userId)?.displayName ?? userId;
    if (runtime.autoPause.speaking(userId, name, speaking, Date.now()) === 'pause') this.pause(runtime, name);
  }

  /** Playing, or paused only by an interruption this engine is itself tracking the resume of. */
  private active(runtime: Runtime): boolean {
    return runtime.playing || runtime.paused?.reason === 'interruption';
  }

  private pause(runtime: Runtime, by: string): void {
    if (!runtime.playing) return;
    const now = Date.now();
    runtime.position = projectPosition(runtime, now);
    runtime.playing = false;
    runtime.updatedAt = now;
    runtime.paused = { reason: 'interruption', by };
    runtime.clockRevision++;
    runtime.revision++;
    this.diagnostic('auto-pause', runtime);
    this.broadcast(runtime);
  }

  private resume(runtime: Runtime, now: number): void {
    runtime.clockRevision++;
    const rewindS = runtime.settings.rewindOnResumeMs / 1000;
    runtime.position = Math.max(0, projectPosition(runtime, now) - rewindS);
    runtime.playing = true;
    runtime.updatedAt = now;
    runtime.paused = null;
    runtime.revision++;
    runtime.autoPause.clear();
    runtime.speakingStates.clear();
  }

  /**
   * Re-checks the auto-pause threshold for speech that never sent a second event, the auto-resume
   * countdown (D158), and a safety resync broadcast for late joiners' drift math.
   */
  private tick(): void {
    const now = Date.now();
    for (const runtime of this.parties.values()) {
      if (!this.active(runtime)) continue;
      const action = runtime.autoPause.tick(now);
      if (action === 'pause') this.pause(runtime, runtime.autoPause.reason?.displayName ?? 'Someone');
      else if (action === 'resume') {
        this.resume(runtime, now);
        this.diagnostic('auto-resume', runtime, { rewindMs: runtime.settings.rewindOnResumeMs });
        this.broadcast(runtime);
      } else if (runtime.playing) this.broadcast(runtime);
    }
  }

  private diagnostic(event: string, runtime: Runtime, detail: Record<string, unknown> = {}): void {
    const key = typeof detail.userId === 'string' ? detail.userId : runtime.partyId;
    if (!this.diagnosticLimit.attempt(key)) return; // All server transition logs are bounded too.
    this.log.info({ partyId: runtime.partyId, revision: runtime.revision, clockRevision: runtime.clockRevision, event: `party.${event}`, clubId: runtime.clubId, bookId: runtime.bookId, editionId: runtime.editionId, track: runtime.track, position: runtime.position, playing: runtime.playing, rate: runtime.rate, updatedAt: runtime.updatedAt, pausedReason: runtime.paused?.reason ?? null, members: runtime.members.size, ...detail }, `party.${event}`);
  }

  private broadcast(runtime: Runtime): void {
    const state = toState(runtime);
    this.hub.publish(runtime.clubId, () => ({ type: 'party:state', clubId: runtime.clubId, bookId: runtime.bookId, state }));
    // The 500 ms safety broadcast is not an info log: transitions above and sampled client sync
    // records carry the useful evidence without two server log entries/second/party.
  }
}

/** Whoever has been in the party the longest, once the host leaves (`members` is never empty when this is called). */
function nextHost(members: Runtime['members']): string {
  let best: string | null = null;
  let bestJoinedAt = Number.POSITIVE_INFINITY;
  for (const [userId, m] of members) {
    if (m.joinedAt < bestJoinedAt) {
      best = userId;
      bestJoinedAt = m.joinedAt;
    }
  }
  return best!;
}

function toState(r: Runtime): PartyState {
  return {
    partyId: r.partyId,
    revision: r.revision,
    clockRevision: r.clockRevision,
    clubId: r.clubId,
    bookId: r.bookId,
    editionId: r.editionId,
    hostId: r.hostId,
    track: r.track,
    position: r.position,
    playing: r.playing,
    rate: r.rate,
    updatedAt: r.updatedAt,
    settings: r.settings,
    paused: r.paused,
    members: [...r.members.entries()].map(([userId, m]) => ({ userId, displayName: m.displayName, color: m.color, joinedAt: m.joinedAt })),
  };
}
