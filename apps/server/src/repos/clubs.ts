import { type ClubSummary, MEMBER_PALETTE, type Member, type Role, memberColor, slotColor } from '@bookclub/shared';
import { type Db } from '../db/db';
import { newId, newToken } from '../lib/crypto';
import { isoRequired } from '../lib/json';

export interface ClubRow {
  id: string;
  name: string;
  description: string;
  created_by: string;
  created_at: number;
  /** Disbanded (D179): kept on the server, gone for everyone in the app. */
  deleted_at?: number | null;
  deleted_by?: string | null;
}

export interface MembershipRow {
  club_id: string;
  user_id: string;
  role: Role;
  joined_at: number;
}

export interface InviteRow {
  code: string;
  club_id: string;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  uses: number;
}

/** A club the app knows: a disbanded one (D179) is not found, here and so everywhere. */
export function clubById(db: Db, id: string): ClubRow | undefined {
  return db.get<ClubRow>('SELECT * FROM clubs WHERE id = ? AND deleted_at IS NULL', [id]);
}

export function membership(db: Db, clubId: string, userId: string): MembershipRow | undefined {
  return db.get<MembershipRow>('SELECT * FROM memberships WHERE club_id = ? AND user_id = ?', [clubId, userId]);
}

export function createClub(db: Db, input: { name: string; description: string; ownerId: string }): ClubRow {
  const id = newId();
  const now = Date.now();
  db.tx(() => {
    db.exec('INSERT INTO clubs (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      input.name,
      input.description,
      input.ownerId,
      now,
    ]);
    db.exec("INSERT INTO memberships (club_id, user_id, role, joined_at, color) VALUES (?, ?, 'owner', ?, 0)", [id, input.ownerId, now]);
    createInvite(db, id, input.ownerId);
  });
  return clubById(db, id)!;
}

export function updateClub(db: Db, id: string, input: { name?: string; description?: string }): void {
  if (input.name !== undefined) db.exec('UPDATE clubs SET name = ? WHERE id = ?', [input.name, id]);
  if (input.description !== undefined) db.exec('UPDATE clubs SET description = ? WHERE id = ?', [input.description, id]);
}

/** The first palette slot no current member holds (after eight, slots are shared in turn). */
export function freeColorSlot(db: Db, clubId: string): number {
  const slots = db.all<{ color: number }>('SELECT color FROM memberships WHERE club_id = ?', [clubId]).map((r) => r.color);
  const taken = new Set(slots);
  for (let slot = 0; slot < MEMBER_PALETTE.length; slot++) if (!taken.has(slot)) return slot;
  return slots.length % MEMBER_PALETTE.length;
}

export function addMember(db: Db, clubId: string, userId: string, role: Role = 'member'): boolean {
  const result = db.exec('INSERT OR IGNORE INTO memberships (club_id, user_id, role, joined_at, color) VALUES (?, ?, ?, ?, ?)', [
    clubId,
    userId,
    role,
    Date.now(),
    freeColorSlot(db, clubId),
  ]);
  return result.changes > 0;
}

/** A member's colour in a club; someone who is no longer a member keeps a colour of their own. */
export function colorInClub(db: Db, clubId: string, userId: string): string {
  const row = db.get<{ color: number }>('SELECT color FROM memberships WHERE club_id = ? AND user_id = ?', [clubId, userId]);
  return row ? slotColor(row.color) : memberColor(userId);
}

export function removeMember(db: Db, clubId: string, userId: string): boolean {
  return db.exec('DELETE FROM memberships WHERE club_id = ? AND user_id = ?', [clubId, userId]).changes > 0;
}

/** Clubs this person owns (D176's cap on starting more). */
export function clubsOwnedBy(db: Db, userId: string): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships m JOIN clubs c ON c.id = m.club_id WHERE m.user_id = ? AND m.role = 'owner' AND c.deleted_at IS NULL", [userId])?.n ?? 0);
}

export function ownerCount(db: Db, clubId: string): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE club_id = ? AND role = 'owner'", [clubId])?.n ?? 0);
}

export function setRole(db: Db, clubId: string, userId: string, role: Role): void {
  db.exec('UPDATE memberships SET role = ? WHERE club_id = ? AND user_id = ?', [role, clubId, userId]);
}

export function clubsForUser(db: Db, userId: string): ClubSummary[] {
  return db
    .all<ClubRow & { role: Role; member_count: number; book_count: number }>(
      `SELECT c.*, m.role,
              (SELECT COUNT(*) FROM memberships WHERE club_id = c.id) AS member_count,
              (SELECT COUNT(*) FROM books WHERE club_id = c.id AND deleted_at IS NULL) AS book_count
         FROM clubs c JOIN memberships m ON m.club_id = c.id
        WHERE m.user_id = ? AND c.deleted_at IS NULL
        ORDER BY c.created_at`,
      [userId],
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      role: r.role,
      memberCount: Number(r.member_count),
      bookCount: Number(r.book_count),
    }));
}

export function members(db: Db, clubId: string): Member[] {
  return db
    .all<{
      user_id: string;
      display_name: string;
      role: Role;
      joined_at: number;
      color: number;
      password_hash: string | null;
      upstream_subject: string | null;
      linked_provider: 'apple' | 'google' | null;
    }>(
      `SELECT m.user_id, u.display_name, m.role, m.joined_at, m.color, u.password_hash, u.upstream_subject,
              (SELECT provider FROM external_identities WHERE user_id = m.user_id ORDER BY created_at LIMIT 1) AS linked_provider
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.club_id = ?
        ORDER BY m.joined_at`,
      [clubId],
    )
    .map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      color: slotColor(r.color),
      role: r.role,
      joinedAt: isoRequired(r.joined_at),
      // How they sign in (D178): a password on file always means `local` (linking Apple or
      // Google by a verified email match clears any password the matched account had, so a
      // password here was only ever added after, by an owner's reset link); failing that, the
      // upstream grant's own subject, then a linked provider, then plain `local`.
      source: r.password_hash !== null ? ('local' as const) : r.upstream_subject ? ('upstream' as const) : r.linked_provider ?? ('local' as const),
    }));
}

export function memberIds(db: Db, clubId: string): string[] {
  return db.all<{ user_id: string }>('SELECT user_id FROM memberships WHERE club_id = ?', [clubId]).map((r) => r.user_id);
}

/* Invites ---------------------------------------------------------------------------------- */

export function createInvite(db: Db, clubId: string, createdBy: string): InviteRow {
  const code = newToken(16);
  db.exec('INSERT INTO invites (code, club_id, created_by, created_at) VALUES (?, ?, ?, ?)', [code, clubId, createdBy, Date.now()]);
  return db.get<InviteRow>('SELECT * FROM invites WHERE code = ?', [code])!;
}

export function activeInvite(db: Db, clubId: string): InviteRow | undefined {
  return db.get<InviteRow>(
    'SELECT * FROM invites WHERE club_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [clubId],
  );
}

/** A live invite: not revoked, and of a club that has not been disbanded (D179), so no path can join one. */
export function inviteByCode(db: Db, code: string): InviteRow | undefined {
  const invite = db.get<InviteRow>(
    'SELECT i.* FROM invites i JOIN clubs c ON c.id = i.club_id WHERE i.code = ? AND c.deleted_at IS NULL',
    [code],
  );
  return invite && invite.revoked_at === null ? invite : undefined;
}

/** Revoke every invite of the club and issue a fresh one. */
export function rotateInvite(db: Db, clubId: string, createdBy: string): InviteRow {
  return db.tx(() => {
    db.exec('UPDATE invites SET revoked_at = ? WHERE club_id = ? AND revoked_at IS NULL', [Date.now(), clubId]);
    return createInvite(db, clubId, createdBy);
  });
}

export function countInviteUse(db: Db, code: string): void {
  db.exec('UPDATE invites SET uses = uses + 1 WHERE code = ?', [code]);
}
