import { askCalInChat } from '../cal/in-chat';
import { type AppContext } from '../context';
import { type ChatMessageWithAuthor } from '../repos/chat';
import { deliverToAgent } from './agent-webhooks';
import { agentsAsked } from './chat';

/**
 * A message has just been sent: ask every agent it asks (services/chat.ts `agentsAsked`): Cal
 * answers it himself (D204); an agent of another service has it delivered to its webhook (D205).
 * Each one's own checks run now and its work in the background; nothing here holds up the reply to
 * the person who sent it, and nothing an agent does can fail their message. `origin` is the
 * server's public origin, as the sender's request reached it: where an agent answers.
 */
export function askAgents(ctx: AppContext, message: ChatMessageWithAuthor, origin: string): void {
  for (const agent of agentsAsked(ctx, message)) {
    if (agent.kind === 'cal') askCalInChat(ctx, agent, message);
    else deliverToAgent(ctx, agent, message, origin);
  }
}
