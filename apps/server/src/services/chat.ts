import { type MentionCandidate, type MentionDirectory, findMentions, mentionDirectory, mentionedTargets, snippet } from '@bookclub/chat-core';
import { type ChatAttachmentView, type ChatMention, type ChatMessageView, type ChatQuote, chapterLabel, memberColor, slotColor } from '@bookclub/shared';
import { type AppContext } from '../context';
import { type Db } from '../db/db';
import { isoRequired } from '../lib/json';
import { type BookRow, bookById, bookChapters } from '../repos/books';
import { type ChatMessageWithAuthor, chatMessagesByIds, reactionsFor, replyCounts } from '../repos/chat';
import { type ChatAttachmentRow, attachmentsForMessages } from '../repos/chat-attachments';
import { members } from '../repos/clubs';
import { type Reading, readingOf } from '../repos/progress';
import { type Gate, type Gated, gateFor } from './gating';
import { createMentionNotifications } from './notifications';

/**
 * Chat messages (D150). A message with no spoiler fence is open the instant it is posted — this
 * is a conversation, not a progressive reveal, so most messages are never gated at all. One with
 * a fence (`spoiler_t`/`spoiler_edition_id`) is judged exactly as a note at that place would be
 * (services/gating.ts `Gate`, reused unchanged): hidden until the viewer's reading reaches it,
 * with only the chapter it waits for ever sent to a client that cannot read it yet.
 *
 * A reply's quote of the message it answers (D200) is judged by that message's own fence for the
 * same viewer, never by the reply's: a quote can show no more of a message than the message
 * itself would show the person looking at it.
 */

function gatedPlace(row: Pick<ChatMessageWithAuthor, 'user_id' | 'spoiler_t' | 'spoiler_edition_id'>, referenceEditionId: string | null): Gated {
  return {
    user_id: row.user_id,
    edition_id: row.spoiler_edition_id ?? referenceEditionId ?? '',
    locator_json: '',
    end_locator_json: null,
    t: row.spoiler_t ?? 0,
    end_t: null,
  };
}

export interface ChatGateContext {
  readonly gate: Gate | null;
  readonly reading: Reading | null;
  readonly chapters: ReturnType<typeof bookChapters>;
  readonly referenceEditionId: string | null;
}

/** Built once per request/page of messages, not once per message (the same cost comments.ts pays). */
export function chatGateFor(db: Db, book: BookRow | undefined, viewerId: string): ChatGateContext {
  if (!book) return { gate: null, reading: null, chapters: [], referenceEditionId: null };
  return { gate: gateFor(db, book), reading: readingOf(db, viewerId, book.id), chapters: bookChapters(book), referenceEditionId: book.reference_edition_id };
}

function reactionSummary(rows: readonly { emoji: string; user_id: string }[], viewerId: string) {
  const counts = new Map<string, { count: number; mine: boolean }>();
  for (const r of rows) {
    const entry = counts.get(r.emoji) ?? { count: 0, mine: false };
    entry.count += 1;
    if (r.user_id === viewerId) entry.mine = true;
    counts.set(r.emoji, entry);
  }
  return [...counts.entries()].map(([emoji, v]) => ({ emoji, ...v }));
}

function authorOf(row: ChatMessageWithAuthor) {
  return { userId: row.user_id, displayName: row.author_name, color: row.author_color !== null ? slotColor(Number(row.author_color)) : memberColor(row.user_id) };
}

/**
 * Whether a viewer may read a message's words, and the label its fence gives (D150). A fenced
 * message with no gate/reading to judge it against (its book is gone, or this request raced a
 * delete of it) fails closed, never open (PR #13 review): the opposite treated "we cannot tell
 * whether you've read this" as "you have".
 */
function judge(row: ChatMessageWithAuthor, ctx: ChatGateContext, viewerId: string): { open: boolean; spoilerLabel: string | null } {
  const fenced = row.spoiler_t !== null;
  const open = row.user_id === viewerId || !fenced || (ctx.gate !== null && ctx.reading !== null && ctx.gate.isOpen(gatedPlace(row, ctx.referenceEditionId), viewerId, ctx.reading));
  return { open, spoilerLabel: fenced ? `Spoiler up to ${chapterLabel(ctx.chapters, row.spoiler_t!)}` : null };
}

/** Whether a viewer may read a message (its words, its pictures): its own fence judged for them. */
export function canReadMessage(db: Db, row: ChatMessageWithAuthor, viewerId: string): boolean {
  return row.deleted_at === null && judge(row, chatGateFor(db, bookFor(db, row.book_id), viewerId), viewerId).open;
}

/** How the reply's quote shows the message it answers, to this viewer (D200); `images`: how many pictures it holds (D203). */
export function toChatQuote(parent: ChatMessageWithAuthor, ctx: ChatGateContext, viewerId: string, images = 0): ChatQuote {
  const author = authorOf(parent);
  if (parent.deleted_at !== null) return { id: parent.id, author, hidden: false, deleted: true, text: null, spoilerLabel: null, imageCount: 0 };
  const { open, spoilerLabel } = judge(parent, ctx, viewerId);
  if (!open) return { id: parent.id, author, hidden: true, deleted: false, text: null, spoilerLabel: spoilerLabel ?? 'Spoiler', imageCount: 0 };
  return { id: parent.id, author, hidden: false, deleted: false, text: snippet(parent.text, 140), spoilerLabel: null, imageCount: images };
}

/** A picture as a message's view carries it once open (D203): its two addresses, both gated live (routes/chat-attachments.ts). */
export function toAttachmentView(row: ChatAttachmentRow): ChatAttachmentView {
  return { id: row.id, kind: 'image', url: `/media/chat/${row.id}`, thumbUrl: `/media/chat/${row.id}/thumb`, width: row.width ?? 1, height: row.height ?? 1 };
}

/** What a view needs beyond the row and its gate: counted, quoted and parsed in batches by `ChatViews`. */
export interface ChatViewExtras {
  readonly replyCount?: number;
  readonly replyTo?: ChatQuote | null;
  readonly mentions?: readonly ChatMention[];
  readonly attachments?: readonly ChatAttachmentRow[];
}

export function toChatView(
  row: ChatMessageWithAuthor,
  ctx: ChatGateContext,
  viewerId: string,
  reactionRows: readonly { emoji: string; user_id: string }[],
  extras: ChatViewExtras = {},
): ChatMessageView {
  const base = {
    id: row.id,
    clubId: row.club_id,
    bookId: row.book_id,
    parentId: row.parent_id,
    threadId: row.thread_id,
    replyCount: extras.replyCount ?? 0,
    replyTo: extras.replyTo ?? null,
    author: authorOf(row),
    createdAt: isoRequired(row.created_at),
    editedAt: row.edited_at === null ? null : isoRequired(row.edited_at),
    reactions: reactionSummary(reactionRows, viewerId),
    mine: row.user_id === viewerId,
  };
  const gone = row.deleted_at !== null;
  const { open, spoilerLabel } = judge(row, ctx, viewerId);
  const pictures = gone ? [] : (extras.attachments ?? []);
  if (open) return { ...base, hidden: false, deleted: gone, text: gone ? null : row.text, mentions: gone ? [] : [...(extras.mentions ?? [])], attachments: pictures.map(toAttachmentView), spoilerLabel };
  // Hidden, its pictures say only that they are there (D144's rule for a note's media).
  return { ...base, hidden: true, spoilerLabel: spoilerLabel ?? 'Spoiler', attachments: pictures.map(() => ({ kind: 'image' as const })) };
}

/** Who can be @-mentioned in a club (D201): its members. */
export function chatDirectory(db: Db, clubId: string): MentionDirectory {
  const candidates: MentionCandidate[] = members(db, clubId).map((m) => ({ target: { kind: 'member', id: m.userId }, displayName: m.displayName }));
  return mentionDirectory(candidates);
}

/** A message's mentions as the API carries them (D201): spans and whom each names. */
export function chatMentions(text: string, directory: MentionDirectory): ChatMention[] {
  return findMentions(text, directory).map((s) => ({
    start: s.start,
    end: s.end,
    userId: s.target.kind === 'member' ? s.target.id : null,
    agent: s.target.kind === 'agent' ? s.target.handle : null,
  }));
}

/**
 * Views of chat messages for one viewer, built in batches: one query each for reactions, reply
 * counts and the parents replies quote, one gate per book and one mention directory per club,
 * however many messages a page, a thread or a push holds. Every route renders messages through
 * this, so a message reads the same in the channel, in its thread and over the socket.
 */
export class ChatViews {
  private readonly gates = new Map<string, ChatGateContext>();
  private readonly directories = new Map<string, MentionDirectory>();

  constructor(
    private readonly db: Db,
    private readonly viewerId: string,
  ) {}

  gate(bookId: string | null): ChatGateContext {
    const key = bookId ?? '';
    let ctx = this.gates.get(key);
    if (!ctx) {
      ctx = chatGateFor(this.db, bookFor(this.db, bookId), this.viewerId);
      this.gates.set(key, ctx);
    }
    return ctx;
  }

  directory(clubId: string): MentionDirectory {
    let directory = this.directories.get(clubId);
    if (!directory) {
      directory = chatDirectory(this.db, clubId);
      this.directories.set(clubId, directory);
    }
    return directory;
  }

  many(rows: readonly ChatMessageWithAuthor[]): ChatMessageView[] {
    if (rows.length === 0) return [];
    const reactions = reactionsFor(this.db, rows.map((r) => r.id));
    const counts = replyCounts(this.db, rows.filter((r) => r.thread_id === null).map((r) => r.id));
    const held = new Map(rows.map((r) => [r.id, r]));
    const missing = [...new Set(rows.map((r) => r.parent_id).filter((id): id is string => id !== null && !held.has(id)))];
    const parents = chatMessagesByIds(this.db, missing);
    const pictures = attachmentsForMessages(this.db, [...held.keys(), ...parents.keys()]);
    return rows.map((row) => {
      const parent = row.parent_id ? (held.get(row.parent_id) ?? parents.get(row.parent_id)) : undefined;
      return toChatView(row, this.gate(row.book_id), this.viewerId, reactions.get(row.id) ?? [], {
        replyCount: counts.get(row.id) ?? 0,
        replyTo: parent ? toChatQuote(parent, this.gate(parent.book_id), this.viewerId, pictures.get(parent.id)?.length ?? 0) : null,
        mentions: row.deleted_at === null ? chatMentions(row.text, this.directory(row.club_id)) : [],
        attachments: pictures.get(row.id) ?? [],
      });
    });
  }

  one(row: ChatMessageWithAuthor): ChatMessageView {
    return this.many([row])[0]!;
  }
}

/**
 * Who a message @-mentions (D152, D201): club members, read by chat-core's `findMentions` — the
 * same parser the composer's autocomplete writes for, so a picked name always reads back as the
 * person picked. Never includes anyone not in the club.
 */
export function mentionedMembers(db: Db, clubId: string, text: string): string[] {
  return mentionedTargets(findMentions(text, chatDirectory(db, clubId))).flatMap((t) => (t.kind === 'member' ? [t.id] : []));
}

/**
 * After a chat message is created or edited: notify whoever it @-mentions (never the writer).
 * Each person is notified once per message (the notifications table's own unique key), so an
 * edit notifies only whom it newly names.
 */
export function notifyMentions(ctx: AppContext, clubId: string, message: ChatMessageWithAuthor): void {
  const mentioned = mentionedMembers(ctx.db, clubId, message.text).filter((id) => id !== message.user_id);
  if (mentioned.length === 0) return;
  createMentionNotifications(ctx, clubId, mentioned, message);
}

/** A message's book, looked up once for the chat gate when it carries a bookId. */
export function bookFor(db: Db, bookId: string | null): BookRow | undefined {
  return bookId ? bookById(db, bookId) : undefined;
}
