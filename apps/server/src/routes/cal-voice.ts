import { type FastifyInstance } from 'fastify';
import { CAL_HANDS_FREE_MAX_MS, CAL_HANDS_FREE_MAX_TURNS, TurnBuffer } from '@bookclub/shared';
import { originAllowed } from '../auth/plugin';
import { calConsentFor } from '../cal/consent';
import { calBudgetSpent, conversationById, settingsFor } from '../cal/store';
import { runVoiceTurn } from '../cal/voice/pipeline';
import { voiceRateLimiterFor } from '../cal/voice/transcription';
import { sttProviderFor, ttsProviderFor } from '../cal/voice';
import { type AppContext } from '../context';
import { requireMember } from '../auth/access';
import { resolveSession } from '../repos/sessions';
import { calEnabled } from '../services/chat-agents';

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
  readonly handsFree?: boolean;
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
 * or pause whatever audiobook is playing. `speakingStart` says whose voice the reply is in: Cal's,
 * or the conversation's book's narrator's (D223). A `{type:"bargeIn"}` message (the listener starts
 * talking over Cal) aborts whatever is still being generated or sent.
 */
export function calVoiceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const rateLimiter = voiceRateLimiterFor(ctx);

  app.get<{ Querystring: { clubId?: string; conversationId?: string } }>('/ws/cal/voice', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !originAllowed(ctx, request, origin)) return socket.close(4003, 'origin not allowed');
    const token = request.sessionToken;
    if (!request.user || !token) return socket.close(4001, 'sign in');
    if (!calEnabled(ctx.config)) return socket.close(4004, 'cal is not set up on this server');
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
    if (!calConsentFor(ctx, userId).allowed) return socket.close(4003, 'AI access disabled');
    let turn: { audio: TurnBuffer; mimeType: string; handsFree: boolean } | null = null;
    let abort: AbortController | null = null;
    let speaking: AbortController | null = null;
    let handsFreeTurns = 0;
    let handsFreeDeadline: number | undefined;
    let handsFreeTimer: ReturnType<typeof setTimeout> | undefined;
    const stopAtLimit = () => {
      turn = null;
      abort?.abort();
      socket.close(4010, 'hands-free session limit');
    };

    const canSend = (): boolean => {
      if (socket.readyState !== socket.OPEN) return false;
      // A hands-free conversation can stay open across sign-out or a club removal.
      if (resolveSession(ctx.db, token, ctx.config.SESSION_DAYS)?.user.id !== userId) {
        abort?.abort();
        socket.close(4001, 'sign in');
        return false;
      }
      try {
        requireMember(ctx.db, clubId, userId);
      } catch {
        abort?.abort();
        socket.close(4003, 'not a member of this club');
        return false;
      }
      if (!calConsentFor(ctx, userId).allowed) {
        abort?.abort();
        socket.close(4003, 'AI access disabled');
        return false;
      }
      if (handsFreeDeadline !== undefined && Date.now() >= handsFreeDeadline) {
        stopAtLimit();
        return false;
      }
      return true;
    };
    const send = (data: unknown) => {
      if (canSend()) socket.send(JSON.stringify(data));
    };

    const endSpeech = (controller: AbortController) => {
      if (speaking !== controller) return;
      speaking = null;
      send({ type: 'speakingEnd' });
    };
    const interrupt = () => {
      if (!abort) return;
      abort.abort();
      endSpeech(abort);
    };

    const endTurn = () => {
      const clip = turn;
      turn = null;
      if (!canSend() || !clip) return;
      if (!conversationById(ctx.db, conversationId)) {
        socket.close(4004, 'conversation not found');
        return;
      }
      const audio = clip.audio.take();
      if (audio.byteLength === 0) {
        send({ type: 'turnDone', outcome: 'silent' });
        return;
      }
      const bounded = handsFreeDeadline !== undefined;
      if (bounded && handsFreeTurns >= CAL_HANDS_FREE_MAX_TURNS) {
        stopAtLimit();
        return;
      }
      if (!rateLimiter.attempt(userId)) {
        send({ type: 'error', message: "You've asked Cal a lot in the last minute. Try again shortly." });
        return;
      }
      const spent = calBudgetSpent(ctx.db, clubId, { club: ctx.config.CAL_MONTHLY_SPEND_CAP_USD, instance: ctx.config.CAL_INSTANCE_MONTHLY_SPEND_CAP_USD });
      if (spent) {
        send({ type: 'error', message: spent === 'club' ? 'This club has reached its Cal budget for this month.' : "Cal has reached this month's budget for every club here." });
        return;
      }
      // The standing setting as it is now, so a change made in Cal's settings mid-session holds from the next turn on.
      const wholeSeries = settingsFor(ctx.db, userId).whole_series === 1;
      if (bounded) handsFreeTurns += 1;
      const controller = new AbortController();
      abort = controller;
      const sendTurn = (data: unknown) => {
        if (!controller.signal.aborted) send(data);
      };
      void runVoiceTurn({
        ctx,
        stt,
        tts,
        clubId,
        userId,
        conversationId,
        wholeSeries,
        audio,
        mimeType: clip.mimeType,
        handsFree: clip.handsFree,
        signal: controller.signal,
        verifyAccess: () => {
          if (!canSend()) controller.abort();
        },
        onTranscript: (text) => sendTurn({ type: 'transcript', text }),
        onTextDelta: (text) => sendTurn({ type: 'textDelta', text }),
        onSpeakingStart: (voice) => {
          speaking = controller;
          sendTurn({ type: 'speakingStart', voice, mimeType: tts.outputMimeType });
        },
        onAudioChunk: (chunk) => {
          if (!controller.signal.aborted && canSend()) socket.send(chunk);
        },
        onSpeakingEnd: () => endSpeech(controller),
      }).then((outcome) => {
        sendTurn({ type: 'turnDone', outcome, ...(bounded && handsFreeTurns >= CAL_HANDS_FREE_MAX_TURNS ? { limitReached: true } : {}) });
      }).catch((err: unknown) => {
        if (controller.signal.aborted) return;
        ctx.log.error({ err, conversationId }, 'cal voice turn failed');
        send({ type: 'error', message: 'Cal had trouble with that. Try again.' });
      }).finally(() => {
        if (abort === controller) abort = null;
      });
    };

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (turn && !canSend()) return;
        if (turn && !turn.audio.push(new Uint8Array(data))) {
          send({ type: 'error', message: 'That turn is too long. Release and try again.' });
          turn = null;
          abort?.abort();
          socket.close(4009, 'turn too large');
        }
        return;
      }
      const msg = parseControl(data.toString('utf8'));
      if (!msg) return;
      if (msg.type === 'start') {
        if (!canSend()) return;
        if (handsFreeTurns >= CAL_HANDS_FREE_MAX_TURNS) {
          stopAtLimit();
          return;
        }
        if (msg.handsFree === true && handsFreeDeadline === undefined) {
          handsFreeDeadline = Date.now() + CAL_HANDS_FREE_MAX_MS;
          handsFreeTimer = setTimeout(stopAtLimit, CAL_HANDS_FREE_MAX_MS).unref();
        }
        interrupt();
        turn = { audio: new TurnBuffer(MAX_TURN_BYTES), mimeType: msg.mimeType, handsFree: msg.handsFree === true };
      } else if (msg.type === 'end') {
        endTurn();
      } else if (msg.type === 'bargeIn') {
        turn = null;
        interrupt();
        send({ type: 'turnDone', outcome: 'aborted' });
      }
    });
    const dispose = () => {
      clearTimeout(handsFreeTimer);
      abort?.abort();
    };
    socket.on('close', dispose);
    socket.on('error', dispose);
  });
}
