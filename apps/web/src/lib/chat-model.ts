import { type MentionCandidate, type MentionDirectory, type MentionSpan, type MentionTarget, mentionDirectory, mentionsTarget, snippet } from '@bookclub/chat-core';
import type { ChatMessageView, ChatQuote, Member } from '@bookclub/shared';

/**
 * Where Book Club's chat views meet @bookclub/chat-core: the app-specific rules the core's
 * reducers and composer take as arguments, kept in one place so the cache (lib/queries.ts) and
 * the screen (ChatPanel and friends) apply them identically.
 */

/** Never let a late, hidden copy of a message replace one this viewer can already read (D150). */
export const keepRevealed = (held: ChatMessageView, incoming: ChatMessageView): boolean => !held.hidden && incoming.hidden;

/**
 * A reply's quote of its parent, rebuilt from the parent's own current view (D200): the server
 * gated that view for this viewer, so the quote can never show more than the parent itself does.
 * `snippet` is the very cut the server makes (chat-core's), so the two never disagree.
 */
export function quoteOf(parent: ChatMessageView): ChatQuote {
  const base = { id: parent.id, author: parent.author };
  if (parent.hidden) return { ...base, hidden: true, deleted: false, text: null, spoilerLabel: parent.spoilerLabel };
  if (parent.deleted) return { ...base, hidden: false, deleted: true, text: null, spoilerLabel: null };
  return { ...base, hidden: false, deleted: false, text: snippet(parent.text ?? '', 140), spoilerLabel: null };
}

/** A held reply brought up to date with its parent (or told the parent is gone, `parent` null). */
export function requote(reply: ChatMessageView, parent: ChatMessageView | null): ChatMessageView {
  if (parent) return { ...reply, replyTo: quoteOf(parent) };
  if (!reply.replyTo) return reply;
  return { ...reply, replyTo: { ...reply.replyTo, hidden: false, deleted: true, text: null, spoilerLabel: null } };
}

/** The server's mention spans (D201) as chat-core reads them. */
export function spansOf(message: ChatMessageView): MentionSpan[] {
  if (message.hidden) return [];
  return message.mentions.flatMap((m): MentionSpan[] => {
    if (m.userId) return [{ start: m.start, end: m.end, target: { kind: 'member', id: m.userId } }];
    if (m.agent) return [{ start: m.start, end: m.end, target: { kind: 'agent', handle: m.agent } }];
    return [];
  });
}

export const memberTarget = (userId: string): MentionTarget => ({ kind: 'member', id: userId });

/** Whether a message @-mentions the person looking at it (its bubble is marked, D201). */
export function mentionsMe(message: ChatMessageView, selfId: string | undefined): boolean {
  return !!selfId && mentionsTarget(spansOf(message), memberTarget(selfId));
}

/** Who can be @-mentioned in a club's chat (D201): its members, as the server's directory has them. */
export function directoryOf(members: readonly Member[]): MentionDirectory {
  const candidates: MentionCandidate[] = members.map((m) => ({ target: memberTarget(m.userId), displayName: m.displayName }));
  return mentionDirectory(candidates);
}

/** What the composer shows of the message being answered (D200). */
export interface ReplyTarget {
  readonly id: string;
  readonly authorName: string;
  readonly authorColor: string;
  /** A short excerpt, or null when the message has no words to show. */
  readonly text: string | null;
}

export function replyTargetOf(message: ChatMessageView): ReplyTarget {
  return {
    id: message.id,
    authorName: message.author.displayName,
    authorColor: message.author.color,
    text: !message.hidden && !message.deleted && message.text ? snippet(message.text, 90) : null,
  };
}
