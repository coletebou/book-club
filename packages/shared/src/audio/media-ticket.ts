import { z } from 'zod';

/**
 * Media tickets (D219): the iOS app's audio player has no session cookie of its own (AVPlayer's
 * requests carry none), so the app asks for a ticket for the edition it plays and gives it to the
 * player as this request header, on every request for that edition's tracks.
 */
export const MEDIA_TICKET_HEADER = 'x-bookclub-media-ticket';

export const MediaTicketBodySchema = z.strictObject({ editionId: z.string() });
export type MediaTicketBody = z.infer<typeof MediaTicketBodySchema>;

export const MediaTicketSchema = z.object({ ticket: z.string(), expiresAt: z.number() });
export type MediaTicket = z.infer<typeof MediaTicketSchema>;

/**
 * The edition a track's address is in (`<origin>/media/editions/<id>/tracks/<n>`), or null for any
 * other address. With `origin`, only an address there: a ticket is never sent to another host.
 */
export function editionOfTrackUrl(url: string, origin?: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (origin !== undefined && parsed.origin !== new URL(origin).origin) return null;
  const m = /^\/media\/editions\/([A-Za-z0-9_-]{6,64})\/tracks\/\d{1,6}$/.exec(parsed.pathname);
  return m ? m[1]! : null;
}
