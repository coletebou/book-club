import { rm } from 'node:fs/promises';
import path from 'node:path';
import { type AppContext } from '../context';
import { type Db } from '../db/db';
import { type UserRow } from '../repos/users';
import { disbandClub, endClubVoiceFor } from './removal';

/*
 * A person deletes their own account (D229). `deleteAccount` is the whole of it, in one
 * transaction, and the only caller is `POST /api/me/delete`.
 *
 * The `users` row stays, emptied, as "Former member": foreign keys that do not cascade (the clubs,
 * books and invites the person made) and what they wrote in their clubs still name it. What is
 * theirs alone is deleted outright: how they sign in, where they are in each book, their settings
 * and tokens, their private Cal conversations. What they shared with a club (notes, chat messages,
 * books, meet-up questions) stays there, shown as a "Former member".
 */

/** What every remaining reference to a deleted person is shown as. */
export const FORMER_MEMBER = 'Former member';

/**
 * Rows deleted outright: `table`, and the columns of it that name the person. Private to them, or
 * a signal (a reaction, a vote, a read marker, a notification) that means nothing without them.
 * Everything else that references a user stays with the club it was written in, or is cleared
 * below; test/account-deletion.test.ts reads the schema to prove every reference is one or the other.
 */
const ERASED: readonly (readonly [table: string, column: string])[] = [
  ['sessions', 'user_id'],
  ['sign_in_codes', 'user_id'],
  ['app_auth_codes', 'user_id'],
  ['password_resets', 'user_id'],
  ['password_resets', 'created_by'],
  ['external_identities', 'user_id'],
  ['push_tokens', 'user_id'],
  ['calendar_feeds', 'user_id'],
  ['progress', 'user_id'],
  ['edition_progress', 'user_id'],
  ['reading_sessions', 'user_id'],
  ['book_playback', 'user_id'],
  ['book_audio_controls', 'user_id'],
  ['listening_settings', 'user_id'],
  ['audio_controls_default', 'user_id'],
  ['chat_dnd', 'user_id'],
  ['chat_reads', 'user_id'],
  ['cal_settings', 'user_id'],
  // Their conversations with Cal (the messages go with them) and what those cost.
  ['cal_conversations', 'user_id'],
  ['cal_cost_log', 'user_id'],
  ['chat_reactions', 'user_id'],
  ['member_blocks', 'blocker_id'],
  ['content_reports', 'reporter_id'],
  ['meeting_rsvps', 'user_id'],
  ['meetup_question_votes', 'user_id'],
  ['nomination_votes', 'user_id'],
  ['notifications', 'user_id'],
  ['notifications', 'actor_id'],
];

/** Columns that point at the person only as "who asked", and are emptied (the row is not theirs). */
const CLEARED: readonly (readonly [table: string, column: string])[] = [
  ['chat_messages', 'spoiler_user_id'],
  ['agent_deliveries', 'asker_id'],
];

export interface DeletionReport {
  /** Clubs the person owned that went to another member: `club` → the new owner. */
  readonly handedOver: readonly { clubId: string; to: string }[];
  /** Clubs the person was alone in, disbanded through the recoverable path (D179). */
  readonly disbanded: readonly string[];
  /** Clubs they were an ordinary member of, or an owner alongside another owner. */
  readonly left: readonly string[];
}

interface Membership {
  club_id: string;
  role: 'owner' | 'member';
}

/** The longest-standing other member of a club: who joined first, then by id so a tie is never random. */
function nextOwner(db: Db, clubId: string, leaving: string): string | undefined {
  return db.get<{ user_id: string }>('SELECT user_id FROM memberships WHERE club_id = ? AND user_id != ? ORDER BY joined_at, user_id LIMIT 1', [clubId, leaving])?.user_id;
}

/**
 * Delete the account of `user` (not an agent's row, not one already deleted). The caller has
 * proved who is asking (the password, or a typed word for an account with none).
 */
export async function deleteAccount(ctx: AppContext, user: UserRow): Promise<DeletionReport> {
  const db = ctx.db;
  const now = Date.now();
  const handedOver: { clubId: string; to: string }[] = [];
  const sole: string[] = [];
  const left: string[] = [];
  // In-flight uploads: their files are removed after the rows that name them are gone.
  const partial = db.all<{ id: string }>("SELECT u.id FROM uploads u JOIN imports i ON i.id = u.import_id WHERE i.user_id = ? AND i.status = 'uploading'", [user.id]).map((r) => r.id);

  const clubs = db.all<Membership>('SELECT m.club_id, m.role FROM memberships m JOIN clubs c ON c.id = m.club_id WHERE m.user_id = ? AND c.deleted_at IS NULL', [user.id]);
  // Voice first, while the hub still knows the rooms: a deleted person must not stay in a call.
  for (const { club_id } of clubs) endClubVoiceFor(ctx, club_id, user.id);

  db.tx(() => {
    for (const { club_id, role } of clubs) {
      if (role === 'owner' && db.get('SELECT 1 AS x FROM memberships WHERE club_id = ? AND user_id != ? AND role = ?', [club_id, user.id, 'owner']) === undefined) {
        const heir = nextOwner(db, club_id, user.id);
        if (heir) {
          db.exec("UPDATE memberships SET role = 'owner' WHERE club_id = ? AND user_id = ?", [club_id, heir]);
          handedOver.push({ clubId: club_id, to: heir });
        } else {
          sole.push(club_id);
        }
      } else {
        left.push(club_id);
      }
    }
    // Only the clubs they were alone in keep the membership row: the club is disbanded below and an
    // operator who undeletes it finds its one member, not an empty club. Everywhere else they leave.
    db.exec(`DELETE FROM memberships WHERE user_id = ? AND club_id NOT IN (SELECT value FROM json_each(?))`, [user.id, JSON.stringify(sole)]);
    // Imports still uploading go (their files below); a finished import is a book the club has.
    db.exec("DELETE FROM imports WHERE user_id = ? AND status = 'uploading'", [user.id]);
    for (const [table, column] of ERASED) db.exec(`DELETE FROM ${table} WHERE ${column} = ?`, [user.id]);
    for (const [table, column] of CLEARED) db.exec(`UPDATE ${table} SET ${column} = NULL WHERE ${column} = ?`, [user.id]);
    // The merge record keeps who went into whom and when, and loses what it archived (migration 032).
    db.exec(`UPDATE account_merges SET archive_json = '{"erased":true}', reason = 'erased' WHERE loser_id = ? OR survivor_id = ?`, [user.id, user.id]);
    db.exec(
      `UPDATE users SET display_name = ?, email = NULL, password_hash = NULL, upstream_subject = NULL, disabled_at = COALESCE(disabled_at, ?), deleted_at = ? WHERE id = ?`,
      [FORMER_MEMBER, now, now, user.id],
    );
  });

  // Told after the commit: their sockets close, and each club they left hears that its members changed.
  ctx.hub.disconnectUser(user.id);
  ctx.hub.revalidate();
  for (const { club_id } of clubs) ctx.hub.revoke(club_id, user.id);
  // A sole member's club is soft-disbanded (D179): the operator can bring it back or purge it.
  for (const clubId of sole) disbandClub(ctx, clubId, user.id);
  for (const id of partial) {
    await rm(path.join(ctx.storage.uploadsDir, id), { force: true });
    await rm(path.join(ctx.storage.uploadsDir, `${id}.json`), { force: true });
  }
  ctx.log.info({ user: user.id, handedOver: handedOver.length, disbanded: sole.length, left: left.length }, 'account deleted');
  return { handedOver, disbanded: sole, left };
}
