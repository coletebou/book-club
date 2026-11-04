import { type FastifyInstance } from 'fastify';
import { originAllowed } from '../auth/plugin';
import { type AppContext } from '../context';
import { sha256Hex } from '../lib/crypto';

/** The WebSocket endpoint: authenticated by the session cookie, refused from other origins. */
export function wsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !originAllowed(ctx, request, origin)) {
      socket.close(4003, 'origin not allowed');
      return;
    }
    if (!request.user) {
      socket.close(4001, 'sign in');
      return;
    }
    ctx.hub.attach(socket, request.user.id, request.sessionToken ? sha256Hex(request.sessionToken) : null);
  });
}
