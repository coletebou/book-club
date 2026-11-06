import { type AgentEventMessage, type AgentEventV1, agentWebhookHeaders } from '@bookclub/chat-core';
import { type ChatMessageView } from '@bookclub/shared';
import { type AppContext } from '../context';
import { newId } from '../lib/crypto';
import { bookById } from '../repos/books';
import { type ChatMessageWithAuthor, chatMessageById } from '../repos/chat';
import { clubById } from '../repos/clubs';
import { type ChatAgent, type WebhookSettings } from './chat-agents';
import { ChatViews, conversationBefore } from './chat';

/**
 * Delivering a message to an agent of another service (D205): a member's message that names it
 * (services/chat.ts `agentsAsked`) is POSTed to its webhook as a signed event (chat-core's
 * `agents.ts`: HMAC-SHA256 over the timestamp and the exact body), with the conversation it is in
 * as its writer may read it. Book Club decides nothing about what the agent is asked; it delivers
 * the message, and shows what the agent answers through its own API (routes/agents.ts).
 *
 * - Limited per person (`perMemberPerMinute`) and overall (`perMinute`), so no one member, nor all
 *   of them together, can flood the service; what is over is told to the asker alone.
 * - Never follows a redirect (`redirect: 'manual'`): a signed delivery goes to the address
 *   configured, or nowhere. Ten seconds per attempt; a network failure, a timeout, a 429 or a 5xx
 *   is tried again twice (after 1 s, then 4 s), with the same delivery id, so a receiver can drop a
 *   repeat; any other answer is final. One that never got through is told to the asker.
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
  failed: (name: string) => `${name} could not be reached, so it has not seen that. Try again later.`,
} as const;

type Outcome = 'delivered' | 'retry' | 'refused';

/**
 * Deliver a message just sent to an agent it names: the limits checked at once, the delivery
 * itself in the background (ChatAgents.run). `origin` is where the agent answers (the server's
 * public origin, as the asker's own request reached it).
 */
export function deliverToAgent(ctx: AppContext, agent: ChatAgent, message: ChatMessageWithAuthor, origin: string): void {
  const settings = ctx.agents.webhookOf(agent);
  if (!settings) return;
  const notice = (text: string) =>
    ctx.hub.sendToUser(message.user_id, { type: 'chat:notice', clubId: message.club_id, bookId: message.book_id, messageId: message.id, agent: agent.handle, text });
  if (!ctx.agents.limiter(`${agent.handle}:member`, settings.perMemberPerMinute).attempt(message.user_id)) return notice(AGENT_NOTICES.rate(agent.displayName));
  if (!ctx.agents.limiter(`${agent.handle}:all`, settings.perMinute).attempt('all')) return notice(AGENT_NOTICES.busy(agent.displayName));
  const delivery = newId();
  ctx.agents.run(`agent:${agent.handle}:${message.id}`, async () => {
    // Deleted before it went: nothing to deliver.
    if (chatMessageById(ctx.db, message.id)?.deleted_at !== null) return;
    const body = JSON.stringify(eventFor(ctx, agent, message, origin, delivery));
    for (let attempt = 0; ; attempt++) {
      const outcome = await post(settings, body, delivery);
      if (outcome === 'delivered') return;
      const wait = ctx.agents.retryDelaysMs[attempt];
      if (outcome === 'refused' || wait === undefined) {
        ctx.log.warn({ agent: agent.handle, delivery, outcome, attempts: attempt + 1 }, 'chat agent delivery failed');
        notice(AGENT_NOTICES.failed(agent.displayName));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  });
}

async function post(settings: WebhookSettings, body: string, delivery: string): Promise<Outcome> {
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'BookClub-Agents/1',
    ...(await agentWebhookHeaders({ secret: settings.secret, body, event: 'chat.mention', delivery })),
  };
  try {
    const res = await fetch(settings.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
    // Its answer's body says nothing Book Club acts on: not read, so a large one costs nothing.
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) return 'delivered';
    return res.status === 429 || res.status >= 500 ? 'retry' : 'refused';
  } catch {
    return 'retry';
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

/** The event for a delivery (chat-core's AgentEventV1): what the asker may read of the conversation, and where to answer. */
export function eventFor(ctx: AppContext, agent: ChatAgent, message: ChatMessageWithAuthor, origin: string, delivery: string): AgentEventV1 {
  const club = clubById(ctx.db, message.club_id);
  const book = message.book_id ? bookById(ctx.db, message.book_id) : undefined;
  const rows = conversationBefore(ctx, message, THREAD_CONTEXT);
  // As the person who named the agent may read them: nothing past their place, nothing deleted.
  const views = new ChatViews(ctx, message.user_id).many([...rows, message]);
  const thread = rows.flatMap((row, i) => (views[i]!.hidden || views[i]!.deleted ? [] : [eventMessage(row, views[i]!)]));
  const asked = views.at(-1)!;
  const expires = Date.now() + MEDIA_TTL_MS;
  const images =
    asked.hidden || asked.deleted
      ? []
      : asked.attachments.map((a) => ({
          url: `${origin}/api/agents/v1/media/${a.id}?expires=${expires}&signature=${ctx.agents.mediaSignature(agent.handle, a.id, expires)}`,
          width: a.width,
          height: a.height,
        }));
  return {
    version: 1,
    type: 'chat.mention',
    id: delivery,
    createdAt: new Date().toISOString(),
    agent: { handle: agent.handle },
    club: { id: message.club_id, name: club?.name ?? '' },
    channel: book ? { kind: 'book', bookId: book.id, title: book.title } : { kind: 'general' },
    message: { ...eventMessage(message, asked), images },
    thread,
    reply: { url: `${origin}/api/agents/v1/clubs/${message.club_id}/messages`, parentId: message.id },
  };
}
