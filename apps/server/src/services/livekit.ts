import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import { type LiveKitTokenResponse } from '@bookclub/shared';
import { type Config } from '../config';

export { voiceRoomName } from '@bookclub/shared';

/**
 * Voice channels, self-hosted LiveKit (D153). The server mints a short-lived token for exactly
 * one room name it built itself — never one a client names — scoped to a club a member is
 * actually in (checked by the route, not here); LiveKit itself never learns who our members or
 * clubs are, only room names and participant identities (our user ids).
 */

/** How long a token is good for: long enough that a friends' app does not have to refresh it
 *  mid-conversation, short enough that a leaked one does not grant access for good. */
const TOKEN_TTL = '6h';

export async function mintToken(
  livekit: NonNullable<Config['livekit']>,
  input: { readonly identity: string; readonly displayName: string; readonly color: string; readonly roomName: string },
): Promise<LiveKitTokenResponse> {
  const at = new AccessToken(livekit.apiKey, livekit.apiSecret, {
    identity: input.identity,
    name: input.displayName,
    ttl: TOKEN_TTL,
    // The voice presence row (D154) is rebuilt from each client's own report, not from this, but
    // it rides along for anything LiveKit itself shows (its own dashboards, a future admin view).
    attributes: { color: input.color },
  });
  at.addGrant({ roomJoin: true, room: input.roomName, canPublish: true, canSubscribe: true, canPublishData: true });
  return { url: livekit.url, token: await at.toJwt(), roomName: input.roomName, identity: input.identity };
}

/**
 * Verify and parse a webhook LiveKit posts back (optional, D154's backstop): the body as LiveKit
 * sent it and its `Authorization` header, signed with the same key/secret a token was minted
 * with, so nothing else can forge one.
 */
export function webhookReceiver(livekit: NonNullable<Config['livekit']>): WebhookReceiver {
  return new WebhookReceiver(livekit.apiKey, livekit.apiSecret);
}

/**
 * End an actual, live RTC session (PR #13 security review). A token's `TOKEN_TTL` only bounds how
 * long a *new* join can use it; it does nothing to a connection already established, and removing
 * someone from a club only ever called `hub.revoke` (our own app socket) — never told LiveKit
 * itself to drop them. Without this, a just-kicked member keeps listening and speaking in that
 * room for up to `TOKEN_TTL`. Best effort and silent: the room may not exist, the participant may
 * already be gone, or LiveKit may be briefly unreachable — none of that should block (or even
 * delay) removing someone from the club, which is the actual authority change.
 */
export async function disconnectParticipant(livekit: NonNullable<Config['livekit']>, roomName: string, identity: string): Promise<void> {
  try {
    await new RoomServiceClient(livekit.url, livekit.apiKey, livekit.apiSecret).removeParticipant(roomName, identity);
  } catch {
    // Already gone, room doesn't exist (nobody is or ever was in voice), or LiveKit is
    // unreachable: there is nothing more useful to do than let the club removal itself succeed.
  }
}
