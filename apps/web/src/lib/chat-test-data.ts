import type { ChatMessageView, ChatQuote, HiddenChatMessage, RevealedChatMessage } from '@bookclub/shared';

/** Chat views as the server would send them, for the web's chat tests (D200, D201). */

const START = Date.parse('2026-11-05T20:00:00.000Z');
export const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();

export const ana = { userId: 'user_ana', displayName: 'Ana', color: '#b85c5c', agent: null };
export const ben = { userId: 'user_ben', displayName: 'Ben Carter', color: '#5c7bb8', agent: null };
/** Cal as the author of an answer in chat (D204). */
export const cal = { userId: 'user_cal', displayName: 'Cal', color: '#4f8a7a', agent: 'cal' };

export function message(id: string, minutes: number, extra: Partial<RevealedChatMessage> = {}): RevealedChatMessage {
  return {
    id,
    clubId: 'club_1',
    bookId: null,
    parentId: null,
    threadId: null,
    replyCount: 0,
    replyTo: null,
    author: ana,
    createdAt: at(minutes),
    editedAt: null,
    reactions: [],
    mine: false,
    hidden: false,
    deleted: false,
    text: `message ${id}`,
    mentions: [],
    attachments: [],
    spoilerLabel: null,
    ...extra,
  };
}

export function hidden(id: string, minutes: number, extra: Partial<HiddenChatMessage> = {}): HiddenChatMessage {
  return {
    id,
    clubId: 'club_1',
    bookId: 'book_1',
    parentId: null,
    threadId: null,
    replyCount: 0,
    replyTo: null,
    author: ben,
    createdAt: at(minutes),
    editedAt: null,
    reactions: [],
    mine: false,
    hidden: true,
    spoilerLabel: 'Spoiler up to Chapter 9',
    attachments: [],
    ...extra,
  };
}

export function quote(of: ChatMessageView, extra: Partial<ChatQuote> = {}): ChatQuote {
  return {
    id: of.id,
    author: of.author,
    hidden: of.hidden,
    deleted: !of.hidden && of.deleted,
    text: of.hidden || of.deleted ? null : of.text,
    spoilerLabel: of.hidden ? of.spoilerLabel : null,
    imageCount: of.hidden || of.deleted ? 0 : of.attachments.length,
    ...extra,
  };
}

/** A reply to `parent`, in its thread, quoting it. */
export function reply(id: string, minutes: number, parent: ChatMessageView, extra: Partial<RevealedChatMessage> = {}): RevealedChatMessage {
  return message(id, minutes, { parentId: parent.id, threadId: parent.threadId ?? parent.id, replyTo: quote(parent), ...extra });
}
