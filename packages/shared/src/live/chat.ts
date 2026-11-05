import { z } from 'zod';
import { IdSchema, IsoDateSchema, TimelineValueSchema } from '../api/schemas';

/**
 * Live text chat (D150). A message belongs to a club and, optionally, one of its books (a
 * "spoiler up to <chapter>" fence only makes sense tied to a book's timeline). The spoiler fence
 * is gated the same way a note is (services/gating.ts `Gate`): hidden from a member until their
 * reading reaches the place the writer marked, nothing about its words ever sent to a client that
 * may not have them yet (D150). A message with no fence is open to the whole club at once, like
 * presence; this is a chat, not a progressive reveal, so nothing else about it is gated.
 */

export const MAX_CHAT_TEXT = 4000;
/** An emoji reaction's stored form: short, no whitespace (loose on purpose — unlike the book's six
 * spoiler-free sentiment markers, REACTIONS, chat reactions are any short emoji a client sends). */
export const ChatEmojiSchema = z
  .string()
  .trim()
  .min(1)
  .max(8)
  .refine((s) => !/\s/.test(s), { error: 'An emoji, not a phrase.' });

export const ChatAuthorSchema = z.object({ userId: IdSchema, displayName: z.string(), color: z.string() });
export type ChatAuthor = z.infer<typeof ChatAuthorSchema>;

export const ChatReactionSummarySchema = z.object({ emoji: ChatEmojiSchema, count: z.int().min(1), mine: z.boolean() });
export type ChatReactionSummary = z.infer<typeof ChatReactionSummarySchema>;

const ChatMessageBase = z.object({
  id: IdSchema,
  clubId: IdSchema,
  bookId: IdSchema.nullable(),
  parentId: IdSchema.nullable(),
  author: ChatAuthorSchema,
  createdAt: IsoDateSchema,
  editedAt: IsoDateSchema.nullable(),
  reactions: z.array(ChatReactionSummarySchema),
  /** Written by the person asking: lets the UI offer edit/delete without comparing ids itself. */
  mine: z.boolean(),
});

export const RevealedChatMessageSchema = ChatMessageBase.extend({
  hidden: z.literal(false),
  deleted: z.boolean(),
  /** Null once deleted. */
  text: z.string().nullable(),
  /** "Spoiler up to Chapter 9" when the writer fenced it, shown once it is open to you too. */
  spoilerLabel: z.string().nullable(),
});
export const HiddenChatMessageSchema = ChatMessageBase.extend({
  hidden: z.literal(true),
  /** Where you must read to before it opens ("Spoiler up to Chapter 9"); never the words. */
  spoilerLabel: z.string(),
});
export const ChatMessageViewSchema = z.discriminatedUnion('hidden', [RevealedChatMessageSchema, HiddenChatMessageSchema]);
export type RevealedChatMessage = z.infer<typeof RevealedChatMessageSchema>;
export type HiddenChatMessage = z.infer<typeof HiddenChatMessageSchema>;
export type ChatMessageView = z.infer<typeof ChatMessageViewSchema>;

export const CreateChatMessageBodySchema = z.object({
  bookId: IdSchema.nullable().optional(),
  text: z.string().trim().min(1, { error: 'Write something' }).max(MAX_CHAT_TEXT),
  parentId: IdSchema.nullable().optional(),
  clientId: z.string().min(8).max(64).optional(),
  /** "Spoiler up to <here>": hidden from members who have not reached this place yet (needs `bookId`). */
  spoilerUpToT: TimelineValueSchema.optional(),
});
export type CreateChatMessageBody = z.infer<typeof CreateChatMessageBodySchema>;

export const EditChatMessageBodySchema = z.object({ text: z.string().trim().min(1, { error: 'Write something' }).max(MAX_CHAT_TEXT) });
export const ReactToChatMessageBodySchema = z.object({ emoji: ChatEmojiSchema });

/** A chat channel (D199): `general` is the messages tagged to no book; a book id is that book's own. */
export const ChatChannelSchema = z.union([z.literal('general'), IdSchema]);
export type ChatChannel = z.infer<typeof ChatChannelSchema>;

export const ChatHistoryQuerySchema = z.object({
  bookId: IdSchema.optional(),
  /** Only this channel's messages (D199); absent means the club's whole stream, as before. */
  channel: ChatChannelSchema.optional(),
  /** Messages created strictly before this one (pagination, oldest-first club gets paged backwards). */
  before: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ChatHistoryQuery = z.infer<typeof ChatHistoryQuerySchema>;

export const ChatHistorySchema = z.object({ messages: z.array(ChatMessageViewSchema), hasMore: z.boolean() });
export type ChatHistory = z.infer<typeof ChatHistorySchema>;

export const ChatUnreadSchema = z.object({ clubId: IdSchema, unread: z.int().min(0) });
export type ChatUnread = z.infer<typeof ChatUnreadSchema>;

export const MarkChatReadBodySchema = z.object({ messageId: IdSchema.optional() });

/**
 * Do Not Disturb (D173): one switch per person, not per club — "quiet tonight" means quiet
 * everywhere. While on, a chat @mention still happens (it is recorded, same as always, so the
 * bell has it the moment this is turned back off) but neither buzzes the phone (the APNs push)
 * nor pops an in-app toast; nothing else chat/mention delivers an alert at all today, so there is
 * nothing else to silence. Reply and "got to your note" notifications are a different workstream
 * (notes, not chat) and are never touched by this switch.
 */
export const ChatDndSchema = z.object({ enabled: z.boolean() });
export type ChatDnd = z.infer<typeof ChatDndSchema>;
export const SetChatDndBodySchema = z.object({ enabled: z.boolean() });
