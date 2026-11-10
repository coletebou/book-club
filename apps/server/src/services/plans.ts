import { type ClubPlan, formatBytes } from '@bookclub/shared';
import { type Config } from '../config';
import { type AppContext } from '../context';
import { type Db } from '../db/db';
import { HttpError } from '../lib/errors';

/**
 * A club's plan and what it allows (D208). The host sets each plan's limits (config.ts
 * `CLUB_FREE_*`, `CLUB_PRO_*`), unlimited unless set, so an instance that never sets them works
 * as before. A club is on Club Pro while its `plan` is `pro` and `plan_until` has not passed;
 * then it is back on the free plan's limits, keeping everything it has (a limit only stops what
 * comes next: a new book, a new member).
 */

export type PlanName = 'free' | 'pro';

export interface PlanRow {
  readonly plan: PlanName;
  readonly plan_until: number | null;
}

export interface PlanLimits {
  readonly storageBytes: number | null;
  readonly members: number | null;
}

const GB = 1024 ** 3;

/** The plan in force: Pro until its day, else free. */
export function planOf(club: PlanRow, now = Date.now()): PlanName {
  return club.plan === 'pro' && (club.plan_until === null || club.plan_until > now) ? 'pro' : 'free';
}

export function limitsFor(config: Config, plan: PlanName): PlanLimits {
  const gb = plan === 'pro' ? config.CLUB_PRO_STORAGE_GB : config.CLUB_FREE_STORAGE_GB;
  return {
    storageBytes: gb === undefined ? null : Math.round(gb * GB),
    members: (plan === 'pro' ? config.CLUB_PRO_MEMBERS_MAX : config.CLUB_FREE_MEMBERS_MAX) ?? null,
  };
}

function planRow(db: Db, clubId: string): PlanRow {
  return db.get<PlanRow>('SELECT plan, plan_until FROM clubs WHERE id = ?', [clubId]) ?? { plan: 'free', plan_until: null };
}

/**
 * What a club stores: every file of its books still in the club (each content once, however many
 * editions share it), their covers, and its notes' photos, voice and video; plus what its uploads
 * under way have said they will bring, so two uploads at once cannot pass a limit together. A
 * file two clubs share counts for each: either may keep it alone.
 */
export function clubStorageBytes(db: Db, clubId: string, uploadExpiryHours: number): number {
  const stored = db.get<{ n: number }>(
    `SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE id IN (
       SELECT ef.blob_id FROM edition_files ef JOIN editions e ON e.id = ef.edition_id JOIN books b ON b.id = e.book_id
        WHERE b.club_id = ? AND b.deleted_at IS NULL
       UNION SELECT b.cover_blob_id FROM books b WHERE b.club_id = ? AND b.deleted_at IS NULL AND b.cover_blob_id IS NOT NULL
       UNION SELECT m.original_blob_id FROM comment_media m JOIN books b ON b.id = m.book_id WHERE b.club_id = ? AND b.deleted_at IS NULL AND m.original_blob_id IS NOT NULL
       UNION SELECT m.derived_blob_id FROM comment_media m JOIN books b ON b.id = m.book_id WHERE b.club_id = ? AND b.deleted_at IS NULL AND m.derived_blob_id IS NOT NULL
       UNION SELECT m.poster_blob_id FROM comment_media m JOIN books b ON b.id = m.book_id WHERE b.club_id = ? AND b.deleted_at IS NULL AND m.poster_blob_id IS NOT NULL)`,
    [clubId, clubId, clubId, clubId, clubId],
  );
  // An upload left unfinished past its expiry is gone from the disk: it no longer counts.
  const pending = db.get<{ n: number }>(
    `SELECT COALESCE(SUM(json_extract(f.value, '$.size')), 0) AS n FROM imports i, json_each(i.files_json) f
      WHERE i.club_id = ? AND i.status = 'uploading' AND i.created_at > ?`,
    [clubId, Date.now() - uploadExpiryHours * 3600_000],
  );
  return Number(stored?.n ?? 0) + Number(pending?.n ?? 0);
}

export function clubMemberCount(db: Db, clubId: string): number {
  return Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memberships WHERE club_id = ?', [clubId])?.n ?? 0);
}

/** Where the club's owner takes Club Pro, saying which club (D208); null when the host offers none. */
export function proUrl(config: Config, clubId: string): string | null {
  if (!config.CLUB_PRO_URL) return null;
  const url = new URL(config.CLUB_PRO_URL);
  url.searchParams.set('client_reference_id', clubId);
  return url.toString();
}

const upgradeHint = (ctx: AppContext, plan: PlanName) => (plan === 'free' && ctx.config.CLUB_PRO_URL ? ' Club Pro has room for more: its owner can take it in the club’s settings.' : '');

/** Refuse a new book (or format) the club has no room for (413 `storage_full`), before a byte is sent. */
export function assertRoomToStore(ctx: AppContext, clubId: string, bytes: number): void {
  const plan = planOf(planRow(ctx.db, clubId));
  const max = limitsFor(ctx.config, plan).storageBytes;
  if (max === null) return;
  const used = clubStorageBytes(ctx.db, clubId, ctx.config.UPLOAD_EXPIRY_HOURS);
  if (used + bytes <= max) return;
  throw new HttpError(
    413,
    'storage_full',
    `This club has room for ${formatBytes(Math.max(0, max - used))} more, and this is ${formatBytes(bytes)}. Remove a book you have finished to make room.${upgradeHint(ctx, plan)}`,
  );
}

/** Refuse a new member the club has no room for (409 `club_full`). */
export function assertRoomToJoin(ctx: AppContext, clubId: string): void {
  const plan = planOf(planRow(ctx.db, clubId));
  const max = limitsFor(ctx.config, plan).members;
  if (max === null || clubMemberCount(ctx.db, clubId) < max) return;
  throw new HttpError(409, 'club_full', `This club is full: it has its ${max} members.${upgradeHint(ctx, plan)}`);
}

/** The plan as a club's members see it; the way to Club Pro only for its owners. */
export function planView(ctx: AppContext, clubId: string, owner: boolean): ClubPlan {
  const row = planRow(ctx.db, clubId);
  const plan = planOf(row);
  const limits = limitsFor(ctx.config, plan);
  return {
    name: plan,
    until: plan === 'pro' && row.plan_until !== null ? new Date(row.plan_until).toISOString() : null,
    storage: { usedBytes: clubStorageBytes(ctx.db, clubId, ctx.config.UPLOAD_EXPIRY_HOURS), maxBytes: limits.storageBytes },
    members: { count: clubMemberCount(ctx.db, clubId), max: limits.members },
    proUrl: owner && plan === 'free' ? proUrl(ctx.config, clubId) : null,
  };
}

/** Put a club on a plan (the CLI's `club-plan`): Pro for good, or until a day; free. */
export function setPlan(db: Db, clubId: string, plan: PlanName, until: number | null): boolean {
  return db.exec('UPDATE clubs SET plan = ?, plan_until = ? WHERE id = ? AND deleted_at IS NULL', [plan, plan === 'pro' ? until : null, clubId]).changes > 0;
}

export interface ClubPlanRow {
  readonly id: string;
  readonly name: string;
  readonly plan: PlanName;
  readonly until: number | null;
  readonly members: number;
  readonly storageBytes: number;
}

/** Every club still there, with its plan in force and what it uses (the CLI's `clubs`). */
export function clubPlans(ctx: AppContext): ClubPlanRow[] {
  return ctx.db
    .all<{ id: string; name: string; plan: PlanName; plan_until: number | null }>('SELECT id, name, plan, plan_until FROM clubs WHERE deleted_at IS NULL ORDER BY created_at')
    .map((c) => ({
      id: c.id,
      name: c.name,
      plan: planOf(c),
      until: c.plan_until,
      members: clubMemberCount(ctx.db, c.id),
      storageBytes: clubStorageBytes(ctx.db, c.id, ctx.config.UPLOAD_EXPIRY_HOURS),
    }));
}
