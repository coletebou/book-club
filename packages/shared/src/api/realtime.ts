import { z } from 'zod';
import { LocatorSchema } from '../timeline/locator-schemas';
import { ChatMessageViewSchema } from '../live/chat';
import { PartyStateSchema } from '../live/party';
import { VoiceRoomKindSchema, VoiceRoomStateSchema } from '../live/voice';
import {
  CommentViewSchema,
  EditionKindSchema,
  IdSchema,
  MemberProgressSchema,
  NotificationViewSchema,
  TimelineValueSchema,
} from './schemas';

/** Messages the browser sends over `/ws`. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), clubId: IdSchema }),
  z.object({ type: z.literal('unsubscribe'), clubId: IdSchema }),
  z.object({
    type: z.literal('reading'),
    bookId: IdSchema,
    editionId: IdSchema,
    locator: LocatorSchema,
    label: z.string().max(120),
  }),
  z.object({ type: z.literal('idle') }),
  z.object({ type: z.literal('ping') }),
  /** Live chat: ephemeral (never stored); the server rebroadcasts it to the club's other members. */
  z.object({ type: z.literal('chat:typing'), clubId: IdSchema, bookId: IdSchema.nullable().optional() }),
  /** Voice (D153-D154): each client reports only its own join/leave and mic state. */
  z.object({ type: z.literal('voice:join'), clubId: IdSchema, room: VoiceRoomKindSchema.default('club'), adhocId: z.string().min(1).max(64).optional() }),
  z.object({ type: z.literal('voice:leave'), clubId: IdSchema, room: VoiceRoomKindSchema.default('club'), adhocId: z.string().min(1).max(64).optional() }),
  z.object({
    type: z.literal('voice:self'),
    clubId: IdSchema,
    room: VoiceRoomKindSchema.default('club'),
    adhocId: z.string().min(1).max(64).optional(),
    muted: z.boolean().optional(),
    deafened: z.boolean().optional(),
    speaking: z.boolean().optional(),
    pushToTalk: z.boolean().optional(),
  }),
  /** Listening together (D155, D158): a participant's own mic crossed LiveKit's speaking threshold. */
  z.object({ type: z.literal('party:speaking'), clubId: IdSchema, bookId: IdSchema, speaking: z.boolean() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const ReadingStateSchema = z.object({
  bookId: IdSchema,
  editionId: IdSchema,
  kind: EditionKindSchema,
  t: TimelineValueSchema,
  label: z.string(),
  at: z.number(),
});
export type ReadingState = z.infer<typeof ReadingStateSchema>;

export const PresenceEntrySchema = z.object({
  userId: IdSchema,
  displayName: z.string(),
  color: z.string(),
  online: z.boolean(),
  reading: ReadingStateSchema.nullable(),
});
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

/** Messages the server sends over `/ws`. */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), userId: IdSchema }),
  z.object({ type: z.literal('presence'), clubId: IdSchema, members: z.array(PresenceEntrySchema) }),
  z.object({ type: z.literal('presence:update'), clubId: IdSchema, entry: PresenceEntrySchema }),
  z.object({ type: z.literal('progress'), clubId: IdSchema, bookId: IdSchema, progress: MemberProgressSchema }),
  z.object({ type: z.literal('comment:new'), clubId: IdSchema, bookId: IdSchema, comment: CommentViewSchema }),
  z.object({ type: z.literal('comment:deleted'), clubId: IdSchema, bookId: IdSchema, commentId: IdSchema }),
  z.object({ type: z.literal('book:changed'), clubId: IdSchema, bookId: IdSchema }),
  z.object({ type: z.literal('club:changed'), clubId: IdSchema }),
  z.object({ type: z.literal('notification:new'), notification: NotificationViewSchema }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('error'), message: z.string() }),
  // Live chat (D150-D152).
  z.object({ type: z.literal('chat:new'), clubId: IdSchema, bookId: IdSchema.nullable(), message: ChatMessageViewSchema }),
  z.object({ type: z.literal('chat:updated'), clubId: IdSchema, bookId: IdSchema.nullable(), message: ChatMessageViewSchema }),
  /** `threadId`: the thread the deleted reply was in (D200), so a client can count its root one fewer. */
  z.object({ type: z.literal('chat:deleted'), clubId: IdSchema, bookId: IdSchema.nullable(), messageId: IdSchema, threadId: IdSchema.nullable().optional() }),
  z.object({ type: z.literal('chat:typing'), clubId: IdSchema, bookId: IdSchema.nullable(), userId: IdSchema, displayName: z.string(), until: z.number() }),
  // Voice (D153-D154).
  z.object({ type: z.literal('voice:update'), clubId: IdSchema, state: VoiceRoomStateSchema }),
  // Listening together (D155-D158).
  z.object({ type: z.literal('party:state'), clubId: IdSchema, bookId: IdSchema, state: PartyStateSchema }),
  z.object({ type: z.literal('party:ended'), clubId: IdSchema, bookId: IdSchema }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
