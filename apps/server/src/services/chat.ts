import { type ChatMessageView, type Member, chapterLabel, memberColor, slotColor } from '@bookclub/shared';
import { type AppContext } from '../context';
import { type Db } from '../db/db';
import { isoRequired } from '../lib/json';
import { type BookRow, bookById, bookChapters } from '../repos/books';
import { type ChatMessageWithAuthor } from '../repos/chat';
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

export function toChatView(row: ChatMessageWithAuthor, ctx: ChatGateContext, viewerId: string, reactionRows: readonly { emoji: string; user_id: string }[]): ChatMessageView {
  const author = { userId: row.user_id, displayName: row.author_name, color: row.author_color !== null ? slotColor(Number(row.author_color)) : memberColor(row.user_id) };
  const base = {
    id: row.id,
    clubId: row.club_id,
    bookId: row.book_id,
    parentId: row.parent_id,
    author,
    createdAt: isoRequired(row.created_at),
    editedAt: row.edited_at === null ? null : isoRequired(row.edited_at),
    reactions: reactionSummary(reactionRows, viewerId),
    mine: row.user_id === viewerId,
  };
  const gone = row.deleted_at !== null;
  const fenced = row.spoiler_t !== null;
  // A fenced message with no gate/reading to judge it against (its book is gone, or this request
  // raced a delete of it) fails closed, never open (PR #13 review): the opposite treated "we
  // cannot tell whether you've read this" as "you have".
  const open = row.user_id === viewerId || !fenced || (ctx.gate !== null && ctx.reading !== null && ctx.gate.isOpen(gatedPlace(row, ctx.referenceEditionId), viewerId, ctx.reading));
  const spoilerLabel = fenced ? `Spoiler up to ${chapterLabel(ctx.chapters, row.spoiler_t!)}` : null;
  if (open) return { ...base, hidden: false, deleted: gone, text: gone ? null : row.text, spoilerLabel };
  return { ...base, hidden: true, spoilerLabel: spoilerLabel ?? 'Spoiler' };
}

const NAME_CHARS = /[^a-z0-9]/g;
function slug(s: string): string {
  return s.toLowerCase().replace(NAME_CHARS, '');
}

/**
 * Who a message @-mentions (D152): a club member's full display name with spaces and punctuation
 * dropped (`@GrantSmith`), or their first/only name alone (`@Grant`). Ambiguous first names (two
 * members called Grant) resolve to whichever member's full-name key was registered last — a
 * documented limitation a small club of friends is unlikely to hit twice.
 */
export function parseMentions(text: string, clubMembers: readonly Member[]): string[] {
  const bySlug = new Map<string, string>();
  for (const m of clubMembers) {
    const full = slug(m.displayName);
    if (full) bySlug.set(full, m.userId);
    const first = slug(m.displayName.trim().split(/\s+/)[0] ?? '');
    if (first) bySlug.set(first, m.userId);
  }
  const found = new Set<string>();
  for (const match of text.matchAll(/@([A-Za-z0-9][A-Za-z0-9_-]{0,40})/g)) {
    const id = bySlug.get(slug(match[1]!));
    if (id) found.add(id);
  }
  return [...found];
}

/** After a chat message is created: notify whoever it @-mentions (never the writer). */
export function notifyMentions(ctx: AppContext, clubId: string, message: ChatMessageWithAuthor): void {
  const clubMembers = members(ctx.db, clubId);
  const mentioned = parseMentions(message.text, clubMembers).filter((id) => id !== message.user_id);
  if (mentioned.length === 0) return;
  createMentionNotifications(ctx, clubId, mentioned, message);
}

/** A message's book, looked up once for the chat gate when it carries a bookId. */
export function bookFor(db: Db, bookId: string | null): BookRow | undefined {
  return bookId ? bookById(db, bookId) : undefined;
}
