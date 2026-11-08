import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { IdSchema, MEDIA_TICKET_HEADER, MediaTicketBodySchema, type MediaTicket } from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { type AppContext } from '../context';
import { parse, tooMany, unauthorized } from '../lib/errors';
import { sha256Hex } from '../lib/crypto';
import { RateLimiter } from './ratelimit';
import { requireEdition } from './access';
import { requireUser } from './plugin';
import { type UserRow } from '../repos/users';

/** How long a ticket is good for: longer than any one track takes to hear, at any speed (D219). */
export const MEDIA_TICKET_MS = 12 * 60 * 60 * 1000;

/** The one kind of address a ticket opens: an audiobook's track, nothing else. */
const TRACK_PATH = /^\/media\/editions\/([A-Za-z0-9_-]{6,64})\/tracks\/\d{1,6}(?:\?.*)?$/;

/**
 * Media tickets (D219): what the iOS app's audio player shows the server instead of the session
 * cookie, which AVPlayer does not send (AppleCoreMedia's requests carry no Cookie, seen on the
 * simulator, so every streamed track was a 401). The app asks for one with its own authenticated
 * request and hands it to the player as a request header, never in the address.
 *
 * A ticket is `<session hash>.<edition>.<until>.<signature>`: it opens one edition's tracks, for the
 * person whose session asked, while that session lasts (signing out ends it) and for 12 hours at
 * most, and only while they are still in the club (the track route's own check runs as for a
 * cookie). Signed with a key made at start, as the agents' picture links are (D205): a restart
 * ends every ticket, and the app asks for a new one when a stream fails.
 */
export function registerMediaTickets(app: FastifyInstance, ctx: AppContext): void {
  const key = randomBytes(32);
  const limit = new RateLimiter(120, 60_000);
  const sign = (payload: string) => createHmac('sha256', key).update(payload).digest('base64url');

  /** The person a ticket stands for on this track's address, or null. */
  function verify(ticket: string, editionId: string, now: number): UserRow | null {
    const parts = ticket.split('.');
    if (parts.length !== 4) return null;
    const [hash, edition, until, signature] = parts as [string, string, string, string];
    const expires = Number(until);
    if (edition !== editionId || !/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(expires) || expires < now) return null;
    const expected = Buffer.from(sign(`${hash}.${edition}.${until}`));
    const offered = Buffer.from(signature);
    if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) return null;
    const session = ctx.db.get<{ user_id: string; expires_at: number }>('SELECT user_id, expires_at FROM sessions WHERE id_hash = ?', [hash]);
    if (!session || session.expires_at <= now) return null;
    const user = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [session.user_id]);
    return user && user.disabled_at === null ? user : null;
  }

  // After the cookie's own hook (registerAuth): only for a track, only when no cookie said who it is.
  app.addHook('onRequest', async (request) => {
    if (request.user || request.method !== 'GET' && request.method !== 'HEAD') return;
    const header = request.headers[MEDIA_TICKET_HEADER];
    if (typeof header !== 'string' || header.length > 400) return;
    const match = TRACK_PATH.exec(request.url);
    if (!match) return;
    request.user = verify(header, match[1]!, Date.now());
  });

  app.post('/api/media/ticket', async (request): Promise<MediaTicket> => {
    const user = requireUser(request);
    if (!limit.attempt(user.id)) throw tooMany('Too many media tickets.');
    const { editionId } = parse(MediaTicketBodySchema, request.body);
    const { edition } = requireEdition(ctx.db, parse(IdSchema, editionId), user.id);
    // Only a session cookie can ask: a ticket never begets another.
    if (!request.sessionToken) throw unauthorized('Sign in to listen.');
    const expiresAt = Date.now() + MEDIA_TICKET_MS;
    const payload = `${sha256Hex(request.sessionToken)}.${edition.id}.${expiresAt}`;
    return { ticket: `${payload}.${sign(payload)}`, expiresAt };
  });
}
