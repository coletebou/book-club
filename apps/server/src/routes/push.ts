import { PushRegisterBodySchema, PushUnregisterBodySchema } from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { parse } from '../lib/errors';
import { registerPushToken, removePushToken } from '../repos/push-tokens';

/**
 * The iOS app's device tokens (D134): registered once signed in, forgotten on request (signing
 * out of the app). Accepted whether or not APNs is configured (APNS_* unset): a token kept now
 * is used the day a key is added, with no app update needed.
 */
export function pushRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/push/register', async (request, reply) => {
    const user = requireUser(request);
    const body = parse(PushRegisterBodySchema, request.body);
    registerPushToken(ctx.db, user.id, body.token, body.platform);
    return reply.code(204).send();
  });

  app.post('/api/push/unregister', async (request, reply) => {
    const user = requireUser(request);
    const body = parse(PushUnregisterBodySchema, request.body);
    removePushToken(ctx.db, body.token, user.id);
    return reply.code(204).send();
  });
}
