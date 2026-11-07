import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { type Chapter, type EditionGeometry, type EditionKind, type Locator, MAX_COVER_BYTES, MAX_EDITION_UNITS, type Span, type TiePoint, linearSyncMap, mToT } from '@bookclub/shared';
import { type FastifyBaseLogger } from 'fastify';
import { parseFile } from 'music-metadata';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RateLimiter } from '../src/auth/ratelimit';
import { challengeOf, identityOf, newFlight, openFlight, sameState, sealFlight, startAddress } from '../src/auth/upstream';
import { loadConfig } from '../src/config';
import { type AppContext } from '../src/context';
import { Db, loadMigrations, migrate, openDb } from '../src/db/db';
import { MAX_CHAPTERS_PER_TRACK, TrackReader, TrackTimeoutError, looksLikeAudio, looksLikeImage, looksLikePdf, looksLikeZip, inspectTrack, readLimitMs } from '../src/ingest/audio';
import { COVER_DRAWING, coverThumbnail, generatedCoverSvg, generatedCoverWebp, normaliseCover, pickCoverWidth, wrapTitle } from '../src/ingest/covers';
import { inspectPdf } from '../src/ingest/pdf';
import { placeOnTimeline } from '../src/ingest/pipeline';
import { cleanTitle } from '../src/ingest/text';
import { readTrack } from '../src/ingest/track-worker';
import { DUMMY_PASSWORD_HASH, hashPassword, newId, newToken, setScryptCost, sha256Hex, verifyPassword } from '../src/lib/crypto';
import { HttpError, badRequest, conflict, forbidden, notFound, parse, tooMany, unauthorized, zodFields } from '../src/lib/errors';
import { fromJson, iso, isoRequired, toJson } from '../src/lib/json';
import { deleteBlobRow, insertBlob, orphanBlobs, blobById, removeOrphanBlobs } from '../src/repos/blobs';
import { type AlignmentRecord, type BookRow, type EditionRow, addEditionFile, createBook, createEdition, setBookCover, deleteEdition } from '../src/repos/books';
import { addMember, createClub, memberIds } from '../src/repos/clubs';
import { createImport as createImportRow, createUploadRow, importById, latestUploads, markUploadComplete, setImportStatus } from '../src/repos/imports';
import { type Reading } from '../src/repos/progress';
import { type ReadAlongRow } from '../src/repos/readalong';
import { Gate, type Gated, HORIZON_PAGE, addReadSpans } from '../src/services/gating';
import { agreedRanges } from '../src/services/readalong';
import { MAX_SESSIONS_PER_USER, createSession, endSession, endUserSessions, purgeExpiredSessions, resolveSession } from '../src/repos/sessions';
import { createLocalUser, upsertUpstreamUser, userByEmail, userById } from '../src/repos/users';
import { Jobs } from '../src/services/jobs';
import { chapterLabel } from '../src/services/labels';
import { Storage, hashFile } from '../src/storage/storage';
import { chapFrame, craftM4b, ctocFrame, mp3With, textFrame } from './crafted-audio';
import { FIXTURES, ALICE_PDF, ALICE_TINY_AUDIO, SYNTHETIC_AUDIO } from './helpers';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bookclub-unit-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A logger that records what it was told (the job runner reports through it). */
function recordingLogger(): { log: FastifyBaseLogger; entries: { level: string; obj: unknown; msg: unknown }[] } {
  const entries: { level: string; obj: unknown; msg: unknown }[] = [];
  const at = (level: string) => (obj: unknown, msg?: unknown) => {
    entries.push({ level, obj, msg });
  };
  const log = {
    level: 'info',
    fatal: at('fatal'),
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    trace: at('trace'),
    silent: () => undefined,
    child: () => log,
  };
  return { log, entries };
}

/** A migrated database in a fresh directory. */
function freshDb(): Db {
  return openDb(path.join(tempDir(), 'test.db'));
}

describe('lib/crypto', () => {
  beforeAll(() => setScryptCost(10));

  it('makes URL-safe random ids and tokens of the documented sizes', () => {
    expect(newId()).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newId(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 50 }, () => newToken())).size).toBe(50);
  });

  it('hashes sha256 as lowercase hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
  });

  it('round-trips a password through scrypt with its parameters stored in the hash', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    // Salted: the same password never hashes the same way twice.
    expect(await hashPassword('correct horse battery')).not.toBe(hash);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse batterz', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('verifies with the cost stored in the hash, not the current default', async () => {
    const hash = await hashPassword('another password', { N: 2048, r: 8, p: 1, keylen: 32 });
    expect(hash.startsWith('scrypt$2048$8$1$')).toBe(true);
    expect(await verifyPassword('another password', hash)).toBe(true);
  });

  it('normalises passwords (NFKC) so the same text typed on another keyboard matches', async () => {
    const hash = await hashPassword('ﬁve ﬁngers here');
    expect(await verifyPassword('five fingers here', hash)).toBe(true);
  });

  it('returns false for malformed hashes instead of throwing', async () => {
    const salt = 'A'.repeat(22);
    const key = 'A'.repeat(86);
    const malformed = [
      '',
      'not a hash',
      `bcrypt$1024$8$1$${salt}$${key}`,
      `scrypt$1024$8$1$${salt}`,
      `scrypt$abc$8$1$${salt}$${key}`,
      `scrypt$1$8$1$${salt}$${key}`,
      `scrypt$1024$0$1$${salt}$${key}`,
      `scrypt$1024$8$0$${salt}$${key}`,
      `scrypt$1024$8$1$${salt}$AAAA`,
      // Parameters scrypt itself refuses: N must be a power of two below 2^32.
      `scrypt$3$8$1$${salt}$${key}`,
      `scrypt$1099511627776$8$1$${salt}$${key}`,
    ];
    for (const stored of malformed) {
      await expect(verifyPassword('correct horse battery', stored), stored).resolves.toBe(false);
    }
  });

  it('never verifies anything against the dummy hash used for unknown emails', async () => {
    for (const guess of ['', 'password', 'correct horse battery', 'A'.repeat(64)]) {
      expect(await verifyPassword(guess, DUMMY_PASSWORD_HASH)).toBe(false);
    }
  });
});

describe('auth/ratelimit', () => {
  it('allows the limit within the window, then refuses', () => {
    const limiter = new RateLimiter(3, 1000);
    expect([1, 2, 3].map((i) => limiter.attempt('k', i))).toEqual([true, true, true]);
    expect(limiter.attempt('k', 4)).toBe(false);
    expect(limiter.attempt('k', 5)).toBe(false);
  });

  it('keeps keys independent', () => {
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.attempt('a', 0)).toBe(true);
    expect(limiter.attempt('a', 1)).toBe(false);
    expect(limiter.attempt('b', 1)).toBe(true);
  });

  it('slides the window: old attempts expire', () => {
    const limiter = new RateLimiter(2, 1000);
    limiter.attempt('k', 0);
    limiter.attempt('k', 500);
    expect(limiter.attempt('k', 999)).toBe(false);
    // The attempt at t=0 has left the window; refused attempts are not counted.
    expect(limiter.attempt('k', 1000)).toBe(true);
    expect(limiter.attempt('k', 1001)).toBe(false);
    expect(limiter.attempt('k', 2600)).toBe(true);
  });

  it('reset forgets a key', () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.attempt('k', 0);
    expect(limiter.attempt('k', 1)).toBe(false);
    limiter.reset('k');
    expect(limiter.attempt('k', 2)).toBe(true);
  });

  it('prunes stale keys, and prunes by itself once it tracks more than 10 000 keys', () => {
    const limiter = new RateLimiter(5, 1000);
    const size = () => (limiter as unknown as { hits: Map<string, number[]> }).hits.size;
    limiter.attempt('old', 0);
    limiter.attempt('recent', 900);
    limiter.prune(1500);
    expect(size()).toBe(1);
    for (let i = 0; i < 9_999; i++) limiter.attempt(`flood-${i}`, 1000);
    expect(size()).toBe(10_000);
    // Key 10 001 triggers a prune: everything older than the window goes.
    limiter.attempt('late', 5000);
    expect(size()).toBe(1);
    expect(limiter.attempt('late', 5001)).toBe(true);
  });
});

describe('lib/errors', () => {
  const Body = z.object({ email: z.string().trim().toLowerCase().pipe(z.email({ error: 'Enter a valid email address' })), age: z.number().int() });

  it('parse returns the parsed (and transformed) value', () => {
    expect(parse(Body, { email: '  ANA@Example.com ', age: 3 })).toEqual({ email: 'ana@example.com', age: 3 });
  });

  it('parse throws a 400 HttpError with one message per field', () => {
    let error: unknown;
    try {
      parse(Body, { email: 'nope', age: 1.5 });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(HttpError);
    const e = error as HttpError;
    expect(e.status).toBe(400);
    expect(e.code).toBe('bad_request');
    expect(e.name).toBe('HttpError');
    expect(e.message).toBe('Enter a valid email address');
    expect(Object.keys(e.fields ?? {}).sort()).toEqual(['age', 'email']);
  });

  it('puts issues about the whole value under "_" and keeps the first message per field', () => {
    const result = z.string().safeParse(5);
    expect(result.success).toBe(false);
    expect(zodFields(result.error!)).toEqual({ _: expect.any(String) as string });
    const two = z.object({ a: z.string().min(3, { error: 'first' }).regex(/x/, { error: 'second' }) }).safeParse({ a: 'b' });
    expect(zodFields(two.error!)).toEqual({ a: 'first' });
  });

  it('has helpers for every error the API sends', () => {
    expect([unauthorized(), forbidden(), notFound(), conflict('c'), badRequest('b', { f: 'x' }), tooMany()].map((e) => [e.status, e.code])).toEqual([
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [400, 'bad_request'],
      [429, 'rate_limited'],
    ]);
    expect(badRequest('b', { f: 'x' }).fields).toEqual({ f: 'x' });
    expect(unauthorized().message).toBe('Sign in to continue.');
  });
});

describe('lib/json', () => {
  it('reads JSON columns with a fallback for empty values and surfaces corrupt ones', () => {
    expect(fromJson(null, [1])).toEqual([1]);
    expect(fromJson('', { a: 1 })).toEqual({ a: 1 });
    expect(fromJson(42, 'x')).toBe('x');
    expect(fromJson('{"a":[1,2]}', {})).toEqual({ a: [1, 2] });
    expect(() => fromJson('{broken', {})).toThrow(SyntaxError);
    expect(toJson({ a: 1 })).toBe('{"a":1}');
  });

  it('formats millisecond timestamps as ISO strings', () => {
    expect(iso(null)).toBeNull();
    expect(iso(undefined)).toBeNull();
    expect(iso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(isoRequired(Date.UTC(2026, 9, 23, 12, 56))).toBe('2026-10-23T12:56:00.000Z');
  });
});

describe('services/labels', () => {
  it('labels a timeline position with the chapter it falls in and the percentage', () => {
    const chapters: Chapter[] = [
      { index: 0, title: 'Contents', t: 0 },
      { index: 1, title: 'CHAPTER I. Down the Rabbit-Hole', t: 0.1 },
      { index: 2, title: 'CHAPTER III. A Caucus-Race and a Long Tale', t: 0.2 },
    ];
    // The contents are front matter: a place there is before the story's first chapter (D77).
    expect(chapterLabel(chapters, 0.01)).toBe('Before Chapter 1 · 1%');
    expect(chapterLabel(chapters, 0.24)).toBe('Chapter 3 · 24%');
    expect(chapterLabel([], 0.5)).toBe('50%');
  });
});

describe('services/jobs', () => {
  it('is idle straight away when nothing was queued', async () => {
    const jobs = new Jobs(recordingLogger().log);
    expect(jobs.pending).toBe(0);
    await expect(jobs.idle()).resolves.toBeUndefined();
  });

  it('runs jobs one at a time in the order they were queued', async () => {
    const { log } = recordingLogger();
    const jobs = new Jobs(log);
    const events: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const job = (name: string, ms: number) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      events.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      events.push(`end ${name}`);
      running--;
    };
    jobs.enqueue('a', job('a', 30));
    jobs.enqueue('b', job('b', 5));
    jobs.enqueue('c', job('c', 1));
    expect(jobs.pending).toBe(3);
    await jobs.idle();
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(maxRunning).toBe(1);
    expect(jobs.pending).toBe(0);
  });

  it('isolates failures: a failing job is logged and the next one still runs', async () => {
    const { log, entries } = recordingLogger();
    const jobs = new Jobs(log);
    const ran: string[] = [];
    jobs.enqueue('boom', async () => {
      await Promise.resolve();
      throw new Error('kaput');
    });
    jobs.enqueue('after', async () => {
      await Promise.resolve();
      ran.push('after');
    });
    await jobs.idle();
    expect(ran).toEqual(['after']);
    const failed = entries.find((e) => e.level === 'error');
    expect(failed?.msg).toBe('job failed');
    expect(failed?.obj).toMatchObject({ job: 'boom', err: expect.objectContaining({ message: 'kaput' }) as unknown });
    expect(entries.filter((e) => e.msg === 'job done').map((e) => (e.obj as { job: string }).job)).toEqual(['after']);
  });

  it('wakes every idle waiter, including jobs queued while others run', async () => {
    const jobs = new Jobs(recordingLogger().log);
    const ran: number[] = [];
    jobs.enqueue('first', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      ran.push(1);
      jobs.enqueue('second', async () => {
        await Promise.resolve();
        ran.push(2);
      });
    });
    await Promise.all([jobs.idle(), jobs.idle()]);
    expect(ran).toEqual([1, 2]);
  });
});

describe('db/db', () => {
  it('migrates a fresh database once, idempotently', () => {
    const file = path.join(tempDir(), 'm.db');
    const db = new Db(file);
    expect(migrate(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
    expect(migrate(db)).toEqual([]);
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(22);
    // 022: a chat reply names its thread's root (D200).
    expect(db.all<{ name: string }>('PRAGMA table_info(chat_messages)').map((c) => c.name)).toContain('thread_id');
    // 018: disbanded clubs and removed books are kept, marked (D179).
    expect(db.all<{ name: string }>('PRAGMA table_info(books)').map((c) => c.name)).toEqual(expect.arrayContaining(['deleted_at', 'deleted_by']));
    // 009: how often reading an edition's files has started since it last ended.
    expect(db.all<{ name: string }>('PRAGMA table_info(editions)').map((c) => c.name)).toContain('ingest_starts');
    // 010: where a comment's writer had read to (D69).
    expect(db.all<{ name: string }>('PRAGMA table_info(comments)').map((c) => c.name)).toEqual(expect.arrayContaining(['horizon_edition_id', 'horizon_locator_json', 'horizon_t']));
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'users',
        'sessions',
        'clubs',
        'memberships',
        'books',
        'editions',
        'progress',
        'comments',
        'transcripts',
        'readalong',
        'notifications',
        'ended_sessions',
        'meeting_points',
        'transcriptions',
        'edition_progress',
        // 011: one-time sign-in codes (D87).
        'sign_in_codes',
        // 014: the iOS app's device push tokens (D134).
        'push_tokens',
        // 019: your own reading and listening history (D191).
        'reading_sessions',
        // 021: the audiobook's controls shown or hidden, your default and a book's own (D197).
        'audio_controls_default',
        'book_audio_controls',
      ]),
    );
    db.close();
    // Re-opening the same file applies nothing new.
    const again = openDb(file);
    expect(migrate(again)).toEqual([]);
    expect(again.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(22);
    again.close();
  });

  it('loads numbered migrations in order and ignores other files', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, '002_second.sql'), 'CREATE TABLE b (x);');
    writeFileSync(path.join(dir, '001_first.sql'), 'CREATE TABLE a (x);');
    writeFileSync(path.join(dir, 'README.md'), 'not a migration');
    writeFileSync(path.join(dir, '3_bad_name.sql'), 'CREATE TABLE c (x);');
    expect(loadMigrations(dir).map((m) => [m.version, m.name])).toEqual([
      [1, '001_first.sql'],
      [2, '002_second.sql'],
    ]);
    // 012 and 013 are other workstreams' migration numbers (book-club-20261028); this lists the
    // real migrations directory as it stands once this workstream's own is in it.
    expect(loadMigrations().map((m) => m.name)).toEqual([
      '001_init.sql',
      '002_member_colors.sql',
      '003_readalong.sql',
      '004_replies_notifications.sql',
      '005_ended_sessions.sql',
      '006_meeting_points.sql',
      '007_transcriptions.sql',
      '008_edition_progress.sql',
      '009_ingest_starts.sql',
      '010_comment_horizons.sql',
      '011_sign_in_codes.sql',
      '012_cal.sql',
      '013_note_media.sql',
      '014_push_tokens.sql',
      '015_live.sql',
      '016_chat_dnd.sql',
      '017_external_identities.sql',
      '018_soft_delete.sql',
      '019_reading_history.sql',
      '020_playback_speed.sql',
      '021_audio_controls.sql',
      '022_chat_threads.sql',
    ]);
  });

  it("022 gives every reply sent before it its thread's root, however deep its chain (D200)", () => {
    const db = new Db(path.join(tempDir(), 'threads.db'));
    const before = loadMigrations().filter((m) => m.version < 22);
    migrate(db, before);
    const now = Date.now();
    db.exec("INSERT INTO users (id, display_name, created_at) VALUES ('u1', 'Ana', ?)", [now]);
    db.exec("INSERT INTO clubs (id, name, description, created_by, created_at) VALUES ('c1', 'Club', '', 'u1', ?)", [now]);
    const insert = (id: string, parent: string | null) =>
      db.exec("INSERT INTO chat_messages (id, club_id, user_id, parent_id, text, created_at) VALUES (?, 'c1', 'u1', ?, ?, ?)", [id, parent, id, now]);
    insert('root', null);
    insert('r1', 'root');
    insert('r2', 'r1');
    insert('r3', 'r2');
    insert('other', null);
    expect(migrate(db)).toEqual([22]);
    const roots = Object.fromEntries(db.all<{ id: string; thread_id: string | null }>('SELECT id, thread_id FROM chat_messages').map((r) => [r.id, r.thread_id]));
    expect(roots).toEqual({ root: null, r1: 'root', r2: 'root', r3: 'root', other: null });
    db.close();
  });

  it('applies only newer migrations, and a failing one leaves nothing behind', () => {
    const db = freshDb();
    // Numbered past the real migrations, whatever the newest is: a version the real set already
    // reached would never be "newer" and so never apply.
    const real = loadMigrations();
    const next = Math.max(...real.map((m) => m.version)) + 1;
    expect(migrate(db, [...real, { version: next, name: `${next}_extra.sql`, sql: 'CREATE TABLE extra (x INTEGER);' }])).toEqual([next]);
    expect(() => migrate(db, [{ version: next + 1, name: `${next + 1}_bad.sql`, sql: 'CREATE TABLE half (x); INSERT INTO missing VALUES (1);' }])).toThrow();
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(next);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'half'")).toBeUndefined();
    db.close();
  });

  it('gives the members of an existing club colour slots in the order they joined', () => {
    const db = new Db(path.join(tempDir(), 'colors.db'));
    const [first, second] = loadMigrations();
    migrate(db, [first!]);
    for (const u of ['u1', 'u2', 'u3', 'u4']) db.exec("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, 0)", [u, `${u}@example.com`, u]);
    for (const c of ['clubA', 'clubB']) db.exec("INSERT INTO clubs (id, name, description, created_by, created_at) VALUES (?, ?, '', 'u1', 0)", [c, c]);
    const join = (club: string, user: string, at: number) => db.exec("INSERT INTO memberships (club_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", [club, user, at]);
    join('clubA', 'u3', 300);
    join('clubA', 'u1', 100);
    join('clubA', 'u4', 100); // the same moment as u1: the id breaks the tie
    join('clubA', 'u2', 200);
    join('clubB', 'u2', 50);
    join('clubB', 'u1', 60);
    expect(migrate(db, [first!, second!])).toEqual([2]);
    const slots = db.all<{ club_id: string; user_id: string; color: number }>('SELECT club_id, user_id, color FROM memberships ORDER BY club_id, color');
    expect(slots.map((r) => `${r.club_id}:${r.user_id}=${r.color}`)).toEqual(['clubA:u1=0', 'clubA:u4=1', 'clubA:u2=2', 'clubA:u3=3', 'clubB:u2=0', 'clubB:u1=1']);
    db.close();
  });

  it('keeps what was read in an edition that is deleted as read, in a format no longer known', () => {
    const db = new Db(path.join(tempDir(), 'fold.db'));
    migrate(db, loadMigrations());
    db.exec("INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'u1@example.com', 'U', 0)");
    db.exec("INSERT INTO clubs (id, name, description, created_by, created_at) VALUES ('c1', 'C', '', 'u1', 0)");
    db.exec("INSERT INTO books (id, club_id, title, created_by, created_at) VALUES ('b1', 'c1', 'B', 'u1', 0)");
    // A PDF of 20 pages on the timeline's second half; a page read twice over, and pages 0 to 4.
    db.exec(
      "INSERT INTO editions (id, book_id, kind, status, created_by, created_at, sync_json) VALUES ('pdf', 'b1', 'pdf', 'ready', 'u1', 0, '{\"points\":[{\"m\":0,\"t\":0.5},{\"m\":20,\"t\":1}]}')",
    );
    db.exec("INSERT INTO progress (user_id, book_id, edition_id, t, read_ranges_json, unplaced_ranges_json, updated_at) VALUES ('u1', 'b1', 'pdf', 0.6, '[[0.5,0.625]]', '[[0.1,0.2]]', 0)");
    db.exec("INSERT INTO edition_progress (user_id, book_id, edition_id, read_ranges_json, updated_at) VALUES ('u1', 'b1', 'pdf', '[[0,4],[2,5]]', 0)");
    deleteEdition(db, 'pdf');
    expect(db.all('SELECT * FROM edition_progress')).toEqual([]);
    expect(JSON.parse(db.get<{ unplaced_ranges_json: string }>('SELECT unplaced_ranges_json FROM progress')!.unplaced_ranges_json)).toEqual([
      [0.1, 0.2],
      [0.5, 0.625],
    ]);
    db.close();
  });

  it('keeps what was read before ranges were kept per edition as read in an unknown format', () => {
    const db = new Db(path.join(tempDir(), 'ranges.db'));
    const migrations = loadMigrations();
    migrate(db, migrations.filter((m) => m.version < 8));
    db.exec("INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'u1@example.com', 'U', 0)");
    db.exec("INSERT INTO clubs (id, name, description, created_by, created_at) VALUES ('c1', 'C', '', 'u1', 0)");
    db.exec("INSERT INTO books (id, club_id, title, created_by, created_at) VALUES ('b1', 'c1', 'B', 'u1', 0)");
    db.exec("INSERT INTO progress (user_id, book_id, edition_id, t, read_ranges_json, updated_at) VALUES ('u1', 'b1', 'gone', 0.4, '[[0.1,0.4]]', 0)");
    expect(migrate(db, migrations)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
    expect(db.get('SELECT read_ranges_json, unplaced_ranges_json FROM progress')).toEqual({ read_ranges_json: '[[0.1,0.4]]', unplaced_ranges_json: '[[0.1,0.4]]' });
    expect(db.all('SELECT * FROM edition_progress')).toEqual([]);
    // Ranges kept per edition go with their edition, their book or their reader.
    db.exec("INSERT INTO editions (id, book_id, kind, status, created_by, created_at) VALUES ('e1', 'b1', 'epub', 'ready', 'u1', 0)");
    db.exec("INSERT INTO edition_progress (user_id, book_id, edition_id, read_ranges_json, updated_at) VALUES ('u1', 'b1', 'e1', '[[0,0.5]]', 0)");
    expect(() => db.exec("INSERT INTO edition_progress (user_id, book_id, edition_id, updated_at) VALUES ('u1', 'b1', 'nowhere', 0)")).toThrow(/FOREIGN KEY/);
    db.exec("DELETE FROM editions WHERE id = 'e1'");
    expect(db.all('SELECT * FROM edition_progress')).toEqual([]);
    db.close();
  });

  it('runs in WAL mode with foreign keys enforced', () => {
    const db = freshDb();
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    expect(() => db.exec("INSERT INTO memberships (club_id, user_id, role, joined_at) VALUES ('nope', 'nobody', 'member', 0)")).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('binds positional, named and no parameters, and reuses prepared statements', () => {
    const db = freshDb();
    expect(db.get<{ s: number }>('SELECT ? + ? AS s', [2, 3])?.s).toBe(5);
    expect(db.get<{ s: number }>('SELECT :a * :b AS s', { a: 4, b: 5 })?.s).toBe(20);
    expect(db.all<{ one: number }>('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    expect(db.get<{ s: number }>('SELECT ? + ? AS s', [10, 1])?.s).toBe(11);
    db.close();
    db.close(); // closing twice is harmless
  });

  it('commits a transaction and rolls it back when the function throws', () => {
    const db = freshDb();
    db.exec('CREATE TABLE t (v INTEGER)');
    expect(db.tx(() => db.exec('INSERT INTO t VALUES (1)').changes)).toBe(1);
    expect(() =>
      db.tx(() => {
        db.exec('INSERT INTO t VALUES (2)');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.all<{ v: number }>('SELECT v FROM t ORDER BY v').map((r) => r.v)).toEqual([1]);
    // The connection is usable again after a rollback.
    db.tx(() => db.exec('INSERT INTO t VALUES (3)'));
    expect(db.all<{ v: number }>('SELECT v FROM t ORDER BY v').map((r) => r.v)).toEqual([1, 3]);
    db.close();
  });

  it('nests transactions as savepoints: an inner failure rolls back only the inner work', () => {
    const db = freshDb();
    db.exec('CREATE TABLE t (v INTEGER)');
    db.tx(() => {
      db.exec('INSERT INTO t VALUES (1)');
      expect(() =>
        db.tx(() => {
          db.exec('INSERT INTO t VALUES (2)');
          db.tx(() => db.exec('INSERT INTO t VALUES (3)'));
          throw new Error('inner');
        }),
      ).toThrow('inner');
      db.tx(() => db.exec('INSERT INTO t VALUES (4)'));
    });
    expect(db.all<{ v: number }>('SELECT v FROM t ORDER BY v').map((r) => r.v)).toEqual([1, 4]);
    // An outer failure discards inner savepoints that had been released.
    expect(() =>
      db.tx(() => {
        db.tx(() => db.exec('INSERT INTO t VALUES (5)'));
        throw new Error('outer');
      }),
    ).toThrow('outer');
    expect(db.all<{ v: number }>('SELECT v FROM t ORDER BY v').map((r) => r.v)).toEqual([1, 4]);
    db.close();
  });
});

describe('storage/storage', () => {
  let storage: Storage;
  beforeAll(async () => {
    storage = new Storage(path.join(tempDir(), 'data'));
    await storage.init();
  });

  it('creates its directory layout under one root', () => {
    for (const dir of [storage.root, storage.blobsDir, storage.pubsDir, storage.uploadsDir, storage.derivedDir, storage.tmpDir]) {
      expect(statSync(dir).isDirectory()).toBe(true);
    }
    expect(storage.dbFile).toBe(path.join(storage.root, 'bookclub.db'));
  });

  it('shards blob paths and refuses ids that could escape the store', () => {
    expect(storage.blobPath('abcdef123')).toBe(path.join(storage.blobsDir, 'ab', 'abcdef123'));
    for (const bad of ['', '../etc', 'a/b', 'a.b', '..']) expect(() => storage.blobPath(bad)).toThrow(/bad blob id/);
    for (const bad of ['', '../x', 'a/b', '.']) expect(() => storage.pubDir(bad)).toThrow(/bad edition id/);
  });

  it('pubFile resolves paths inside a publication and refuses anything that escapes it', () => {
    const dir = storage.pubDir('ed1');
    expect(storage.pubFile('ed1', 'OEBPS/ch1.xhtml')).toBe(path.join(dir, 'OEBPS', 'ch1.xhtml'));
    expect(storage.pubFile('ed1', 'OEBPS/../style.css')).toBe(path.join(dir, 'style.css'));
    for (const bad of ['../ed2/x.xhtml', '../../bookclub.db', 'a/../../x', '/etc/passwd', '', '.', '../ed1-sibling/x']) {
      expect(storage.pubFile('ed1', bad), bad).toBeNull();
    }
  });

  it('writes, finds and removes publication files, and refuses unsafe paths', async () => {
    await storage.writePubFile('ed2', 'OEBPS/text/a.xhtml', '<html/>');
    expect(readFileSync(storage.pubFile('ed2', 'OEBPS/text/a.xhtml')!, 'utf8')).toBe('<html/>');
    await expect(storage.writePubFile('ed2', '../escape.txt', 'x')).rejects.toThrow(/unsafe publication path/);
    expect(existsSync(path.join(storage.pubsDir, 'escape.txt'))).toBe(false);
    await storage.removePub('ed2');
    expect(existsSync(storage.pubDir('ed2'))).toBe(false);
    await storage.removePub('ed2'); // removing twice is fine
  });

  it('stores bytes as blobs with their sha256 and size', async () => {
    const bytes = new TextEncoder().encode('hello blob');
    const blob = await storage.putBytes(bytes);
    expect(blob).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/) as string, sha256: sha256Hex(bytes), size: bytes.byteLength });
    expect(readFileSync(storage.blobPath(blob.id), 'utf8')).toBe('hello blob');
    await storage.removeBlob(blob.id);
    expect(existsSync(storage.blobPath(blob.id))).toBe(false);
  });

  it('adopts an upload into the blob store: moved, hashed, measured', async () => {
    const src = path.join(storage.uploadsDir, 'upload-1');
    writeFileSync(src, 'x'.repeat(1000));
    const blob = await storage.adopt(src);
    expect(existsSync(src)).toBe(false);
    expect(blob.size).toBe(1000);
    expect(blob.sha256).toBe(sha256Hex('x'.repeat(1000)));
    expect(await hashFile(storage.blobPath(blob.id))).toBe(blob.sha256);
    await expect(hashFile(path.join(storage.tmpDir, 'missing'))).rejects.toThrow(/ENOENT/);
  });

  it('adopts an upload from another filesystem by copying it (rename cannot cross devices)', async () => {
    // /dev/shm is a tmpfs on Linux; the data directory lives under the system temp directory.
    const elsewhere = mkdtempSync(path.join(existsSync('/dev/shm') ? '/dev/shm' : tmpdir(), 'bookclub-other-fs-'));
    tempDirs.push(elsewhere);
    const src = path.join(elsewhere, 'upload-2');
    writeFileSync(src, 'y'.repeat(2048));
    const blob = await storage.adopt(src);
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(storage.blobPath(blob.id), 'utf8')).toBe('y'.repeat(2048));
    expect(blob).toMatchObject({ size: 2048, sha256: sha256Hex('y'.repeat(2048)) });
  });
});

describe('config', () => {
  it('has safe defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 47100,
      COOKIE_SECURE: 'auto',
      TRUST_PROXY: false,
      SESSION_DAYS: 180,
      SIGNIN_ATTEMPTS: 10,
      SCRYPT_LOG_N: 17,
      MAX_UPLOAD_BYTES: 4 * 1024 ** 3,
      allowedOrigins: [],
      upstream: null,
    });
    expect(path.isAbsolute(config.dataDir)).toBe(true);
    expect(config.dataDir).toBe(path.resolve('.data'));
  });

  it('parses boolean flags the way people write them', () => {
    for (const yes of ['1', 'true', 'yes']) expect(loadConfig({ SEED_DEMO: yes })).toMatchObject({ SEED_DEMO: true });
    for (const no of ['0', 'false', 'no', '']) expect(loadConfig({ TRUST_PROXY: no, SEED_DEMO: no })).toMatchObject({ TRUST_PROXY: false, SEED_DEMO: false });
    expect(() => loadConfig({ SEED_DEMO: 'maybe' })).toThrow();
  });

  it('trusts only the proxies it is told about, by address, range or keyword', () => {
    expect(loadConfig({ TRUST_PROXY: 'loopback' }).TRUST_PROXY).toBe('loopback');
    expect(loadConfig({ TRUST_PROXY: ' 172.16.0.0/12, 10.1.2.3 ,UniqueLocal' }).TRUST_PROXY).toBe('172.16.0.0/12, 10.1.2.3, uniquelocal');
    expect(loadConfig({ TRUST_PROXY: 'fd00::/8,::1' }).TRUST_PROXY).toBe('fd00::/8, ::1');
    // A proxy key: long enough to be a secret, and only for proxies that are trusted at all.
    expect(loadConfig({ TRUST_PROXY: 'uniquelocal', TRUST_PROXY_KEY: 'k'.repeat(32) }).TRUST_PROXY_KEY).toBe('k'.repeat(32));
    expect(loadConfig({ TRUST_PROXY: 'uniquelocal', TRUST_PROXY_KEY: '' }).TRUST_PROXY_KEY).toBeUndefined();
    expect(() => loadConfig({ TRUST_PROXY: 'uniquelocal', TRUST_PROXY_KEY: 'too-short' })).toThrow(/at least 32 characters/);
    expect(() => loadConfig({ TRUST_PROXY_KEY: 'k'.repeat(32) })).toThrow(/TRUST_PROXY_KEY needs TRUST_PROXY/);
    // Trusting every hop would let a client pick its own address; Fastify ignores hop counts.
    for (const bad of ['true', 'yes', '1', '2', 'everyone', '10.0.0.0/33', '300.1.1.1', '10.0.0.0/8/1', ',']) {
      expect(() => loadConfig({ TRUST_PROXY: bad }), bad).toThrow(/TRUST_PROXY lists the proxies/);
    }
  });

  it('coerces numbers and rejects values out of range', () => {
    expect(loadConfig({ PORT: '0', SESSION_DAYS: '30', SIGNIN_ATTEMPTS: '3' })).toMatchObject({ PORT: 0, SESSION_DAYS: 30, SIGNIN_ATTEMPTS: 3 });
    expect(() => loadConfig({ PORT: '70000' })).toThrow();
    expect(() => loadConfig({ SCRYPT_LOG_N: '9' })).toThrow();
    expect(() => loadConfig({ COOKIE_SECURE: 'sometimes' })).toThrow();
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow();
  });

  it('splits and trims the extra allowed origins', () => {
    expect(loadConfig({ ALLOWED_ORIGINS: ' https://a.example ,https://b.example,, ' }).allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  const START = 'https://id.example.com/api/auth/book-club/start';
  const EXCHANGE = 'https://id.example.com/api/auth/book-club/exchange';

  it('enables continuing with the upstream account only when both its addresses are set', () => {
    expect(loadConfig({ UPSTREAM_NAME: 'Upstream ID' }).upstream).toBeNull();
    expect(loadConfig({ UPSTREAM_START_URL: START, UPSTREAM_EXCHANGE_URL: EXCHANGE }).upstream).toEqual({
      startUrl: START, exchangeUrl: EXCHANGE, passwordUrl: null, passwordSecret: null, name: 'your main account',
    });
    expect(loadConfig({ UPSTREAM_START_URL: START, UPSTREAM_EXCHANGE_URL: 'http://upstream:8081/x', UPSTREAM_NAME: ' Upstream ID ' }).upstream).toEqual({
      startUrl: START,
      exchangeUrl: 'http://upstream:8081/x',
      passwordUrl: null,
      passwordSecret: null,
      name: 'Upstream ID',
    });
    // One without the other would offer a sign-in that cannot finish.
    expect(() => loadConfig({ UPSTREAM_START_URL: START })).toThrow(/set together, or neither/);
    expect(() => loadConfig({ UPSTREAM_EXCHANGE_URL: EXCHANGE })).toThrow(/set together, or neither/);
  });

  it('reads empty upstream settings (NAME= in a compose file) as unset', () => {
    expect(loadConfig({ UPSTREAM_START_URL: '', UPSTREAM_EXCHANGE_URL: '', UPSTREAM_NAME: '' }).upstream).toBeNull();
    expect(loadConfig({ UPSTREAM_START_URL: START, UPSTREAM_EXCHANGE_URL: EXCHANGE, UPSTREAM_NAME: '' }).upstream?.name).toBe('your main account');
    expect(() => loadConfig({ UPSTREAM_START_URL: START, UPSTREAM_EXCHANGE_URL: '' })).toThrow(/set together, or neither/);
  });

  it('enables an upstream password typed here (D173) only alongside both the other addresses and its own secret', () => {
    const PASSWORD = 'https://id.example.com/api/auth/book-club/password';
    const SECRET = 'a-bearer-of-at-least-sixteen-characters';
    expect(loadConfig({ UPSTREAM_START_URL: START, UPSTREAM_EXCHANGE_URL: EXCHANGE }).upstream?.passwordUrl).toBeNull();
    expect(loadConfig({ UPSTREAM_START_URL: START, UPSTREAM_EXCHANGE_URL: EXCHANGE }).upstream?.passwordSecret).toBeNull();
    const withPassword = loadConfig({ UPSTREAM_START_URL: START, UPSTREAM_EXCHANGE_URL: EXCHANGE, UPSTREAM_PASSWORD_URL: PASSWORD, UPSTREAM_PASSWORD_SECRET: SECRET });
    expect(withPassword.upstream?.passwordUrl).toBe(PASSWORD);
    expect(withPassword.upstream?.passwordSecret).toBe(SECRET);
    expect(loadConfig({ UPSTREAM_START_URL: START, UPSTREAM_EXCHANGE_URL: EXCHANGE, UPSTREAM_PASSWORD_URL: '', UPSTREAM_PASSWORD_SECRET: '' }).upstream?.passwordUrl).toBeNull();
    // On its own, it would check a password with no upstream configured to redeem its code at.
    expect(() => loadConfig({ UPSTREAM_PASSWORD_URL: PASSWORD, UPSTREAM_PASSWORD_SECRET: SECRET })).toThrow(/needs UPSTREAM_START_URL and UPSTREAM_EXCHANGE_URL/);
    expect(() => loadConfig({ UPSTREAM_START_URL: START, UPSTREAM_PASSWORD_URL: PASSWORD, UPSTREAM_PASSWORD_SECRET: SECRET })).toThrow(/needs UPSTREAM_START_URL and UPSTREAM_EXCHANGE_URL/);
    // The upstream's password check is bearer-gated: an address with no secret would only get 401s.
    expect(() => loadConfig({ UPSTREAM_START_URL: START, UPSTREAM_EXCHANGE_URL: EXCHANGE, UPSTREAM_PASSWORD_URL: PASSWORD })).toThrow(/set together, or neither/);
    expect(() => loadConfig({ UPSTREAM_START_URL: START, UPSTREAM_EXCHANGE_URL: EXCHANGE, UPSTREAM_PASSWORD_SECRET: SECRET })).toThrow(/set together, or neither/);
    expect(() => loadConfig({ UPSTREAM_START_URL: START, UPSTREAM_EXCHANGE_URL: EXCHANGE, UPSTREAM_PASSWORD_SECRET: 'too-short' })).toThrow(/at least 16 characters/);
  });

  it('refuses upstream addresses that are not http(s)', () => {
    for (const bad of ['id.example.com/start', 'javascript:alert(1)', '/start', 'ftp://example.com/start']) {
      expect(() => loadConfig({ UPSTREAM_START_URL: bad, UPSTREAM_EXCHANGE_URL: EXCHANGE }), bad).toThrow(/http\(s\) address/);
      expect(() => loadConfig({ UPSTREAM_START_URL: START, UPSTREAM_EXCHANGE_URL: bad }), bad).toThrow(/http\(s\) address/);
    }
  });

  it('will not start with the cookie adapter’s settings, which the upstream’s own change made useless (D116)', () => {
    for (const name of ['UPSTREAM_JWT_SECRET', 'UPSTREAM_JWT_ISSUER', 'UPSTREAM_JWT_AUDIENCE', 'UPSTREAM_COOKIE', 'UPSTREAM_LOGIN_URL']) {
      expect(() => loadConfig({ [name]: 'set' }), name).toThrow(new RegExp(`^${name} is no longer read\\. .*: remove ${name}, and set UPSTREAM_START_URL and UPSTREAM_EXCHANGE_URL \\(docs/DEPLOY\\.md`));
      // Even beside the new ones: they would do nothing, and say nothing.
      expect(() => loadConfig({ [name]: 'set', UPSTREAM_START_URL: START, UPSTREAM_EXCHANGE_URL: EXCHANGE }), name).toThrow(/no longer read/);
    }
    expect(() => loadConfig({ UPSTREAM_JWT_SECRET: 'a-shared-secret-of-32-characters', UPSTREAM_COOKIE: 'accessToken' })).toThrow(/^UPSTREAM_JWT_SECRET, UPSTREAM_COOKIE are no longer read\. .*: remove UPSTREAM_JWT_SECRET, UPSTREAM_COOKIE, and set/);
    // Empty, as a compose file leaves them, they are nothing.
    expect(loadConfig({ UPSTREAM_JWT_SECRET: '', UPSTREAM_JWT_ISSUER: '', UPSTREAM_JWT_AUDIENCE: '', UPSTREAM_COOKIE: '', UPSTREAM_LOGIN_URL: '' }).upstream).toBeNull();
  });
});

describe('ingest/covers', () => {
  it('wraps a title into lines of about 16 characters', () => {
    expect(wrapTitle('Emma')).toEqual(['Emma']);
    expect(wrapTitle('Alice’s Adventures in Wonderland')).toEqual(['Alice’s', 'Adventures in', 'Wonderland']);
    expect(wrapTitle('  spaced   out  words ')).toEqual(['spaced out words']);
    expect(wrapTitle('')).toEqual([]);
    expect(wrapTitle('Supercalifragilisticexpialidocious is long')).toEqual(['Supercalifragilisticexpialidocious', 'is long']);
    expect(wrapTitle('a b c d e f', 3)).toEqual(['a b', 'c d', 'e f']);
  });

  it('keeps at most four lines and marks the cut with an ellipsis', () => {
    const lines = wrapTitle('The Strange and Curious Case of the Very Long Title That Never Ends at All');
    expect(lines).toHaveLength(4);
    expect(lines[3]!.endsWith('…')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(16);
  });

  it('draws a deterministic, escaped typographic cover', () => {
    const svg = generatedCoverSvg('Tom & Jerry <3', 'Ann "Annie" Author');
    expect(svg).toBe(generatedCoverSvg('Tom & Jerry <3', 'Ann "Annie" Author'));
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('Tom &amp; Jerry &lt;3');
    expect(svg).toContain('Ann &quot;Annie&quot; Author');
    expect(svg).toContain('aria-label="Tom &amp; Jerry &lt;3"');
    expect(svg).not.toContain('<3');
    expect(svg).toContain('font-size="40"');
  });

  it('draws a cover whatever characters the title and author hold, XML forbidding some', async () => {
    const ch = (code: number) => String.fromCharCode(code);
    const smile = String.fromCodePoint(0x1f600);
    const title = `Odd${ch(1)} Title${ch(0x0b)} ${ch(0xfffe)}Here ${ch(0xd800)}`;
    // Cut to 40 characters, this author's name would end in half a character.
    const author = `${ch(0)}${'A'.repeat(38)}${smile}`;
    const svg = generatedCoverSvg(title, author);
    const forbidden = [...svg].filter((c) => {
      const code = c.codePointAt(0)!;
      return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff || (code >= 0xd800 && code <= 0xdfff);
    });
    expect(forbidden).toEqual([]);
    expect(svg).toContain('>Odd Title Here</tspan>');
    expect((await sharp(Buffer.from(svg)).metadata()).format).toBe('svg');
    const file = await generatedCoverWebp(title, author, tempDir(), 'odd', 160);
    expect((await sharp(file).metadata()).format).toBe('webp');
  });

  it('decodes a cover only when it is a JPEG, PNG, GIF or WebP picture of a sensible size', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    const tiff = new Uint8Array(await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).tiff().toBuffer());
    // sharp itself would read both.
    expect((await sharp(svg).metadata()).format).toBe('svg');
    expect((await sharp(tiff).metadata()).format).toBe('tiff');
    await expect(normaliseCover(svg)).rejects.toThrow('a cover must be a JPEG, PNG, GIF or WebP picture');
    await expect(normaliseCover(tiff)).rejects.toThrow('a cover must be a JPEG, PNG, GIF or WebP picture');
    const huge = new Uint8Array(MAX_COVER_BYTES + 1);
    huge.set([0xff, 0xd8, 0xff], 0);
    await expect(normaliseCover(huge)).rejects.toThrow(`larger than ${MAX_COVER_BYTES}`);
    for (const format of ['jpeg', 'png', 'gif', 'webp'] as const) {
      const picture = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#336699' } }).toFormat(format).toBuffer();
      const meta = await sharp(await normaliseCover(new Uint8Array(picture))).metadata();
      expect([format, meta.format, meta.width, meta.height]).toEqual([format, 'jpeg', 20, 30]);
    }
  });

  it('falls back to "Untitled", shrinks long titles and shortens long author names', () => {
    expect(generatedCoverSvg('', 'Someone')).toContain('>Untitled</tspan>');
    expect(generatedCoverSvg('One Two Three Four Five Six Seven Eight Nine Ten Eleven', 'X')).toContain('font-size="34"');
    const author = 'A'.repeat(60);
    expect(generatedCoverSvg('T', author)).toContain(`>${'A'.repeat(40)}</text>`);
  });

  it('picks the smallest standard width that covers the request', () => {
    expect([undefined, 'abc', '', '100', '160', '161', '320', '500', '640', '5000'].map(pickCoverWidth)).toEqual([320, 320, 160, 160, 160, 320, 320, 640, 640, 640]);
  });

  it('renders the generated cover to WebP at the requested width and caches it', async () => {
    const dir = tempDir();
    const file = await generatedCoverWebp('Middlemarch', 'George Eliot', dir, 'k1', 160);
    const meta = await sharp(file).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 160, 240]);
    const mtime = statSync(file).mtimeMs;
    expect(await generatedCoverWebp('Middlemarch', 'George Eliot', dir, 'k1', 160)).toBe(file);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });

  it('normalises uploaded covers to a bounded JPEG and makes cached WebP thumbnails', async () => {
    const dir = tempDir();
    const png = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#336699' } }).png().toBuffer();
    const jpeg = await normaliseCover(new Uint8Array(png));
    const meta = await sharp(jpeg).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1200, 1200]);
    const small = await sharp({ create: { width: 100, height: 150, channels: 3, background: '#000' } }).png().toBuffer();
    const notEnlarged = await sharp(await normaliseCover(new Uint8Array(small))).metadata();
    expect([notEnlarged.width, notEnlarged.height]).toEqual([100, 150]);
    await expect(normaliseCover(new TextEncoder().encode('not an image'))).rejects.toThrow();

    const source = path.join(dir, 'cover.jpg');
    writeFileSync(source, jpeg);
    const thumb = await coverThumbnail(source, dir, 'blob1', 320);
    expect(thumb).toBe(path.join(dir, 'covers', `blob1-320-v${COVER_DRAWING}.webp`));
    const thumbMeta = await sharp(thumb).metadata();
    expect([thumbMeta.format, thumbMeta.width, thumbMeta.height]).toEqual(['webp', 320, 480]);
    expect(await coverThumbnail(source, dir, 'blob1', 320)).toBe(thumb);
  });

  it('shows a square cover (an audiobook’s) whole, on a dark copy of itself, instead of cutting its sides', async () => {
    const dir = tempDir();
    // A 300×300 square: white, with a blue band down its left edge and a red one down its right.
    const square = path.join(dir, 'square.png');
    const band = (r: number, g: number, b: number) => sharp({ create: { width: 30, height: 300, channels: 3, background: { r, g, b } } }).png().toBuffer();
    await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([
        { input: await band(0, 0, 255), left: 0, top: 0 },
        { input: await band(255, 0, 0), left: 270, top: 0 },
      ])
      .png()
      .toFile(square);
    const thumb = await coverThumbnail(square, dir, 'square', 160);
    const { data, info } = await sharp(thumb).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([160, 240]);
    const at = (x: number, y: number): [number, number, number] => {
      const i = (y * info.width + x) * info.channels;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    };
    // Both bands are there, at the edges of the square, centred in the 2:3 frame (rows 40 to 200).
    const [lr, lg, lb] = at(4, 120);
    expect(lb).toBeGreaterThan(200);
    expect(lr + lg).toBeLessThan(120);
    const [rr, rg, rb] = at(155, 120);
    expect(rr).toBeGreaterThan(200);
    expect(rg + rb).toBeLessThan(120);
    // Above and below the square, the darkened backdrop.
    expect(at(80, 10).reduce((a, b) => a + b, 0)).toBeLessThan(3 * 160);
  });

  it('shows a tall cover whole, its title along its top, on the app’s dark ground beside it (FR151)', async () => {
    const dir = tempDir();
    // Gutenberg's Jekyll and Hyde: 500×862, taller than 2:3. White, a red band along its top (its
    // title) and a blue one along its bottom (its author).
    const tall = path.join(dir, 'tall.png');
    const band = (r: number, g: number, b: number) => sharp({ create: { width: 500, height: 40, channels: 3, background: { r, g, b } } }).png().toBuffer();
    await sharp({ create: { width: 500, height: 862, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([
        { input: await band(255, 0, 0), left: 0, top: 0 },
        { input: await band(0, 0, 255), left: 0, top: 822 },
      ])
      .png()
      .toFile(tall);
    for (const width of [160, 320, 640] as const) {
      const thumb = await coverThumbnail(tall, dir, 'tall', width);
      const { data, info } = await sharp(thumb).raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([width, width * 1.5]);
      const at = (x: number, y: number): [number, number, number] => {
        const i = (Math.round(y) * info.width + Math.round(x)) * info.channels;
        return [data[i]!, data[i + 1]!, data[i + 2]!];
      };
      const h = info.height;
      // Its whole height: the red band in the frame's first rows, the blue one in its last.
      const [tr, tg, tb] = at(width / 2, h * 0.01);
      expect(tr).toBeGreaterThan(200);
      expect(tg + tb).toBeLessThan(120);
      const [br, bg, bb] = at(width / 2, h * 0.99);
      expect(bb).toBeGreaterThan(200);
      expect(br + bg).toBeLessThan(120);
      // Beside it, left and right, the dark ground: 500×862 drawn 240 high is 139 of 160 wide.
      for (const x of [1, width - 2]) expect(at(x, h / 2).reduce((a, b) => a + b, 0)).toBeLessThan(3 * 40);
    }
    // A cover of about 2:3 still fills its frame.
    const book = path.join(dir, 'book.png');
    await sharp({ create: { width: 400, height: 602, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toFile(book);
    const { data } = await sharp(await coverThumbnail(book, dir, 'book', 160)).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]! + data[1]! + data[2]!).toBeGreaterThan(3 * 240);
  });
});

describe('ingest/audio and content sniffing', () => {
  const bytes = (...values: (number | string)[]) =>
    new Uint8Array(values.flatMap((v) => (typeof v === 'string' ? [...v].map((c) => c.charCodeAt(0)) : [v])));

  it('recognises the audio containers we can serve by their magic bytes', () => {
    expect(looksLikeAudio(bytes('ID3', 3, 0, 0))).toBe(true);
    expect(looksLikeAudio(bytes(0xff, 0xfb, 0x90, 0x64))).toBe(true);
    expect(looksLikeAudio(bytes(0, 0, 0, 0x20, 'ftypM4B '))).toBe(true);
    expect(looksLikeAudio(bytes('OggS', 0))).toBe(true);
    expect(looksLikeAudio(bytes('fLaC', 0))).toBe(true);
    expect(looksLikeAudio(bytes('RIFF', 0, 0, 0, 0, 'WAVE'))).toBe(true);
    expect(looksLikeAudio(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe(true);
    expect(looksLikeAudio(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe(false);
    expect(looksLikeAudio(bytes('Hello, world'))).toBe(false);
    expect(looksLikeAudio(new Uint8Array())).toBe(false);
  });

  it('recognises PDFs (even after a little junk), ZIPs and images', () => {
    expect(looksLikePdf(bytes('%PDF-1.7'))).toBe(true);
    expect(looksLikePdf(bytes('\n\njunk%PDF-1.4'))).toBe(true);
    expect(looksLikePdf(bytes('PDF but not really'))).toBe(false);
    expect(looksLikeZip(bytes('PK', 3, 4))).toBe(true);
    expect(looksLikeZip(bytes('PK', 5, 6))).toBe(true);
    expect(looksLikeZip(bytes('PK', 7, 8))).toBe(false);
    expect(looksLikeImage(bytes(0xff, 0xd8, 0xff))).toBe(true);
    expect(looksLikeImage(bytes(0x89, 'PNG'))).toBe(true);
    expect(looksLikeImage(bytes('GIF89a'))).toBe(true);
    expect(looksLikeImage(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe(true);
    expect(looksLikeImage(bytes('RIFF', 0, 0, 0, 0, 'WAVE'))).toBe(false);
    expect(looksLikeImage(bytes('<svg'))).toBe(false);
  });

  it('reads tags, duration and the embedded picture of a track', async () => {
    const info = await inspectTrack(path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3'));
    expect(info).toMatchObject({ title: 'The Beginning', artist: 'Ada Tone', album: 'The Synthetic Tale', trackNo: 1, container: 'MPEG' });
    expect(info.durationMs).toBeGreaterThan(7500);
    expect(info.durationMs).toBeLessThan(8500);
    expect(info.picture?.format).toBe('image/jpeg');
    expect(looksLikeImage(info.picture!.data)).toBe(true);
  });

  it('reads the chapters marked inside an M4B, and none from a plain MP3', async () => {
    const info = await inspectTrack(path.join(FIXTURES, 'audio/m4b/tale-in-three-chapters.m4b'));
    expect(info.chapters).toEqual([
      { title: 'Chapter One: The Start', startMs: 0 },
      { title: 'Chapter Two: The Middle', startMs: 4000 },
      { title: 'Chapter Three: The End', startMs: 8000 },
    ]);
    expect(info).toMatchObject({ title: 'A Tale in Three Chapters', artist: 'Ada Tone' });
    expect((await inspectTrack(path.join(ALICE_TINY_AUDIO, 'wonderland_ch_01_64kb.mp3'))).chapters).toEqual([]);
  });

  it('reads LibriVox-style tags without a picture', async () => {
    const info = await inspectTrack(path.join(ALICE_TINY_AUDIO, 'wonderland_ch_01_64kb.mp3'));
    expect(info).toMatchObject({ title: 'wonderland_ch_01', artist: 'Lewis Carroll', album: 'Alice in Wonderland', trackNo: 1, picture: null });
    expect(info.durationMs).toBeGreaterThan(3000);
  });

  describe('chapters and text from tags', () => {
    const synthetic = path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3');
    const write = (name: string, bytes: Uint8Array) => {
      const file = path.join(tempDir(), name);
      writeFileSync(file, bytes);
      return file;
    };
    const ch = (code: number) => String.fromCharCode(code);
    /** A control character or one that reorders text (bidirectional embeddings, overrides, isolates). */
    const unwanted = (text: string) =>
      [...text].some((c) => {
        const code = c.codePointAt(0)!;
        return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
      });

    it('reads ID3 chapter frames (CHAP) at their times, which music-metadata gives in seconds', async () => {
      const file = write(
        'chapters.mp3',
        mp3With([textFrame('TIT2', 'Three Parts'), ctocFrame(['a', 'b', 'c']), chapFrame('a', 0, 3000, 'Part One'), chapFrame('b', 3000, 6000, 'Part Two'), chapFrame('c', 6000, 8000, 'Part Three')], synthetic),
      );
      const raw = await parseFile(file);
      expect(raw.format.chapters?.map((c) => [c.start, c.timeScale])).toEqual([
        [0, undefined],
        [3, undefined],
        [6, undefined],
      ]);
      const info = await inspectTrack(file);
      expect(info.durationMs).toBeGreaterThan(7500);
      // Taken for milliseconds, they began 3 ms apart: one chapter was kept and the others lost.
      expect(info.chapters).toEqual([
        { title: 'Part One', startMs: 0 },
        { title: 'Part Two', startMs: 3000 },
        { title: 'Part Three', startMs: 6000 },
      ]);
      expect(info.chaptersSkipped).toBeNull();
    });

    it('reads a Nero chapter list (chpl), which counts in tenths of a microsecond', async () => {
      // The fixture marks its chapters both ways: without the chapter track's reference, the Nero list is what is left.
      const bytes = readFileSync(path.join(FIXTURES, 'audio/m4b/tale-in-three-chapters.m4b'));
      const at = bytes.indexOf('chap');
      expect(at).toBeGreaterThan(0);
      expect(bytes.indexOf('chap', at + 1)).toBe(-1);
      bytes.write('xref', at, 'latin1');
      const file = write('nero.m4b', bytes);
      expect((await parseFile(file, { includeChapters: true })).format.chapters?.map((c) => [c.start, c.timeScale])).toEqual([
        [0, 10_000_000],
        [40_000_000, 10_000_000],
        [80_000_000, 10_000_000],
      ]);
      expect((await inspectTrack(file)).chapters).toEqual([
        { title: 'Chapter One: The Start', startMs: 0 },
        { title: 'Chapter Two: The Middle', startMs: 4000 },
        { title: 'Chapter Three: The End', startMs: 8000 },
      ]);
    });

    it('keeps no chapters from a file that marks more than a book has', async () => {
      const frames = Array.from({ length: MAX_CHAPTERS_PER_TRACK + 1 }, (_, i) => chapFrame(`c${i}`, i * 10, i * 10 + 10, `Chapter ${i + 1}`));
      const info = await inspectTrack(write('crowded.mp3', mp3With(frames, synthetic)));
      expect(info).toMatchObject({ chapters: [], chaptersSkipped: `it marks more than ${MAX_CHAPTERS_PER_TRACK} chapters`, title: null });
      expect(info.durationMs).toBeGreaterThan(7500);
    });

    it('keeps tag text to one tidy line: cut to size, with no control or bidirectional characters', async () => {
      const title = `The Title${ch(7)}\n${ch(0x202e)}3pm.exe${'x'.repeat(10_000)}`;
      const file = write(
        'tags.mp3',
        mp3With(
          [
            textFrame('TIT2', title),
            textFrame('TPE1', `Ada${ch(0x1b)}[31m Tone${ch(0x2066)}`),
            textFrame('TALB', 'Album '.repeat(100)),
            ctocFrame(['a', 'b']),
            chapFrame('a', 0, 4000, `One${ch(0x202e)}eno`),
            chapFrame('b', 4000, 8000, ch(0x0b)),
          ],
          synthetic,
        ),
      );
      const info = await inspectTrack(file);
      expect(info.title!.startsWith('The Title 3pm.exexxx')).toBe(true);
      expect(info.title).toHaveLength(300);
      expect(info.artist).toBe('Ada[31m Tone');
      expect(info.album!.length).toBeLessThanOrEqual(300);
      expect(info.album!.startsWith('Album Album')).toBe(true);
      // A chapter whose title is nothing once tidied is numbered instead.
      expect(info.chapters).toEqual([
        { title: 'Oneeno', startMs: 0 },
        { title: 'Chapter 2', startMs: 4000 },
      ]);
      for (const text of [info.title!, info.artist!, info.album!, ...info.chapters.map((c) => c.title)]) expect(unwanted(text), text).toBe(false);
    });
  });
});

describe('ingest/audio TrackReader', () => {
  /** How busy the event loop was while `work` ran, and the longest it went without turning. */
  async function watchingTheLoop<T>(work: () => Promise<T>): Promise<{ result: T; ms: number; utilisation: number; longestStallMs: number }> {
    const started = performance.now();
    const before = performance.eventLoopUtilization();
    let last = started;
    let longest = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 10);
    try {
      const result = await work();
      const now = performance.now();
      return { result, ms: now - started, utilisation: performance.eventLoopUtilization(before).utilization, longestStallMs: Math.max(longest, now - last) };
    } finally {
      clearInterval(timer);
    }
  }

  const m4b = path.join(FIXTURES, 'audio/m4b/tale-in-three-chapters.m4b');
  let crafted: string;
  beforeAll(() => {
    // A million audio chunks, walked once for each of a thousand chapters: seconds of work, in 4 MB.
    crafted = path.join(tempDir(), 'busy.m4b');
    writeFileSync(crafted, craftM4b({ chunks: 1_000_000, chapters: 1000 }));
  });

  it('a crafted M4B read on the server’s own thread keeps it busy throughout (the check that this can fail)', async () => {
    // A tenth of the work, read as tracks were before.
    const small = path.join(tempDir(), 'busy-small.m4b');
    writeFileSync(small, craftM4b({ chunks: 100_000, chapters: 1000 }));
    const control = await watchingTheLoop(() => parseFile(small, { duration: true, includeChapters: true }));
    expect(control.result.format.chapters).toHaveLength(1000);
    expect(control.utilisation).toBeGreaterThan(0.6);
  });

  it('stops reading a chapter track that takes too long, reads the file again without it, and the event loop stays free', async () => {
    const reader = new TrackReader({ chapterMs: 500 });
    try {
      const watched = await watchingTheLoop(() => reader.inspect(crafted));
      expect(watched.result).toMatchObject({ durationMs: 128_000_000, chapters: [], chaptersSkipped: 'its chapters took too long to read' });
      // Half a second on the chapter track, then the file read without it: not the seconds the walk takes.
      expect(watched.ms).toBeLessThan(5000);
      expect(watched.utilisation).toBeLessThan(0.3);
      expect(watched.longestStallMs).toBeLessThan(250);
      // The reader's next files are spared the wait: their chapter tracks are not read.
      expect(await reader.inspect(m4b)).toMatchObject({ durationMs: 12_023, chapters: [], chaptersSkipped: expect.stringContaining('an earlier file') as string });
      expect(await reader.inspect(path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3'))).toMatchObject({ title: 'The Beginning', chaptersSkipped: null });
    } finally {
      await reader.close();
    }
  });

  it('gives up on a file it cannot read in time even without its chapter track', async () => {
    const reader = new TrackReader({ chapterMs: 1, readMs: () => 1 });
    try {
      await expect(reader.inspect(crafted)).rejects.toBeInstanceOf(TrackTimeoutError);
      await expect(reader.inspect(path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3'))).rejects.toThrow('reading took longer than 1 ms');
    } finally {
      await reader.close();
    }
  });

  it('reads one file at a time, answering each read with its own file, and outlives a failed one', async () => {
    const reader = new TrackReader();
    try {
      const [a, b] = await Promise.all([reader.inspect(path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3')), reader.inspect(path.join(SYNTHETIC_AUDIO, '03 - The End.mp3'))]);
      expect([a.title, b.title]).toEqual(['The Beginning', 'The End']);
      await expect(reader.inspect(path.join(tempDir(), 'not-there.mp3'))).rejects.toThrow();
      const notAudio = path.join(tempDir(), 'not-audio.m4b');
      writeFileSync(notAudio, Buffer.from('\0\0\0\x10ftypM4B but nothing more', 'latin1'));
      await expect(reader.inspect(notAudio)).rejects.toThrow();
      expect((await reader.inspect(path.join(SYNTHETIC_AUDIO, '02 - The Middle.mp3'))).title).toBe('The Middle');
      // Closed, it starts a new worker if asked again.
      await reader.close();
      expect((await reader.inspect(m4b)).chapters).toHaveLength(3);
    } finally {
      await reader.close();
    }
  });

  it('gives a big file more time: a minute, and a second for every 256 KB', () => {
    expect(readLimitMs(0)).toBe(60_000);
    expect(readLimitMs(1)).toBe(61_000);
    expect(readLimitMs(256 * 1024 * 1024)).toBe(60_000 + 1024 * 1000);
  });

  it('the worker’s own reading passes on no more than it is allowed', async () => {
    const reply = await readTrack({ id: 7, file: m4b, chapters: true }, { chapters: 2, text: 9, pictureBytes: 0 });
    expect(reply).toMatchObject({ id: 7, track: { title: 'A Tale in', artist: 'Ada Tone', moreChapters: true, picture: null } });
    expect('track' in reply && reply.track.chapters.map((c) => c.title)).toEqual(['Chapter O', 'Chapter T']);
    const pictured = await readTrack({ id: 8, file: path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3'), chapters: false }, { chapters: 10, text: 100, pictureBytes: 1_000_000 });
    expect('track' in pictured && pictured.track.picture?.format).toBe('image/jpeg');
    const tooBig = await readTrack({ id: 9, file: path.join(SYNTHETIC_AUDIO, '01 - The Beginning.mp3'), chapters: false }, { chapters: 10, text: 100, pictureBytes: 100 });
    expect('track' in tooBig && tooBig.track.picture).toBeNull();
    expect(await readTrack({ id: 10, file: path.join(tempDir(), 'missing.mp3'), chapters: false }, { chapters: 1, text: 1, pictureBytes: 1 })).toMatchObject({ id: 10, error: expect.any(String) as string });
  });
});

describe('ingest/text cleanTitle', () => {
  const ch = (code: number) => String.fromCharCode(code);

  it('makes text taken from a file one tidy line', () => {
    expect(cleanTitle(`  Part${ch(9)}One\r\n${ch(0x85)}The  Start  `, 100)).toBe('Part One The Start');
  });

  it('drops control characters, bidirectional controls, byte-order marks and noncharacters', () => {
    const text = ['A', ch(0), ch(0x1b), ch(0x7f), ch(0x9f), ch(0x202a), ch(0x202e), ch(0x2066), ch(0x2069), ch(0xfeff), ch(0xfffe), ch(0xffff), 'B'].join('');
    expect(cleanTitle(text, 100)).toBe('AB');
    expect(cleanTitle(`${ch(7)}${ch(0x202e)}`, 10)).toBe('');
    // A mark that only says which way a word runs (in a Hebrew or Arabic title) stays.
    expect(cleanTitle(`x${ch(0x200f)}y`, 10)).toBe(`x${ch(0x200f)}y`);
  });

  it('drops lone halves of surrogate pairs, keeps whole ones, and never cuts one in two', () => {
    const smile = String.fromCodePoint(0x1f600);
    expect(cleanTitle(`a${ch(0xd800)}b${ch(0xdc00)}c${smile}`, 100)).toBe(`abc${smile}`);
    expect(cleanTitle(`abc${smile}`, 4)).toBe('abc');
    expect(cleanTitle(`abc${smile}`, 5)).toBe(`abc${smile}`);
    expect(cleanTitle('a'.repeat(500), 200)).toHaveLength(200);
    expect(cleanTitle('word '.repeat(100), 12)).toBe('word word wo');
  });
});

describe('ingest/pdf', () => {
  it('reads page count, document info and the outline, and can skip the cover render', async () => {
    const info = await inspectPdf(ALICE_PDF, { renderCover: false });
    expect(info.pageCount).toBe(91);
    expect(info.title).toBe("Alice's Adventures in Wonderland");
    expect(info.author).toBe('Lewis Carroll');
    expect(info.outline).toHaveLength(12);
    expect(info.outline.map((o) => o.title)[0]).toBe('CHAPTER I. Down the Rabbit-Hole');
    expect(info.outline.every((o, i, all) => i === 0 || o.page + o.y >= all[i - 1]!.page + all[i - 1]!.y)).toBe(true);
    expect(info.coverJpeg).toBeNull();
  });
});

describe('services/readalong agreedRanges (D47)', () => {
  it('keeps what both maps agree was read, and never the gap a far move would open', () => {
    // A listener heard 0.25–0.5; a new map moves that stretch further than its length: nothing
    // is agreed (it used to become 0.5–0.625, a part nobody heard).
    expect(agreedRanges([[0.25, 0.5]], (t) => t + 0.375)).toEqual([]);
    // A small move keeps the overlap.
    expect(agreedRanges([[0.25, 0.5]], (t) => t + 0.125)).toEqual([[0.375, 0.5]]);
    // Ranges that do not move stay whole; the others shrink to their overlap.
    expect(agreedRanges([[0, 0.125], [0.5, 0.75]], (t) => (t < 0.375 ? t : t - 0.125))).toEqual([[0, 0.125], [0.5, 0.625]]);
  });
});

describe('services/gating Gate: where a note may be, format by format', () => {
  // A book of two chapters, the second starting half-way. Every edition below spends half its
  // measure on each chapter, so a fraction of an edition is also its place on the timeline, and a
  // minute of the twenty-minute audiobook is 0.05 of the book.
  const MIN = 60_000;
  const chapters = [
    { index: 0, title: 'One', t: 0 },
    { index: 1, title: 'Two', t: 0.5 },
  ];
  const bookOf = (referenceId: string): BookRow => ({
    id: 'b',
    club_id: 'c',
    title: 'B',
    author: '',
    cover_blob_id: null,
    reference_edition_id: referenceId,
    chapters_json: toJson(chapters),
    created_by: 'u',
    created_at: 0,
  });
  const editionOf = (id: string, kind: EditionKind, geometry: EditionGeometry, points: TiePoint[], units: { title: string; m: number }[], alignment: AlignmentRecord): EditionRow => ({
    id,
    book_id: 'b',
    kind,
    status: 'ready',
    error: null,
    geometry_json: toJson(geometry),
    units_json: toJson(units),
    sync_json: toJson({ points }),
    alignment_json: toJson(alignment),
    meta_json: '{}',
    size_bytes: 0,
    created_by: 'u',
    created_at: 0,
  });
  const byChapters: AlignmentRecord = { method: 'count', unitToChapter: [0, 1] };
  const reference: AlignmentRecord = { method: 'reference', unitToChapter: [0, 1] };
  const textGeometry: EditionGeometry = { kind: 'epub', sectionLengths: [10_000, 10_000] };
  const audioGeometry: EditionGeometry = { kind: 'audio', trackDurationsMs: [10 * MIN, 10 * MIN] };
  const text = editionOf('text', 'epub', textGeometry, [{ m: 0, t: 0 }, { m: 20_000, t: 1 }], [{ title: 'One', m: 0 }, { title: 'Two', m: 10_000 }], reference);
  const textByChapters = editionOf('text', 'epub', textGeometry, [{ m: 0, t: 0 }, { m: 10_000, t: 0.5 }, { m: 20_000, t: 1 }], [{ title: 'One', m: 0 }, { title: 'Two', m: 10_000 }], byChapters);
  const audioPoints = [{ m: 0, t: 0 }, { m: 10 * MIN, t: 0.5 }, { m: 20 * MIN, t: 1 }];
  const audioUnits = [{ title: 'One', m: 0 }, { title: 'Two', m: 10 * MIN }];
  const audio = editionOf('audio', 'audio', audioGeometry, audioPoints, audioUnits, byChapters);
  const note = (editionId: string, locator: Locator, t: number, end?: { locator: Locator; t: number }): Gated => ({
    user_id: 'author',
    edition_id: editionId,
    locator_json: toJson(locator),
    end_locator_json: end ? toJson(end.locator) : null,
    t,
    end_t: end ? end.t : null,
  });
  /** Ranges read in each edition, given as fractions of it (kept in its own measure), and before that, on the timeline. */
  const TOTALS: Record<string, number> = { text: 20_000, text2: 20_000, audio: 20 * MIN, long: 60 * MIN, print: 20, gone: 1 };
  const read = (byEdition: Record<string, Span[]>, unplaced: Span[] = []): Reading => ({
    byEdition: new Map(Object.entries(byEdition).map(([id, spans]) => [id, spans.map(([a, b]): Span => [a * TOTALS[id]!, b * TOTALS[id]!])])),
    unplaced,
  });
  const inText = (offset: number): Locator => ({ kind: 'epub', section: offset < 10_000 ? 0 : 1, offset: offset % 10_000 });
  const inAudio = (ms: number): Locator => ({ kind: 'audio', track: Math.floor(ms / (10 * MIN)), ms: ms % (10 * MIN) });
  const opens = (gate: Gate, gated: Gated, reading: Reading) => gate.isOpen(gated, 'viewer', reading);

  it('keeps what was read in an edition in its own measure, merged, inside it, its end included', () => {
    // Touching spans merge, in any order; backwards ones turn round; empty ones and the outside go.
    expect(addReadSpans([[3000, 5000]], [[0, 1000], [1000, 2000], [9000, 8000], [4000, 4000], [-50, 10], [19_000, 25_000]], 20_000)).toEqual([
      [0, 2000],
      [3000, 5000],
      [8000, 9000],
      [19_000, 20_000],
    ]);
    const pdf = editionOf('print', 'pdf', { kind: 'pdf', pageCount: 20 }, [{ m: 0, t: 0 }, { m: 20, t: 1 }], [], reference);
    const gate = new Gate(bookOf('print'), [pdf], []);
    // The first page read is not the top of the second (a range is half-open), but the last moment
    // of an edition is read with it.
    expect(opens(gate, note('print', { kind: 'pdf', page: 1, y: 0 }, 0.05), read({ print: [[0, 0.05]] }))).toBe(false);
    expect(opens(gate, note('print', { kind: 'pdf', page: 0, y: 0.99 }, 0.0495), read({ print: [[0, 0.05]] }))).toBe(true);
    expect(opens(gate, note('print', { kind: 'pdf', page: 19, y: 1 }, 1), read({ print: [[0.9, 1]] }))).toBe(true);
    const listened = new Gate(bookOf('text'), [text, audio], []);
    expect(opens(listened, note('audio', { kind: 'audio', track: 1, ms: 10 * MIN }, 1), read({ audio: [[0.75, 1]] }))).toBe(true);
  });

  describe('the text the reference, the audiobook lined up by chapters', () => {
    const gate = new Gate(bookOf('text'), [text, audio], []);

    it('a note in the text opens for a listener a minute of listening past it, and from a minute before it', () => {
      const n = note('text', inText(5000), 0.25);
      expect(opens(gate, n, read({ audio: [[0, 0.299]] }))).toBe(false);
      expect(opens(gate, n, read({ audio: [[0, 0.301]] }))).toBe(true);
      expect(opens(gate, n, read({ audio: [[0.201, 0.301]] }))).toBe(false);
      expect(opens(gate, n, read({ audio: [[0.199, 0.301]] }))).toBe(true);
      // Read in the text itself: exactly.
      expect(opens(gate, n, read({ text: [[0.2499, 0.2501]] }))).toBe(true);
      expect(opens(gate, n, read({ text: [[0.2, 0.2499]] }))).toBe(false);
      // Its author, always.
      expect(gate.isOpen(n, 'author', read({}))).toBe(true);
    });

    it('a listener’s note opens for a reader once a minute of listening either side of it is read, and for a listener exactly', () => {
      const n = note('audio', inAudio(5 * MIN), 0.25);
      expect(opens(gate, n, read({ text: [[0.2, 0.301]] }))).toBe(true);
      expect(opens(gate, n, read({ text: [[0.2, 0.299]] }))).toBe(false);
      expect(opens(gate, n, read({ text: [[0.201, 0.301]] }))).toBe(false);
      expect(opens(gate, n, read({ audio: [[0.2, 0.2501]] }))).toBe(true);
      expect(opens(gate, n, read({ audio: [[0.2, 0.2499]] }))).toBe(false);
    });

    it('the margin stops at a chapter start, where the map is right', () => {
      const late = note('text', inText(9800), 0.49);
      expect(opens(gate, late, read({ audio: [[0, 0.5]] }))).toBe(true);
      expect(opens(gate, late, read({ audio: [[0, 0.499]] }))).toBe(false);
      const early = note('text', inText(10_200), 0.51);
      expect(opens(gate, early, read({ audio: [[0.5, 0.575]] }))).toBe(true);
      expect(opens(gate, early, read({ audio: [[0.5, 0.555]] }))).toBe(false);
    });

    it('a passage opens once all of where it may be has been heard', () => {
      const passage = note('text', inText(5000), 0.25, { locator: inText(6000), t: 0.3 });
      expect(opens(gate, passage, read({ audio: [[0.19, 0.351]] }))).toBe(true);
      expect(opens(gate, passage, read({ audio: [[0.19, 0.349]] }))).toBe(false);
    });

    it('reading from before ranges were kept per edition counts as done in the other format', () => {
      const inTheText = note('text', inText(5000), 0.25);
      expect(opens(gate, inTheText, read({}, [[0, 0.299]]))).toBe(false);
      expect(opens(gate, inTheText, read({}, [[0, 0.301]]))).toBe(true);
      const heard = note('audio', inAudio(5 * MIN), 0.25);
      expect(opens(gate, heard, read({}, [[0.2, 0.301]]))).toBe(true);
      expect(opens(gate, heard, read({}, [[0.201, 0.301]]))).toBe(false);
    });

    it('a note whose edition is gone may be anywhere in its chapter; reading in one that is gone counts no more', () => {
      const orphan = note('gone', inAudio(5 * MIN), 0.25);
      expect(opens(gate, orphan, read({ text: [[0, 0.499]] }))).toBe(false);
      expect(opens(gate, orphan, read({ text: [[0, 0.5]] }))).toBe(true);
      expect(opens(gate, note('text', inText(5000), 0.25), read({ gone: [[0, 1]] }))).toBe(false);
    });
  });

  it('with its reference gone, a book keeps its notes in place and each format its own margin', () => {
    const gate = new Gate(bookOf('gone'), [audio], []);
    const n = note('gone', inText(5000), 0.25);
    expect(opens(gate, n, read({ audio: [[0, 0.301]] }))).toBe(true);
    expect(opens(gate, n, read({ audio: [[0, 0.299]] }))).toBe(false);
  });

  it('the audiobook as the reference: a minute of it either side of a text lined up by chapters', () => {
    const audioReference = editionOf('audio', 'audio', audioGeometry, [{ m: 0, t: 0 }, { m: 20 * MIN, t: 1 }], audioUnits, reference);
    const gate = new Gate(bookOf('audio'), [audioReference, textByChapters], []);
    const written = note('text', inText(5000), 0.25);
    expect(opens(gate, written, read({ audio: [[0.2, 0.299]] }))).toBe(false);
    expect(opens(gate, written, read({ audio: [[0.2, 0.301]] }))).toBe(true);
    const heard = note('audio', inAudio(5 * MIN), 0.25);
    expect(opens(gate, heard, read({ text: [[0.2, 0.299]] }))).toBe(false);
    expect(opens(gate, heard, read({ text: [[0.199, 0.301]] }))).toBe(true);
    expect(opens(gate, heard, read({ text: [[0.201, 0.301]] }))).toBe(false);
  });

  it('a PDF and a text lined up by chapters are a page apart, whichever is the reference', () => {
    const pdfGeometry: EditionGeometry = { kind: 'pdf', pageCount: 20 };
    const units = [{ title: 'One', m: 0 }, { title: 'Two', m: 10 }];
    const pdf = editionOf('print', 'pdf', pdfGeometry, [{ m: 0, t: 0 }, { m: 10, t: 0.5 }, { m: 20, t: 1 }], units, byChapters);
    const gate = new Gate(bookOf('text'), [text, pdf], []);
    const written = note('text', inText(5000), 0.25);
    expect(opens(gate, written, read({ print: [[0, 0.299]] }))).toBe(false);
    expect(opens(gate, written, read({ print: [[0, 0.301]] }))).toBe(true);
    const printed = note('print', { kind: 'pdf', page: 5, y: 0 }, 0.25);
    expect(opens(gate, printed, read({ text: [[0.2, 0.301]] }))).toBe(true);
    expect(opens(gate, printed, read({ text: [[0.2, 0.299]] }))).toBe(false);
    // The PDF as the reference: a page of it.
    const pdfReference = editionOf('print', 'pdf', pdfGeometry, [{ m: 0, t: 0 }, { m: 20, t: 1 }], units, reference);
    const printFirst = new Gate(bookOf('print'), [pdfReference, textByChapters], []);
    expect(opens(printFirst, printed, read({ text: [[0, 0.301]] }))).toBe(true);
    expect(opens(printFirst, printed, read({ text: [[0, 0.299]] }))).toBe(false);
  });

  it('two EPUBs lined up by chapters are about a printed page apart', () => {
    const other = editionOf('text2', 'epub', { kind: 'epub', sectionLengths: [12_000, 8000] }, [{ m: 0, t: 0 }, { m: 12_000, t: 0.5 }, { m: 20_000, t: 1 }], [{ title: 'One', m: 0 }, { title: 'Two', m: 12_000 }], byChapters);
    const gate = new Gate(bookOf('text'), [text, other], []);
    // 0.25 is 6,000 characters into the other EPUB; 2,000 more are 0.4 of it.
    const written = note('text', inText(5000), 0.25);
    expect(opens(gate, written, read({ text2: [[0, 0.399]] }))).toBe(false);
    expect(opens(gate, written, read({ text2: [[0, 0.401]] }))).toBe(true);
  });

  it('takes listening paused and played on again for one stretch heard, not two cut short at the pause', () => {
    const gate = new Gate(bookOf('text'), [text, audio], []);
    // Paused at 4:59.997 and played on from 5:00.000 (WebKit resumes a few milliseconds off), to 7:00.
    const resumed = read({ audio: [[0, 299_997 / (20 * MIN)], [300_000 / (20 * MIN), (7 * MIN) / (20 * MIN)]] });
    expect(opens(gate, note('text', inText(5000), 0.25), resumed)).toBe(true);
    // A skip forward is a gap: what it jumped over was not heard.
    const skipped = read({ audio: [[0, (4 * MIN) / (20 * MIN)], [(4 * MIN + 30_000) / (20 * MIN), (7 * MIN) / (20 * MIN)]] });
    expect(opens(gate, note('text', inText(5000), 0.25), skipped)).toBe(false);
    // And saved joined: pieces within two seconds become one.
    expect(addReadSpans([[0, 299_997]], [[300_000, 420_000]], 20 * MIN, 2000)).toEqual([[0, 420_000]]);
    expect(addReadSpans([[0, 240_000]], [[270_000, 420_000]], 20 * MIN, 2000)).toEqual([
      [0, 240_000],
      [270_000, 420_000],
    ]);
  });

  it('widens the margin to a tenth of the chapter in long chapters (half-hour ones here), not a minute', () => {
    const long = editionOf('long', 'audio', { kind: 'audio', trackDurationsMs: [30 * MIN, 30 * MIN] }, [{ m: 0, t: 0 }, { m: 30 * MIN, t: 0.5 }, { m: 60 * MIN, t: 1 }], [{ title: 'One', m: 0 }, { title: 'Two', m: 30 * MIN }], byChapters);
    const gate = new Gate(bookOf('text'), [text, long], []);
    // A note half-way through the text's first chapter, which the audiobook's map puts at 15:00:
    // the narrator may really read it three minutes either side.
    const midway = note('text', inText(5000), 0.25);
    expect(opens(gate, midway, read({ long: [[0, (17 * MIN) / (60 * MIN)]] }))).toBe(false);
    expect(opens(gate, midway, read({ long: [[0, (18 * MIN + 1000) / (60 * MIN)]] }))).toBe(true);
  });

  describe('a forced alignment', () => {
    const forced = editionOf('audio', 'audio', audioGeometry, audioPoints, audioUnits, { method: 'forced', unitToChapter: [0, 1], chapterMethod: 'count' });
    // Its first track aligned (it has sentences); the second did not.
    const readAlong = (textEditionId: string): ReadAlongRow => ({
      audio_edition_id: 'audio',
      text_edition_id: textEditionId,
      refined_edition_id: 'audio',
      sentences_json: toJson([[[0, 0, 10, 0, 900]], []]),
      stats_json: '{}',
      created_at: 0,
    });

    it('lines a trusted track up with the reference exactly; a track it did not trust keeps the margin', () => {
      const gate = new Gate(bookOf('text'), [text, forced], [readAlong('text')]);
      expect(opens(gate, note('text', inText(5000), 0.25), read({ audio: [[0, 0.2501]] }))).toBe(true);
      expect(opens(gate, note('text', inText(5000), 0.25), read({ audio: [[0, 0.2499]] }))).toBe(false);
      expect(opens(gate, note('audio', inAudio(5 * MIN), 0.25), read({ text: [[0.2499, 0.2501]] }))).toBe(true);
      expect(opens(gate, note('text', inText(15_000), 0.75), read({ audio: [[0.5, 0.7501]] }))).toBe(false);
      expect(opens(gate, note('text', inText(15_000), 0.75), read({ audio: [[0.5, 0.801]] }))).toBe(true);
    });

    it('counts for nothing in reading from before ranges were kept per edition, which may have come through the chapter map', () => {
      const gate = new Gate(bookOf('text'), [text, forced], [readAlong('text')]);
      expect(opens(gate, note('text', inText(5000), 0.25), read({}, [[0, 0.2501]]))).toBe(false);
      expect(opens(gate, note('text', inText(5000), 0.25), read({}, [[0, 0.301]]))).toBe(true);
      // The same for a note in the refined audiobook itself: the old reading may have been heard in
      // it, through the chapter map the transcript replaced.
      expect(opens(gate, note('audio', inAudio(5 * MIN), 0.25), read({}, [[0, 0.2501]]))).toBe(false);
      expect(opens(gate, note('audio', inAudio(5 * MIN), 0.25), read({}, [[0, 0.301]]))).toBe(true);
    });

    it('is only as good as its text’s chapter map when that text is not the reference', () => {
      const other = editionOf('text2', 'epub', textGeometry, [{ m: 0, t: 0 }, { m: 10_000, t: 0.5 }, { m: 20_000, t: 1 }], [{ title: 'One', m: 0 }, { title: 'Two', m: 10_000 }], byChapters);
      const gate = new Gate(bookOf('text'), [text, other, forced], [readAlong('text2')]);
      expect(opens(gate, note('text', inText(5000), 0.25), read({ audio: [[0, 0.2501]] }))).toBe(false);
      expect(opens(gate, note('text', inText(5000), 0.25), read({ audio: [[0, 0.301]] }))).toBe(true);
    });
  });

  describe('where its writer had read to (D69)', () => {
    const gate = new Gate(bookOf('text'), [text, audio], []);
    /** A comment whose writer had read to `locator` of an edition (at `t`) when they wrote it. */
    const writtenFrom = (gated: Gated, editionId: string, locator: Locator, t: number): Gated => ({
      ...gated,
      horizon_edition_id: editionId,
      horizon_locator_json: toJson(locator),
      horizon_t: t,
    });

    it('holds a comment whose place you have read until you have read where its writer had, there exactly', () => {
      const n = writtenFrom(note('text', inText(5000), 0.25), 'text', inText(15_000), 0.75);
      expect(gate.access(n, 'viewer', read({ text: [[0.2, 0.3]] }))).toBe('held');
      expect(gate.access(n, 'viewer', read({ text: [[0.2, 0.7499]] }))).toBe('held');
      expect(gate.access(n, 'viewer', read({ text: [[0.2, 0.7501]] }))).toBe('open');
      // A place like a note's: reading it opens it, wherever else you read.
      expect(gate.access(n, 'viewer', read({ text: [[0.2, 0.3], [0.74, 0.76]] }))).toBe('open');
      // Its own place unread, it is ahead of you however far you have read.
      expect(gate.access(n, 'viewer', read({ text: [[0.7, 0.8]] }))).toBe('ahead');
      expect(gate.isOpen(n, 'viewer', read({ text: [[0.2, 0.3]] }))).toBe(false);
      // Its writer reads it, always.
      expect(gate.access(n, 'author', read({}))).toBe('open');
      // Said as the club bar says places, from its locator through the map as it is now.
      expect(gate.horizonLabel(n)).toBe('Two');
      expect(gate.horizonLabel({ ...n, horizon_t: 0.4 })).toBe('Two');
      expect(gate.horizonLabel(note('text', inText(5000), 0.25))).toBeNull();
    });

    it('from another format, judges where its writer had read to with the margins of a note made there', () => {
      // A reader's, for a listener: a minute of listening past it, or a tenth of its chapter (0.05).
      const readTo = writtenFrom(note('text', inText(5000), 0.25), 'text', inText(15_000), 0.75);
      expect(opens(gate, readTo, read({ audio: [[0.19, 0.799]] }))).toBe(false);
      expect(opens(gate, readTo, read({ audio: [[0.19, 0.801]] }))).toBe(true);
      // A listener's, for a reader: all of where the narrator may really be; for a listener, exactly.
      const heardTo = writtenFrom(note('text', inText(5000), 0.25), 'audio', inAudio(15 * MIN), 0.75);
      expect(opens(gate, heardTo, read({ text: [[0.19, 0.799]] }))).toBe(false);
      expect(opens(gate, heardTo, read({ text: [[0.19, 0.801]] }))).toBe(true);
      expect(opens(gate, heardTo, read({ text: [[0.19, 0.31], [0.69, 0.81]] }))).toBe(true);
      expect(opens(gate, heardTo, read({ text: [[0.19, 0.31], [0.71, 0.81]] }))).toBe(false);
      expect(opens(gate, heardTo, read({ text: [[0.19, 0.31]], audio: [[0.6, 0.7501]] }))).toBe(true);
      expect(opens(gate, heardTo, read({ text: [[0.19, 0.31]], audio: [[0.6, 0.7499]] }))).toBe(false);
      // Its edition gone: anywhere in its chapter.
      const gone = writtenFrom(note('text', inText(5000), 0.25), 'gone', inAudio(15 * MIN), 0.75);
      expect(opens(gate, gone, read({ text: [[0.19, 0.999]] }))).toBe(false);
      expect(opens(gate, gone, read({ text: [[0.19, 1]] }))).toBe(true);
    });

    it('is the furthest its writer had read, less the page on screen, in the edition read furthest in', () => {
      const place = note('text', inText(5000), 0.25);
      // Read to the end of the page the note is on, or a little more: nothing holds it.
      expect(gate.horizon(read({ text: [[0, 0.3]] }), 0.3, 'text', place)).toBeNull();
      expect(gate.horizon(read({ text: [[0, 0.35]] }), 0.35, 'text', place)).toBeNull();
      // Read on beyond a printed page: there, less one.
      expect(HORIZON_PAGE.epub).toBe(2000);
      expect(gate.horizon(read({ text: [[0, 0.75]] }), 0.75, 'text', place)).toEqual({ editionId: 'text', locator: inText(13_000), t: 0.65 });
      // Heard further than read: in the audiobook, less a minute of it.
      expect(gate.horizon(read({ text: [[0, 0.3]], audio: [[0, 0.75]] }), 0.75, 'text', place)).toEqual({ editionId: 'audio', locator: inAudio(14 * MIN), t: 0.7 });
      // Reading kept only on the timeline (from before ranges were kept per edition) reaching further:
      // in the edition read now.
      expect(gate.horizon(read({ text: [[0, 0.3]] }, [[0, 0.75]]), 0.75, 'text', place)).toEqual({ editionId: 'text', locator: inText(13_000), t: 0.65 });
      expect(gate.horizon(read({}), 0, null, place)).toBeNull();
      // A passage: past its end. A place in another format: past it on the timeline.
      const passage = note('text', inText(5000), 0.25, { locator: inText(12_000), t: 0.6 });
      expect(gate.horizon(read({ text: [[0, 0.7]] }), 0.7, 'text', passage)).toBeNull();
      expect(gate.horizon(read({ text: [[0, 0.75]] }), 0.75, 'text', passage)).toMatchObject({ locator: inText(13_000) });
      const heard = note('audio', inAudio(5 * MIN), 0.25);
      expect(gate.horizon(read({ text: [[0, 0.35]] }), 0.35, 'text', heard)).toBeNull();
      expect(gate.horizon(read({ text: [[0, 0.4]] }), 0.4, 'text', heard)).toEqual({ editionId: 'text', locator: inText(6000), t: 0.3 });
    });

    it('is named where its writer had read to: the page held back is added again, so a writer just into a chapter is in it (fidelity review round 16)', () => {
      const place = note('text', inText(5000), 0.25);
      const keep = (h: { editionId: string; locator: Locator; t: number }): Gated => writtenFrom(place, h.editionId, h.locator, h.t);
      // Read to 200 characters into Two: the horizon kept is a page back, in One, where the writer was not.
      const read200 = gate.horizon(read({ text: [[0, 0.51]] }), 0.51, 'text', place)!;
      expect(read200).toEqual({ editionId: 'text', locator: inText(8200), t: 0.41 });
      expect(gate.horizonLabel(keep(read200))).toBe('Two');
      // Heard 24 s into Two: a minute back is One, and it is named Two.
      const heard24 = gate.horizon(read({ audio: [[0, 0.52]] }), 0.52, 'audio', place)!;
      expect(heard24).toMatchObject({ editionId: 'audio', locator: inAudio(564_000) });
      expect(gate.horizonLabel(keep(heard24))).toBe('Two');
      // Read to One's very end, the place Two starts at: read to One, not into Two.
      expect(gate.horizonLabel(keep(gate.horizon(read({ text: [[0, 0.5]] }), 0.5, 'text', place)!))).toBe('One');
      // Further into a chapter, it is the chapter it was before; read to the end, the end.
      expect(gate.horizonLabel(keep(gate.horizon(read({ text: [[0, 0.75]] }), 0.75, 'text', place)!))).toBe('Two');
      expect(gate.horizonLabel(keep(gate.horizon(read({ text: [[0, 0.45]] }), 0.45, 'text', place)!))).toBe('One');
      expect(gate.horizonLabel(keep(gate.horizon(read({ text: [[0, 1]] }), 1, 'text', place)!))).toBe('Two');
    });

    it('stops at the story’s end: a licence read after it is no story', () => {
      const licensed = editionOf('text2', 'epub', { kind: 'epub', sectionLengths: [10_000, 15_000] }, [{ m: 0, t: 0 }, { m: 20_000, t: 1 }], [{ title: 'One', m: 0 }, { title: 'Two', m: 10_000 }], reference);
      const withLicence = new Gate(bookOf('text2'), [licensed], []);
      const place = note('text2', inText(5000), 0.25);
      expect(withLicence.horizon(read({ text2: [[0, 1.25]] }), 1, 'text2', place)).toEqual({ editionId: 'text2', locator: { kind: 'epub', section: 1, offset: 8000 }, t: 0.9 });
    });
  });
});

describe('auth/upstream: the sign-in grant’s pieces', () => {
  it('makes the S256 challenge of RFC 7636', () => {
    // Appendix B of the RFC.
    expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('keeps a sign-in under way in a cookie value and reads it back; anything else is none', () => {
    const flight = newFlight('/join/abc', 1_000);
    expect(flight).toMatchObject({ next: '/join/abc', expires: 1_000 + 10 * 60_000 });
    expect(flight.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flight.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flight.verifier).not.toBe(flight.state);
    expect(sealFlight(flight)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(openFlight(sealFlight(flight))).toEqual(flight);
    const sealed = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const bad of [undefined, '', 'not base64 json', sealed({ ...flight, state: 'short' }), sealed({ ...flight, verifier: undefined }), sealed({ ...flight, expires: 'soon' }), sealed([flight]), 'x'.repeat(5000)]) {
      expect(openFlight(bad)).toBeNull();
    }
    // A next is read again as appPath reads it: nowhere but this app.
    expect(openFlight(sealed({ ...flight, next: '//evil.example/' }))?.next).toBe('/');
  });

  it('compares states in full', () => {
    const { state } = newFlight('/');
    expect(sameState(state, state)).toBe(true);
    expect(sameState(`${state}x`, state)).toBe(false);
    expect(sameState(state.slice(1), state)).toBe(false);
    expect(sameState(undefined, state)).toBe(false);
    expect(sameState([state], state)).toBe(false);
  });

  it('sends the browser to the start address with the state and the challenge, its own query kept', () => {
    const flight = newFlight('/');
    const upstream = {
      startUrl: 'https://id.example.com/api/auth/book-club/start?from=books', exchangeUrl: 'https://x/', passwordUrl: null, passwordSecret: null, name: 'Upstream ID',
    };
    const url = new URL(startAddress(upstream, flight, 'books.example.org'));
    expect(`${url.origin}${url.pathname}`).toBe('https://id.example.com/api/auth/book-club/start');
    expect(Object.fromEntries(url.searchParams)).toEqual({ from: 'books', state: flight.state, code_challenge: challengeOf(flight.verifier), code_challenge_method: 'S256' });
    // Not on loopback, the address is never another than configured, whatever the request's name.
    expect(new URL(startAddress(upstream, flight, 'localhost')).hostname).toBe('id.example.com');
    const local = { ...upstream, startUrl: 'http://127.0.0.1:47101/api/auth/book-club/start' };
    expect(new URL(startAddress(local, flight, 'LocalHost')).host).toBe('localhost:47101');
    expect(new URL(startAddress(local, flight, 'books.example.org')).host).toBe('127.0.0.1:47101');
  });

  it('maps the upstream’s answer to a person here', () => {
    const bea = { id: '66f0c0ffee0000000000b001', name: '  Bea  ', email: 'Bea@Upstream.EXAMPLE', emailVerified: true };
    expect(identityOf(bea)).toEqual({ subject: 'upstream:66f0c0ffee0000000000b001', displayName: 'Bea', email: 'bea@upstream.example' });
    expect(identityOf({ ...bea, emailVerified: false })).toEqual({ subject: 'upstream:66f0c0ffee0000000000b001', displayName: 'Bea', email: null });
    expect(identityOf({ ...bea, name: ' ', email: 'carl@example.com' }).displayName).toBe('carl');
    // Unverified, the address gives no name either.
    expect(identityOf({ ...bea, name: '', emailVerified: false }).displayName).toBe('Reader');
    expect(identityOf({ ...bea, name: '', email: null }).displayName).toBe('Reader');
    expect(identityOf({ ...bea, email: 'not-an-email' }).email).toBeNull();
    expect(identityOf({ ...bea, name: 'N'.repeat(100) }).displayName).toHaveLength(60);
    expect(identityOf({ ...bea, name: `${'N'.repeat(58)} Bo` }).displayName).toBe(`${'N'.repeat(58)} B`);
    expect(identityOf({ ...bea, name: `${'N'.repeat(59)} Bo` }).displayName).toBe('N'.repeat(59));
    expect(identityOf({ ...bea, name: `${'n'.repeat(59)}🦋` }).displayName).toBe('n'.repeat(59));
  });
});

describe('repos (against a real database)', () => {
  let db: Db;
  let userId: string;
  beforeAll(() => {
    db = freshDb();
    userId = createLocalUser(db, { displayName: 'Ana', email: 'ana@example.com', passwordHash: 'x' }).id;
  });
  afterAll(() => db.close());

  it('sessions: resolve a fresh token, refuse junk and unknown tokens', () => {
    const { token, expiresAt } = createSession(db, userId, 180, 'Test UA');
    expect(expiresAt).toBeGreaterThan(Date.now() + 179 * 86_400_000);
    const resolved = resolveSession(db, token, 180);
    expect(resolved?.user.id).toBe(userId);
    expect(resolved?.session.user_agent).toBe('Test UA');
    expect(resolved?.renewedUntil).toBeNull();
    expect(resolveSession(db, 'short', 180)).toBeNull();
    expect(resolveSession(db, 'x'.repeat(201), 180)).toBeNull();
    expect(resolveSession(db, newToken(), 180)).toBeNull();
  });

  it('sessions: slide the expiry at most once an hour', () => {
    const { token } = createSession(db, userId, 180);
    const hash = sha256Hex(token);
    db.exec('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?', [Date.now() - 2 * 3600_000, Date.now() + 86_400_000, hash]);
    const renewed = resolveSession(db, token, 180);
    expect(renewed?.renewedUntil).toBeGreaterThan(Date.now() + 179 * 86_400_000);
    expect(db.get<{ expires_at: number }>('SELECT expires_at FROM sessions WHERE id_hash = ?', [hash])?.expires_at).toBe(renewed?.renewedUntil);
    expect(resolveSession(db, token, 180)?.renewedUntil).toBeNull();
  });

  it('sessions: expired ones are deleted, disabled users are refused', () => {
    const { token } = createSession(db, userId, 180);
    db.exec('UPDATE sessions SET expires_at = ? WHERE id_hash = ?', [Date.now() - 1, sha256Hex(token)]);
    expect(resolveSession(db, token, 180)).toBeNull();
    expect(db.get('SELECT 1 FROM sessions WHERE id_hash = ?', [sha256Hex(token)])).toBeUndefined();

    const bob = createLocalUser(db, { displayName: 'Bob', email: 'bob@example.com', passwordHash: 'x' });
    const bobs = createSession(db, bob.id, 180);
    db.exec('UPDATE users SET disabled_at = ? WHERE id = ?', [Date.now(), bob.id]);
    expect(resolveSession(db, bobs.token, 180)).toBeNull();
  });

  it('sessions: one person keeps at most 50 live sessions, the least used go first', () => {
    const erin = createLocalUser(db, { displayName: 'Erin', email: 'erin@example.com', passwordHash: 'x' });
    const first = createSession(db, erin.id, 180);
    // The first one was used just now; all others are older.
    db.exec('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?', [Date.now() + 60_000, sha256Hex(first.token)]);
    const rest = Array.from({ length: MAX_SESSIONS_PER_USER }, () => createSession(db, erin.id, 180));
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [erin.id])!.n).toBe(MAX_SESSIONS_PER_USER);
    expect(resolveSession(db, first.token, 180)?.user.id).toBe(erin.id);
    expect(resolveSession(db, rest.at(-1)!.token, 180)?.user.id).toBe(erin.id);
    expect(rest.filter((r) => resolveSession(db, r.token, 180) === null)).toHaveLength(1);
  });

  it('sessions: end all of a user but one, and purge expired ones', () => {
    const cara = createLocalUser(db, { displayName: 'Cara', email: 'cara@example.com', passwordHash: 'x' });
    const keep = createSession(db, cara.id, 180);
    const second = createSession(db, cara.id, 180);
    createSession(db, cara.id, 180);
    expect(endUserSessions(db, cara.id, keep.token)).toBe(2);
    expect(resolveSession(db, keep.token, 180)?.user.id).toBe(cara.id);
    expect(resolveSession(db, second.token, 180)).toBeNull();
    expect(endUserSessions(db, cara.id)).toBe(1);
    const old = createSession(db, cara.id, 180);
    db.exec('UPDATE sessions SET expires_at = 0 WHERE id_hash = ?', [sha256Hex(old.token)]);
    expect(purgeExpiredSessions(db)).toBeGreaterThanOrEqual(1);
    expect(db.get('SELECT 1 FROM sessions WHERE expires_at <= ?', [Date.now()])).toBeUndefined();
  });

  it('sessions: an ended one signs nobody in again, and ending it twice is harmless', () => {
    const dora = createLocalUser(db, { displayName: 'Dora', email: 'dora@example.com', passwordHash: 'x' });
    const ended = createSession(db, dora.id, 180);
    const other = createSession(db, dora.id, 180);
    endSession(db, ended.token);
    expect(resolveSession(db, ended.token, 180)).toBeNull();
    expect(db.get('SELECT 1 FROM sessions WHERE id_hash = ?', [sha256Hex(ended.token)])).toBeUndefined();
    endSession(db, ended.token);
    expect(resolveSession(db, other.token, 180)?.user.id).toBe(dora.id);
    // Nothing is kept of it (D116): the record of ended sessions that D52 needed is no longer written.
    expect(db.get('SELECT 1 FROM ended_sessions WHERE id_hash = ?', [sha256Hex(ended.token)])).toBeUndefined();
    // What is left there from before goes once its cookie would have expired.
    db.exec('INSERT INTO ended_sessions (id_hash, expires_at) VALUES (?, ?), (?, ?)', ['old', Date.now() - 1, 'fresh', Date.now() + 60_000]);
    purgeExpiredSessions(db);
    expect(db.all<{ id_hash: string }>("SELECT id_hash FROM ended_sessions WHERE id_hash IN ('old', 'fresh')").map((r) => r.id_hash)).toEqual(['fresh']);
  });

  it('clubs: lists the ids of a club’s members', () => {
    const owner = createLocalUser(db, { displayName: 'Owner', email: 'owner@example.com', passwordHash: 'x' });
    const club = createClub(db, { name: 'Ids', description: '', ownerId: owner.id });
    expect(addMember(db, club.id, userId)).toBe(true);
    expect(addMember(db, club.id, userId)).toBe(false);
    expect(memberIds(db, club.id).sort()).toEqual([owner.id, userId].sort());
  });

  it('users: emails match case-insensitively', () => {
    expect(userByEmail(db, 'ANA@EXAMPLE.COM')?.id).toBe(userId);
  });

  it('users: upstream identities are created once and follow upstream name and email', () => {
    const first = upsertUpstreamUser(db, { subject: 'upstream:1', displayName: 'Dee', email: 'dee@example.com' });
    expect(first).toMatchObject({ display_name: 'Dee', email: 'dee@example.com', upstream_subject: 'upstream:1', password_hash: null });
    const renamed = upsertUpstreamUser(db, { subject: 'upstream:1', displayName: 'Dee Dee', email: 'dd@example.com' });
    expect(renamed).toMatchObject({ id: first.id, display_name: 'Dee Dee', email: 'dd@example.com' });
    // An email that belongs to another account is never taken over.
    const clash = upsertUpstreamUser(db, { subject: 'upstream:1', displayName: 'Dee Dee', email: 'ana@example.com' });
    expect(clash).toMatchObject({ id: first.id, email: 'dd@example.com' });
    const newcomer = upsertUpstreamUser(db, { subject: 'upstream:2', displayName: 'Eve', email: 'ANA@example.com' });
    expect(newcomer.email).toBeNull();
    expect(userById(db, userId)?.email).toBe('ana@example.com');
  });

  it('imports: prefer a completed upload of a file, else the newest attempt', () => {
    const club = createClub(db, { name: 'C', description: '', ownerId: userId });
    const imp = createImportRow(db, { clubId: club.id, userId, kind: 'audio', files: [] });
    const add = (id: string, fileIndex: number, createdAt: number, complete: boolean) => {
      createUploadRow(db, { id, importId: imp.id, fileIndex, userId, size: 10 });
      db.exec('UPDATE uploads SET created_at = ? WHERE id = ?', [createdAt, id]);
      if (complete) markUploadComplete(db, id);
    };
    add('done-old', 0, 1, true);
    add('partial-new', 0, 2, false);
    add('partial-a', 1, 1, false);
    add('partial-b', 1, 2, false);
    add('done-a', 2, 1, true);
    add('done-b', 2, 2, true);
    add('partial-c', 3, 1, false);
    add('done-c', 3, 2, true);
    const latest = latestUploads(db, imp.id);
    expect([0, 1, 2, 3].map((i) => latest.get(i)?.id)).toEqual(['done-old', 'partial-b', 'done-b', 'done-c']);
    // Completing an upload twice keeps the first completion time.
    const before = db.get<{ completed_at: number }>("SELECT completed_at FROM uploads WHERE id = 'done-old'")?.completed_at;
    markUploadComplete(db, 'done-old');
    expect(db.get<{ completed_at: number }>("SELECT completed_at FROM uploads WHERE id = 'done-old'")?.completed_at).toBe(before);
  });

  it('imports: once finished or cancelled, an import stays so, whichever of a cancel and a finish comes first', () => {
    const club = createClub(db, { name: 'S', description: '', ownerId: userId });
    const cancelled = createImportRow(db, { clubId: club.id, userId, kind: 'epub', files: [] });
    expect(setImportStatus(db, cancelled.id, 'cancelled')).toBe(true);
    expect(setImportStatus(db, cancelled.id, 'finalized', 'book-x', 'edition-x')).toBe(false);
    expect(importById(db, cancelled.id)).toMatchObject({ status: 'cancelled', book_id: null, edition_id: null });
    const finished = createImportRow(db, { clubId: club.id, userId, kind: 'epub', files: [] });
    expect(setImportStatus(db, finished.id, 'finalized', 'book-y', 'edition-y')).toBe(true);
    expect(setImportStatus(db, finished.id, 'cancelled')).toBe(false);
    expect(importById(db, finished.id)).toMatchObject({ status: 'finalized', book_id: 'book-y', edition_id: 'edition-y' });
  });

  it('blobs: an unused file shared while the sweep runs is kept, where deleting it would have failed', async () => {
    const own = freshDb();
    const storage = new Storage(tempDir());
    await storage.init();
    const { log, entries } = recordingLogger();
    const ctx = { db: own, storage, log } as unknown as AppContext;
    const owner = createLocalUser(own, { displayName: 'O', email: 'o@example.com', passwordHash: 'x' });
    const book = createBook(own, { clubId: createClub(own, { name: 'B', description: '', ownerId: owner.id }).id, title: 'B', author: '', createdBy: owner.id });
    const edition = createEdition(own, { bookId: book.id, kind: 'epub', createdBy: owner.id, sizeBytes: 1 });
    for (const id of ['blobAaaaaaaaaaaa', 'blobBbbbbbbbbbbb']) {
      insertBlob(own, { id, sha256: id, size: 1, mime: 'application/epub+zip' });
      own.exec('UPDATE blobs SET created_at = 0 WHERE id = ?', [id]);
      mkdirSync(path.dirname(storage.blobPath(id)), { recursive: true });
      writeFileSync(storage.blobPath(id), 'x');
    }
    // While the first is removed, a finish shares the second.
    const remove = storage.removeBlob.bind(storage);
    let shared: string | null = null;
    storage.removeBlob = async (id) => {
      shared ??= id === 'blobAaaaaaaaaaaa' ? 'blobBbbbbbbbbbbb' : 'blobAaaaaaaaaaaa';
      addEditionFile(own, { edition_id: edition.id, idx: 0, blob_id: shared, role: 'main', original_name: 'shared.epub' });
      return remove(id);
    };
    expect(await removeOrphanBlobs(ctx, 0)).toBe(1);
    expect(shared).not.toBeNull();
    expect(blobById(own, shared!)).toBeDefined();
    expect(existsSync(storage.blobPath(shared!))).toBe(true);
    expect(entries.filter((e) => e.level === 'error')).toEqual([]);
    own.close();
  });

  it('blobs: the sweep never fails; what goes wrong is logged and left for the next round', async () => {
    const own = freshDb();
    const storage = new Storage(tempDir());
    await storage.init();
    const { log, entries } = recordingLogger();
    insertBlob(own, { id: 'blobCcccccccccccc', sha256: 'c', size: 1, mime: 'image/jpeg' });
    own.exec('UPDATE blobs SET created_at = 0');
    storage.removeBlob = () => Promise.reject(new Error('EIO: the disk is gone'));
    await expect(removeOrphanBlobs({ db: own, storage, log } as unknown as AppContext, 0)).resolves.toBe(0);
    expect(entries).toContainEqual(expect.objectContaining({ level: 'error', msg: 'an unused file could not be removed' }));
    own.close();
    // A database that cannot be read at all.
    await expect(removeOrphanBlobs({ db: own, storage, log } as unknown as AppContext, 0)).resolves.toBe(0);
    expect(entries).toContainEqual(expect.objectContaining({ level: 'error', msg: 'unused files could not be listed' }));
  });

  it('blobs: lists blobs nothing refers to any more', () => {
    const club = createClub(db, { name: 'D', description: '', ownerId: userId });
    insertBlob(db, { id: 'blob-orphan', sha256: 'a', size: 1, mime: 'image/jpeg' });
    insertBlob(db, { id: 'blob-cover', sha256: 'b', size: 1, mime: 'image/jpeg' });
    const book = createBook(db, { clubId: club.id, title: 'B', author: '', createdBy: userId });
    setBookCover(db, book.id, 'blob-cover');
    const orphans = orphanBlobs(db).map((b) => b.id);
    expect(orphans).toContain('blob-orphan');
    expect(orphans).not.toContain('blob-cover');
    deleteBlobRow(db, 'blob-orphan');
    expect(blobById(db, 'blob-orphan')).toBeUndefined();
  });
});

describe('ingest/pipeline placeOnTimeline', () => {
  const book = (over: Partial<BookRow> = {}): BookRow => ({
    id: 'book1',
    club_id: 'club1',
    title: 'T',
    author: 'A',
    cover_blob_id: null,
    reference_edition_id: null,
    chapters_json: '[]',
    created_by: 'u1',
    created_at: 0,
    ...over,
  });
  const edition = (id: string, status: EditionRow['status'] = 'ready'): EditionRow => ({
    id,
    book_id: 'book1',
    kind: 'epub',
    status,
    error: null,
    geometry_json: null,
    units_json: '[]',
    sync_json: null,
    alignment_json: '{"method":"none","unitToChapter":[]}',
    meta_json: '{}',
    size_bytes: 0,
    created_by: 'u1',
    created_at: 0,
  });
  type Ingested = Parameters<typeof placeOnTimeline>[3];
  const ingested = (units: { title: string; m: number }[], story: { start: number; end: number }): Ingested => ({
    geometry: { kind: 'epub', sectionLengths: [story.end] },
    units,
    story,
    meta: {},
  });

  it('makes the first edition the reference: a linear map over its story and its chapters', () => {
    const placement = placeOnTimeline(
      book(),
      [edition('e1', 'processing')],
      'e1',
      ingested(
        [
          { title: 'Header', m: 10 },
          { title: 'Part One', m: 100 },
          { title: 'Chapter 1', m: 100 },
          { title: 'Chapter 2', m: 600 },
          { title: 'Licence', m: 1100 },
        ],
        { start: 100, end: 1100 },
      ),
    );
    expect(placement.sync).toEqual(linearSyncMap(100, 1100));
    expect(placement.alignment.method).toBe('reference');
    // A part heading at the same place as its first chapter gives way to the chapter.
    expect(placement.chapters).toEqual([
      { index: 0, title: 'Chapter 1', t: 0 },
      { index: 1, title: 'Chapter 2', t: 0.5 },
    ]);
    expect(placement.alignment.unitToChapter).toEqual([null, null, 0, 1, null]);
  });

  it('falls back to [0, 1] when an edition has no story to speak of', () => {
    const placement = placeOnTimeline(book(), [], 'e1', ingested([], { start: 0, end: 0 }));
    expect(placement.sync).toEqual(linearSyncMap(0, 1));
    expect(placement.chapters).toEqual([]);
  });

  it('aligns a later edition to the book chapters', () => {
    const chapters = [
      { index: 0, title: 'Chapter 1', t: 0 },
      { index: 1, title: 'Chapter 2', t: 0.4 },
      { index: 2, title: 'Chapter 3', t: 0.7 },
    ];
    const placement = placeOnTimeline(
      book({ reference_edition_id: 'e1', chapters_json: JSON.stringify(chapters) }),
      [edition('e1'), edition('e2', 'processing')],
      'e2',
      ingested(
        [
          { title: 'Track 1', m: 0 },
          { title: 'Track 2', m: 1000 },
          { title: 'Track 3', m: 3000 },
        ],
        { start: 0, end: 4000 },
      ),
    );
    expect(placement.alignment).toEqual({ method: 'count', unitToChapter: [0, 1, 2] });
    expect(placement.chapters).toBeNull();
    expect(mToT(placement.sync, 1000)).toBeCloseTo(0.4, 12);
    expect(mToT(placement.sync, 3000)).toBeCloseTo(0.7, 12);
    expect(mToT(placement.sync, 4000)).toBe(1);
  });

  it('lets a later edition name the chapters of a book whose first edition had none', () => {
    const placement = placeOnTimeline(
      book({ reference_edition_id: 'e1' }),
      [edition('e1'), edition('e2', 'processing')],
      'e2',
      ingested(
        [
          { title: 'Opening', m: 0 },
          { title: 'Closing', m: 500 },
        ],
        { start: 0, end: 1000 },
      ),
    );
    expect(placement.alignment.method).toBe('none');
    expect(placement.sync).toEqual(linearSyncMap(0, 1000));
    expect(placement.chapters).toEqual([
      { index: 0, title: 'Opening', t: 0 },
      { index: 1, title: 'Closing', t: 0.5 },
    ]);
  });

  it('places a great many units in time that grows with their number, not its square', () => {
    const units = (n: number, title: (i: number) => string) => Array.from({ length: n }, (_, i) => ({ title: title(i), m: i * 10 }));
    let started = performance.now();
    const reference = placeOnTimeline(book(), [edition('e1', 'processing')], 'e1', ingested(units(MAX_EDITION_UNITS, (i) => `Chapter ${i + 1}`), { start: 0, end: MAX_EDITION_UNITS * 10 }));
    expect(reference.chapters).toHaveLength(MAX_EDITION_UNITS);
    expect(reference.alignment.unitToChapter.at(-1)).toBe(MAX_EDITION_UNITS - 1);
    expect(performance.now() - started).toBeLessThan(1000);
    // A hundred times the units an ingest keeps, each numbered as no chapter is: matched by number
    // as before, every one of them would have looked through all 2000 chapters (minutes of work).
    started = performance.now();
    const later = placeOnTimeline(
      book({ reference_edition_id: 'e1', chapters_json: JSON.stringify(reference.chapters) }),
      [edition('e1'), edition('e2', 'processing')],
      'e2',
      ingested(units(100 * MAX_EDITION_UNITS, () => 'Track 9999'), { start: 0, end: 1000 * MAX_EDITION_UNITS }),
    );
    expect(later.alignment.method).toBe('none');
    expect(later.alignment.unitToChapter).toHaveLength(100 * MAX_EDITION_UNITS);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
