import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { type ClubDetail } from '@bookclub/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureAgentUser, followMerge, userById } from '../src/repos/users';
import { type MergeReport, MergeRefused, formatMerge, leftovers, mergeAccounts, snapshotBeforeMerge, unruled } from '../src/services/account-merge';
import { type Client, PASSWORD, ROOT, type TestApp, closeApp, joinClub, makeTestApp, setupOwner } from './helpers';

/*
 * `bookclub merge-accounts` (D228): one person's second account folded into the one they keep.
 * Against a real app and its real database. The people sign up, sign in and start clubs through
 * the API; the rows a merge has a rule for are then written straight into the tables, so every
 * reference to a user in the schema holds the account to be merged before a merge runs (a test
 * below checks exactly that, from the schema).
 */

const SERVER = path.join(ROOT, 'apps/server');

type Values = Record<string, SQLInputValue>;

interface Scene {
  readonly t: TestApp;
  readonly dbFile: string;
  readonly backups: string;
  readonly club: ClubDetail;
  /** A second club the loser owns and the survivor is a member of; a third only the loser is in. */
  readonly club2: string;
  readonly club3: string;
  readonly owner: { c: Client; id: string };
  /** The account kept. */
  readonly sam: { c: Client; id: string };
  /** The account merged away. */
  readonly dup: { c: Client; id: string };
  readonly pat: { c: Client; id: string };
}

const idOf = async (c: Client) => (await c.json<{ user: { id: string } }>(c.get('/api/me'), 200)).user.id;

async function scene(): Promise<Scene> {
  const t = await makeTestApp();
  const { owner, club } = await setupOwner(t, 'Olive', 'First Readers');
  const sam = await joinClub(t, club, 'Sam');
  const dup = await joinClub(t, club, 'Sam Again');
  const pat = await joinClub(t, club, 'Pat');
  const club2 = await dup.json<ClubDetail>(dup.post('/api/clubs', { name: 'Second Readers' }), 201);
  expect((await sam.post(`/api/invites/${club2.invite!.code}/accept`)).statusCode).toBe(200);
  const club3 = await dup.json<ClubDetail>(dup.post('/api/clubs', { name: 'Third Readers' }), 201);
  return {
    t,
    dbFile: path.join(t.dir, 'bookclub.db'),
    backups: mkdtempSync(path.join(tmpdir(), 'bookclub-merge-backups-')),
    club,
    club2: club2.id,
    club3: club3.id,
    owner: { c: owner, id: await idOf(owner) },
    sam: { c: sam, id: await idOf(sam) },
    dup: { c: dup, id: await idOf(dup) },
    pat: { c: pat, id: await idOf(pat) },
  };
}

async function endScene(s: Scene): Promise<void> {
  await closeApp(s.t);
  rmSync(s.backups, { recursive: true, force: true });
}

/** Rows for every table a merge has a rule for, with the loser (and, where two rows can clash, the survivor) in them. */
function fill(s: Scene): void {
  const db = s.t.ctx.db;
  const [S, L, O, P] = [s.sam.id, s.dup.id, s.owner.id, s.pat.id];
  const insert = (table: string, row: Values) =>
    db.exec(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row));

  // Memberships as the merge should fold them: in the first club the loser joined first; in the
  // second the loser is the owner and joined first; the third only the loser is in.
  db.exec('UPDATE memberships SET joined_at = ? WHERE club_id = ? AND user_id = ?', [2000, s.club.id, S]);
  db.exec('UPDATE memberships SET joined_at = ? WHERE club_id = ? AND user_id = ?', [1000, s.club.id, L]);
  db.exec('UPDATE memberships SET joined_at = ? WHERE club_id = ? AND user_id = ?', [10, s.club2, L]);
  db.exec('UPDATE memberships SET joined_at = ?, color = 5 WHERE club_id = ? AND user_id = ?', [20, s.club2, S]);

  insert('series', { id: 'series1', club_id: s.club.id, title: 'A series', created_by: L, created_at: 1 });
  for (const id of ['b1', 'b2', 'b3']) insert('books', { id, club_id: s.club.id, title: `Book ${id}`, created_by: L, created_at: 1 });
  insert('books', { id: 'b-gone', club_id: s.club.id, title: 'Removed', created_by: O, created_at: 1, deleted_at: 5, deleted_by: L });
  insert('clubs', { id: 'club-gone', name: 'Disbanded', created_by: L, created_at: 1, deleted_at: 5, deleted_by: L });
  for (const id of ['e1', 'e2']) insert('editions', { id, book_id: 'b1', kind: 'epub', status: 'ready', created_by: L, created_at: 1 });

  // Reading. b1: both have read, the loser further. b2: only the loser. b3: both finished it.
  const progress = (user: string, book: string, more: Values) =>
    insert('progress', { user_id: user, book_id: book, edition_id: 'e1', locator_json: '{"kind":"epub","section":0,"offset":0}', client_at: 1, updated_at: 1, ...more });
  progress(S, 'b1', { t: 0.3, label: 'Chapter 3', read_ranges_json: '[[0,0.3]]', unplaced_ranges_json: '[[0,0.1]]', furthest: 0.3, coverage: 0.3, client_at: 300, updated_at: 300 });
  progress(L, 'b1', { t: 0.5, label: 'Chapter 5', read_ranges_json: '[[0.2,0.6]]', unplaced_ranges_json: '[[0.7,0.8]]', furthest: 0.6, coverage: 0.4, client_at: 200, updated_at: 200, edition_id: 'e2' });
  progress(L, 'b2', { t: 1, label: 'The end', read_ranges_json: '[[0,1]]', furthest: 1, coverage: 1, finished_at: 5000 });
  progress(S, 'b3', { t: 1, label: 'The end', read_ranges_json: '[[0,1]]', furthest: 1, coverage: 1, finished_at: 9000, updated_at: 900 });
  progress(L, 'b3', { t: 0.9, label: 'Nearly', read_ranges_json: '[[0,1]]', furthest: 1, coverage: 1, finished_at: 4000, updated_at: 400 });
  // In an edition's own measure (characters here), far outside [0, 1].
  insert('edition_progress', { user_id: S, book_id: 'b1', edition_id: 'e1', read_ranges_json: '[[0,1500]]', updated_at: 300 });
  insert('edition_progress', { user_id: L, book_id: 'b1', edition_id: 'e1', read_ranges_json: '[[1000,4000],[9000,12000]]', updated_at: 200 });
  insert('edition_progress', { user_id: L, book_id: 'b1', edition_id: 'e2', read_ranges_json: '[[0,700]]', updated_at: 200 });
  for (const id of ['rs1', 'rs2']) {
    insert('reading_sessions', { id, user_id: L, book_id: 'b1', edition_id: 'e1', kind: 'epub', device: 'phone', started_at: 1, ended_at: 2, from_m: 0, to_m: 10, last_m: 10, from_json: '{}', to_json: '{}', from_t: 0, to_t: 0.1, updated_at: 2 });
  }

  // Settings: one row per person (and book).
  insert('book_playback', { user_id: S, book_id: 'b1', rate: 1.5, at: 1, updated_at: 1 });
  insert('book_playback', { user_id: L, book_id: 'b1', rate: 2, at: 2, updated_at: 2 });
  insert('book_playback', { user_id: L, book_id: 'b2', rate: 1.25, at: 2, updated_at: 2 });
  insert('book_audio_controls', { user_id: L, book_id: 'b1', hidden: 1, at: 1, updated_at: 1 });
  insert('listening_settings', { user_id: S, default_rate: 1.1, at: 1, updated_at: 1 });
  insert('listening_settings', { user_id: L, default_rate: 1.9, at: 1, updated_at: 1 });
  insert('audio_controls_default', { user_id: L, hidden: 1, at: 1, updated_at: 1 });
  insert('chat_dnd', { user_id: L, enabled: 1, updated_at: 1 });
  insert('cal_settings', { user_id: S, whole_series: 0, updated_at: 1 });
  insert('cal_settings', { user_id: L, whole_series: 1, updated_at: 1 });
  insert('calendar_feeds', { user_id: L, token_hash: 'feed-hash-of-the-loser', created_at: 1 });

  // Notes and chat. `k1` is a replay key both accounts used.
  const comment = (id: string, user: string, client: string | null) =>
    insert('comments', { id, book_id: 'b1', user_id: user, edition_id: 'e1', kind: 'epub', locator_json: '{}', t: 0.1, text: `note ${id}`, client_id: client, created_at: 1 });
  comment('c-s', S, 'k1');
  comment('c-l1', L, 'k1');
  comment('c-l2', L, 'k2');
  comment('c-l3', L, null);
  insert('comment_media', { id: 'cm1', comment_id: 'c-l2', user_id: L, book_id: 'b1', kind: 'photo', created_at: 1 });
  const message = (id: string, user: string, client: string | null, more: Values = {}) =>
    insert('chat_messages', { id, club_id: s.club.id, user_id: user, text: `message ${id}`, client_id: client, created_at: 1, ...more });
  message('m-s', S, 'k1');
  message('m-l1', L, 'k1');
  message('m-l2', L, null);
  message('m-o', O, null, { spoiler_user_id: L });
  insert('chat_attachments', { id: 'ca1', message_id: 'm-l2', club_id: s.club.id, user_id: L, kind: 'image', created_at: 1 });
  insert('chat_reactions', { message_id: 'm-o', user_id: S, emoji: '👍', created_at: 1 });
  insert('chat_reactions', { message_id: 'm-o', user_id: L, emoji: '👍', created_at: 2 });
  insert('chat_reactions', { message_id: 'm-o', user_id: L, emoji: '🎉', created_at: 2 });
  insert('chat_reads', { club_id: s.club.id, user_id: S, last_read_at: 100, last_read_message_id: 'm-s' });
  insert('chat_reads', { club_id: s.club.id, user_id: L, last_read_at: 200, last_read_message_id: 'm-o' });
  insert('chat_reads', { club_id: s.club2, user_id: S, last_read_at: 300 });
  insert('chat_reads', { club_id: s.club2, user_id: L, last_read_at: 50 });
  insert('chat_reads', { club_id: s.club3, user_id: L, last_read_at: 70 });

  const notify = (id: string, user: string, actor: string, kind: string, more: Values = {}) => insert('notifications', { id, user_id: user, actor_id: actor, kind, created_at: 1, ...more });
  notify('n-for-loser', L, O, 'reply', { book_id: 'b1', comment_id: 'c-l1' });
  notify('n-by-loser', O, L, 'reply', { book_id: 'b1', comment_id: 'c-l2' });
  notify('n-self-1', L, S, 'reply', { book_id: 'b1' });
  notify('n-self-2', S, L, 'reached', { book_id: 'b1', chapter_index: 1 });
  notify('n-mention-s', S, O, 'mention', { club_id: s.club.id, chat_message_id: 'm-o' });
  notify('n-mention-l', L, O, 'mention', { club_id: s.club.id, chat_message_id: 'm-o' });
  notify('n-reached-s', O, S, 'reached', { book_id: 'b1', chapter_index: 2 });
  notify('n-reached-l', O, L, 'reached', { book_id: 'b1', chapter_index: 2 });
  notify('n-reached-l3', O, L, 'reached', { book_id: 'b1', chapter_index: 3 });

  // Meet-ups, questions and the next book.
  insert('meeting_points', { book_id: 'b1', t: 0.5, set_by: L, set_at: 1 });
  insert('meeting_points', { book_id: 'b2', t: 0.5, set_by: O, set_at: 1 });
  insert('meeting_rsvps', { book_id: 'b1', user_id: S, answer: 'no', occasion: 'day:old', answered_at: 100 });
  insert('meeting_rsvps', { book_id: 'b1', user_id: L, answer: 'yes', occasion: 'day:new', answered_at: 200 });
  insert('meeting_rsvps', { book_id: 'b2', user_id: S, answer: 'yes', occasion: 'day:x', answered_at: 500 });
  insert('meeting_rsvps', { book_id: 'b2', user_id: L, answer: 'no', occasion: 'day:x', answered_at: 100 });
  insert('meetup_questions', { id: 'q1', book_id: 'b1', t: 0.5, text: 'Why?', author_id: L, created_at: 1 });
  insert('meetup_questions', { id: 'q2', book_id: 'b1', t: 0.5, text: 'Cal’s', author_id: null, asked_by: L, created_at: 1 });
  insert('meetup_question_votes', { question_id: 'q1', user_id: S, created_at: 1 });
  insert('meetup_question_votes', { question_id: 'q1', user_id: L, created_at: 2 });
  insert('meetup_question_votes', { question_id: 'q2', user_id: L, created_at: 2 });
  insert('meetup_question_asks', { book_id: 'b1', t: 0.5, user_id: L, asked_at: 1 });
  insert('nomination_rounds', { id: 'r1', club_id: s.club.id, status: 'closed', opened_by: L, opened_at: 1, closed_by: L, closed_at: 2 });
  insert('nominations', { id: 'nom1', round_id: 'r1', club_id: s.club.id, title: 'A book', created_by: L, created_at: 1, updated_at: 1 });
  insert('nominations', { id: 'nom2', round_id: 'r1', club_id: s.club.id, title: 'Another', created_by: O, created_at: 1, updated_at: 1 });
  insert('nomination_votes', { nomination_id: 'nom1', user_id: S, created_at: 1 });
  insert('nomination_votes', { nomination_id: 'nom1', user_id: L, created_at: 2 });
  insert('nomination_votes', { nomination_id: 'nom2', user_id: L, created_at: 2 });

  // Uploads and Cal.
  insert('imports', { id: 'imp1', club_id: s.club.id, user_id: L, kind: 'epub', status: 'cancelled', files_json: '[]', created_at: 1 });
  insert('uploads', { id: 'up1', import_id: 'imp1', file_index: 0, user_id: L, size: 1, created_at: 1 });
  insert('cal_conversations', { id: 'conv1', user_id: L, club_id: s.club.id, created_at: 1, updated_at: 1 });
  insert('cal_shelf_items', { id: 'shelf1', club_id: s.club.id, user_id: L, kind: 'txt', created_at: 1 });
  insert('cal_cost_log', { id: 'cost1', club_id: s.club.id, user_id: L, kind: 'chat', provider: 'p', model: 'm', created_at: 1 });
  insert('agent_deliveries', { id: 'del1', agent: 'helper', message_id: 'm-l2', club_id: s.club.id, asker_id: L, created_at: 1 });

  // How the loser is known and signs in.
  insert('external_identities', { provider: 'apple', subject: 'apple-subject-of-the-loser', user_id: L, email: 'sam.again@example.com', created_at: 1 });
  insert('push_tokens', { token: 'push-token-of-the-loser', user_id: L, created_at: 1, last_seen_at: 1 });
  insert('app_auth_codes', { code_hash: 'app-code-hash', user_id: L, challenge: 'x', created_at: 1, expires_at: Date.now() + 60_000 });
  const reset = (hash: string, user: string, by: string) => insert('password_resets', { token_hash: hash, user_id: user, created_by: by, created_at: 1, expires_at: Date.now() + 60_000 });
  reset('reset-for-loser', L, O);
  reset('reset-by-loser-for-pat', P, L);
  reset('reset-by-loser-for-survivor', S, L);
  db.exec('UPDATE users SET upstream_subject = ? WHERE id = ?', ['upstream:the-losers-subject', L]);
}

/** Every row of every table, as text: what "nothing was written" is checked against. */
function dump(t: TestApp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name } of t.ctx.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name")) {
    out[name] = JSON.stringify(t.ctx.db.all(`SELECT * FROM "${name}"`));
  }
  return out;
}

/** What another connection sees change when anything is committed to the file. */
function dataVersion(peer: DatabaseSync): number {
  return (peer.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
}

const refusal = async (run: Promise<MergeReport>): Promise<string> => {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MergeRefused);
  return (err as Error).message;
};

describe('bookclub merge-accounts: the plan, the snapshot and the merge (D228)', () => {
  let s: Scene;
  let request: { db: TestApp['ctx']['db']; dbFile: string; loserId: string; survivorId: string; reason: string };
  /** A one-time sign-in code the loser made while it was still an account. */
  let code: string;

  beforeAll(async () => {
    s = await scene();
    fill(s);
    code = (await s.dup.c.json<{ code: string }>(s.dup.c.post('/api/auth/codes'), 201)).code;
    request = { db: s.t.ctx.db, dbFile: s.dbFile, loserId: s.dup.id, survivorId: s.sam.id, reason: 'Sam signed up twice' };
  });

  afterAll(async () => {
    await endScene(s);
  });

  const db = () => s.t.ctx.db;
  const count = (sql: string, params: SQLInputValue[] = []) => db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${sql}`, params)!.n;

  it('has a rule for every reference to a user in the schema, and the scene puts the account to merge in each', () => {
    expect(unruled(db())).toEqual([]);
    const references: string[] = [];
    for (const { name } of db().all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
      for (const fk of db().all<{ table: string; from: string }>(`PRAGMA foreign_key_list("${name}")`)) {
        if (fk.table === 'users') references.push(`${name}.${fk.from}`);
      }
    }
    // 48 foreign keys in 43 tables when this was written, and the merge pointer itself.
    expect(references.length).toBeGreaterThanOrEqual(49);
    const empty = references.filter((ref) => {
      const [table, column] = ref.split('.') as [string, string];
      return ref !== 'users.merged_into' && count(`"${table}" WHERE "${column}" = ?`, [s.dup.id]) === 0;
    });
    expect(empty).toEqual([]);
    expect(count('clubs WHERE deleted_by = ?', [s.dup.id]) + count('books WHERE deleted_by = ?', [s.dup.id])).toBe(2);
  });

  it('without --apply it prints the whole plan and writes nothing', async () => {
    const before = dump(s.t);
    const peer = new DatabaseSync(s.dbFile, { readOnly: true });
    const version = dataVersion(peer);
    const report = await mergeAccounts(request);
    expect(report.status).toBe('planned');
    expect(report.mergeId).toBeNull();
    expect(report.snapshot).toBeNull();
    expect(dataVersion(peer)).toBe(version);
    peer.close();
    expect(dump(s.t)).toEqual(before);
    expect(readdirSync(s.backups)).toEqual([]);
    expect(count('account_merges')).toBe(0);
    // Both accounts still work exactly as before.
    expect((await s.dup.c.get('/api/me')).statusCode).toBe(200);
    expect(userById(db(), s.dup.id)).toMatchObject({ disabled_at: null, merged_into: null });

    const lines = formatMerge(report);
    expect(lines[0]).toBe('DRY RUN: this is what --apply would do. Nothing was written.');
    expect(lines.join('\n')).toContain(`from (merged away): ${s.dup.id}  "Sam Again"  sam.again@example.com  signs in with: password, upstream, apple`);
    expect(lines.join('\n')).toContain(`into (kept):        ${s.sam.id}  "Sam"  sam@example.com  signs in with: password`);
    expect(lines.join('\n')).toContain('reason: Sam signed up twice');
    // The plan is the merge, counted: the same numbers applying gives (checked again below).
    expect(report.counts).toMatchObject({
      progress: { merged: 2, 'folded in': 2, moved: 1 },
      edition_progress: { merged: 1, 'folded in': 1, moved: 1 },
      reading_sessions: { moved: 2 },
      memberships: { merged: 2, 'folded in': 2, moved: 1 },
      comments: { 'replay keys cleared': 1, moved: 3 },
      chat_messages: { 'replay keys cleared': 1, moved: 3 },
      chat_reactions: { dropped: 1, moved: 1 },
      chat_reads: { replaced: 1, dropped: 1, moved: 2 },
      meeting_rsvps: { replaced: 1, dropped: 1, moved: 1 },
      notifications: { moved: 3, 'dropped (about themselves)': 2, 'dropped (a repeat)': 2 },
      sessions: { dropped: 1 },
      password_resets: { dropped: 2, moved: 1 },
      external_identities: { moved: 1 },
      users: { 'upstream identity taken over': 1, 'merged away': 1 },
    });
    expect(report.survivorAfter.signsInWith).toEqual(['password', 'upstream', 'apple']);
    expect(report.notes.join('\n')).toContain('own password stops working');
    expect(report.notes.join('\n')).toContain('(sam.again@example.com) stays on its row');
  });

  it('--apply without a snapshot refuses, and writes nothing: no --backup-dir, or one a snapshot cannot be written to', async () => {
    const before = dump(s.t);
    expect(await refusal(mergeAccounts({ ...request, apply: true }))).toMatch(/--apply needs --backup-dir/);
    const notADirectory = path.join(s.backups, 'a-file');
    writeFileSync(notADirectory, 'x');
    expect(await refusal(mergeAccounts({ ...request, apply: true, backupDir: notADirectory }))).toMatch(/no snapshot could be taken .* so nothing was merged/);
    rmSync(notADirectory);
    expect(dump(s.t)).toEqual(before);
    expect(count('account_merges')).toBe(0);
    expect(readdirSync(s.backups)).toEqual([]);
  });

  it('a snapshot is a whole, checked copy of the database, readable by its owner alone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bookclub-merge-snapshot-'));
    try {
      const made = await snapshotBeforeMerge(s.dbFile, path.join(dir, 'nested'), Date.UTC(2026, 10, 10, 12, 0, 0));
      expect(made.file).toBe(path.join(dir, 'nested', 'pre-merge-20261110T120000Z.db'));
      expect(statSync(made.file).mode & 0o777).toBe(0o600);
      expect(made.bytes).toBe(statSync(made.file).size);
      const copy = new DatabaseSync(made.file, { readOnly: true });
      expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect((copy.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(count('users'));
      copy.close();
      // A second one in the same second does not replace the first.
      const again = await snapshotBeforeMerge(s.dbFile, path.join(dir, 'nested'), Date.UTC(2026, 10, 10, 12, 0, 0));
      expect(path.basename(again.file)).toBe('pre-merge-20261110T120000Z-2.db');
      // No database to copy: it throws, and leaves nothing behind.
      await expect(snapshotBeforeMerge(path.join(dir, 'missing.db'), path.join(dir, 'other'))).rejects.toThrow();
      expect(existsSync(path.join(dir, 'other'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('applied', () => {
    let plan: MergeReport;
    let report: MergeReport;
    let before: Record<string, string>;

    beforeAll(async () => {
      // An account merged into the loser earlier: its trail must end at the survivor afterwards.
      const zed = await joinClub(s.t, s.club, 'Zed');
      const earlier = await mergeAccounts({ ...request, loserId: await idOf(zed), survivorId: s.dup.id, reason: 'Zed was Sam too', apply: true, backupDir: s.backups });
      expect(earlier.status).toBe('merged');
      before = dump(s.t);
      plan = await mergeAccounts(request);
      report = await mergeAccounts({ ...request, apply: true, backupDir: s.backups });
    });

    const S = () => s.sam.id;
    const L = () => s.dup.id;
    const archive = () => JSON.parse(db().get<{ archive_json: string }>('SELECT archive_json FROM account_merges WHERE id = ?', [report.mergeId])!.archive_json) as {
      snapshot: string;
      users: { loser: { id: string; password_hash: string | null }; survivor: { id: string } };
      dropped: Record<string, Record<string, unknown>[]>;
      before: Record<string, Record<string, unknown>[]>;
      moved: Record<string, Record<string, unknown>[]>;
      cleared: Record<string, Record<string, unknown>[]>;
    };

    it('does what the plan said, after a snapshot of the database as it was', () => {
      expect(report.status).toBe('merged');
      expect(report.counts).toEqual(plan.counts);
      expect(report.notes).toEqual(plan.notes);
      expect(report.snapshot).toMatch(/pre-merge-\d{8}T\d{6}Z(-\d+)?\.db$/);
      expect(path.dirname(report.snapshot!)).toBe(s.backups);
      expect(statSync(report.snapshot!).mode & 0o777).toBe(0o600);
      const copy = new DatabaseSync(report.snapshot!, { readOnly: true });
      expect(copy.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      // The snapshot is from before the first write: the loser is still an account there.
      expect(copy.prepare('SELECT disabled_at, merged_into FROM users WHERE id = ?').get(L())).toEqual({ disabled_at: null, merged_into: null });
      expect((copy.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(L()) as { n: number }).n).toBe(1);
      copy.close();
      expect(formatMerge(report)[0]).toBe(`merged (merge ${report.mergeId})`);
      expect(formatMerge(report).at(-1)).toBe(`  snapshot taken before the merge: ${report.snapshot}`);
    });

    it('leaves the database whole: no broken reference, and the merged id nowhere but its own row and the record', () => {
      expect(db().all('PRAGMA foreign_key_check')).toEqual([]);
      expect(leftovers(db(), L())).toEqual([]);
      expect(db().get('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' });
      // Only the tables a merge touches changed; the rest are byte for byte what they were.
      const after = dump(s.t);
      const untouched = ['blobs', 'cal_chunks', 'cal_messages', 'edition_files', 'ended_sessions', 'narrator_voices', 'readalong', 'transcripts', 'club_up_next'];
      for (const table of untouched) expect(after[table], table).toBe(before[table]);
    });

    it('reading: the furthest place, the union of what was read, the first finish', () => {
      expect(count('progress WHERE user_id = ?', [L()])).toBe(0);
      const b1 = db().get('SELECT * FROM progress WHERE user_id = ? AND book_id = ?', [S(), 'b1'])!;
      expect(b1).toMatchObject({ t: 0.5, label: 'Chapter 5', edition_id: 'e2', client_at: 200, read_ranges_json: '[[0,0.6]]', unplaced_ranges_json: '[[0,0.1],[0.7,0.8]]', furthest: 0.6, finished_at: null, updated_at: 300 });
      expect(b1.coverage).toBeCloseTo(0.6);
      // Only the loser had read b2: its row is the survivor's now, as it was.
      expect(db().get('SELECT t, finished_at FROM progress WHERE user_id = ? AND book_id = ?', [S(), 'b2'])).toEqual({ t: 1, finished_at: 5000 });
      // Both finished b3: when the first of them did; the place of whoever reported later at the same furthest point.
      expect(db().get('SELECT t, label, finished_at FROM progress WHERE user_id = ? AND book_id = ?', [S(), 'b3'])).toEqual({ t: 1, label: 'The end', finished_at: 4000 });
      // In the edition's own measure: joined where they touch, never clamped to [0, 1].
      expect(db().all('SELECT edition_id, read_ranges_json FROM edition_progress WHERE user_id = ? ORDER BY edition_id', [S()])).toEqual([
        { edition_id: 'e1', read_ranges_json: '[[0,4000],[9000,12000]]' },
        { edition_id: 'e2', read_ranges_json: '[[0,700]]' },
      ]);
      expect(count('edition_progress WHERE user_id = ?', [L()])).toBe(0);
      expect(count('reading_sessions WHERE user_id = ?', [S()])).toBe(2);
      // What was folded in or overwritten is in the record, whole.
      expect(archive().dropped.progress!.map((r) => r.book_id).sort()).toEqual(['b1', 'b3']);
      expect(archive().before.progress!.find((r) => r.book_id === 'b1')).toMatchObject({ user_id: S(), t: 0.3, read_ranges_json: '[[0,0.3]]' });
      expect(archive().before.edition_progress).toEqual([expect.objectContaining({ user_id: S(), read_ranges_json: '[[0,1500]]' })]);
    });

    it('settings: the survivor’s own, the loser’s where the survivor had none', () => {
      expect(db().all('SELECT book_id, rate FROM book_playback WHERE user_id = ? ORDER BY book_id', [S()])).toEqual([
        { book_id: 'b1', rate: 1.5 },
        { book_id: 'b2', rate: 1.25 },
      ]);
      expect(archive().dropped.book_playback).toEqual([expect.objectContaining({ user_id: L(), book_id: 'b1', rate: 2 })]);
      expect(db().get('SELECT default_rate FROM listening_settings WHERE user_id = ?', [S()])).toEqual({ default_rate: 1.1 });
      expect(db().get('SELECT whole_series FROM cal_settings WHERE user_id = ?', [S()])).toEqual({ whole_series: 0 });
      for (const table of ['book_audio_controls', 'audio_controls_default', 'chat_dnd', 'calendar_feeds']) expect(count(`${table} WHERE user_id = ?`, [S()]), table).toBe(1);
      expect(db().get('SELECT token_hash FROM calendar_feeds WHERE user_id = ?', [S()])).toEqual({ token_hash: 'feed-hash-of-the-loser' });
    });

    it('membership: one row a club, the higher role, the earlier joining, the survivor’s colour', () => {
      expect(count('memberships WHERE user_id = ?', [L()])).toBe(0);
      expect(db().get('SELECT role, joined_at FROM memberships WHERE club_id = ? AND user_id = ?', [s.club.id, S()])).toEqual({ role: 'member', joined_at: 1000 });
      expect(db().get('SELECT role, joined_at, color FROM memberships WHERE club_id = ? AND user_id = ?', [s.club2, S()])).toEqual({ role: 'owner', joined_at: 10, color: 5 });
      expect(db().get('SELECT role FROM memberships WHERE club_id = ? AND user_id = ?', [s.club3, S()])).toEqual({ role: 'owner' });
      expect(archive().dropped.memberships!.map((r) => r.club_id).sort()).toEqual([s.club.id, s.club2].sort());
    });

    it('notes and chat move; a replay key both used is cleared on the loser’s row, which keeps its words', () => {
      expect(db().all('SELECT id, client_id FROM comments WHERE user_id = ? ORDER BY id', [S()])).toEqual([
        { id: 'c-l1', client_id: null },
        { id: 'c-l2', client_id: 'k2' },
        { id: 'c-l3', client_id: null },
        { id: 'c-s', client_id: 'k1' },
      ]);
      expect(db().all('SELECT id, client_id FROM chat_messages WHERE user_id = ? ORDER BY id', [S()])).toEqual([
        { id: 'm-l1', client_id: null },
        { id: 'm-l2', client_id: null },
        { id: 'm-s', client_id: 'k1' },
      ]);
      expect(archive().cleared['comments.client_id']).toEqual([{ id: 'c-l1', client_id: 'k1' }]);
      expect(archive().cleared['chat_messages.client_id']).toEqual([{ id: 'm-l1', client_id: 'k1' }]);
      expect(archive().moved['comments.user_id']!.map((r) => r.id).sort()).toEqual(['c-l1', 'c-l2', 'c-l3']);
      expect(db().get("SELECT spoiler_user_id FROM chat_messages WHERE id = 'm-o'")).toEqual({ spoiler_user_id: S() });
      expect(count('comment_media WHERE user_id = ?', [S()])).toBe(1);
      expect(count('chat_attachments WHERE user_id = ?', [S()])).toBe(1);
    });

    it('reactions and votes: a repeat is dropped; a read marker or an answer: the later one', () => {
      expect(db().all("SELECT emoji, created_at FROM chat_reactions WHERE message_id = 'm-o' AND user_id = ? ORDER BY emoji", [S()])).toEqual([
        { emoji: '🎉', created_at: 2 },
        { emoji: '👍', created_at: 1 },
      ]);
      expect(archive().dropped.chat_reactions).toEqual([{ message_id: 'm-o', user_id: L(), emoji: '👍', created_at: 2 }]);
      expect(db().all('SELECT club_id, last_read_at, last_read_message_id FROM chat_reads WHERE user_id = ? ORDER BY last_read_at', [S()])).toEqual([
        { club_id: s.club3, last_read_at: 70, last_read_message_id: null },
        { club_id: s.club.id, last_read_at: 200, last_read_message_id: 'm-o' },
        { club_id: s.club2, last_read_at: 300, last_read_message_id: null },
      ]);
      expect(archive().before.chat_reads).toEqual([expect.objectContaining({ club_id: s.club.id, user_id: S(), last_read_at: 100 })]);
      // The answer given last stands, whichever account gave it.
      expect(db().all('SELECT book_id, answer, occasion FROM meeting_rsvps WHERE user_id = ? ORDER BY book_id', [S()])).toEqual([
        { book_id: 'b1', answer: 'yes', occasion: 'day:new' },
        { book_id: 'b2', answer: 'yes', occasion: 'day:x' },
      ]);
      expect(db().all('SELECT question_id FROM meetup_question_votes WHERE user_id = ? ORDER BY question_id', [S()])).toEqual([{ question_id: 'q1' }, { question_id: 'q2' }]);
      expect(db().all('SELECT nomination_id FROM nomination_votes WHERE user_id = ? ORDER BY nomination_id', [S()])).toEqual([{ nomination_id: 'nom1' }, { nomination_id: 'nom2' }]);
    });

    it('notifications: re-pointed, never about oneself, never twice', () => {
      expect(db().all('SELECT id, user_id, actor_id FROM notifications ORDER BY id')).toEqual([
        { id: 'n-by-loser', user_id: s.owner.id, actor_id: S() },
        { id: 'n-for-loser', user_id: S(), actor_id: s.owner.id },
        { id: 'n-mention-s', user_id: S(), actor_id: s.owner.id },
        { id: 'n-reached-l3', user_id: s.owner.id, actor_id: S() },
        { id: 'n-reached-s', user_id: s.owner.id, actor_id: S() },
      ]);
      expect(archive().dropped.notifications!.map((r) => r.id).sort()).toEqual(['n-mention-l', 'n-reached-l', 'n-self-1', 'n-self-2']);
    });

    it('everything the person made, set or asked is the survivor’s', () => {
      const made: [string, string, number][] = [
        ['clubs', 'created_by', 3],
        ['clubs', 'deleted_by', 1],
        ['books', 'created_by', 3],
        ['books', 'deleted_by', 1],
        ['editions', 'created_by', 2],
        ['series', 'created_by', 1],
        ['invites', 'created_by', 2],
        ['meeting_points', 'set_by', 1],
        ['meetup_questions', 'author_id', 1],
        ['meetup_questions', 'asked_by', 1],
        ['meetup_question_asks', 'user_id', 1],
        ['nomination_rounds', 'opened_by', 1],
        ['nomination_rounds', 'closed_by', 1],
        ['nominations', 'created_by', 1],
        ['imports', 'user_id', 1],
        ['uploads', 'user_id', 1],
        ['cal_conversations', 'user_id', 1],
        ['cal_shelf_items', 'user_id', 1],
        ['cal_cost_log', 'user_id', 1],
        ['agent_deliveries', 'asker_id', 1],
        ['external_identities', 'user_id', 1],
        ['push_tokens', 'user_id', 1],
      ];
      for (const [table, column, n] of made) {
        expect(count(`${table} WHERE ${column} = ?`, [S()]), `${table}.${column}`).toBe(n);
        expect(count(`${table} WHERE ${column} = ?`, [L()]), `${table}.${column}`).toBe(0);
      }
    });

    it('the merged row stays: disabled, pointing at the survivor, with what the survivor did not take', () => {
      const loser = userById(db(), L())!;
      expect(loser).toMatchObject({ merged_into: S(), display_name: 'Sam Again', email: 'sam.again@example.com', upstream_subject: null });
      expect(loser.disabled_at).toBe(report.mergedAt);
      expect(loser.password_hash).not.toBeNull();
      // The survivor had no upstream identity: it took the loser's. It had an address: it kept its own.
      expect(userById(db(), S())).toMatchObject({ upstream_subject: 'upstream:the-losers-subject', email: 'sam@example.com', disabled_at: null, merged_into: null });
      // The account merged into the loser earlier now leads straight to the survivor.
      const zed = db().get<{ id: string; merged_into: string }>("SELECT id, merged_into FROM users WHERE display_name = 'Zed'")!;
      expect(zed.merged_into).toBe(S());
      expect(followMerge(db(), userById(db(), zed.id)!)?.id).toBe(S());
      expect(followMerge(db(), loser)?.id).toBe(S());
      expect(archive().users).toMatchObject({ loser: { id: L() }, survivor: { id: S() } });
      expect(archive().moved['users.merged_into']).toEqual([{ id: zed.id }]);
    });

    it('nothing that signed the loser in is carried across; it is all in the record', async () => {
      for (const table of ['sessions', 'sign_in_codes', 'app_auth_codes']) expect(count(`${table} WHERE user_id = ?`, [L()]), table).toBe(0);
      expect(archive().dropped.sessions).toHaveLength(1);
      expect(archive().dropped.sign_in_codes).toHaveLength(1);
      expect(archive().dropped.app_auth_codes).toEqual([expect.objectContaining({ code_hash: 'app-code-hash', user_id: L() })]);
      // Reset links: the loser's own and the one it made for the survivor end; one it made for somebody else is the survivor's to have made.
      expect(db().all('SELECT token_hash, user_id, created_by FROM password_resets ORDER BY token_hash')).toEqual([{ token_hash: 'reset-by-loser-for-pat', user_id: s.pat.id, created_by: S() }]);
      expect(archive().dropped.password_resets!.map((r) => r.token_hash).sort()).toEqual(['reset-by-loser-for-survivor', 'reset-for-loser']);

      // The loser's session, its sign-in code and its own password sign nobody in.
      expect((await s.dup.c.get('/api/me')).statusCode).toBe(401);
      expect((await s.t.client().post('/api/auth/code', { code })).statusCode).toBe(401);
      const typed = await s.t.client().post('/api/auth/signin', { email: 'sam.again@example.com', password: PASSWORD });
      expect(typed.statusCode).toBe(401);
      expect(typed.json()).toEqual({ error: { code: 'invalid_credentials', message: 'That email and password do not match.' } });
      // The survivor's session and password are untouched, and it sees what both accounts had.
      expect((await s.sam.c.get('/api/me')).statusCode).toBe(200);
      const again = s.t.client();
      expect((await again.post('/api/auth/signin', { email: 'sam@example.com', password: PASSWORD })).statusCode).toBe(200);
      const clubs = (await again.json<{ clubs: { id: string }[] }>(again.get('/api/me'), 200)).clubs.map((c) => c.id).sort();
      expect(clubs).toEqual([s.club.id, s.club2, s.club3].sort());
    });

    it('is recorded once, for good: who, when, why and how many rows of each table', () => {
      const rows = db().all<{ id: string; loser_id: string; survivor_id: string; merged_at: number; reason: string; counts_json: string }>(
        'SELECT id, loser_id, survivor_id, merged_at, reason, counts_json FROM account_merges WHERE loser_id = ?',
        [L()],
      );
      expect(rows).toEqual([{ id: report.mergeId, loser_id: L(), survivor_id: S(), merged_at: report.mergedAt, reason: 'Sam signed up twice', counts_json: JSON.stringify(report.counts) }]);
      expect(archive().snapshot).toBe(path.basename(report.snapshot!));
      expect(() => db().exec("UPDATE account_merges SET reason = 'rewritten' WHERE id = ?", [report.mergeId])).toThrow(/append-only/);
      expect(() => db().exec('DELETE FROM account_merges WHERE id = ?', [report.mergeId])).toThrow(/append-only/);
      expect(count('account_merges')).toBe(2);
    });

    it('asked for again, it says "already merged" and does nothing: no second record, no second snapshot', async () => {
      const snapshots = readdirSync(s.backups).length;
      const was = dump(s.t);
      for (const apply of [false, true]) {
        const again = await mergeAccounts({ ...request, apply, backupDir: s.backups });
        expect(again).toMatchObject({ status: 'already', mergeId: report.mergeId, mergedAt: report.mergedAt, reason: 'Sam signed up twice' });
        expect(formatMerge(again)).toEqual([`already merged: ${L()} went into ${S()} on ${new Date(report.mergedAt!).toISOString()} (merge ${report.mergeId}). Nothing to do.`]);
      }
      expect(dump(s.t)).toEqual(was);
      expect(readdirSync(s.backups)).toHaveLength(snapshots);
    });

    it('refuses to merge a merged account elsewhere, or anything into one', async () => {
      expect(await refusal(mergeAccounts({ ...request, survivorId: s.pat.id }))).toMatch(/was already merged into another account/);
      expect(await refusal(mergeAccounts({ ...request, loserId: s.pat.id, survivorId: s.dup.id }))).toMatch(/was itself merged into .*: merge into that account instead/);
    });
  });
});

describe('bookclub merge-accounts: what it refuses (D228)', () => {
  let s: Scene;
  let before: Record<string, string>;

  beforeAll(async () => {
    s = await scene();
  });

  beforeEach(() => {
    before = dump(s.t);
  });

  afterEach(() => {
    // A refusal writes nothing, whatever it refused.
    expect(dump(s.t)).toEqual(before);
    expect(readdirSync(s.backups)).toEqual([]);
  });

  afterAll(async () => {
    await endScene(s);
  });

  const attempt = (loserId: string, survivorId: string, reason = 'the same person') =>
    refusal(mergeAccounts({ db: s.t.ctx.db, dbFile: s.dbFile, loserId, survivorId, reason, apply: true, backupDir: s.backups }));

  it('the same account twice', async () => {
    expect(await attempt(s.dup.id, s.dup.id)).toMatch(/name the same account/);
  });

  it('an account that is not there, on either side', async () => {
    expect(await attempt('no-such-account', s.sam.id)).toBe('no account no-such-account (--from)');
    expect(await attempt(s.dup.id, 'no-such-account')).toBe('no account no-such-account (--into)');
  });

  it('an agent’s row, on either side', async () => {
    const agent = ensureAgentUser(s.t.ctx.db, { handle: 'a-test-agent', displayName: 'An Agent' }).id;
    before = dump(s.t);
    expect(await attempt(agent, s.sam.id)).toMatch(/\(--from\) is an agent's row/);
    expect(await attempt(s.dup.id, agent)).toMatch(/\(--into\) is an agent's row/);
  });

  it('a disabled account to merge into', async () => {
    s.t.ctx.db.exec('UPDATE users SET disabled_at = 1 WHERE id = ?', [s.pat.id]);
    before = dump(s.t);
    expect(await attempt(s.dup.id, s.pat.id)).toMatch(/\(--into\) is disabled/);
    s.t.ctx.db.exec('UPDATE users SET disabled_at = NULL WHERE id = ?', [s.pat.id]);
    before = dump(s.t);
  });

  it('no reason, or one too long to be one', async () => {
    expect(await attempt(s.dup.id, s.sam.id, '   ')).toMatch(/needs --reason/);
    expect(await attempt(s.dup.id, s.sam.id, 'x'.repeat(501))).toMatch(/at most 500 characters/);
  });

  it('a table that references a user and has no rule: refused before anything is written', async () => {
    s.t.ctx.db.raw.exec('CREATE TABLE things_added_later (id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id))');
    try {
      before = dump(s.t);
      expect(unruled(s.t.ctx.db)).toEqual(['things_added_later.owner_id']);
      expect(await attempt(s.dup.id, s.sam.id)).toMatch(/no merge rule for things_added_later\.owner_id/);
      // Even with no row of the loser's in it: the rule is missing, so the merge is not made.
      expect(await refusal(mergeAccounts({ db: s.t.ctx.db, dbFile: s.dbFile, loserId: s.dup.id, survivorId: s.sam.id, reason: 'a dry run is refused too' }))).toMatch(/no merge rule/);
    } finally {
      s.t.ctx.db.raw.exec('DROP TABLE things_added_later');
      before = dump(s.t);
    }
  });

  it('the merged id left anywhere else, even inside JSON in a column that is no foreign key: rolled back whole', async () => {
    s.t.ctx.db.raw.exec('CREATE TABLE loose_notes (id TEXT PRIMARY KEY, detail_json TEXT)');
    s.t.ctx.db.exec('INSERT INTO loose_notes (id, detail_json) VALUES (?, ?)', ['x', JSON.stringify({ seenBy: [s.dup.id] })]);
    try {
      before = dump(s.t);
      expect(await attempt(s.dup.id, s.sam.id)).toMatch(/would still stand in loose_notes\.detail_json \(1\)/);
      expect(userById(s.t.ctx.db, s.dup.id)).toMatchObject({ disabled_at: null, merged_into: null });
      expect((await s.dup.c.get('/api/me')).statusCode).toBe(200);
    } finally {
      s.t.ctx.db.raw.exec('DROP TABLE loose_notes');
      before = dump(s.t);
    }
  });

  it('a row can only be merged if it is disabled too, and never into itself (the schema’s own check)', () => {
    expect(() => s.t.ctx.db.exec('UPDATE users SET merged_into = ? WHERE id = ?', [s.sam.id, s.dup.id])).toThrow(/CHECK constraint failed/);
    expect(() => s.t.ctx.db.exec('UPDATE users SET merged_into = id, disabled_at = 1 WHERE id = ?', [s.dup.id])).toThrow(/CHECK constraint failed/);
  });
});

describe('followMerge', () => {
  let s: Scene;

  beforeAll(async () => {
    s = await scene();
  });

  afterAll(async () => {
    await endScene(s);
  });

  it('an account not merged is itself; a trail is followed to its end, a few hops at most, and never round a loop', () => {
    const db = s.t.ctx.db;
    const row = (id: string) => userById(db, id)!;
    expect(followMerge(db, row(s.sam.id))?.id).toBe(s.sam.id);
    const point = (from: string, to: string) => db.exec('UPDATE users SET disabled_at = 1, merged_into = ? WHERE id = ?', [to, from]);
    point(s.dup.id, s.pat.id);
    point(s.pat.id, s.sam.id);
    expect(followMerge(db, row(s.dup.id))?.id).toBe(s.sam.id);
    // A loop (never made by a merge, which refuses a merged survivor) ends nowhere.
    point(s.sam.id, s.dup.id);
    expect(followMerge(db, row(s.dup.id))).toBeUndefined();
    // Nor does a trail longer than any merge leaves.
    db.exec('UPDATE users SET disabled_at = NULL, merged_into = NULL WHERE id = ?', [s.sam.id]);
    const chain = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
    for (const id of chain) db.exec('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, 1)', [id, id]);
    chain.forEach((id, i) => point(id, chain[i + 1] ?? s.dup.id));
    expect(followMerge(db, row('h1'))).toBeUndefined();
    expect(followMerge(db, row('h4'))?.id).toBe(s.sam.id);
  });
});

describe('bookclub merge-accounts, the command itself', () => {
  let s: Scene;

  beforeAll(async () => {
    s = await scene();
  });

  afterAll(async () => {
    await endScene(s);
  });

  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'merge-accounts', ...args], { cwd: SERVER, encoding: 'utf8', env: { ...process.env, DATA_DIR: s.t.dir, LOG_LEVEL: 'silent' } });

  it('plans, refuses, merges after a snapshot, and says "already merged" the second time', () => {
    const pair = ['--from', s.dup.id, '--into', s.sam.id, '--reason', 'Sam signed up twice'];
    const missing = cli('--from', s.dup.id, '--into', s.sam.id);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('merge-accounts needs --from ID (the account merged away), --into ID (the account kept) and --reason TEXT');

    const plan = cli(...pair);
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.stdout).toContain('DRY RUN: this is what --apply would do. Nothing was written.');
    expect(plan.stdout).toContain('memberships');
    expect(userById(s.t.ctx.db, s.dup.id)).toMatchObject({ disabled_at: null, merged_into: null });

    const noSnapshot = cli(...pair, '--apply');
    expect(noSnapshot.status).toBe(1);
    expect(noSnapshot.stderr).toContain('--apply needs --backup-dir DIR');
    expect(userById(s.t.ctx.db, s.dup.id)).toMatchObject({ merged_into: null });

    const unknown = cli('--from', 'nobody-at-all', '--into', s.sam.id, '--reason', 'x', '--apply', '--backup-dir', s.backups);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('no account nobody-at-all (--from)');
    expect(readdirSync(s.backups)).toEqual([]);

    const applied = cli(...pair, '--apply', '--backup-dir', s.backups);
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toMatch(/^merged \(merge [A-Za-z0-9_-]+\)\n/);
    const [snapshot] = readdirSync(s.backups);
    expect(snapshot).toMatch(/^pre-merge-\d{8}T\d{6}Z\.db$/);
    expect(applied.stdout).toContain(`snapshot taken before the merge: ${path.join(s.backups, snapshot!)}`);
    expect(statSync(path.join(s.backups, snapshot!)).mode & 0o777).toBe(0o600);
    expect(userById(s.t.ctx.db, s.dup.id)).toMatchObject({ merged_into: s.sam.id });

    const again = cli(...pair, '--apply', '--backup-dir', s.backups);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/^already merged: /);
    expect(readdirSync(s.backups)).toHaveLength(1);
  });
});
