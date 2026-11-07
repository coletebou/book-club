import { type AgentEventMessage, type AgentEventV1, agentWebhookHeaders } from '@coletebou/chat-core';
import { type ChatMessageView } from '@bookclub/shared';
import { type AppContext } from '../context';
import { newId } from '../lib/crypto';
import { raiseAgentDeliveryFence, recordAgentDelivery } from '../repos/agent-deliveries';
import { bookById } from '../repos/books';
import { type ChatMessageWithAuthor, chatMessageById } from '../repos/chat';
import { clubById, membership } from '../repos/clubs';
import { type ChatAgent, type WebhookSettings } from './chat-agents';
import { ChatViews, conversationBefore } from './chat';

/**
 * Delivering a message to an agent of another service (D205): a member's message that names it
 * (services/chat.ts `agentsAsked`) is POSTed to its webhook as a signed event (chat-core's
 * `agents.ts`: HMAC-SHA256 over the timestamp and the exact body), with the conversation it is in
 * as its writer may read it. Book Club decides nothing about what the agent is asked; it delivers
 * the message, and shows what the agent answers through its own API (routes/agents.ts).
 *
 * - Each delivery is kept (agent_deliveries, migration 025) with the furthest fence of everything it
 *   carried, before its first attempt: what the agent writes back is fenced by what it was given.
 * - Every address in it is a path on Book Club's own API (where to answer, a picture), never an
 *   origin: the agent puts the address it was configured with for Book Club in front of it, so
 *   nothing a request carries (its Host header) can send the agent, and its token, anywhere else.
 * - Limited per person (`perMemberPerMinute`) and overall (`perMinute`), so no one member, nor all
 *   of them together, can flood the service; what is over is told to the asker alone.
 * - Never follows a redirect (`redirect: 'manual'`): a signed delivery goes to the address
 *   configured, or nowhere. Ten seconds per attempt; a network failure, a timeout, a 429 or a 5xx
 *   is tried again twice (after 1 s, then 4 s), with the same delivery id, so a receiver can drop a
 *   repeat; any other answer is final. Before each attempt the message must still be there and its
 *   writer still in the club, and each retry is built again, so that it carries the conversation as
 *   it is then (a message deleted meanwhile is not sent again) and its fence, kept with the
 *   delivery, rises to cover it. One that never got through is told to the asker. A server that
 *   stops calls off the attempt under way and the wait for the next one.
 * - Its pictures are passed as addresses good for an hour, signed for this agent and fetched with
 *   its own token (`GET /api/agents/v1/media/:id`); the rest of the conversation says only how many
 *   pictures a message holds.
 */

/** How many earlier messages an agent is given with the one that names it. */
const THREAD_CONTEXT = 20;
const ATTEMPT_TIMEOUT_MS = 10_000;
/** How long the address of a picture in a delivery is good for. */
const MEDIA_TTL_MS = 60 * 60_000;

export const AGENT_NOTICES = {
  rate: (name: string) => `You've sent ${name} a lot in the last minute. Try again shortly.`,
  busy: (name: string) => `${name} has had a lot of messages in the last minute. Try again shortly.`,
  // (Not "has not seen it": an attempt that timed out may have reached it.)
  failed: (name: string) => `${name} could not be reached, so it may not have seen that. Try again later.`,
} as const;

interface Attempt {
  readonly outcome: 'delivered' | 'retry' | 'refused';
  /** The webhook's answer, when it gave one. */
  readonly status?: number;
  /** Why no answer came (a network failure, the timeout, the server stopping). */
  readonly error?: unknown;
}

/** Deliver a message just sent to an agent it names: the limits checked at once, the delivery itself in the background (ChatAgents.run). */
export function deliverToAgent(ctx: AppContext, agent: ChatAgent, message: ChatMessageWithAuthor): void {
  const settings = ctx.agents.webhookOf(agent);
  if (!settings) return;
  const notice = (text: string) =>
    ctx.hub.sendToUser(message.user_id, { type: 'chat:notice', clubId: message.club_id, bookId: message.book_id, messageId: message.id, agent: agent.handle, text });
  if (!ctx.agents.limiter(`${agent.handle}:member`, settings.perMemberPerMinute).attempt(message.user_id)) return notice(AGENT_NOTICES.rate(agent.displayName));
  if (!ctx.agents.limiter(`${agent.handle}:all`, settings.perMinute).attempt('all')) return notice(AGENT_NOTICES.busy(agent.displayName));
  const delivery = newId();
  ctx.agents.run(`agent:${agent.handle}:${message.id}`, async () => {
    // Still to be delivered: not deleted meanwhile, nor written by someone who has since left the club.
    const stillAsked = () => {
      const current = chatMessageById(ctx.db, message.id);
      return current !== undefined && current.deleted_at === null && membership(ctx.db, message.club_id, message.user_id) !== undefined;
    };
    if (!stillAsked()) return;
    const createdAt = new Date().toISOString();
    const first = deliveryFor(ctx, agent, message, delivery, createdAt);
    // Kept before it goes: the agent may answer before its webhook's own reply reaches us.
    recordAgentDelivery(ctx.db, { id: delivery, agent: agent.handle, message_id: message.id, club_id: message.club_id, book_id: message.book_id, asker_id: message.user_id, fence_t: first.fence });
    let event = first.event;
    const stopping = ctx.agents.shutdown;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        // Built again: the conversation as it is now. The asker may have read on, so it may carry
        // more than before, and its fence rises before it goes (never falls: an attempt before may
        // have got through, unanswered).
        // The asking message as it is now too (an edit since is what its asker means).
        const again = deliveryFor(ctx, agent, chatMessageById(ctx.db, message.id) ?? message, delivery, createdAt);
        if (again.fence !== null) raiseAgentDeliveryFence(ctx.db, delivery, again.fence);
        event = again.event;
      }
      const result = await post(settings, JSON.stringify(event), delivery, stopping);
      if (result.outcome === 'delivered') return;
      const wait = ctx.agents.retryDelaysMs[attempt];
      const tryAgain = result.outcome === 'retry' && wait !== undefined && (await pause(wait, stopping));
      // Gone while it waited: no one is waiting on it, so nothing more to send or say.
      if (!stillAsked()) return;
      if (!tryAgain) {
        ctx.log.warn({ agent: agent.handle, delivery, outcome: result.outcome, status: result.status, err: result.error, attempts: attempt + 1 }, 'chat agent delivery failed');
        notice(AGENT_NOTICES.failed(agent.displayName));
        return;
      }
    }
  });
}

/** Wait `ms`; false at once if the server stops meanwhile. */
function pause(ms: number, stopping: AbortSignal): Promise<boolean> {
  if (stopping.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      stopping.removeEventListener('abort', stop);
      resolve(true);
    }, ms);
    stopping.addEventListener('abort', stop, { once: true });
  });
}

async function post(settings: WebhookSettings, body: string, delivery: string, stopping: AbortSignal): Promise<Attempt> {
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'BookClub-Agents/1',
    ...(await agentWebhookHeaders({ secret: settings.secret, body, event: 'chat.mention', delivery })),
  };
  try {
    const res = await fetch(settings.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(ATTEMPT_TIMEOUT_MS), stopping]) });
    // Its answer's body says nothing Book Club acts on: not read, so a large one costs nothing.
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) return { outcome: 'delivered', status: res.status };
    return { outcome: res.status === 429 || res.status >= 500 ? 'retry' : 'refused', status: res.status };
  } catch (error) {
    return { outcome: 'retry', error };
  }
}

function eventMessage(row: ChatMessageWithAuthor, view: ChatMessageView): AgentEventMessage {
  return {
    id: row.id,
    author: { id: row.user_id, name: row.author_name, agent: row.author_agent },
    text: view.hidden ? '' : (view.text ?? ''),
    createdAt: view.createdAt,
    parentId: row.parent_id,
    threadId: row.thread_id,
    pictures: view.attachments.length,
  };
}

/**
 * A delivery (chat-core's AgentEventV1): what the asker may read of the conversation, and where to
 * answer; and its fence, the furthest of everything it carries (none in General, which has no
 * fences), which an answer to it is fenced at (routes/agents.ts).
 */
export function deliveryFor(ctx: AppContext, agent: ChatAgent, message: ChatMessageWithAuthor, delivery: string, createdAt: string): { event: AgentEventV1; fence: number | null } {
  const club = clubById(ctx.db, message.club_id);
  const book = message.book_id ? bookById(ctx.db, message.book_id) : undefined;
  const rows = conversationBefore(ctx, message, THREAD_CONTEXT);
  // As the person who named the agent may read them: nothing past their place, nothing deleted.
  const views = new ChatViews(ctx, message.user_id).many([...rows, message]);
  const carried = rows.flatMap((row, i) => (views[i]!.hidden || views[i]!.deleted ? [] : [{ row, view: views[i]! }]));
  const asked = views.at(-1)!;
  const expires = Date.now() + MEDIA_TTL_MS;
  const images =
    asked.hidden || asked.deleted
      ? []
      : asked.attachments.map((a) => ({
          path: `/api/agents/v1/media/${a.id}?expires=${expires}&signature=${ctx.agents.mediaSignature(agent.handle, a.id, expires)}`,
          width: a.width,
          height: a.height,
        }));
  let fence: number | null = null;
  if (message.book_id) for (const row of [...carried.map((c) => c.row), message]) if (row.spoiler_t !== null) fence = Math.max(fence ?? 0, row.spoiler_t);
  const event: AgentEventV1 = {
    version: 1,
    type: 'chat.mention',
    id: delivery,
    createdAt,
    agent: { handle: agent.handle },
    club: { id: message.club_id, name: club?.name ?? '' },
    channel: book ? { kind: 'book', bookId: book.id, title: book.title } : { kind: 'general' },
    message: { ...eventMessage(message, asked), images },
    thread: carried.map((c) => eventMessage(c.row, c.view)),
    reply: { path: `/api/agents/v1/clubs/${message.club_id}/messages`, parentId: message.id },
  };
  return { event, fence };
}
