import { type FastifyInstance } from 'fastify';
import { type AppContext } from '../context';
import { webhookReceiver } from '../services/livekit';

/**
 * LiveKit's webhook (D154), optional and off when LIVEKIT_* is unset: a backstop, not the source
 * of truth for voice presence (each client reports its own join/leave/mic state over the hub).
 * `app.ts` registers a raw-string content-type parser for `application/webhook+json` (LiveKit's
 * content type for signed webhooks) so the body reaching `receive` is the exact bytes LiveKit
 * signed, not a re-serialised copy that would fail verification.
 */
export function livekitWebhookRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/livekit/webhook', async (request, reply) => {
    if (!ctx.config.livekit) return reply.code(404).send();
    const body = typeof request.body === 'string' ? request.body : '';
    try {
      const event = await webhookReceiver(ctx.config.livekit).receive(body, request.headers.authorization);
      if (event.event === 'participant_left' && event.room?.name && event.participant?.identity) {
        ctx.hub.forceVoiceLeave(event.room.name, event.participant.identity);
      }
    } catch (err) {
      request.log.warn({ err }, 'rejected a LiveKit webhook (bad signature or body)');
      return reply.code(400).send();
    }
    return reply.code(200).send();
  });
}
