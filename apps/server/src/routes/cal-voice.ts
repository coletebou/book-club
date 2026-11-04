import { type FastifyInstance } from 'fastify';
import { TurnBuffer } from '@bookclub/shared';
import { originAllowed } from '../auth/plugin';
import { RateLimiter } from '../auth/ratelimit';
import { calBudgetSpent, conversationById, settingsFor } from '../cal/store';
import { runVoiceTurn } from '../cal/voice/pipeline';
import { sttProviderFor, ttsProviderFor } from '../cal/voice';
import { type AppContext } from '../context';
import { requireMember } from '../auth/access';

/**
 * One voice turn's audio, held in memory while push-to-talk (or hands-free silence detection) is
 * still deciding it is over: generous for a real turn (minutes of compressed speech), far short
 * of what the shared Node process can hold before every club on it starts feeling it (PR #13
 * security review: see `@bookclub/shared`'s `TurnBuffer`).
 */
const MAX_TURN_BYTES = 25 * 1024 * 1024;

interface StartMessage {
  readonly type: 'start';
  readonly mimeType: string;
}
interface EndMessage {
  readonly type: 'end';
}
interface BargeInMessage {
  readonly type: 'bargeIn';
}
// No per-turn spoiler scope message any more (D183): each turn reads the asker's standing setting.
type ControlMessage = StartMessage | EndMessage | BargeInMessage;

function parseControl(raw: string): ControlMessage | null {
  try {
    const msg = JSON.parse(raw) as Partial<ControlMessage>;
    if (msg.type === 'start' && typeof (msg as StartMessage).mimeType === 'string') return msg as StartMessage;
    if (msg.type === 'end' || msg.type === 'bargeIn') return msg as ControlMessage;
    return null;
  } catch {
    return null;
  }
}

/**
 * Voice with Cal (D160, D167): push-to-talk or hands-free turns over one WebSocket per
 * conversation. The client sends binary audio chunks between a `{type:"start"}` and a
 * `{type:"end"}` control message (push-to-talk release, or the client's own hands-free silence
 * detection); the server runs STT -> Claude -> streaming TTS (voice/pipeline.ts) and sends audio
 * chunks back, bracketed by `speakingStart`/`speakingEnd` control messages the client uses to duck
 * or pause whatever audiobook is playing. A `{type:"bargeIn"}` message (the listener starts
 * talking over Cal) aborts whatever is still being generated or sent.
 */
export function calVoiceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const rateLimiter = new RateLimiter(ctx.config.CAL_RATE_LIMIT_PER_MINUTE, 60_000);

  app.get<{ Querystring: { clubId?: string; conversationId?: string } }>('/ws/cal/voice', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !originAllowed(ctx, request, origin)) return socket.close(4003, 'origin not allowed');
    if (!request.user) return socket.close(4001, 'sign in');
    if (!ctx.config.ANTHROPIC_API_KEY) return socket.close(4004, 'cal is not set up on this server');
    const stt = sttProviderFor(ctx.config);
    const tts = ttsProviderFor(ctx.config);
    if (!stt || !tts) return socket.close(4004, 'voice is not configured on this server');

    const { clubId, conversationId } = request.query;
    if (!clubId || !conversationId) return socket.close(4000, 'clubId and conversationId are required');
    try {
      requireMember(ctx.db, clubId, request.user.id);
    } catch {
      return socket.close(4003, 'not a member of this club');
    }
    const conversation = conversationById(ctx.db, conversationId);
    if (!conversation || conversation.user_id !== request.user.id || conversation.club_id !== clubId) {
      return socket.close(4004, 'conversation not found');
    }

    const userId = request.user.id;
    let turn = new TurnBuffer(MAX_TURN_BYTES);
    let mimeType = 'audio/webm';
    let abort: AbortController | null = null;

    const send = (data: unknown) => socket.send(JSON.stringify(data));

    const endTurn = () => {
      abort?.abort();
      if (!rateLimiter.attempt(userId)) {
        send({ type: 'error', message: "You've asked Cal a lot in the last minute. Try again shortly." });
        turn.clear();
        return;
      }
      const spent = calBudgetSpent(ctx.db, clubId, { club: ctx.config.CAL_MONTHLY_SPEND_CAP_USD, instance: ctx.config.CAL_INSTANCE_MONTHLY_SPEND_CAP_USD });
      if (spent) {
        send({ type: 'error', message: spent === 'club' ? 'This club has reached its Cal budget for this month.' : "Cal has reached this month's budget for every club here." });
        turn.clear();
        return;
      }
      const audio = turn.take();
      if (audio.byteLength === 0) return;
      // The standing setting as it is now, so a change made in Cal's settings mid-session holds from the next turn on.
      const wholeSeries = settingsFor(ctx.db, userId).whole_series === 1;
      const controller = new AbortController();
      abort = controller;
      void runVoiceTurn({
        ctx,
        stt,
        tts,
        clubId,
        userId,
        conversationId,
        wholeSeries,
        audio,
        mimeType,
        signal: controller.signal,
        onTranscript: (text) => send({ type: 'transcript', text }),
        onTextDelta: (text) => send({ type: 'textDelta', text }),
        onSpeakingStart: () => send({ type: 'speakingStart' }),
        onAudioChunk: (chunk) => socket.send(chunk),
        onSpeakingEnd: () => send({ type: 'speakingEnd' }),
      }).catch((err: unknown) => {
        ctx.log.error({ err, conversationId }, 'cal voice turn failed');
        send({ type: 'error', message: 'Cal had trouble with that. Try again.' });
      });
    };

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (!turn.push(new Uint8Array(data))) {
          // One club member streaming forever (or one absurdly long turn) must not grow without
          // bound in a process every club shares (PR #13 security review): drop the turn and
          // close rather than let `turn` keep growing.
          send({ type: 'error', message: 'That turn is too long. Release and try again.' });
          turn.clear();
          abort?.abort();
          socket.close(4009, 'turn too large');
        }
        return;
      }
      const msg = parseControl(data.toString('utf8'));
      if (!msg) return;
      if (msg.type === 'start') {
        turn = new TurnBuffer(MAX_TURN_BYTES);
        mimeType = msg.mimeType;
      } else if (msg.type === 'end') {
        endTurn();
      } else if (msg.type === 'bargeIn') {
        abort?.abort();
      }
    });
    socket.on('close', () => abort?.abort());
  });
}
