import { MediaTicketSchema } from '@bookclub/shared';

/**
 * Media tickets for the native player (D219): AVPlayer's requests carry no session cookie, so the
 * player shows the server a ticket instead, in a request header. This asks for one per edition with
 * the app's own request (which does carry the cookie: it is the same shared store the background
 * download uses), keeps it until shortly before it ends, and forgets it when a stream fails with it.
 */
export interface MediaTickets {
  get(editionId: string): Promise<string | null>;
  invalidate(editionId: string): void;
}

/** Asked for again this long before it would end, so a track never starts on a dying ticket. */
const RENEW_BEFORE_MS = 30 * 60 * 1000;

export function createMediaTickets(serverUrl: string, fetchFn: typeof fetch, now: () => number = Date.now): MediaTickets {
  const held = new Map<string, { ticket: string; expiresAt: number }>();
  const asking = new Map<string, Promise<string | null>>();
  return {
    get(editionId) {
      const kept = held.get(editionId);
      if (kept && kept.expiresAt - RENEW_BEFORE_MS > now()) return Promise.resolve(kept.ticket);
      const inFlight = asking.get(editionId);
      if (inFlight) return inFlight;
      const ask = (async () => {
        try {
          const res = await fetchFn(`${serverUrl.replace(/\/$/, '')}/api/media/ticket`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ editionId }),
          });
          if (!res.ok) return null;
          const parsed = MediaTicketSchema.safeParse(await res.json());
          if (!parsed.success) return null;
          held.set(editionId, parsed.data);
          return parsed.data.ticket;
        } catch {
          return null; // offline, or a server without tickets: the player goes on as before, cookie only
        } finally {
          asking.delete(editionId);
        }
      })();
      asking.set(editionId, ask);
      return ask;
    },
    invalidate(editionId) {
      held.delete(editionId);
    },
  };
}
