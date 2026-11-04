import type { WidgetSnapshot } from '@bookclub/shared';
import { type FastifyInstance } from 'fastify';
import { requireUser } from '../auth/plugin';
import { type AppContext } from '../context';
import { widgetSnapshot } from '../services/widget';

/** What the iOS app's widgets show (D188): yours only, for the person signed in. */
export function widgetRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/widget', async (request, reply): Promise<WidgetSnapshot> => {
    const user = requireUser(request);
    void reply.header('Cache-Control', 'private, no-store');
    return widgetSnapshot(ctx.db, user.id);
  });
}
