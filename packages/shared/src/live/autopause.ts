import { type PartySettings } from './party';

/**
 * Auto-pause on interruption (D158). Pure state machine, driven only by explicit timestamps (no
 * timers of its own), so it is unit-tested with fake speaker events and a fake clock
 * (apps/server/src/realtime/party.test.ts, shared/live/autopause.test.ts) and reused unchanged by
 * the server's real party loop (apps/server/src/realtime/party.ts), which feeds it `Date.now()`.
 *
 * Each client reports only its own mic's active-speaker state (from LiveKit's own
 * `ActiveSpeakersChanged`/`isSpeakingChanged`) — never anyone else's, and never the audiobook,
 * which plays locally and is never published to the room. LiveKit's own event fires once per
 * *transition* (false→true, true→false), not repeatedly while someone keeps talking, so crossing
 * the threshold cannot be checked only when a new `speaking` call arrives: `tick` (the party's own
 * periodic resync, every 500 ms) re-checks it too, which is why continuous, unbroken speech still
 * trips it with no further event from the client at all.
 *
 * This engine's sharpest limit: it cannot tell a real voice from the audiobook leaking out of a
 * speaker into an open mic. Echo cancellation (required on every published track, D158) removes
 * the part of that leak that matches what the device itself is playing out, but a laptop's
 * speakers picked up by a phone sitting next to it are a different device's output and are not
 * cancelled by either side — earbuds or headphones remove the leak at the source instead, and are
 * the documented workaround.
 */
export class AutoPauseEngine {
  private readonly speakingSince = new Map<string, { readonly since: number; readonly displayName: string }>();
  private pausedBy: { readonly userId: string; readonly displayName: string } | null = null;
  private quietSince: number | null = null;

  constructor(private settings: () => PartySettings) {}

  /** A participant's own mic crossed LiveKit's active-speaker threshold. Returns 'pause' to act on. */
  speaking(userId: string, displayName: string, isSpeaking: boolean, now: number): 'pause' | null {
    if (!this.settings().autoPause) {
      this.speakingSince.clear();
      this.quietSince = null;
      return null;
    }
    if (!isSpeaking) {
      this.speakingSince.delete(userId);
      if (this.speakingSince.size === 0) this.quietSince ??= now;
      return null;
    }
    this.quietSince = null;
    if (!this.speakingSince.has(userId)) this.speakingSince.set(userId, { since: now, displayName });
    return this.checkThreshold(now);
  }

  /**
   * Call periodically (the party's own resync tick): re-checks the threshold for speech that
   * never sent a second event (above), and the auto-resume countdown while paused by an
   * interruption. Returns at most one of 'pause' or 'resume' to act on.
   */
  tick(now: number): 'pause' | 'resume' | null {
    const paused = this.checkThreshold(now);
    if (paused) return paused;
    if (!this.pausedBy || !this.settings().autoResume) return null;
    if (this.speakingSince.size > 0) return null;
    if (this.quietSince !== null && now - this.quietSince >= this.settings().autoResumeAfterMs) {
      this.pausedBy = null;
      this.quietSince = null;
      return 'resume';
    }
    return null;
  }

  private checkThreshold(now: number): 'pause' | null {
    if (this.pausedBy) return null;
    for (const [userId, info] of this.speakingSince) {
      if (now - info.since >= this.settings().autoPauseSensitivityMs) {
        this.pausedBy = { userId, displayName: info.displayName };
        return 'pause';
      }
    }
    return null;
  }

  /** A tap on "paused: X is talking", or anyone manually resuming: clears the hold without waiting. */
  clear(): void {
    this.pausedBy = null;
    this.quietSince = null;
  }

  /**
   * A manual play/pause/seek: there is nothing to "interrupt" while the party itself is not
   * playing, so every count this engine keeps starts clean the next time it is. Without this, a
   * speaker's countdown begun minutes before a manual pause would still be sitting in
   * `speakingSince` when play resumes, and could fire the instant it does.
   */
  reset(): void {
    this.speakingSince.clear();
    this.pausedBy = null;
    this.quietSince = null;
  }

  get reason(): { readonly userId: string; readonly displayName: string } | null {
    return this.pausedBy;
  }
}
