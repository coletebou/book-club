import { z } from 'zod';
import { IdSchema, PlaybackRateSchema } from '../api/schemas';

/**
 * Listening together (D155-D157). One shared playback state per book, owned by the server and
 * broadcast to the club over the existing hub — the same primitive presence already uses — rather
 * than a new persistence or coordination layer: a party is ephemeral by nature (nobody needs it
 * to survive a server restart, same as presence) and lives entirely in memory
 * (apps/server/src/realtime/party.ts). Each member's player stays local and authenticated as
 * their own (the audiobook is never piped through LiveKit); it reconciles to the server's clock
 * with `projectPosition` and `driftCorrection` below, which are pure so the sync math is tested
 * without a server, a browser or real audio at all.
 */

export const PartySettingsSchema = z.object({
  /** Off: anyone in the party may play, pause, seek or change speed. On: only the host. */
  hostOnlyControls: z.boolean(),
  /** Pause the party while someone is speaking for longer than `autoPauseSensitivityMs` (D158). */
  autoPause: z.boolean(),
  autoPauseSensitivityMs: z.int().min(200).max(3000),
  /** Resume by itself after quiet, instead of waiting for a tap. */
  autoResume: z.boolean(),
  autoResumeAfterMs: z.int().min(1000).max(60_000),
  /** Rewind this much on resume (auto or tapped), so the first words lost to the pause are heard again. */
  rewindOnResumeMs: z.int().min(0).max(15_000),
});
export type PartySettings = z.infer<typeof PartySettingsSchema>;

export const DEFAULT_PARTY_SETTINGS: PartySettings = {
  hostOnlyControls: false,
  autoPause: true,
  autoPauseSensitivityMs: 700,
  autoResume: true,
  autoResumeAfterMs: 4000,
  rewindOnResumeMs: 2000,
};

export const PartyMemberSchema = z.object({ userId: IdSchema, displayName: z.string(), color: z.string(), joinedAt: z.number() });
export type PartyMember = z.infer<typeof PartyMemberSchema>;

export const PartyPauseSchema = z
  .object({
    reason: z.enum(['interruption', 'manual', 'join']),
    /** Who is talking (interruption) or who paused it (manual); null for "just started". */
    by: z.string().nullable(),
  })
  .nullable();
export type PartyPause = z.infer<typeof PartyPauseSchema>;

export const PartyStateSchema = z.object({
  /** Unique party incarnation and revision order all mutations, not just clock changes. */
  partyId: z.uuid().optional(),
  revision: z.int().min(0).optional(),
  /** Only playback mutations advance this, so automatic end commands can be conditional. */
  clockRevision: z.int().min(0).optional(),
  clubId: IdSchema,
  bookId: IdSchema,
  editionId: IdSchema,
  hostId: IdSchema,
  track: z.int().min(0),
  /** Seconds into the track, as the server's clock has it (not necessarily any one listener's). */
  position: z.number().min(0),
  playing: z.boolean(),
  rate: z.number().min(0.5).max(3),
  /** `Date.now()` when `position`/`playing` last changed: project forward with `projectPosition`. */
  updatedAt: z.number(),
  settings: PartySettingsSchema,
  paused: PartyPauseSchema,
  members: z.array(PartyMemberSchema),
});
export type PartyState = z.infer<typeof PartyStateSchema>;

export const StartPartyBodySchema = z.object({ editionId: IdSchema, settings: PartySettingsSchema.partial().optional() });
export type StartPartyBody = z.infer<typeof StartPartyBodySchema>;

export const PartyControlBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('play') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('seek'), track: z.int().min(0), position: z.number().min(0), fromTrack: z.int().min(0).optional() }),
  // A person's own choice, so one of the speeds offered (D195); drift nudges never reach the server.
  z.object({ action: z.literal('rate'), rate: PlaybackRateSchema }),
  /** A tap on "paused: X is talking", or the end of auto-pause's own quiet countdown. */
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('settings'), settings: PartySettingsSchema.partial() }),
]).and(z.object({ partyId: z.uuid().optional(), expectedClockRevision: z.int().min(0).optional() }));
export type PartyControlBody = z.infer<typeof PartyControlBodySchema>;

/** Sent over the hub whenever a client's own mic crosses the active-speaker threshold it got from LiveKit. */
export const PartySpeakingSchema = z.object({ clubId: IdSchema, bookId: IdSchema, speaking: z.boolean() });
export type PartySpeaking = z.infer<typeof PartySpeakingSchema>;

/** Where the party's position is right now, projected from the server's last update. */
export function projectPosition(state: Pick<PartyState, 'position' | 'playing' | 'rate' | 'updatedAt'>, now: number): number {
  if (!state.playing) return state.position;
  return state.position + ((Math.max(0, now - state.updatedAt) / 1000) * state.rate);
}

/** How far off the party's clock a local player may drift before it is corrected (the spec's 0.75 s). */
export const DRIFT_SEEK_THRESHOLD_S = 0.75;
/** Below the threshold, nudge playback rate by this fraction instead of seeking (no audible jump). */
export const DRIFT_NUDGE_FRACTION = 0.05;
/** Close enough that nudging the rate would do more harm (float jitter) than good. */
export const DRIFT_IGNORE_S = 0.05;

export interface DriftCorrection {
  /** Seek the local player here (big drift); null when a seek is not called for. */
  readonly seekTo: number | null;
  /** The rate to actually play at (the party's rate, nudged a little to close a small drift). */
  readonly rate: number;
}

/** join/leave mid-way, drift correction (D155): seek past the threshold, else nudge rate, else nothing. */
export function driftCorrection(localPosition: number, expectedPosition: number, partyRate: number): DriftCorrection {
  const diff = expectedPosition - localPosition;
  if (Math.abs(diff) > DRIFT_SEEK_THRESHOLD_S) return { seekTo: expectedPosition, rate: partyRate };
  if (Math.abs(diff) <= DRIFT_IGNORE_S) return { seekTo: null, rate: partyRate };
  return { seekTo: null, rate: partyRate * (1 + Math.sign(diff) * DRIFT_NUDGE_FRACTION) };
}
