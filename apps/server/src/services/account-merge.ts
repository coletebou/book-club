import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type Span, rangesCoverage, rangesFinished, rangesFurthest, unionRanges } from '@bookclub/shared';
import { type Db, type Row } from '../db/db';
import { newId } from '../lib/crypto';
import { fromJson, toJson } from '../lib/json';
import { type UserRow, userById } from '../repos/users';

/*
 * One person, one account (D228): fold the second account a person ended up with (the "loser")
 * into the one they keep (the "survivor"). `bookclub merge-accounts` is its only caller.
 *
 * - One transaction. Every table that references a user has a rule below, and the merge refuses
 *   before it writes anything if the schema holds a reference with no rule (a table added since).
 *   After the rules: `PRAGMA foreign_key_check` must be empty, and no text anywhere in the database
 *   may still hold the loser's id outside its own `users` row and the audit table. Anything else
 *   rolls the whole merge back.
 * - Soft, and nothing is lost. The loser's `users` row stays, disabled, with `merged_into` naming
 *   the survivor, so a sign-in that still finds it is led on (`followMerge`, repos/users.ts). Every
 *   row the merge drops instead of moving, every value it overwrites and the key of every row it
 *   moves is written, whole, into the `account_merges` record in the same transaction.
 * - A plan is the merge itself, run and rolled back: what a dry run prints is what applying does.
 * - Applying needs a snapshot of the database first (`snapshotBeforeMerge`), taken the way the
 *   backups take theirs.
 */

/** Refused: nothing was written. The message is for the operator. */
export class MergeRefused extends Error {}

export interface MergeAccount {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly createdAt: number;
  readonly disabled: boolean;
  /** The account this one was merged into, if it was. */
  readonly mergedInto: string | null;
  /** How it signs in: `password`, `upstream`, and each provider linked (`apple`, `google`). */
  readonly signsInWith: readonly string[];
  /** The clubs it is in, with its role in each. */
  readonly clubs: readonly { readonly id: string; readonly name: string; readonly role: string }[];
}

/** Per table, how many rows the merge moved, dropped, merged into the survivor's or changed. */
export type MergeCounts = Record<string, Record<string, number>>;

export interface MergeReport {
  /** `planned`: a dry run, rolled back. `merged`: applied. `already`: applied before, nothing done now. */
  readonly status: 'planned' | 'merged' | 'already';
  readonly mergeId: string | null;
  readonly mergedAt: number | null;
  readonly reason: string;
  readonly loser: MergeAccount;
  readonly survivor: MergeAccount;
  /** The survivor as the merge leaves it. */
  readonly survivorAfter: MergeAccount;
  readonly counts: MergeCounts;
  /** What the operator should know before applying. */
  readonly notes: readonly string[];
  /** The snapshot taken before an applied merge. */
  readonly snapshot: string | null;
}

export interface MergeOptions {
  readonly db: Db;
  /** The database's file: what the snapshot is taken of. */
  readonly dbFile: string;
  readonly loserId: string;
  readonly survivorId: string;
  readonly reason: string;
  /** False (the default): plan only, nothing is written. */
  readonly apply?: boolean;
  /** Where the snapshot goes. Needed to apply. */
  readonly backupDir?: string;
  readonly now?: number;
}

const REASON_MAX = 500;

function account(db: Db, row: UserRow): MergeAccount {
  const providers = db.all<{ provider: string }>('SELECT DISTINCT provider FROM external_identities WHERE user_id = ? ORDER BY provider', [row.id]).map((r) => r.provider);
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    createdAt: row.created_at,
    disabled: row.disabled_at !== null,
    mergedInto: row.merged_into,
    signsInWith: [...(row.password_hash !== null ? ['password'] : []), ...(row.upstream_subject !== null ? ['upstream'] : []), ...providers],
    clubs: db.all<{ id: string; name: string; role: string }>(
      'SELECT c.id, c.name, m.role FROM memberships m JOIN clubs c ON c.id = m.club_id WHERE m.user_id = ? ORDER BY m.joined_at, c.name, c.id',
      [row.id],
    ),
  };
}

/** Every account, oldest first (never an agent's row): how the admin finds the two ids to merge. */
export function listAccounts(db: Db): MergeAccount[] {
  return db.all<UserRow>('SELECT * FROM users WHERE agent IS NULL ORDER BY created_at, id').map((row) => account(db, row));
}

/** An account as `bookclub accounts` prints it: tab-separated, the id first. */
export function formatAccount(a: MergeAccount): string {
  const state = a.mergedInto !== null ? `merged into ${a.mergedInto}` : a.disabled ? 'disabled' : '';
  return [a.id, a.displayName, a.email ?? '-', a.signsInWith.join('+') || '-', new Date(a.createdAt).toISOString().slice(0, 10), a.clubs.map((c) => `${c.name} (${c.role})`).join(', ') || '-', state]
    .join('\t')
    .trimEnd();
}

/** The two accounts, or the record of this same merge already made, or a refusal. */
function mergeable(db: Db, loserId: string, survivorId: string): { loser: UserRow; survivor: UserRow } | { already: { id: string; merged_at: number; reason: string }; loser: UserRow; survivor: UserRow } {
  if (loserId === survivorId) throw new MergeRefused('--from and --into name the same account: there is nothing to merge');
  const loser = userById(db, loserId);
  if (!loser) throw new MergeRefused(`no account ${loserId} (--from)`);
  const survivor = userById(db, survivorId);
  if (!survivor) throw new MergeRefused(`no account ${survivorId} (--into)`);
  if (loser.agent !== null) throw new MergeRefused(`${loserId} (--from) is an agent's row (${loser.agent}), not an account`);
  if (survivor.agent !== null) throw new MergeRefused(`${survivorId} (--into) is an agent's row (${survivor.agent}), not an account`);
  if (loser.merged_into !== null) {
    // The same merge, asked for again: said so, and nothing is done. Looked for in the record, not
    // only on the row, whose `merged_into` moves on if the survivor is itself merged later.
    const record = db.get<{ id: string; merged_at: number; reason: string }>(
      'SELECT id, merged_at, reason FROM account_merges WHERE loser_id = ? AND survivor_id = ? ORDER BY merged_at DESC LIMIT 1',
      [loserId, survivorId],
    );
    if (record) return { already: record, loser, survivor };
    throw new MergeRefused(`${loserId} (--from) was already merged into another account, ${loser.merged_into}`);
  }
  if (survivor.merged_into !== null) throw new MergeRefused(`${survivorId} (--into) was itself merged into ${survivor.merged_into}: merge into that account instead`);
  if (survivor.disabled_at !== null) throw new MergeRefused(`${survivorId} (--into) is disabled: nobody could sign in to the merged account`);
  return { loser, survivor };
}

/** A column's name as SQL takes it. Every name here comes from this file or from the schema itself. */
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** One merge under way: the two ids, and what it has done so far. */
class Merge {
  readonly counts: MergeCounts = {};
  /** Rows deleted (the loser's, unless said otherwise), whole. */
  readonly dropped: Record<string, Row[]> = {};
  /** Rows of the survivor's as they were before the merge changed them. */
  readonly before: Record<string, Row[]> = {};
  /** `table.column` → the keys of the rows re-pointed from the loser to the survivor. */
  readonly moved: Record<string, Row[]> = {};
  /** Values cleared on rows that moved (replay keys), with the rows' ids. */
  readonly cleared: Record<string, Row[]> = {};

  constructor(
    readonly db: Db,
    readonly loser: string,
    readonly survivor: string,
    readonly now: number,
  ) {}

  count(table: string, what: string, n: number): void {
    if (n <= 0) return;
    const entry = (this.counts[table] ??= {});
    entry[what] = (entry[what] ?? 0) + n;
  }

  private push(into: Record<string, Row[]>, key: string, rows: readonly Row[]): void {
    if (rows.length > 0) (into[key] ??= []).push(...rows);
  }

  /** The columns that name a row of `table`: its primary key, or every column when it has none. */
  private keyColumns(table: string): string[] {
    const columns = this.db.all<{ name: string; pk: number }>(`PRAGMA table_info(${q(table)})`);
    const pk = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    return (pk.length > 0 ? pk : columns).map((c) => c.name);
  }

  /** Re-point every row of `table` whose `column` is the loser to the survivor; their keys are recorded. */
  move(table: string, column: string): number {
    const keys = this.db.all(`SELECT ${this.keyColumns(table).map(q).join(', ')} FROM ${q(table)} WHERE ${q(column)} = ?`, [this.loser]);
    if (keys.length === 0) return 0;
    this.db.exec(`UPDATE ${q(table)} SET ${q(column)} = ? WHERE ${q(column)} = ?`, [this.survivor, this.loser]);
    this.push(this.moved, `${table}.${column}`, keys);
    this.count(table, 'moved', keys.length);
    return keys.length;
  }

  /** Delete the rows that match, keeping each whole in the record. */
  drop(table: string, where: string, params: string[], what = 'dropped'): number {
    const rows = this.db.all(`SELECT * FROM ${q(table)} WHERE ${where}`, params);
    if (rows.length === 0) return 0;
    this.db.exec(`DELETE FROM ${q(table)} WHERE ${where}`, params);
    this.push(this.dropped, table, rows);
    this.count(table, what, rows.length);
    return rows.length;
  }

  /** Keep a survivor's row as it was before it is changed or replaced. */
  keepBefore(table: string, row: Row): void {
    this.push(this.before, table, [row]);
  }

  clearedOn(table: string, rows: readonly Row[]): void {
    this.push(this.cleared, table, rows);
  }

  /**
   * A table with one row per person and `keys` (a setting, a vote, a reaction, a read marker).
   * Where only the loser has the row it moves. Where both have it, one is kept: the survivor's,
   * or with `laterBy` whichever is later by that column (a tie is the survivor's). The other is
   * dropped, whole, into the record.
   */
  oneRowEach(table: string, column: string, keys: readonly string[], laterBy?: string): void {
    const same = keys.map((k) => `${q(k)} = ?`).join(' AND ');
    for (const mine of this.db.all(`SELECT * FROM ${q(table)} WHERE ${q(column)} = ?`, [this.loser])) {
      const at = keys.map((k) => mine[k] as string);
      const theirs = this.db.get(`SELECT * FROM ${q(table)} WHERE ${q(column)} = ?${same ? ` AND ${same}` : ''}`, [this.survivor, ...at]);
      if (!theirs) continue;
      const where = `${q(column)} = ?${same ? ` AND ${same}` : ''}`;
      if (laterBy && Number(mine[laterBy]) > Number(theirs[laterBy])) {
        // The loser's is the later one: the survivor's makes way, and the loser's moves below.
        this.keepBefore(table, theirs);
        this.db.exec(`DELETE FROM ${q(table)} WHERE ${where}`, [this.survivor, ...at]);
        this.count(table, 'replaced', 1);
      } else {
        this.push(this.dropped, table, [mine]);
        this.db.exec(`DELETE FROM ${q(table)} WHERE ${where}`, [this.loser, ...at]);
        this.count(table, 'dropped', 1);
      }
    }
    this.move(table, column);
  }
}

const spans = (json: unknown): Span[] => fromJson<Span[]>(json, []);

/**
 * The union of two lists of spans in an edition's own measure (characters, pages, milliseconds),
 * which is not the book's [0, 1] timeline: sorted and merged where they touch, never clamped and
 * never joined across a gap, so it claims exactly what the two lists did and no more.
 */
function unionMeasured(a: readonly Span[], b: readonly Span[]): Span[] {
  const sorted = [...a, ...b].filter(([from, to]) => Number.isFinite(from) && Number.isFinite(to) && to > from).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

interface ProgressShape {
  book_id: string;
  edition_id: string | null;
  locator_json: string | null;
  t: number;
  label: string;
  client_at: number;
  read_ranges_json: string;
  unplaced_ranges_json: string;
  furthest: number;
  finished_at: number | null;
  updated_at: number;
}

/**
 * Where the person is in each book. One person read both: what is read is the union of the two
 * (the spoiler gate reads it, and it may open what either account had opened, never less), the
 * place kept is the one of whichever account had read furthest (a tie: the later report), and the
 * book was finished when the first of them finished it.
 */
function mergeProgress(m: Merge): void {
  for (const mine of m.db.all<ProgressShape & Row>('SELECT * FROM progress WHERE user_id = ?', [m.loser])) {
    const theirs = m.db.get<ProgressShape & Row>('SELECT * FROM progress WHERE user_id = ? AND book_id = ?', [m.survivor, mine.book_id]);
    if (!theirs) continue;
    const read = unionRanges(spans(theirs.read_ranges_json), spans(mine.read_ranges_json));
    const unplaced = unionRanges(spans(theirs.unplaced_ranges_json), spans(mine.unplaced_ranges_json));
    const place = mine.furthest > theirs.furthest || (mine.furthest === theirs.furthest && mine.updated_at > theirs.updated_at) ? mine : theirs;
    const finished = [theirs.finished_at, mine.finished_at].filter((at): at is number => at !== null);
    const finishedAt = finished.length > 0 ? Math.min(...finished) : rangesFinished(read) ? m.now : null;
    m.keepBefore('progress', theirs);
    m.db.exec(
      `UPDATE progress SET edition_id = ?, locator_json = ?, t = ?, label = ?, client_at = ?, read_ranges_json = ?, unplaced_ranges_json = ?,
         furthest = ?, coverage = ?, finished_at = ?, updated_at = ? WHERE user_id = ? AND book_id = ?`,
      [
        place.edition_id,
        place.locator_json,
        place.t,
        place.label,
        place.client_at,
        toJson(read),
        toJson(unplaced),
        rangesFurthest(read),
        rangesCoverage(read),
        finishedAt,
        Math.max(theirs.updated_at, mine.updated_at),
        m.survivor,
        mine.book_id,
      ],
    );
    m.count('progress', 'merged', 1);
    m.drop('progress', 'user_id = ? AND book_id = ?', [m.loser, mine.book_id], 'folded in');
  }
  m.move('progress', 'user_id');
}

/** What was read in each edition, in its own measure: the union, as for the book's own ranges. */
function mergeEditionProgress(m: Merge): void {
  type Shape = { book_id: string; edition_id: string; read_ranges_json: string; updated_at: number } & Row;
  for (const mine of m.db.all<Shape>('SELECT * FROM edition_progress WHERE user_id = ?', [m.loser])) {
    const at = [mine.book_id, mine.edition_id];
    const theirs = m.db.get<Shape>('SELECT * FROM edition_progress WHERE user_id = ? AND book_id = ? AND edition_id = ?', [m.survivor, ...at]);
    if (!theirs) continue;
    m.keepBefore('edition_progress', theirs);
    m.db.exec('UPDATE edition_progress SET read_ranges_json = ?, updated_at = ? WHERE user_id = ? AND book_id = ? AND edition_id = ?', [
      toJson(unionMeasured(spans(theirs.read_ranges_json), spans(mine.read_ranges_json))),
      Math.max(theirs.updated_at, mine.updated_at),
      m.survivor,
      ...at,
    ]);
    m.count('edition_progress', 'merged', 1);
    m.drop('edition_progress', 'user_id = ? AND book_id = ? AND edition_id = ?', [m.loser, ...at], 'folded in');
  }
  m.move('edition_progress', 'user_id');
}

/** One membership per club: the higher role, the earlier joining, the survivor's colour. */
function mergeMemberships(m: Merge): void {
  type Shape = { club_id: string; role: string; joined_at: number } & Row;
  for (const mine of m.db.all<Shape>('SELECT * FROM memberships WHERE user_id = ?', [m.loser])) {
    const theirs = m.db.get<Shape>('SELECT * FROM memberships WHERE user_id = ? AND club_id = ?', [m.survivor, mine.club_id]);
    if (!theirs) continue;
    const role = mine.role === 'owner' || theirs.role === 'owner' ? 'owner' : 'member';
    const joinedAt = Math.min(mine.joined_at, theirs.joined_at);
    if (role !== theirs.role || joinedAt !== theirs.joined_at) {
      m.keepBefore('memberships', theirs);
      m.db.exec('UPDATE memberships SET role = ?, joined_at = ? WHERE user_id = ? AND club_id = ?', [role, joinedAt, m.survivor, mine.club_id]);
      m.count('memberships', 'merged', 1);
    }
    m.drop('memberships', 'user_id = ? AND club_id = ?', [m.loser, mine.club_id], 'folded in');
  }
  m.move('memberships', 'user_id');
}

/**
 * Rows that carry a replay key (`client_id`, unique per person: an offline device sending the same
 * note twice makes one). Where the loser's key is one the survivor has used too, the loser's row
 * keeps its words and loses the key, so both rows stand.
 */
function moveWithReplayKeys(m: Merge, table: string): void {
  const clashes = m.db.all(
    `SELECT id, client_id FROM ${q(table)} WHERE user_id = ? AND client_id IS NOT NULL
       AND client_id IN (SELECT client_id FROM ${q(table)} WHERE user_id = ? AND client_id IS NOT NULL)`,
    [m.loser, m.survivor],
  );
  for (const row of clashes) m.db.exec(`UPDATE ${q(table)} SET client_id = NULL WHERE id = ?`, [row.id as string]);
  m.clearedOn(`${table}.client_id`, clashes);
  m.count(table, 'replay keys cleared', clashes.length);
  m.move(table, 'user_id');
}

/**
 * Notifications name two people: whom they are for and who caused them. Each of the loser's is
 * re-pointed, unless that would tell the person about themselves, or repeat one the survivor
 * already has (the two partial unique indexes of migrations 004 and 022): those are dropped.
 */
function mergeNotifications(m: Merge): void {
  type Shape = { id: string; user_id: string; actor_id: string; kind: string; book_id: string | null; chapter_index: number | null; chat_message_id: string | null; read_at: number | null } & Row;
  const mine = m.db.all<Shape>('SELECT * FROM notifications WHERE user_id = ? OR actor_id = ? ORDER BY created_at, id', [m.loser, m.loser]);
  const repointed: Row[] = [];
  for (const n of mine) {
    const user = n.user_id === m.loser ? m.survivor : n.user_id;
    const actor = n.actor_id === m.loser ? m.survivor : n.actor_id;
    let repeat = false;
    if (user !== actor && n.kind === 'mention') {
      repeat = m.db.get("SELECT 1 AS x FROM notifications WHERE id != ? AND kind = 'mention' AND user_id = ? AND chat_message_id = ?", [n.id, user, n.chat_message_id]) !== undefined;
    } else if (user !== actor && n.kind === 'reached' && n.read_at === null) {
      repeat =
        m.db.get("SELECT 1 AS x FROM notifications WHERE id != ? AND kind = 'reached' AND read_at IS NULL AND user_id = ? AND actor_id = ? AND book_id = ? AND chapter_index = ?", [
          n.id,
          user,
          actor,
          n.book_id,
          n.chapter_index,
        ]) !== undefined;
    }
    if (user === actor || repeat) {
      m.drop('notifications', 'id = ?', [n.id], user === actor ? 'dropped (about themselves)' : 'dropped (a repeat)');
      continue;
    }
    m.db.exec('UPDATE notifications SET user_id = ?, actor_id = ? WHERE id = ?', [user, actor, n.id]);
    repointed.push({ id: n.id, user_id: n.user_id, actor_id: n.actor_id });
  }
  if (repointed.length > 0) {
    (m.moved['notifications.user_id+actor_id'] ??= []).push(...repointed);
    m.count('notifications', 'moved', repointed.length);
  }
}

/**
 * What signs the loser in is never carried across: its sessions, its one-time codes and the reset
 * links made for it end here (kept in the record), and the person signs in again as the survivor.
 * A reset link the loser made for the survivor goes too: after the merge it would read as one the
 * account made for itself, which the reset route trusts without its club check.
 */
function dropCredentials(m: Merge): void {
  m.drop('sessions', 'user_id = ?', [m.loser]);
  m.drop('sign_in_codes', 'user_id = ?', [m.loser]);
  m.drop('app_auth_codes', 'user_id = ?', [m.loser]);
  m.drop('password_resets', 'user_id = ?', [m.loser]);
  m.drop('password_resets', 'created_by = ? AND user_id = ?', [m.loser, m.survivor]);
  m.move('password_resets', 'created_by');
}

/**
 * The two `users` rows. The survivor takes the loser's upstream identity and address only where
 * it has none of its own (both columns are unique: the loser's is cleared first). Otherwise they
 * stay on the loser's row, where a sign-in that finds them is led on to the survivor. The loser's
 * row is then disabled and says where it went; accounts merged into the loser earlier are
 * re-pointed, so a trail is one hop long.
 */
function mergeUsers(m: Merge, loser: UserRow, survivor: UserRow): void {
  if (loser.upstream_subject !== null && survivor.upstream_subject === null) {
    m.db.exec('UPDATE users SET upstream_subject = NULL WHERE id = ?', [m.loser]);
    m.db.exec('UPDATE users SET upstream_subject = ? WHERE id = ?', [loser.upstream_subject, m.survivor]);
    m.count('users', 'upstream identity taken over', 1);
  }
  if (loser.email !== null && survivor.email === null) {
    m.db.exec('UPDATE users SET email = NULL WHERE id = ?', [m.loser]);
    m.db.exec('UPDATE users SET email = ? WHERE id = ?', [loser.email, m.survivor]);
    m.count('users', 'address taken over', 1);
  }
  m.db.exec('UPDATE users SET disabled_at = COALESCE(disabled_at, ?), merged_into = ? WHERE id = ?', [m.now, m.survivor, m.loser]);
  m.count('users', 'merged away', 1);
  const earlier = m.db.all('SELECT id FROM users WHERE merged_into = ? AND id != ?', [m.loser, m.loser]);
  if (earlier.length > 0) {
    m.db.exec('UPDATE users SET merged_into = ? WHERE merged_into = ? AND id != ?', [m.survivor, m.loser, m.loser]);
    (m.moved['users.merged_into'] ??= []).push(...earlier);
    m.count('users', 'earlier merges re-pointed', earlier.length);
  }
}

interface Rule {
  /** Every `table.column` that references a user and that this rule takes care of. */
  readonly covers: readonly string[];
  run(m: Merge, loser: UserRow, survivor: UserRow): void;
}

const moves = (...columns: string[]): Rule => ({
  covers: columns,
  run: (m) => {
    for (const column of columns) m.move(...(column.split('.') as [string, string]));
  },
});

const oneRowEach = (table: string, keys: readonly string[], laterBy?: string): Rule => ({ covers: [`${table}.user_id`], run: (m) => m.oneRowEach(table, 'user_id', keys, laterBy) });

/**
 * The rule for every reference to a user in the schema, in the order they run. A reference with no
 * rule here stops the merge before it starts (`unruled`), so a table added later cannot be merged
 * by accident: whoever adds it decides what a merge does with it.
 */
const RULES: readonly Rule[] = [
  // Reading: the furthest place, the union of what was read; every sitting kept.
  { covers: ['progress.user_id'], run: mergeProgress },
  { covers: ['edition_progress.user_id'], run: mergeEditionProgress },
  moves('reading_sessions.user_id'),
  // Listening and other settings: the survivor's own, the loser's where the survivor has none.
  oneRowEach('book_playback', ['book_id']),
  oneRowEach('book_audio_controls', ['book_id']),
  oneRowEach('listening_settings', []),
  oneRowEach('audio_controls_default', []),
  oneRowEach('chat_dnd', []),
  oneRowEach('cal_settings', []),
  oneRowEach('calendar_feeds', []),
  { covers: ['memberships.user_id'], run: mergeMemberships },
  // Notes and chat: everything written moves.
  { covers: ['comments.user_id'], run: (m) => moveWithReplayKeys(m, 'comments') },
  { covers: ['chat_messages.user_id'], run: (m) => moveWithReplayKeys(m, 'chat_messages') },
  moves('comment_media.user_id', 'chat_messages.spoiler_user_id', 'chat_attachments.user_id'),
  // One reaction, one vote: a repeat is dropped. A read marker or an answer: the later one.
  oneRowEach('chat_reactions', ['message_id', 'emoji']),
  oneRowEach('chat_reads', ['club_id'], 'last_read_at'),
  oneRowEach('meeting_rsvps', ['book_id'], 'answered_at'),
  oneRowEach('meetup_question_votes', ['question_id']),
  oneRowEach('nomination_votes', ['nomination_id']),
  { covers: ['notifications.user_id', 'notifications.actor_id'], run: mergeNotifications },
  // What the person made, set or asked: re-pointed. `deleted_by` is a user id with no foreign key.
  moves(
    'meeting_points.set_by',
    'meetup_questions.author_id',
    'meetup_questions.asked_by',
    'meetup_question_asks.user_id',
    'nominations.created_by',
    'nomination_rounds.opened_by',
    'nomination_rounds.closed_by',
    'clubs.created_by',
    'clubs.deleted_by',
    'books.created_by',
    'books.deleted_by',
    'editions.created_by',
    'invites.created_by',
    'series.created_by',
    'imports.user_id',
    'uploads.user_id',
    'cal_conversations.user_id',
    'cal_shelf_items.user_id',
    'cal_cost_log.user_id',
    'agent_deliveries.asker_id',
  ),
  // How the person is known: the providers' identities and the phone's push tokens move.
  moves('external_identities.user_id', 'push_tokens.user_id'),
  { covers: ['sessions.user_id', 'sign_in_codes.user_id', 'app_auth_codes.user_id', 'password_resets.user_id', 'password_resets.created_by'], run: dropCredentials },
  { covers: ['users.merged_into'], run: mergeUsers },
];

const tablesOf = (db: Db) => db.all<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");

/** Every `table.column` the schema declares as a reference to `users` that no rule covers. */
export function unruled(db: Db): string[] {
  const covered = new Set(RULES.flatMap((r) => r.covers));
  const missing: string[] = [];
  for (const { name } of tablesOf(db)) {
    for (const fk of db.all<{ table: string; from: string }>(`PRAGMA foreign_key_list(${q(name)})`)) {
      if (fk.table === 'users' && !covered.has(`${name}.${fk.from}`)) missing.push(`${name}.${fk.from}`);
    }
  }
  return missing;
}

/**
 * Where the loser's id still stands after the rules have run, in any text of any table (a foreign
 * key or not, alone or inside JSON), as `table.column (n)`. Two places may keep it: the record of
 * merges, and the `id` of the loser's own `users` row (no other row may point at it any more).
 * Empty when the merge is whole.
 */
export function leftovers(db: Db, loserId: string): string[] {
  const found: string[] = [];
  for (const { name, sql } of tablesOf(db)) {
    if (name === 'account_merges') continue;
    // A full-text index is a second copy of text its own table holds, read through that table.
    if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql ?? '')) continue;
    for (const column of db.all<{ name: string }>(`PRAGMA table_info(${q(name)})`)) {
      const own = name === 'users' && column.name === 'id';
      const n = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${q(name)} WHERE typeof(${q(column.name)}) = 'text' AND instr(${q(column.name)}, ?) > 0${own ? ' AND id != ?' : ''}`,
        own ? [loserId, loserId] : [loserId],
      )!.n;
      if (n > 0) found.push(`${name}.${column.name} (${n})`);
    }
  }
  return found;
}

/** `20261028T000000Z`, as the backup set names its snapshots (cli/backup-set.ts). */
function utcTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * A snapshot of the whole database before a merge writes to it, made the way the backups make
 * theirs (cli/backup.ts): `VACUUM INTO` from a read-only connection, safe while the server runs,
 * then `PRAGMA integrity_check` on the copy. Readable by this user alone (0600): it holds every
 * account. Throws, leaving no file, if any of that fails.
 */
export async function snapshotBeforeMerge(dbFile: string, backupDir: string, now = Date.now()): Promise<{ file: string; bytes: number }> {
  await stat(dbFile);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  let file = path.join(path.resolve(backupDir), `pre-merge-${utcTimestamp(now)}.db`);
  for (let n = 2; existsSync(file); n++) file = path.join(path.resolve(backupDir), `pre-merge-${utcTimestamp(now)}-${n}.db`);
  const umask = process.umask(0o077);
  try {
    const source = new DatabaseSync(dbFile, { readOnly: true });
    try {
      source.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    } finally {
      source.close();
    }
    await chmod(file, 0o600);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error(`the snapshot failed integrity_check: ${check.integrity_check}`);
    } finally {
      copy.close();
    }
    return { file, bytes: (await stat(file)).size };
  } catch (err) {
    await rm(file, { force: true });
    throw err;
  } finally {
    process.umask(umask);
  }
}

/** A plan's way out of its transaction: thrown so that `db.tx` rolls everything back. */
class Planned extends Error {
  constructor(readonly report: MergeReport) {
    super('planned');
  }
}

function notesFor(db: Db, loser: UserRow, survivor: UserRow, after: UserRow, loserAfter: UserRow, sessions: number): string[] {
  const notes: string[] = [];
  if (loser.password_hash !== null) notes.push('The merged account’s own password stops working: a password proves nothing about the account it is merged into.');
  if (loser.upstream_subject !== null && survivor.upstream_subject !== null) {
    notes.push('Both accounts have an upstream identity. The merged account’s stays on its row and signs in as the kept account; the kept account’s name and address go on following its own.');
  }
  if (loserAfter.email !== null) {
    const proven =
      loser.password_hash === null ||
      loser.upstream_subject !== null ||
      db.get('SELECT 1 AS x FROM external_identities WHERE user_id = ? AND email = ? COLLATE NOCASE', [after.id, loserAfter.email]) !== undefined;
    notes.push(
      `The merged account’s address (${loserAfter.email}) stays on its row: a sign-in whose provider proves that address signs in as the kept account.` +
        (proven ? '' : ' It was typed at sign-up and no provider has verified it: merge only if you know it is this person’s.'),
    );
  }
  if (after.password_hash === null && after.upstream_subject === null && !db.get('SELECT 1 AS x FROM external_identities WHERE user_id = ?', [after.id])) {
    notes.push('The kept account has no password and no identity of its own: nobody can sign in to it until a provider proves an address of either account, or it is given a password (bookclub reset-link, for an account with an address).');
  }
  if (loser.disabled_at !== null) notes.push('The merged account was already disabled.');
  if (loser.upstream_subject !== null && survivor.upstream_subject === null) {
    notes.push('The kept account takes the merged account’s upstream identity: from its next sign-in through the upstream its name follows the upstream’s, and is no longer changed here.');
  }
  if (sessions > 0) {
    notes.push(
      `${sessions} session(s) of the merged account end at once. The running server closes a live connection of theirs at its next heartbeat (within about 20 seconds); a voice call they are in goes on until they leave it or the app restarts.`,
    );
  }
  return notes;
}

/** Everything the merge does, inside the caller's transaction. */
function run(options: MergeOptions, now: number, snapshot: string | null): MergeReport {
  const { db, loserId, survivorId } = options;
  const reason = options.reason.trim();
  const found = mergeable(db, loserId, survivorId);
  if ('already' in found) throw new MergeRefused(`${loserId} was merged into ${survivorId} while this merge was being prepared`);
  const { loser, survivor } = found;
  const missing = unruled(db);
  if (missing.length > 0) {
    throw new MergeRefused(`no merge rule for ${missing.join(', ')}: a reference to a user that this command does not know how to merge. Nothing was written.`);
  }
  const before = { loser: account(db, loser), survivor: account(db, survivor) };
  const m = new Merge(db, loserId, survivorId, now);
  for (const rule of RULES) rule.run(m, loser, survivor);

  const mergeId = newId();
  const after = userById(db, survivorId)!;
  const loserAfter = userById(db, loserId)!;
  db.exec('INSERT INTO account_merges (id, loser_id, survivor_id, merged_at, reason, counts_json, archive_json) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    mergeId,
    loserId,
    survivorId,
    now,
    reason,
    toJson(m.counts),
    toJson({ snapshot: snapshot ? path.basename(snapshot) : null, users: { loser, survivor }, dropped: m.dropped, before: m.before, moved: m.moved, cleared: m.cleared }),
  ]);

  const broken = db.all('PRAGMA foreign_key_check');
  if (broken.length > 0) throw new MergeRefused(`the merge would leave ${broken.length} broken reference(s) (PRAGMA foreign_key_check): ${toJson(broken.slice(0, 5))}. Nothing was written.`);
  const left = leftovers(db, loserId);
  if (left.length > 0) {
    throw new MergeRefused(`the merged account’s id would still stand in ${left.join(', ')}, which no rule of this command covers. Nothing was written.`);
  }
  return {
    status: options.apply ? 'merged' : 'planned',
    mergeId: options.apply ? mergeId : null,
    mergedAt: options.apply ? now : null,
    reason,
    loser: before.loser,
    survivor: before.survivor,
    survivorAfter: account(db, after),
    counts: m.counts,
    notes: notesFor(db, loser, survivor, after, loserAfter, m.counts.sessions?.dropped ?? 0),
    snapshot,
  };
}

function inTransaction(options: MergeOptions, now: number, snapshot: string | null): MergeReport {
  try {
    return options.db.tx(() => {
      const report = run(options, now, snapshot);
      if (!options.apply) throw new Planned(report);
      return report;
    });
  } catch (err) {
    if (err instanceof Planned) return err.report;
    throw err;
  }
}

/**
 * Plan a merge, or with `apply` make it. Refusals throw `MergeRefused` and write nothing. A merge
 * already made answers `already` and does nothing. Applying first plans (so a merge that could not
 * go through costs no snapshot), then snapshots the database into `backupDir`, then merges; with
 * no `backupDir`, or a snapshot that fails, it refuses.
 */
export async function mergeAccounts(options: MergeOptions): Promise<MergeReport> {
  const { db, loserId, survivorId } = options;
  const now = options.now ?? Date.now();
  const reason = options.reason.trim();
  if (reason === '') throw new MergeRefused('a merge needs --reason: why these two accounts are one person');
  if (reason.length > REASON_MAX) throw new MergeRefused(`--reason takes at most ${REASON_MAX} characters`);
  const found = mergeable(db, loserId, survivorId);
  if ('already' in found) {
    const counts = fromJson<MergeCounts>(db.get<{ counts_json: string }>('SELECT counts_json FROM account_merges WHERE id = ?', [found.already.id])?.counts_json, {});
    const survivor = account(db, found.survivor);
    return { status: 'already', mergeId: found.already.id, mergedAt: found.already.merged_at, reason: found.already.reason, loser: account(db, found.loser), survivor, survivorAfter: survivor, counts, notes: [], snapshot: null };
  }
  const plan = inTransaction({ ...options, apply: false }, now, null);
  if (!options.apply) return plan;
  if (!options.backupDir) throw new MergeRefused('--apply needs --backup-dir DIR: a snapshot of the database is taken there before anything is written');
  let snapshot: { file: string };
  try {
    snapshot = await snapshotBeforeMerge(options.dbFile, options.backupDir, now);
  } catch (err) {
    throw new MergeRefused(`no snapshot could be taken in ${options.backupDir}, so nothing was merged: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return inTransaction(options, now, snapshot.file);
  } catch (err) {
    // Nothing was merged after all (the accounts changed under the plan): no copy of the whole
    // database is left behind for a merge that did not happen.
    await rm(snapshot.file, { force: true });
    throw err;
  }
}

const describe = (a: MergeAccount): string =>
  `${a.id}  "${a.displayName}"  ${a.email ?? 'no address'}  signs in with: ${a.signsInWith.join(', ') || 'nothing'}${a.disabled ? '  (disabled)' : ''}` +
  `  clubs: ${a.clubs.map((c) => `${c.name} (${c.role})`).join(', ') || 'none'}`;

/** A report as the command prints it, a line at a time. */
export function formatMerge(report: MergeReport): string[] {
  if (report.status === 'already') {
    return [`already merged: ${report.loser.id} went into ${report.survivor.id} on ${new Date(report.mergedAt!).toISOString()} (merge ${report.mergeId}). Nothing to do.`];
  }
  const lines = [
    report.status === 'merged' ? `merged (merge ${report.mergeId})` : 'DRY RUN: this is what --apply would do. Nothing was written.',
    `  from (merged away): ${describe(report.loser)}`,
    `  into (kept):        ${describe(report.survivor)}`,
    `  reason: ${report.reason}`,
    '  rows:',
  ];
  const tables = Object.keys(report.counts).sort();
  const width = Math.max(0, ...tables.map((t) => t.length));
  for (const table of tables) {
    lines.push(`    ${table.padEnd(width)}  ${Object.entries(report.counts[table]!).map(([what, n]) => `${n} ${what}`).join(', ')}`);
  }
  if (tables.length === 0) lines.push('    (none)');
  lines.push(`  afterwards the kept account: ${describe(report.survivorAfter)}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  if (report.snapshot) lines.push(`  snapshot taken before the merge: ${report.snapshot}`);
  return lines;
}
