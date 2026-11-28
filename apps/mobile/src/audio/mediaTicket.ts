import { MediaTicketSchema, editionOfTrackUrl } from '@bookclub/shared';

/**
 * Media tickets for the native player (D219): AVPlayer's requests carry no session cookie, so the
 * player shows the server a ticket instead, in a request header. This asks for one per edition with
 * the app's own request (which does carry the cookie: it is the same shared store the background
 * download uses), keeps it until shortly before it ends, and forgets it when a stream fails with it.
 */
export interface MediaTickets {
  /** The edition of a track on this server (null for an address anywhere else: no ticket goes there). */
  editionOf(url: string): string | null;
  get(editionId: string, userId?: string): Promise<string | null>;
  invalidate(editionId: string, userId?: string): void;
  clear(): void;
}

/** Asked for again this long before it would end, so a track never starts on a dying ticket. */
const RENEW_BEFORE_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const ticketKey = (editionId: string, userId?: string) => `${editionId}/${userId ?? ''}`;

interface PendingTicket {
  readonly controller: AbortController;
  readonly promise: Promise<string | null>;
  waiters: number;
}

export function createMediaTickets(serverUrl: string, fetchFn: typeof fetch, now: () => number = Date.now): MediaTickets {
  const held = new Map<string, { ticket: string; expiresAt: number }>();
  const asking = new Map<string, PendingTicket>();

  function waitForTicket(key: string, pending: PendingTicket): Promise<string | null> {
    pending.waiters += 1;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS); });
    return Promise.race([pending.promise, deadline]).finally(() => {
      clearTimeout(timeout);
      pending.waiters -= 1;
      // Each caller gets its own deadline. An earlier tap must not cancel a joined load (D255).
      if (pending.waiters === 0 && asking.get(key) === pending) {
        asking.delete(key);
        pending.controller.abort();
      }
    });
  }

  return {
    editionOf: (url) => editionOfTrackUrl(url, serverUrl),
    get(editionId, userId) {
      const key = ticketKey(editionId, userId);
      const kept = held.get(key);
      if (kept && kept.expiresAt - RENEW_BEFORE_MS > now()) return Promise.resolve(kept.ticket);
      const inFlight = asking.get(key);
      if (inFlight) return waitForTicket(key, inFlight);
      const controller = new AbortController();
      const promise = Promise.resolve().then(async () => {
        try {
          if (controller.signal.aborted) return null;
          const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
          if (userId) headers['x-bookclub-user'] = userId;
          const res = await fetchFn(`${serverUrl.replace(/\/$/, '')}/api/media/ticket`, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({ editionId }),
            signal: controller.signal,
          });
          if (!res.ok) return null;
          const parsed = MediaTicketSchema.safeParse(await res.json());
          if (!parsed.success || controller.signal.aborted) return null;
          held.set(key, parsed.data);
          return parsed.data.ticket;
        } catch {
          return null; // offline, or a server without tickets: the player goes on as before, cookie only
        } finally {
          if (asking.get(key)?.controller === controller) asking.delete(key);
        }
      });
      const pending = { controller, promise, waiters: 0 };
      asking.set(key, pending);
      return waitForTicket(key, pending);
    },
    invalidate(editionId, userId) {
      held.delete(ticketKey(editionId, userId));
    },
    clear() {
      held.clear();
      for (const { controller } of asking.values()) controller.abort();
      asking.clear();
    },
  };
}
