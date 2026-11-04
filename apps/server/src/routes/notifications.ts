import { type NotificationList, ReadNotificationsBodySchema } from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { parse } from '../lib/errors';
import { markRead, notificationsFor } from '../services/notifications';

export function notificationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/notifications', async (request): Promise<NotificationList> => {
    const user = requireUser(request);
    return notificationsFor(ctx.db, user.id);
  });

  /** Mark some (`ids`) or all of your notifications read. */
  app.post('/api/notifications/read', async (request, reply) => {
    const user = requireUser(request);
    const body = parse(ReadNotificationsBodySchema, request.body ?? {});
    markRead(ctx.db, user.id, body.ids);
    return reply.code(204).send();
  });
}
