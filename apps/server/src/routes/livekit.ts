import { type LiveKitConfig, type LiveKitTokenResponse, IdSchema, LiveKitTokenRequestSchema, voiceRoomName } from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { requireMember } from '../auth/access';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { badRequest, notFound, parse } from '../lib/errors';
import { members } from '../repos/clubs';
import { mintToken } from '../services/livekit';

/**
 * Voice channels (D153). Only members get a token (`requireMember`, like every other club
 * resource), and only for a room name this server built — never one the client sends — so LiveKit
 * is reached with exactly the authorization our own membership table already decided.
 */
export function livekitRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/livekit/config', async (): Promise<LiveKitConfig> => ({ enabled: ctx.config.livekit !== null, url: ctx.config.livekit?.url ?? null }));

  app.post('/api/livekit/token', async (request): Promise<LiveKitTokenResponse> => {
    const user = requireUser(request);
    if (!ctx.config.livekit) throw notFound('Voice is not set up on this instance.');
    const body = parse(LiveKitTokenRequestSchema, request.body);
    const clubId = parse(IdSchema, body.clubId);
    requireMember(ctx.db, clubId, user.id);
    if (body.room === 'adhoc' && !body.adhocId) throw badRequest('adhocId is required for an ad hoc room.');
    const member = members(ctx.db, clubId).find((m) => m.userId === user.id)!;
    const roomName = voiceRoomName(clubId, body.room, body.adhocId);
    return mintToken(ctx.config.livekit, { identity: user.id, displayName: member.displayName, color: member.color, roomName });
  });
}
