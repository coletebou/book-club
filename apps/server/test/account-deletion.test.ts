import { ApiErrorSchema, type BookDetail, type ClubDetail } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALICE_EPUB, type Client, PASSWORD, type Res, type TestApp, bookDetail, closeApp, createImport, fileFrom, joinClub, makeTestApp, openSocket, readEpubTo, setupOwner, signIn, uploadBook } from './helpers';

/*
 * A person deletes their own account (D229): POST /api/me/delete. The App Store asks that an app
 * which makes accounts lets people end theirs from inside it, so this is the real flow over HTTP,
 * with the database read afterwards for what is gone and what is left.
 */

const errorOf = (res: Res) => ApiErrorSchema.parse(res.json()).error;

describe('deleting your own account (D229)', () => {
  let t: TestApp;
  let owner: Client;
  let club: ClubDetail;
  let book: BookDetail;
  let seq = 0;

  const count = (sql: string, ...params: string[]) => Number(t.ctx.db.get<{ n: number }>(sql, params)?.n);
  const idOf = async (c: Client) => (await c.json<{ user: { id: string } }>(c.get('/api/me'), 200)).user.id;
  /** A new person in the first club, under a name nobody used yet. */
  const person = async (name: string) => joinClub(t, club, `${name} ${++seq}`);
  const emailOf = (name: string) => `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`;
  const remove = (c: Client, body: Record<string, unknown> = { password: PASSWORD }) => c.post('/api/me/delete', body);

  beforeAll(async () => {
    t = await makeTestApp({ SIGNIN_ATTEMPTS: '3' });
    ({ owner, club } = await setupOwner(t));
    const { bookId } = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
    await t.settle();
    book = await bookDetail(owner, bookId);
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('needs a signed-in person, and proof of the password: nothing is deleted without both', async () => {
    const pat = await person('Pat');
    const id = await idOf(pat);
    expect((await t.client().post('/api/me/delete', { password: PASSWORD })).statusCode).toBe(401);
    const none = await remove(pat, {});
    expect(none.statusCode).toBe(400);
    expect(errorOf(none)).toMatchObject({ code: 'invalid_credentials', fields: { password: 'Incorrect' } });
    // The word that stands in for a password on an account with none does not stand in for one here.
    expect((await remove(pat, { confirm: 'DELETE' })).statusCode).toBe(400);
    expect((await remove(pat, { password: 'not the password' })).statusCode).toBe(400);
    expect((await pat.get('/api/me')).statusCode).toBe(200);
    expect(count('SELECT COUNT(*) AS n FROM users WHERE id = ? AND deleted_at IS NULL AND email IS NOT NULL', id)).toBe(1);
  });

  it('is rate limited per person, like a password change', async () => {
    const pat = await person('Pat');
    for (let i = 0; i < 10; i++) expect((await remove(pat, { password: 'wrong wrong wrong' })).statusCode).toBe(400);
    const limited = await remove(pat);
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('rate_limited');
    expect((await pat.get('/api/me')).statusCode).toBe(200);
  });

  it('removes what is personal, ends every session and socket, and frees the address', async () => {
    const pat = await person('Pat');
    const email = emailOf(`Pat ${seq}`);
    const id = await idOf(pat);
    const other = await signIn(t, email); // a second device
    const socket = await openSocket(t, pat);
    // Something of each kind: reading, a push token, a calendar link, an upload not finished.
    await readEpubTo(pat, book, 0.3);
    expect((await pat.post('/api/push/register', { token: 'a'.repeat(64) })).statusCode).toBe(204);
    expect((await pat.post('/api/me/calendar')).statusCode).toBe(200);
    const pending = await createImport(pat, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')]);
    expect(count('SELECT COUNT(*) AS n FROM progress WHERE user_id = ?', id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', id)).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM imports WHERE id = ?', pending.id)).toBe(1);

    const res = await remove(pat);
    expect(res.statusCode).toBe(204);
    // This device is told to forget what it kept, as after signing out.
    expect(res.headers['clear-site-data']).toBe('"cache", "storage"');
    expect(pat.cookies.has('bc_session')).toBe(false);

    expect((await pat.get('/api/me')).statusCode).toBe(401);
    expect((await other.get('/api/me')).statusCode).toBe(401);
    expect((await socket.closed).code).toBe(4001);
    expect((await t.client().post('/api/auth/signin', { email, password: PASSWORD })).statusCode).toBe(401);

    const row = t.ctx.db.get<{ display_name: string; email: string | null; password_hash: string | null; upstream_subject: string | null; disabled_at: number | null; deleted_at: number | null }>(
      'SELECT * FROM users WHERE id = ?',
      [id],
    )!;
    expect(row).toMatchObject({ display_name: 'Former member', email: null, password_hash: null, upstream_subject: null });
    expect(row.disabled_at).not.toBeNull();
    expect(row.deleted_at).toBe(row.disabled_at);
    for (const table of ['sessions', 'progress', 'push_tokens', 'calendar_feeds', 'memberships', 'imports']) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, id), table).toBe(0);
    }
    expect(count('SELECT COUNT(*) AS n FROM uploads WHERE import_id = ?', pending.id)).toBe(0);
    // The address is free: the same person (or anyone) can make a new account with it, empty.
    const again = t.client();
    const signup = await again.post('/api/auth/signup', { inviteCode: club.invite!.code, displayName: 'Pat again', email, password: PASSWORD });
    expect(signup.statusCode).toBe(201);
    expect(await idOf(again)).not.toBe(id);
  });

  it('leaves their notes and messages in the club, shown as a Former member, and their books with it', async () => {
    const pat = await person('Pat');
    const id = await idOf(pat);
    const epub = book.editions.find((e) => e.kind === 'epub')!;
    const note = await pat.json<{ id: string }>(pat.post(`/api/books/${book.id}/comments`, { editionId: epub.id, locator: { kind: 'epub', section: 0, offset: 5 }, text: 'a note of mine' }), 201);
    const message = await pat.json<{ id: string }>(pat.post(`/api/clubs/${club.id}/chat`, { text: 'hello from Pat' }), 201);
    const { bookId } = await uploadBook(pat, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Pat’s pick', author: 'Anon' });
    await t.settle();

    expect((await remove(pat)).statusCode).toBe(204);

    expect(t.ctx.db.get<{ user_id: string }>('SELECT user_id FROM comments WHERE id = ?', [note.id])?.user_id).toBe(id);
    expect(t.ctx.db.get<{ user_id: string }>('SELECT user_id FROM chat_messages WHERE id = ?', [message.id])?.user_id).toBe(id);
    expect(t.ctx.db.get<{ created_by: string; deleted_at: number | null }>('SELECT created_by, deleted_at FROM books WHERE id = ?', [bookId])).toMatchObject({ created_by: id, deleted_at: null });
    // What the club reads: the text, under the name that replaced theirs.
    const chat = await owner.json<{ messages: { id: string; text?: string; author: { displayName: string } }[] }>(owner.get(`/api/clubs/${club.id}/chat`), 200);
    expect(chat.messages.find((m) => m.id === message.id)).toMatchObject({ text: 'hello from Pat', author: { userId: id, displayName: 'Former member' } });
    const notes = await owner.json<{ id: string; authorName: string }[]>(owner.get(`/api/books/${book.id}/comments`), 200);
    expect(notes.find((n) => n.id === note.id)?.authorName).toBe('Former member');
    expect((await owner.get(`/api/clubs/${club.id}`)).statusCode).toBe(200);
  });

  it('hands a club to the member who has been in it longest, and leaves ones they only belonged to', async () => {
    const pat = await person('Pat');
    const patId = await idOf(pat);
    const mine = await pat.json<ClubDetail>(pat.post('/api/clubs', { name: 'Pat’s club' }), 201);
    const first = await joinClub(t, mine, `First ${++seq}`);
    const second = await joinClub(t, mine, `Second ${++seq}`);
    const firstId = await idOf(first);
    // Same millisecond as the second's join must not decide it: the one who joined first is older.
    t.ctx.db.exec('UPDATE memberships SET joined_at = joined_at - 5000 WHERE club_id = ? AND user_id = ?', [mine.id, firstId]);
    // A club Pat only belongs to, and one Pat owns beside another owner, are each left as they are.
    const shared = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Shared' }), 201);
    const guest = await joinClub(t, shared, `Guest ${++seq}`);
    const guestId = await idOf(guest);
    expect((await pat.post(`/api/invites/${shared.invite!.code}/accept`)).statusCode).toBe(200);
    expect((await owner.put(`/api/clubs/${shared.id}/members/${patId}/role`, { role: 'owner' })).statusCode).toBe(200);
    const co = await owner.json<ClubDetail>(owner.post('/api/clubs', { name: 'Two owners' }), 201);
    expect((await pat.post(`/api/invites/${co.invite!.code}/accept`)).statusCode).toBe(200);

    expect((await remove(pat)).statusCode).toBe(204);

    const roles = (clubId: string) => t.ctx.db.all<{ user_id: string; role: string }>('SELECT user_id, role FROM memberships WHERE club_id = ? ORDER BY joined_at', [clubId]);
    expect(roles(mine.id)).toEqual([
      { user_id: firstId, role: 'owner' },
      { user_id: await idOf(second), role: 'member' },
    ]);
    // The new owner is the club's owner as the app sees it, and the other member is not.
    expect((await first.json<ClubDetail>(first.get(`/api/clubs/${mine.id}`), 200)).role).toBe('owner');
    expect((await second.json<ClubDetail>(second.get(`/api/clubs/${mine.id}`), 200)).role).toBe('member');
    // Shared had two owners: the other goes on, with its guest still a member. The club Pat only joined loses one member.
    expect(roles(shared.id).map((m) => m.role).sort()).toEqual(['member', 'owner']);
    expect(roles(shared.id).find((m) => m.user_id === guestId)).toEqual({ user_id: guestId, role: 'member' });
    expect(roles(co.id).map((m) => m.role)).toEqual(['owner']);
    expect(count('SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?', patId)).toBe(0);
    expect((await first.get('/api/me')).statusCode).toBe(200);
  });

  it('disbands a club they were the only member of, through the recoverable path (D179), and nobody else’s', async () => {
    const pat = await person('Pat');
    const patId = await idOf(pat);
    const alone = await pat.json<ClubDetail>(pat.post('/api/clubs', { name: 'Pat alone' }), 201);

    expect((await remove(pat)).statusCode).toBe(204);

    const row = t.ctx.db.get<{ deleted_at: number | null; deleted_by: string | null }>('SELECT deleted_at, deleted_by FROM clubs WHERE id = ?', [alone.id])!;
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).toBe(patId);
    // Still there for the operator to undelete or purge, not erased.
    expect(count('SELECT COUNT(*) AS n FROM clubs WHERE id = ?', alone.id)).toBe(1);
    // Nobody can reach it, and the first club, which others are in, is untouched.
    expect((await owner.get(`/api/clubs/${alone.id}`)).statusCode).toBe(404);
    expect(count('SELECT COUNT(*) AS n FROM clubs WHERE id = ? AND deleted_at IS NULL', club.id)).toBe(1);
  });

  it('an account with no password confirms with the word DELETE, typed', async () => {
    const pat = await person('Pat');
    const id = await idOf(pat);
    // As an account made by Apple, Google or the upstream: nothing to re-type.
    t.ctx.db.exec('UPDATE users SET password_hash = NULL WHERE id = ?', [id]);
    t.ctx.db.exec("INSERT INTO external_identities (provider, subject, user_id, email, created_at) VALUES ('apple', ?, ?, NULL, ?)", [`apple-${id}`, id, Date.now()]);

    for (const body of [{}, { confirm: 'delete me' }, { password: PASSWORD }]) {
      const res = await remove(pat, body);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toMatchObject({ code: 'confirmation_required', fields: { confirm: 'Type DELETE' } });
    }
    expect((await pat.get('/api/me')).statusCode).toBe(200);
    expect((await remove(pat, { confirm: 'DELETE' })).statusCode).toBe(204);
    expect((await pat.get('/api/me')).statusCode).toBe(401);
    // The identity is gone with the account: signing in with Apple again would start a new one.
    expect(count('SELECT COUNT(*) AS n FROM external_identities WHERE user_id = ?', id)).toBe(0);
  });

  it('erases what a merge archived about them, and keeps who went into whom', async () => {
    const pat = await person('Pat');
    const id = await idOf(pat);
    const survivor = await person('Survivor');
    t.ctx.db.exec("INSERT INTO account_merges (id, loser_id, survivor_id, merged_at, reason, counts_json, archive_json) VALUES ('m1', ?, ?, 1, 'same person, pat@old.example', '{}', '{\"users\":[{\"email\":\"pat@old.example\"}]}')", [id, await idOf(survivor)]);
    expect((await remove(pat)).statusCode).toBe(204);
    expect(t.ctx.db.get('SELECT loser_id, merged_at, reason, archive_json FROM account_merges WHERE id = ?', ['m1'])).toEqual({
      loser_id: id,
      merged_at: 1,
      reason: 'erased',
      archive_json: '{"erased":true}',
    });
    // Still append-only for anything but that.
    expect(() => t.ctx.db.exec("UPDATE account_merges SET reason = 'rewritten' WHERE id = 'm1'")).toThrow(/append-only/);
    expect(() => t.ctx.db.exec("DELETE FROM account_merges WHERE id = 'm1'")).toThrow(/append-only/);
  });

  it('has a decision for every column that references a user, so a table added later cannot be forgotten', () => {
    const references: string[] = [];
    for (const { name } of t.ctx.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
      for (const fk of t.ctx.db.all<{ table: string; from: string }>(`PRAGMA foreign_key_list("${name}")`)) {
        if (fk.table === 'users') references.push(`${name}.${fk.from}`);
      }
    }
    // Deleted with the account.
    const erased = [
      'sessions.user_id', 'sign_in_codes.user_id', 'app_auth_codes.user_id', 'password_resets.user_id', 'password_resets.created_by', 'external_identities.user_id', 'push_tokens.user_id',
      'calendar_feeds.user_id', 'progress.user_id', 'edition_progress.user_id', 'reading_sessions.user_id', 'book_playback.user_id', 'book_audio_controls.user_id',
      'listening_settings.user_id', 'audio_controls_default.user_id', 'chat_dnd.user_id', 'chat_reads.user_id', 'cal_settings.user_id', 'cal_conversations.user_id', 'cal_cost_log.user_id',
      'chat_reactions.user_id', 'meeting_rsvps.user_id', 'meetup_question_votes.user_id', 'nomination_votes.user_id', 'notifications.user_id', 'notifications.actor_id',
    ];
    // Some of each: a membership goes (a club they were alone in keeps its row, disbanded), and an
    // import still uploading goes with its files while a finished one is a book the club has.
    const mixed = ['memberships.user_id', 'imports.user_id', 'uploads.user_id'];
    // Emptied: the row is not theirs, it only says who asked.
    const cleared = ['chat_messages.spoiler_user_id', 'agent_deliveries.asker_id'];
    // Kept, shown as a Former member: what they shared with a club, and what the club's own rows name.
    const kept = [
      'comments.user_id', 'chat_messages.user_id', 'comment_media.user_id', 'chat_attachments.user_id', 'clubs.created_by', 'books.created_by', 'editions.created_by', 'invites.created_by',
      'series.created_by', 'nominations.created_by', 'nomination_rounds.opened_by', 'nomination_rounds.closed_by', 'meeting_points.set_by', 'meetup_questions.author_id',
      'meetup_questions.asked_by', 'meetup_question_asks.user_id', 'cal_shelf_items.user_id', 'users.merged_into',
    ];
    expect([...references].sort()).toEqual([...erased, ...cleared, ...kept, ...mixed].sort());
  });
});
