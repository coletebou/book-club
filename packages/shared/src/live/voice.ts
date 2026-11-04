import { z } from 'zod';
import { IdSchema } from '../api/schemas';

/**
 * Voice channels (D153): one LiveKit room per club, plus ad hoc rooms (a party's own room, or a
 * side conversation). The server only ever mints a token for a room name it built itself, scoped
 * to a club a member is actually in (routes/livekit.ts); LiveKit itself never sees who our
 * members are. Presence in voice (who has joined, muted, speaking) is reported by each client
 * about itself and relayed over the existing hub (D154) — not polled from LiveKit — because a
 * client already knows its own mic state the instant it changes, and the hub already fans state
 * out to a club's subscribers; LiveKit's webhooks (routes/livekit-webhook.ts) are an optional,
 * server-trusted backstop for a client that vanished without saying so (a crash, a killed tab).
 */

export const VoiceRoomKindSchema = z.enum(['club', 'adhoc']);
export type VoiceRoomKind = z.infer<typeof VoiceRoomKindSchema>;

/** One room per club for its voice channel; one more per ad hoc id for a side conversation. A
 *  listening party (D155) uses the club's own room: "the club's LiveKit room for the party". Pure
 *  and shared so the server (token minting, the hub's presence) and tests agree on the name
 *  without either depending on the LiveKit SDK. */
export function voiceRoomName(clubId: string, room: VoiceRoomKind, adhocId?: string): string {
  if (room === 'adhoc') {
    if (!adhocId) throw new Error('adhocId is required for an ad hoc room');
    return `club:${clubId}:adhoc:${adhocId}`;
  }
  return `club:${clubId}`;
}

export const LiveKitTokenRequestSchema = z.object({
  clubId: IdSchema,
  room: VoiceRoomKindSchema.default('club'),
  /** Only for `room: "adhoc"`: a short id the caller chooses, naming one ad hoc room per value. */
  adhocId: z.string().trim().min(1).max(64).optional(),
});
export type LiveKitTokenRequest = z.infer<typeof LiveKitTokenRequestSchema>;

export const LiveKitTokenResponseSchema = z.object({
  url: z.string(),
  token: z.string(),
  roomName: z.string(),
  identity: IdSchema,
});
export type LiveKitTokenResponse = z.infer<typeof LiveKitTokenResponseSchema>;

export const LiveKitConfigSchema = z.object({ enabled: z.boolean(), url: z.string().nullable() });
export type LiveKitConfig = z.infer<typeof LiveKitConfigSchema>;

export const VoiceParticipantSchema = z.object({
  userId: IdSchema,
  displayName: z.string(),
  color: z.string(),
  muted: z.boolean(),
  deafened: z.boolean(),
  speaking: z.boolean(),
  pushToTalk: z.boolean(),
});
export type VoiceParticipant = z.infer<typeof VoiceParticipantSchema>;

export const VoiceRoomStateSchema = z.object({
  clubId: IdSchema,
  roomName: z.string(),
  participants: z.array(VoiceParticipantSchema),
});
export type VoiceRoomState = z.infer<typeof VoiceRoomStateSchema>;

/** What a client reports about its own mic the moment it changes (never about anyone else's). */
export const VoiceSelfSchema = z.object({
  clubId: IdSchema,
  room: VoiceRoomKindSchema.default('club'),
  adhocId: z.string().trim().min(1).max(64).optional(),
  muted: z.boolean().optional(),
  deafened: z.boolean().optional(),
  speaking: z.boolean().optional(),
  pushToTalk: z.boolean().optional(),
});
export type VoiceSelf = z.infer<typeof VoiceSelfSchema>;
