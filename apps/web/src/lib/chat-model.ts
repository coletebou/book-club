import { type MentionCandidate, type MentionDirectory, type MentionSpan, type MentionTarget, findMentions, mentionDirectory, mentionedTargets, mentionsTarget, snippet } from '@bookclub/chat-core';
import { CAL_AGENT_HANDLE, type ChatAgentView, type ChatAuthor, type ChatMessageView, type ChatQuote, type Member } from '@bookclub/shared';

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
  if (parent.hidden) return { ...base, hidden: true, deleted: false, text: null, spoilerLabel: parent.spoilerLabel, imageCount: 0 };
  if (parent.deleted) return { ...base, hidden: false, deleted: true, text: null, spoilerLabel: null, imageCount: 0 };
  return { ...base, hidden: false, deleted: false, text: snippet(parent.text ?? '', 140), spoilerLabel: null, imageCount: parent.attachments.length };
}

/** A held reply brought up to date with its parent (or told the parent is gone, `parent` null). */
export function requote(reply: ChatMessageView, parent: ChatMessageView | null): ChatMessageView {
  if (parent) return { ...reply, replyTo: quoteOf(parent) };
  if (!reply.replyTo) return reply;
  return { ...reply, replyTo: { ...reply.replyTo, hidden: false, deleted: true, text: null, spoilerLabel: null, imageCount: 0 } };
}

/**
 * A message view as this client expects it, from whatever sent it: a page the service worker kept
 * from before a deploy lacks the fields added since (D200, D201), and must not break the screen.
 */
export function normalizeChatView(m: ChatMessageView): ChatMessageView {
  const author = (a: ChatAuthor): ChatAuthor => ({ ...a, agent: a.agent ?? null });
  const base = {
    ...m,
    author: author(m.author),
    threadId: m.threadId ?? null,
    replyCount: m.replyCount ?? 0,
    replyTo: m.replyTo ? { ...m.replyTo, author: author(m.replyTo.author), imageCount: m.replyTo.imageCount ?? 0 } : null,
  };
  if (base.hidden) return { ...base, attachments: base.attachments ?? [] };
  return { ...base, mentions: base.mentions ?? [], attachments: base.attachments ?? [] };
}

/** The server's mention spans (D201) as chat-core reads them. */
export function spansOf(message: ChatMessageView): MentionSpan[] {
  if (message.hidden) return [];
  return (message.mentions ?? []).flatMap((m): MentionSpan[] => {
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

export const agentTarget = (handle: string): MentionTarget => ({ kind: 'agent', handle });

/**
 * Who can be @-mentioned in a club's chat (D201, D204): its members and its agents, built exactly
 * as the server's directory is (services/chat.ts `chatDirectory`), so what the composer writes for
 * a pick reads back on the server as the one picked.
 */
export function directoryOf(members: readonly Member[], agents: readonly ChatAgentView[] = []): MentionDirectory {
  const candidates: MentionCandidate[] = members.map((m) => ({ target: memberTarget(m.userId), displayName: m.displayName }));
  for (const a of agents) candidates.push({ target: agentTarget(a.handle), displayName: a.displayName, handle: a.handle });
  return mentionDirectory(candidates);
}

/** What a message's author is shown as (D204): a person, Cal (the club's AI librarian), or another agent. */
export function authorKind(author: ChatAuthor): 'person' | 'cal' | 'agent' {
  if (!author.agent) return 'person';
  return author.agent === 'cal' ? 'cal' : 'agent';
}

/** What the composer shows of the message being answered (D200). */
export interface ReplyTarget {
  readonly id: string;
  readonly authorName: string;
  readonly authorColor: string;
  /** A short excerpt, or null when the message has no words to show. */
  readonly text: string | null;
  /** The handle of the agent that wrote it (D204, D205); null for a person. */
  readonly authorAgent: string | null;
}

export function replyTargetOf(message: ChatMessageView): ReplyTarget {
  return {
    id: message.id,
    authorName: message.author.displayName,
    authorColor: message.author.color,
    text: !message.hidden && !message.deleted && message.text ? snippet(message.text, 90) : null,
    authorAgent: message.author.agent,
  };
}

/**
 * While the club's agents are not known (their list still loading, or failed): the handles a draft
 * may name as agents of other services, by the server's own reading. Each `@word` is tried as the
 * handle of an agent, beside the club's members, with chat-core's parser, so code, an email address
 * or a member's name reads as it will on the server; Cal is never one (his answers are Book Club's).
 * The composer holds such a message until the list says whether it would leave Book Club (D205).
 */
export function possibleAgentHandles(text: string, members: readonly Member[]): string[] {
  const words = [...new Set([...text.matchAll(/@([A-Za-z][A-Za-z0-9_]{1,31})/gu)].map((m) => m[1]!.toLowerCase()))].filter((h) => h !== CAL_AGENT_HANDLE);
  if (words.length === 0) return [];
  const directory = directoryOf(members, words.map((handle): ChatAgentView => ({ handle, displayName: handle, kind: 'webhook', about: '', avatar: null })));
  return mentionedTargets(findMentions(text, directory)).flatMap((t) => (t.kind === 'agent' ? [t.handle] : []));
}

/** Whoever wrote the message a draft answers: an agent's handle (null for a person), and their name. */
export interface AnsweringAuthor {
  readonly agent: string | null;
  readonly name: string;
}

/**
 * The names of the agents of other services a message being written would be sent to (D205), read
 * as the server will read it once sent (services/chat.ts `agentsAsked`): every one it names; failing
 * that, the one whose message it answers, unless it names someone else. The composer says so before
 * it goes, as the @ picker does: such a message leaves Book Club. Cal is never among them (his
 * answers are Book Club's own, D204). `agents` is null while the club's agents are not known (still
 * loading, or their request failed): the message answered still says whether an agent wrote it, and
 * any agent but Cal is another service's, so a reply to one is said to leave Book Club even then.
 */
export function sentOutsideTo(text: string, directory: MentionDirectory, answering: AnsweringAuthor | null, agents: readonly ChatAgentView[] | null): string[] {
  const named = mentionedTargets(findMentions(text, directory));
  if (agents === null) return named.length === 0 && answering?.agent && answering.agent !== CAL_AGENT_HANDLE ? [answering.name] : [];
  const outside = agents.filter((a) => a.kind === 'webhook');
  const asked = outside.filter((a) => named.some((t) => t.kind === 'agent' && t.handle === a.handle));
  if (asked.length > 0 || named.length > 0) return asked.map((a) => a.displayName);
  const answered = answering?.agent ? outside.find((a) => a.handle === answering.agent) : undefined;
  return answered ? [answered.displayName] : [];
}
