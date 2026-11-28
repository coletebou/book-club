import type { BlockedMember, ContentReport, ContentReports, CreateReportBody } from '@bookclub/shared';
import type { Db } from '../db/db';
import { newId } from '../lib/crypto';
import { isoRequired } from '../lib/json';

export function blockedMembers(db: Db, viewerId: string): BlockedMember[] {
  return db.all<BlockedMember>(
    `SELECT u.id AS userId, u.display_name AS displayName
     FROM member_blocks b JOIN users u ON u.id = b.blocked_id
     WHERE b.blocker_id = ? ORDER BY u.display_name, u.id`, [viewerId],
  );
}

export function blockedMemberIds(db: Db, viewerId: string): string[] {
  return db.all<{ blocked_id: string }>('SELECT blocked_id FROM member_blocks WHERE blocker_id = ? ORDER BY blocked_id', [viewerId]).map((row) => row.blocked_id);
}

export function blocksMember(db: Db, viewerId: string, authorId: string): boolean {
  return !!db.get('SELECT 1 FROM member_blocks WHERE blocker_id = ? AND blocked_id = ?', [viewerId, authorId]);
}

/** Used only with fixed SQL column names or a bound viewer placeholder. */
export function unblockedAuthor(viewer: string, author: string): string {
  return `NOT EXISTS (SELECT 1 FROM member_blocks block WHERE block.blocker_id = ${viewer} AND block.blocked_id = ${author})`;
}

export function setMemberBlock(db: Db, viewerId: string, targetId: string, blocked: boolean): void {
  if (blocked) db.exec('INSERT OR IGNORE INTO member_blocks (blocker_id, blocked_id) VALUES (?, ?)', [viewerId, targetId]);
  else db.exec('DELETE FROM member_blocks WHERE blocker_id = ? AND blocked_id = ?', [viewerId, targetId]);
}

export function saveContentReport(db: Db, body: CreateReportBody, reporterId: string, target: { clubId: string; bookId: string | null; authorId: string }): void {
  db.exec(
    `INSERT INTO content_reports (id, club_id, book_id, reporter_id, author_id, target_id, kind, reason, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (reporter_id, kind, target_id) DO NOTHING`,
    [newId(), target.clubId, target.bookId, reporterId, target.authorId, body.targetId, body.kind, body.reason, body.details || null, Date.now()],
  );
}

/** Reports carry references and the reporter's reason, never a copy of the reported content. D264. */
export function contentReports(db: Db, clubId: string | null, before?: string): ContentReports {
  const conditions: string[] = [];
  const params: (string | null)[] = [];
  if (clubId) {
    conditions.push('r.club_id = ?');
    params.push(clubId);
  }
  if (before) {
    conditions.push('(r.created_at, r.id) < (SELECT created_at, id FROM content_reports WHERE id = ? AND (? IS NULL OR club_id = ?))');
    params.push(before, clubId, clubId);
  }
  const select = `SELECT r.id, r.club_id AS clubId, r.book_id AS bookId, r.target_id AS targetId, note.parent_id AS parentId, r.kind, r.reason, r.details,
    reporter.display_name AS reporterName, author.display_name AS authorName, r.created_at AS timestamp
    FROM content_reports r JOIN users reporter ON reporter.id = r.reporter_id JOIN users author ON author.id = r.author_id
    LEFT JOIN comments note ON r.kind != 'chat' AND note.id = r.target_id`;
  const rows = db.all<Omit<ContentReport, 'createdAt'> & { timestamp: number }>(
    `${select} ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY r.created_at DESC, r.id DESC LIMIT 51`, params,
  );
  const hasMore = rows.length > 50;
  const reports = rows.slice(0, 50).map(({ timestamp, ...row }) => ({ ...row, createdAt: isoRequired(timestamp) }));
  return { reports, before: hasMore ? reports.at(-1)!.id : null };
}
