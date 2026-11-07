import { askCalInChat } from '../cal/in-chat';
import { type AppContext } from '../context';
import { type ChatMessageWithAuthor } from '../repos/chat';
import { agentsAsked } from './chat';

/**
 * A message has just been sent: ask every agent it asks (services/chat.ts `agentsAsked`, D204).
 * Each one's own checks run now and its work in the background; nothing here holds up the reply to
 * the person who sent it, and nothing an agent does can fail their message.
 */
export function askAgents(ctx: AppContext, message: ChatMessageWithAuthor): void {
  for (const agent of agentsAsked(ctx, message)) {
    if (agent.kind === 'cal') askCalInChat(ctx, agent, message);
  }
}
