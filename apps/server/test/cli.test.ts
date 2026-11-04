import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BookDetailSchema, type BookProgress, type ClubSummary, type CommentView, type Publication } from '@bookclub/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeBook } from '../src/services/removal';
import { backup, restore } from '../src/cli/backup';
import { backupSet, listSnapshots, pruneSet, restoreSet, type SetManifest } from '../src/cli/backup-set';
import { DEMO_PASSWORD, DEMO_USERS, findDemoAssets, seedDemoIfEmpty } from '../src/cli/seed';
import { hashFile } from '../src/storage/storage';
import { ALICE_EPUB, ALICE_PDF, FIXTURES, ROOT, type TestApp, bookDetail, closeApp, fileFrom, makeTestApp, setupOwner, signIn, uploadBook } from './helpers';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** The set's snapshots are named to the second; two in the same test need a second apart. */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

describe('demo seed', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeTestApp();
  });

  afterAll(async () => {
    await closeApp(t);
  });

  it('finds the demo books in the folder it is given, else in the repository fixtures', async () => {
    const audioDirs = [path.join(FIXTURES, 'audio/librivox-alice'), path.join(FIXTURES, 'audio/alice-tiny')];
    for (const root of [FIXTURES, '', '/nonexistent/demo-assets']) {
      const assets = await findDemoAssets(root);
      expect(assets).toMatchObject({ epub: path.join(FIXTURES, 'books/alice-gutenberg-11.epub'), pdf: path.join(FIXTURES, 'books/alice.pdf') });
      expect(audioDirs).toContain(assets!.audioDir);
    }
  });

  it('seeds four friends reading Alice in three formats, once', async () => {
    expect(await seedDemoIfEmpty(t.ctx, FIXTURES)).toBe(true);
    const cole = await signIn(t, 'cole@demo.bookclub', DEMO_PASSWORD);
    const clubs = await cole.json<ClubSummary[]>(cole.get('/api/clubs'), 200);
    expect(clubs).toEqual([expect.objectContaining({ name: 'The Rabbit Hole Society', role: 'owner', memberCount: 4, bookCount: 1 })]);
    const [summary] = await cole.json<{ id: string }[]>(cole.get(`/api/clubs/${clubs[0]!.id}/books`), 200);
    const book = BookDetailSchema.parse(await cole.json(cole.get(`/api/books/${summary!.id}`), 200));
    expect(book).toMatchObject({ title: "Alice's Adventures in Wonderland", author: 'Lewis Carroll', hasCover: true });
    expect(book.editions.map((e) => [e.kind, e.status])).toEqual([
      ['epub', 'ready'],
      ['pdf', 'ready'],
      ['audio', 'ready'],
    ]);
    expect(book.referenceEditionId).toBe(book.editions[0]!.id);
    expect(book.chapters).toHaveLength(15);

    const progress = await cole.json<BookProgress>(cole.get(`/api/books/${book.id}/progress`), 200);
    const byName = new Map(progress.members.map((m) => [m.displayName, m]));
    // The seed creates every membership in the same millisecond, so their order is not defined.
    expect([...byName.keys()].sort()).toEqual(['Ana', 'Ben', 'Cleo', 'Cole']);
    // Cole, who opens the demo on his phone, in the EPUB; the PDF read further on, at a computer.
    for (const [name, t, kind] of [
      ['Ana', 0.47, 'epub'],
      ['Cleo', 0.71, 'pdf'],
      ['Ben', 0.18, 'audio'],
      ['Cole', 0.08, 'epub'],
    ] as const) {
      expect(byName.get(name)!.t, name).toBeCloseTo(t, 3);
      expect(byName.get(name)!.kind, name).toBe(kind);
    }

    // Cole has read the first 8 %: only the note at 3.5 % is open to him.
    const comments = await cole.json<CommentView[]>(cole.get(`/api/books/${book.id}/comments`), 200);
    expect(comments).toHaveLength(6);
    expect(comments.filter((c) => !c.hidden).map((c) => [c.authorName, c.reaction])).toEqual([['Ana', '😂']]);
    expect(comments.find((c) => c.kind === 'audio')).toMatchObject({ authorName: 'Ben', hidden: true });

    // The club's next stop, set by Ana: the end of chapter 6, in four days; Cleo is past it.
    expect(book.meeting).toMatchObject({ label: 'the end of Chapter 6', setBy: { displayName: 'Ana' } });
    expect(book.meeting!.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(book.meeting!.on!) - Date.now()).toBeGreaterThan(3 * 24 * 3600_000);
    expect(byName.get('Cleo')!.furthest).toBeGreaterThan(book.meeting!.t);
    expect(byName.get('Ana')!.furthest).toBeLessThan(book.meeting!.t);

    for (const u of DEMO_USERS) await signIn(t, u.email, DEMO_PASSWORD);
    expect(await seedDemoIfEmpty(t.ctx, FIXTURES)).toBe(false);
  });

  it('seeds a one-format demo when only the EPUB is available', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bookclub-demo-assets-'));
    const app = await makeTestApp();
    try {
      mkdirSync(path.join(root, 'books'));
      copyFileSync(ALICE_EPUB, path.join(root, 'books', 'alice-gutenberg-11.epub'));
      expect(await findDemoAssets(root)).toEqual({ epub: path.join(root, 'books', 'alice-gutenberg-11.epub'), pdf: null, audioDir: null, transcript: null });
      expect(await seedDemoIfEmpty(app.ctx, root)).toBe(true);
      const cole = await signIn(app, 'cole@demo.bookclub', DEMO_PASSWORD);
      const [club] = await cole.json<ClubSummary[]>(cole.get('/api/clubs'), 200);
      const [summary] = await cole.json<{ id: string }[]>(cole.get(`/api/clubs/${club!.id}/books`), 200);
      const book = await bookDetail(cole, summary!.id);
      expect(book.editions.map((e) => e.kind)).toEqual(['epub']);
      const progress = await cole.json<BookProgress>(cole.get(`/api/books/${book.id}/progress`), 200);
      expect(progress.members.map((m) => m.kind)).toEqual(['epub', 'epub', 'epub', 'epub']);
      expect(await cole.json<CommentView[]>(cole.get(`/api/books/${book.id}/comments`), 200)).toHaveLength(5);
    } finally {
      await closeApp(app);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('seeds nothing when the demo books cannot be found anywhere', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'bookclub-no-assets-'));
    const nested = path.join(base, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const cwd = process.cwd();
    const app = await makeTestApp();
    try {
      // Away from the repository, neither ./fixtures nor ../../fixtures exists.
      process.chdir(nested);
      expect(await findDemoAssets('')).toBeNull();
      expect(await seedDemoIfEmpty(app.ctx, path.join(base, 'missing'))).toBe(false);
      expect(app.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n).toBe(0);
    } finally {
      process.chdir(cwd);
      await closeApp(app);
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('create-owner', () => {
  let dir: string;
  // The command as an operator runs it: a process of its own, the password piped in.
  const cli = (args: string[], input?: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'create-owner', ...args], {
      cwd: path.join(ROOT, 'apps/server'),
      input,
      encoding: 'utf8',
      env: { ...process.env, DATA_DIR: dir, LOG_LEVEL: 'silent', SCRYPT_LOG_N: '12' },
    });

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bookclub-owner-test-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the password from stdin, so it is never on the command line', async () => {
    const run = cli(['--email', 'Owner@Example.org', '--name', 'Owner', '--club', 'Our club', '--password-stdin'], 'a piped-in password\n');
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('created owner@example.org with club "Our club"\n');
    expect(run.status).toBe(0);
    const t = await makeTestApp({ DATA_DIR: dir });
    try {
      // Without the line break that ended the piped line.
      const owner = await signIn(t, 'owner@example.org', 'a piped-in password');
      const clubs = await owner.json<ClubSummary[]>(owner.get('/api/clubs'), 200);
      expect(clubs).toEqual([expect.objectContaining({ name: 'Our club', role: 'owner' })]);
    } finally {
      await closeApp(t);
    }
  });

  it('refuses what the setup page refuses, two passwords, and none', () => {
    const second = ['--email', 'second@example.org', '--name', 'Second'];
    expect(cli([...second, '--password-stdin'], 'too short\n')).toMatchObject({ status: 1, stderr: '--password: Use at least 10 characters\n' });
    expect(cli([...second, '--password', 'too short'])).toMatchObject({ status: 1, stderr: '--password: Use at least 10 characters\n' });
    expect(cli(['--email', 'not an address', '--name', 'Second', '--password', 'long enough, surely'])).toMatchObject({ status: 1, stderr: '--email: Enter a valid email address\n' });
    expect(cli([...second, '--password', 'long enough, surely', '--password-stdin'], 'long enough, surely')).toMatchObject({
      status: 1,
      stderr: 'create-owner takes --password or --password-stdin, not both\n',
    });
    expect(cli([...second, '--password-stdin'], '')).toMatchObject({ status: 1, stderr: 'create-owner needs --email, --name and --password (or --password-stdin)\n' });
    // A second owner with the first one's address, in any case.
    expect(cli(['--email', 'OWNER@example.org', '--name', 'Again', '--password-stdin'], 'another long password')).toMatchObject({
      status: 1,
      stderr: 'a user with that email exists\n',
    });
  });
});

describe('backup and restore', () => {
  let work: string;
  let archive: string;
  let bookId: string;

  beforeAll(async () => {
    work = mkdtempSync(path.join(tmpdir(), 'bookclub-backup-test-'));
    const t = await makeTestApp();
    try {
      const { owner, club } = await setupOwner(t);
      const uploaded = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
      bookId = uploaded.bookId;
      await t.settle();
      await owner.json(owner.post(`/api/books/${bookId}/comments`, { editionId: uploaded.editionId, locator: { kind: 'epub', section: 3, offset: 0 }, text: 'Saved in the backup' }), 201);
      expect((await owner.get(`/media/books/${bookId}/cover?w=160`)).statusCode).toBe(200);
      // Taken while the server is running.
      const result = await backup(t.dir, path.join(work, 'nested', 'bookclub.tar.gz'));
      archive = result.file;
      expect(result.bytes).toBe(statSync(archive).size);
      expect(readdirSync(t.dir).some((name) => name.startsWith('.backup-'))).toBe(false);
    } finally {
      await closeApp(t);
    }
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('writes one archive with the database snapshot and the stored files, without caches', () => {
    expect(path.isAbsolute(archive)).toBe(true);
    expect(existsSync(`${archive}.partial`)).toBe(false);
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(listing).toContain('bookclub.db');
    expect(listing.some((entry) => entry.startsWith('blobs/'))).toBe(true);
    expect(listing.some((entry) => entry.startsWith('pubs/'))).toBe(true);
    expect(listing.some((entry) => /^(derived|uploads|tmp)\b/.test(entry) || entry.includes('-wal'))).toBe(false);
  });

  it('restores into an empty directory that a new server can run on', async () => {
    const restored = path.join(work, 'restored');
    await restore(archive, restored);
    const t = await makeTestApp({ DATA_DIR: restored });
    try {
      const owner = await signIn(t, 'cole@example.com');
      const book = await bookDetail(owner, bookId);
      expect(book.editions[0]!.status).toBe('ready');
      const pub = await owner.json<Publication>(owner.get(book.editions[0]!.publicationUrl!), 200);
      const chapterOne = pub.sections[pub.toc.find((e) => e.title.startsWith('CHAPTER I.'))!.section]!;
      expect((await owner.get(`${pub.baseUrl}${chapterOne.href}`)).body).toContain('Alice was beginning to get very tired');
      const comments = await owner.json<CommentView[]>(owner.get(`/api/books/${bookId}/comments`), 200);
      expect(comments.map((c) => (c.hidden ? null : c.text))).toEqual(['Saved in the backup']);
      // Cover thumbnails were left out and are simply rebuilt.
      expect((await owner.get(`/media/books/${bookId}/cover?w=160`)).statusCode).toBe(200);
    } finally {
      await closeApp(t);
    }
  });

  it('refuses to replace an existing database unless forced, and then replaces everything', async () => {
    const target = path.join(work, 'occupied');
    await restore(archive, target);
    mkdirSync(path.join(target, 'derived'), { recursive: true });
    writeFileSync(path.join(target, 'derived', 'stale.webp'), 'stale');
    await expect(restore(archive, target)).rejects.toThrow(/exists; pass --force to replace it/);
    await restore(archive, target, { force: true });
    expect(existsSync(path.join(target, 'derived', 'stale.webp'))).toBe(false);
    expect(existsSync(path.join(target, 'bookclub.db'))).toBe(true);
  });

  it('refuses a damaged archive', async () => {
    const bad = path.join(work, 'bad');
    mkdirSync(bad);
    writeFileSync(path.join(bad, 'bookclub.db'), 'this is not a database, just text pretending to be one'.repeat(100));
    const badArchive = path.join(work, 'bad.tar.gz');
    execFileSync('tar', ['-czf', badArchive, '-C', bad, 'bookclub.db']);
    await expect(restore(badArchive, path.join(work, 'from-bad'))).rejects.toThrow();
  });

  it('a damaged or truncated archive, even forced, leaves the current data exactly as it was', async () => {
    const target = path.join(work, 'kept');
    await restore(archive, target);
    const before = readFileSync(path.join(target, 'bookclub.db'));
    const truncated = path.join(work, 'truncated.tar.gz');
    writeFileSync(truncated, readFileSync(archive).subarray(0, Math.floor(readFileSync(archive).length / 2)));
    await expect(restore(truncated, target, { force: true })).rejects.toThrow();
    const bad = path.join(work, 'bad2');
    mkdirSync(bad);
    writeFileSync(path.join(bad, 'bookclub.db'), 'not a database '.repeat(500));
    const badArchive = path.join(work, 'bad2.tar.gz');
    execFileSync('tar', ['-czf', badArchive, '-C', bad, 'bookclub.db']);
    await expect(restore(badArchive, target, { force: true })).rejects.toThrow();
    expect(readFileSync(path.join(target, 'bookclub.db')).equals(before)).toBe(true);
    expect(existsSync(path.join(target, 'blobs'))).toBe(true);
    // Nothing half-done is left beside the data.
    expect(readdirSync(target).filter((n) => n.startsWith('.restore-') || n.startsWith('.replaced-'))).toEqual([]);
  });

  it('refuses an archive with links, special files or anything unexpected in it, and one without its files', async () => {
    const target = path.join(work, 'guarded');
    await restore(archive, target);
    const before = readFileSync(path.join(target, 'bookclub.db'));
    const unpacked = path.join(work, 'unpacked');
    mkdirSync(unpacked);
    execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
    const repack = (name: string) => {
      const out = path.join(work, `${name}.tar.gz`);
      execFileSync('tar', ['-czf', out, '-C', unpacked, ...readdirSync(unpacked)]);
      return out;
    };
    // A symbolic link to somewhere else on the machine.
    symlinkSync('/etc/passwd', path.join(unpacked, 'pubs', 'link'));
    await expect(restore(repack('with-link'), target, { force: true })).rejects.toThrow(/a link or a special file: pubs\/link/);
    rmSync(path.join(unpacked, 'pubs', 'link'));
    // Something that is not part of a backup.
    writeFileSync(path.join(unpacked, 'extra.sh'), 'echo hi');
    await expect(restore(repack('with-extra'), target, { force: true })).rejects.toThrow(/something it should not: extra.sh/);
    rmSync(path.join(unpacked, 'extra.sh'));
    // The database alone: every book's files would be gone.
    rmSync(path.join(unpacked, 'blobs'), { recursive: true });
    await expect(restore(repack('db-only'), target, { force: true })).rejects.toThrow(/missing \d+ of the \d+ files/);
    // None of that touched the data.
    expect(readFileSync(path.join(target, 'bookclub.db')).equals(before)).toBe(true);
    expect(readdirSync(path.join(target, 'blobs')).length).toBeGreaterThan(0);
  });

  it('fails clearly when there is nothing to back up or restore', async () => {
    await expect(backup(path.join(work, 'no-data-here'), path.join(work, 'x.tar.gz'))).rejects.toThrow(/ENOENT/);
    await expect(restore(path.join(work, 'missing.tar.gz'), path.join(work, 'nowhere'))).rejects.toThrow(/ENOENT/);
  });
});

describe('incremental backup sets (D125, D126)', () => {
  let work: string;

  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), 'bookclub-backup-set-test-'));
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('writes a snapshot once, copies nothing again when nothing changed, and restores either one', async () => {
    const t = await makeTestApp();
    const setDir = path.join(work, 'set-basic');
    let bookId: string;
    try {
      const { owner, club } = await setupOwner(t, 'Basic', 'Basic Club');
      const uploaded = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
      bookId = uploaded.bookId;
      await t.settle();
      await owner.json(owner.post(`/api/books/${bookId}/comments`, { editionId: uploaded.editionId, locator: { kind: 'epub', section: 3, offset: 0 }, text: 'Kept across the snapshot' }), 201);

      const first = await backupSet(t.dir, setDir, { keep: 14 });
      expect(first.blobsTotal).toBeGreaterThan(0);
      expect(first.blobsCopied).toBe(first.blobsTotal);
      expect(first.pubsTotal).toBeGreaterThan(0);
      expect(first.pubsCopied).toBe(first.pubsTotal);
      // Staging cleaned up beside the set, as the one-file backup cleans up beside the data.
      expect(readdirSync(setDir).filter((n) => n.startsWith('.backup-'))).toEqual([]);

      await nextSecond();
      const second = await backupSet(t.dir, setDir, { keep: 14 });
      expect(second.ts).not.toBe(first.ts);
      expect(second.blobsCopied).toBe(0); // the blob's bytes are already in the set, unchanged
      expect(second.pubsCopied).toBe(0);
      expect(await listSnapshots(setDir)).toHaveLength(2);

      // The newest snapshot restores; so does the first, named by its own timestamp.
      for (const [dir, at] of [
        [path.join(work, 'basic-restored-newest'), undefined],
        [path.join(work, 'basic-restored-first'), first.ts],
      ] as const) {
        await restoreSet(setDir, dir, { at });
        const t2 = await makeTestApp({ DATA_DIR: dir });
        try {
          const owner2 = await signIn(t2, 'basic@example.com');
          const book = await bookDetail(owner2, bookId);
          expect(book.editions[0]!.status).toBe('ready');
          const pub = await owner2.json<Publication>(owner2.get(book.editions[0]!.publicationUrl!), 200);
          const chapterOne = pub.sections[pub.toc.find((e) => e.title.startsWith('CHAPTER I.'))!.section]!;
          expect((await owner2.get(`${pub.baseUrl}${chapterOne.href}`)).body).toContain('Alice was beginning to get very tired');
          const comments = await owner2.json<CommentView[]>(owner2.get(`/api/books/${bookId}/comments`), 200);
          expect(comments.map((c) => (c.hidden ? null : c.text))).toEqual(['Kept across the snapshot']);
        } finally {
          await closeApp(t2);
        }
      }
    } finally {
      await closeApp(t);
    }
  });

  it('prunes old snapshots and the files only they needed, after a book is deleted and cleaned up', async () => {
    const t = await makeTestApp();
    const setDir = path.join(work, 'set-prune');
    const aliceSha = await hashFile(ALICE_EPUB);
    try {
      const { owner, club } = await setupOwner(t, 'Pruner', 'Prune Club');
      const first = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
      await t.settle();
      await backupSet(t.dir, setDir, { keep: 14 });
      expect(existsSync(path.join(setDir, 'files', 'blobs', aliceSha.slice(0, 2), aliceSha))).toBe(true);

      // Deleting a book removes its now-unreferenced blob and publication files at once
      // (services/removal.ts purgeBook): the live store has moved on, but the first snapshot
      // still names Alice's files, so they must stay in the set until that snapshot is pruned.
      expect((await owner.delete(`/api/books/${first.bookId}`)).statusCode).toBe(204);
      await purgeBook(t.ctx, first.bookId); // removing is recoverable (D179); purging frees the files
      expect(existsSync(path.join(t.dir, 'blobs', aliceSha.slice(0, 2), aliceSha))).toBe(false);

      await nextSecond();
      await uploadBook(owner, club.id, 'pdf', [fileFrom(ALICE_PDF, 'main', 'application/pdf')], { title: 'Alice (PDF)', author: 'Lewis Carroll' });
      await t.settle();
      await nextSecond();
      const second = await backupSet(t.dir, setDir, { keep: 1 });

      expect(await listSnapshots(setDir)).toEqual([{ ts: second.ts, dbFile: second.dbFile, manifestFile: `bookclub-${second.ts}.manifest.json.gz` }]);
      expect(second.pruned.snapshotsRemoved).toBe(1);
      expect(second.pruned.filesRemoved).toBeGreaterThan(0);
      expect(second.pruned.bytesFreed).toBeGreaterThan(0);
      // Alice's EPUB, named only by the pruned first snapshot, is gone from the set too.
      expect(existsSync(path.join(setDir, 'files', 'blobs', aliceSha.slice(0, 2), aliceSha))).toBe(false);
    } finally {
      await closeApp(t);
    }
  });

  it('keeps an older snapshot restorable after a publication file is rewritten with different bytes (D126)', async () => {
    const t = await makeTestApp();
    const setDir = path.join(work, 'set-pub-change');
    try {
      const { owner, club } = await setupOwner(t, 'Pub', 'Pub Club');
      const uploaded = await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
      await t.settle();
      const manifestPath = path.join(t.dir, 'pubs', uploaded.editionId, '.publication.json');
      const before = readFileSync(manifestPath);
      const snap1 = await backupSet(t.dir, setDir, { keep: 14 });

      // A re-ingest from the same immutable blob can legitimately write different bytes at the
      // same path (a parser fix, a re-run): simulated directly, since nothing but content tells
      // the two apart (storage.ts writes pub files in place; D126's point is that it may).
      await t.ctx.storage.writePubFile(uploaded.editionId, '.publication.json', Buffer.concat([before, Buffer.from('\n')]));
      const after = readFileSync(manifestPath);
      expect(after.equals(before)).toBe(false);

      await nextSecond();
      const snap2 = await backupSet(t.dir, setDir, { keep: 14 });
      expect(snap2.pubsCopied).toBe(1); // only the one changed file is new content; the rest matched

      const beforeSha = sha256(before);
      const afterSha = sha256(after);
      expect(existsSync(path.join(setDir, 'files', 'pubs', beforeSha.slice(0, 2), beforeSha))).toBe(true);
      expect(existsSync(path.join(setDir, 'files', 'pubs', afterSha.slice(0, 2), afterSha))).toBe(true);

      const r1 = path.join(work, 'pub-restore-old');
      await restoreSet(setDir, r1, { at: snap1.ts });
      expect(readFileSync(path.join(r1, 'pubs', uploaded.editionId, '.publication.json')).equals(before)).toBe(true);

      const r2 = path.join(work, 'pub-restore-new');
      await restoreSet(setDir, r2);
      expect(readFileSync(path.join(r2, 'pubs', uploaded.editionId, '.publication.json')).equals(after)).toBe(true);
    } finally {
      await closeApp(t);
    }
  });

  it('refuses to restore a set missing a file its manifest names, and an unknown timestamp', async () => {
    const t = await makeTestApp();
    const setDir = path.join(work, 'set-corrupt');
    try {
      const { owner, club } = await setupOwner(t, 'Corrupt', 'Corrupt Club');
      await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
      await t.settle();
      await backupSet(t.dir, setDir, { keep: 14 });
    } finally {
      await closeApp(t);
    }
    const blobsRoot = path.join(setDir, 'files', 'blobs');
    const [prefix] = readdirSync(blobsRoot);
    rmSync(path.join(blobsRoot, prefix!), { recursive: true, force: true });
    await expect(restoreSet(setDir, path.join(work, 'from-corrupt'))).rejects.toThrow(/missing \d+ of the \d+ files/);
    await expect(restoreSet(setDir, path.join(work, 'from-nowhen'), { at: '19990101T000000Z' })).rejects.toThrow(/no snapshot at or before/);
    await expect(restoreSet(path.join(work, 'no-such-set'), path.join(work, 'from-nothing'))).rejects.toThrow(/no snapshot in/);
  });

  it('refuses a tampered manifest that tries to escape the set via sha256/editionId/path traversal (PR #13 security review)', async () => {
    const t = await makeTestApp();
    const setDir = path.join(work, 'set-traversal');
    try {
      const { owner, club } = await setupOwner(t, 'Traversal', 'Traversal Club');
      await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
      await t.settle();
      await backupSet(t.dir, setDir, { keep: 14 });
    } finally {
      await closeApp(t);
    }

    const outsideWrite = path.join(work, 'traversal-written.txt');
    const dbDir = path.join(setDir, 'db');
    const manifestFile = readdirSync(dbDir).find((n) => n.endsWith('.manifest.json.gz'))!;
    const manifestGzPath = path.join(dbDir, manifestFile);
    const original = JSON.parse(gunzipSync(readFileSync(manifestGzPath)).toString('utf8')) as SetManifest;

    const attempts: SetManifest[] = [
      // A blob sha256 that walks out of <setDir>/files/blobs to read an arbitrary file as the source.
      { ...original, blobs: original.blobs.map((b) => ({ ...b, sha256: '../../../../../../../../etc/passwd' })) },
      // A publication sha256 doing the same on the read side.
      { ...original, pubs: original.pubs.map((p) => ({ ...p, sha256: '../../../../../../../../etc/passwd' })) },
      // A publication editionId that escapes staging on the write side.
      { ...original, pubs: original.pubs.map((p) => ({ ...p, editionId: '..' })) },
      // A publication path that escapes staging on the write side, outside the setDir tree entirely.
      { ...original, pubs: original.pubs.map((p) => ({ ...p, path: `../../../../../../${outsideWrite}` })) },
    ];

    for (const tampered of attempts) {
      writeFileSync(manifestGzPath, gzipSync(Buffer.from(JSON.stringify(tampered))));
      await expect(restoreSet(setDir, path.join(work, `traversal-restored-${attempts.indexOf(tampered)}`))).rejects.toThrow(/invalid sha256|invalid editionId|unsafe path/);
      expect(existsSync(outsideWrite)).toBe(false);
    }
  });

  it('refuses to replace an existing database unless forced; pruneSet keeps at least one snapshot', async () => {
    const t = await makeTestApp();
    const setDir = path.join(work, 'set-keep-floor');
    try {
      const { owner, club } = await setupOwner(t, 'Floor', 'Floor Club');
      await uploadBook(owner, club.id, 'epub', [fileFrom(ALICE_EPUB, 'main', 'application/epub+zip')], { title: 'Alice', author: 'Lewis Carroll' });
      await t.settle();
      await backupSet(t.dir, setDir, { keep: 14 });
    } finally {
      await closeApp(t);
    }
    const occupied = path.join(work, 'floor-occupied');
    await restoreSet(setDir, occupied);
    await expect(restoreSet(setDir, occupied)).rejects.toThrow(/exists; pass --force to replace it/);
    await restoreSet(setDir, occupied, { force: true });
    // Asked to keep none, it keeps the one snapshot there is rather than leave the set empty.
    const pruned = await pruneSet(setDir, 0);
    expect(pruned.snapshotsRemoved).toBe(0);
    expect(await listSnapshots(setDir)).toHaveLength(1);
  });
});

describe('backup/restore/prune through the CLI', () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: path.join(ROOT, 'apps/server'),
      encoding: 'utf8',
      env: { ...process.env, LOG_LEVEL: 'silent', SCRYPT_LOG_N: '12', ...env },
    });

  it('backs up to a set, restores it elsewhere, and prunes it, with the flags an operator types', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'bookclub-cli-set-data-'));
    const setDir = mkdtempSync(path.join(tmpdir(), 'bookclub-cli-set-'));
    const restoreDir = mkdtempSync(path.join(tmpdir(), 'bookclub-cli-set-restored-'));
    try {
      expect(cli(['create-owner', '--email', 'owner@cli.test', '--name', 'Owner', '--password', 'a long cli password'], { DATA_DIR: dataDir })).toMatchObject({ status: 0 });

      const made = cli(['backup', '--set', setDir, '--keep', '2'], { DATA_DIR: dataDir });
      expect(made.stderr).toBe('');
      expect(made).toMatchObject({ status: 0, stdout: expect.stringMatching(/^backup set updated: .*\(snapshot bookclub-\d{8}T\d{6}Z\.db\.gz/) as string });

      const restored = cli(['restore', '--from-set', setDir, '--force'], { DATA_DIR: restoreDir });
      expect(restored).toMatchObject({ status: 0, stdout: expect.stringContaining(`restored ${setDir}`) as string });

      const pruned = cli(['prune', '--set', setDir, '--keep', '1']);
      expect(pruned).toMatchObject({ status: 0, stdout: expect.stringMatching(/^pruned 0 old snapshot/) as string }); // only the one snapshot exists
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(setDir, { recursive: true, force: true });
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it('rejects bad flags the way the single-file commands do', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bookclub-cli-set-badflags-'));
    try {
      expect(cli(['restore'], { DATA_DIR: dir })).toMatchObject({ status: 1, stderr: 'restore needs --from FILE or --from-set DIR\n' });
      expect(cli(['prune'], { DATA_DIR: dir })).toMatchObject({ status: 1, stderr: 'prune needs --set DIR\n' });
      expect(cli(['backup', '--set', path.join(dir, 'set'), '--keep', '0'], { DATA_DIR: dir })).toMatchObject({ status: 1, stderr: '--keep needs a positive whole number\n' });
      expect(cli(['prune', '--set', path.join(dir, 'set'), '--keep', 'many'], { DATA_DIR: dir })).toMatchObject({ status: 1, stderr: '--keep needs a positive whole number\n' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
