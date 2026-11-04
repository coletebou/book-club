import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const run = promisify(execFile);

/**
 * One-file backups: a consistent SQLite snapshot (VACUUM INTO, safe while the server runs) plus
 * the stored files, in a gzip'd tar. Derived caches (cover thumbnails) and in-flight uploads are
 * left out; they are rebuilt or re-sent.
 */
export async function backup(dataDir: string, outFile: string): Promise<{ file: string; bytes: number }> {
  const db = path.join(dataDir, 'bookclub.db');
  await stat(db);
  const staging = await mkdtemp(path.join(dataDir, '.backup-'));
  try {
    const source = new DatabaseSync(db, { readOnly: true });
    try {
      source.exec(`VACUUM INTO '${path.join(staging, 'bookclub.db').replace(/'/g, "''")}'`);
    } finally {
      source.close();
    }
    const out = path.resolve(outFile);
    await mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.partial`;
    const entries = ['blobs', 'pubs'];
    const existing: string[] = [];
    for (const e of entries) {
      try {
        await stat(path.join(dataDir, e));
        existing.push(e);
      } catch {
        // nothing stored yet
      }
    }
    await run('tar', ['-czf', tmp, '-C', staging, 'bookclub.db', ...existing.flatMap((e) => ['-C', dataDir, e])]);
    await rename(tmp, out);
    return { file: out, bytes: (await stat(out)).size };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export const RESTORED = ['bookclub.db', 'blobs', 'pubs'] as const;
export const REPLACED = ['bookclub.db', 'bookclub.db-wal', 'bookclub.db-shm', 'blobs', 'pubs', 'derived'] as const;

export async function moveIfThere(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * What a backup may hold, and nothing else: only regular files and directories under its three
 * entries (a link would point the restored data anywhere on the machine). Shared with the
 * incremental backup set's restore (cli/backup-set.ts), which stages the same three entries.
 */
export async function checkUnpacked(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    if (!(RESTORED as readonly string[]).includes(name)) throw new Error(`the backup holds something it should not: ${name}`);
  }
  const walk = async (p: string): Promise<void> => {
    const s = await lstat(p);
    if (s.isDirectory()) {
      for (const entry of await readdir(p)) await walk(path.join(p, entry));
    } else if (!s.isFile() || s.nlink > 1) {
      throw new Error(`the backup holds a link or a special file: ${path.relative(dir, p)}`);
    }
  };
  for (const name of await readdir(dir)) await walk(path.join(dir, name));
}

/**
 * Restore a backup into an empty (or, with `force`, a to-be-replaced) data directory. Stop the
 * server first. The archive is unpacked and checked beside the data before anything there is
 * touched, so a damaged or truncated archive leaves the current data exactly as it was.
 */
export async function restore(archive: string, dataDir: string, options: { force?: boolean } = {}): Promise<void> {
  await stat(archive);
  await mkdir(dataDir, { recursive: true });
  const db = path.join(dataDir, 'bookclub.db');
  const hasDb = await stat(db).then(
    () => true,
    () => false,
  );
  if (hasDb && !options.force) throw new Error(`${db} exists; pass --force to replace it`);
  const staging = await mkdtemp(path.join(dataDir, '.restore-'));
  try {
    await run('tar', ['-xzf', archive, '-C', staging, '--no-same-owner', '--no-same-permissions']);
    await checkUnpacked(staging);
    const check = new DatabaseSync(path.join(staging, 'bookclub.db'), { readOnly: true });
    try {
      const result = check.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (result.integrity_check !== 'ok') throw new Error(`the backup's database failed integrity_check: ${result.integrity_check}`);
      // Every file the database says is stored must be in the archive: a database-only archive
      // would otherwise replace every book's files with nothing.
      const ids = (check.prepare('SELECT id FROM blobs').all() as { id: string }[]).map((r) => r.id);
      const missing = ids.filter((id) => !/^[A-Za-z0-9_-]+$/.test(id) || !existsSync(path.join(staging, 'blobs', id.slice(0, 2), id)));
      if (missing.length > 0) throw new Error(`the backup is missing ${missing.length} of the ${ids.length} files its database lists`);
    } finally {
      check.close();
    }
    // Swap on the same volume: the current data moves aside, the restored data moves in.
    const aside = await mkdtemp(path.join(dataDir, '.replaced-'));
    for (const name of REPLACED) await moveIfThere(path.join(dataDir, name), path.join(aside, name));
    for (const name of RESTORED) await moveIfThere(path.join(staging, name), path.join(dataDir, name));
    await rm(aside, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
