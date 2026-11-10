import { type Db } from '../db/db';
import { newId } from '../lib/crypto';

/** Picking the next book (D214): a club's nomination rounds, its nominations, their votes and Up next. */

export interface RoundRow {
  id: string;
  club_id: string;
  status: 'open' | 'closed';
  opened_by: string;
  opened_by_name: string;
  opened_at: number;
  closed_by: string | null;
  closed_by_name: string | null;
  closed_at: number | null;
  winner_nomination_id: string | null;
}

export interface NominationRow {
  id: string;
  round_id: string;
  club_id: string;
  title: string;
  author: string | null;
  link: string | null;
  pitch: string | null;
  created_by: string;
  created_by_name: string;
  created_at: number;
  updated_at: number;
  votes: number;
  voted_by_me: number;
}

export interface VoterRow {
  user_id: string;
  display_name: string;
}

export interface ClubUpNextRow {
  club_id: string;
  nomination_id: string;
  round_id: string;
  set_at: number;
  title: string;
  author: string | null;
  link: string | null;
  pitch: string | null;
}

const ROUND_SELECT = `SELECT r.*, ou.display_name AS opened_by_name, cu.display_name AS closed_by_name
  FROM nomination_rounds r
  JOIN users ou ON ou.id = r.opened_by
  LEFT JOIN users cu ON cu.id = r.closed_by`;

export function roundById(db: Db, id: string): RoundRow | undefined {
  return db.get<RoundRow>(`${ROUND_SELECT} WHERE r.id = ?`, [id]);
}

export function openRoundFor(db: Db, clubId: string): RoundRow | undefined {
  return db.get<RoundRow>(`${ROUND_SELECT} WHERE r.club_id = ? AND r.status = 'open'`, [clubId]);
}

/** Closed rounds, most recent first: a small history of what the club picked between (D214). */
export function closedRoundsFor(db: Db, clubId: string, limit = 10): RoundRow[] {
  return db.all<RoundRow>(`${ROUND_SELECT} WHERE r.club_id = ? AND r.status = 'closed' ORDER BY r.closed_at DESC LIMIT ?`, [clubId, limit]);
}

/** Opens a round if the club has none open (nominating opens one, D214); otherwise the one it has. */
export function openOrReuseRound(db: Db, clubId: string, userId: string): RoundRow {
  const open = openRoundFor(db, clubId);
  if (open) return open;
  const id = newId();
  db.exec(`INSERT INTO nomination_rounds (id, club_id, status, opened_by, opened_at) VALUES (?, ?, 'open', ?, ?)`, [id, clubId, userId, Date.now()]);
  return roundById(db, id)!;
}

export function closeRound(db: Db, roundId: string, userId: string, winnerNominationId: string | null): void {
  db.exec(`UPDATE nomination_rounds SET status = 'closed', closed_by = ?, closed_at = ?, winner_nomination_id = ? WHERE id = ?`, [
    userId,
    Date.now(),
    winnerNominationId,
    roundId,
  ]);
}

const NOMINATION_SELECT = `SELECT n.*, u.display_name AS created_by_name,
    (SELECT COUNT(*) FROM nomination_votes v WHERE v.nomination_id = n.id) AS votes,
    EXISTS(SELECT 1 FROM nomination_votes v WHERE v.nomination_id = n.id AND v.user_id = ?) AS voted_by_me
  FROM nominations n JOIN users u ON u.id = n.created_by`;

/** Every nomination of a round, oldest first, with its vote count and whether `selfId` voted. */
export function nominationsForRound(db: Db, roundId: string, selfId: string): NominationRow[] {
  return db.all<NominationRow>(`${NOMINATION_SELECT} WHERE n.round_id = ? ORDER BY n.created_at`, [selfId, roundId]);
}

export function nominationById(db: Db, id: string, selfId: string): NominationRow | undefined {
  return db.get<NominationRow>(`${NOMINATION_SELECT} WHERE n.id = ?`, [selfId, id]);
}

export interface BareNomination {
  id: string;
  round_id: string;
  club_id: string;
  created_by: string;
}

/** A nomination with no view needs (access checks, ownership, the round it belongs to). */
export function bareNomination(db: Db, id: string): BareNomination | undefined {
  return db.get<BareNomination>('SELECT id, round_id, club_id, created_by FROM nominations WHERE id = ?', [id]);
}

export function createNomination(
  db: Db,
  input: { roundId: string; clubId: string; title: string; author: string | null; link: string | null; pitch: string | null; createdBy: string },
): string {
  const id = newId();
  const now = Date.now();
  db.exec(
    `INSERT INTO nominations (id, round_id, club_id, title, author, link, pitch, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.roundId, input.clubId, input.title, input.author, input.link, input.pitch, input.createdBy, now, now],
  );
  return id;
}

export function updateNomination(db: Db, id: string, input: { title: string; author: string | null; link: string | null; pitch: string | null }): void {
  db.exec('UPDATE nominations SET title = ?, author = ?, link = ?, pitch = ?, updated_at = ? WHERE id = ?', [input.title, input.author, input.link, input.pitch, Date.now(), id]);
}

/** Withdrawing (the nominator) or removing (the owner): gone outright, its votes with it. */
export function deleteNomination(db: Db, id: string): boolean {
  return db.exec('DELETE FROM nominations WHERE id = ?', [id]).changes > 0;
}

export function votersFor(db: Db, nominationId: string): VoterRow[] {
  return db.all<VoterRow>(
    'SELECT v.user_id, u.display_name FROM nomination_votes v JOIN users u ON u.id = v.user_id WHERE v.nomination_id = ? ORDER BY v.created_at',
    [nominationId],
  );
}

export function setVote(db: Db, nominationId: string, userId: string): void {
  db.exec('INSERT OR IGNORE INTO nomination_votes (nomination_id, user_id, created_at) VALUES (?, ?, ?)', [nominationId, userId, Date.now()]);
}

export function clearVote(db: Db, nominationId: string, userId: string): void {
  db.exec('DELETE FROM nomination_votes WHERE nomination_id = ? AND user_id = ?', [nominationId, userId]);
}

export function upNextFor(db: Db, clubId: string): ClubUpNextRow | undefined {
  return db.get<ClubUpNextRow>(
    `SELECT cun.club_id, cun.nomination_id, cun.round_id, cun.set_at, n.title, n.author, n.link, n.pitch
       FROM club_up_next cun JOIN nominations n ON n.id = cun.nomination_id
      WHERE cun.club_id = ?`,
    [clubId],
  );
}

export function setUpNext(db: Db, clubId: string, nominationId: string, roundId: string): void {
  db.exec(
    `INSERT INTO club_up_next (club_id, nomination_id, round_id, set_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(club_id) DO UPDATE SET nomination_id = excluded.nomination_id, round_id = excluded.round_id, set_at = excluded.set_at`,
    [clubId, nominationId, roundId, Date.now()],
  );
}

export function clearUpNext(db: Db, clubId: string): boolean {
  return db.exec('DELETE FROM club_up_next WHERE club_id = ?', [clubId]).changes > 0;
}
