import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, gunzipSync, gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { hashFile } from '../storage/storage';
import { REPLACED, RESTORED, checkUnpacked, moveIfThere } from './backup';

/**
 * Incremental backups (D125): the one-file `backup`/`restore` above stays exactly as it is (a
 * drill, moving to a new host, one portable artifact), but daily operation on a shared,
 * size-limited host cannot keep `BOOKCLUB_BACKUP_KEEP` FULL copies once a club's files are
 * audiobooks (a single full tarball already runs hundreds of MB to a few GB; fourteen of them
 * would not fit the free disk). `backupSet` instead writes one dated, gzip'd SQLite snapshot
 * (`VACUUM INTO`, checked with `PRAGMA integrity_check`) per run, plus the files it needs, into
 * two content-addressed stores shared by every snapshot:
 *
 *   <SET>/db/bookclub-<UTC>.db.gz             one per run
 *   <SET>/db/bookclub-<UTC>.manifest.json.gz  what that run's snapshot needs: every blob (by the
 *                                              sha256 the database records for it) and every
 *                                              publication file (by a sha256 this backup computes,
 *                                              since nothing records one for it, D126)
 *   <SET>/files/blobs/<sha256[0:2]>/<sha256>  a blob's bytes, named by its content
 *   <SET>/files/pubs/<sha256[0:2]>/<sha256>   a publication file's bytes, named by its content
 *
 * A file already in its store, under the content it holds now, is never copied again ("once").
 * Content addressing also makes a changed publication (a re-ingest after a parser fix, D126) safe:
 * the old bytes stay, under their own hash, for any older snapshot that still names them; the new
 * bytes land under a new hash. `pruneSet` keeps the newest `keep` snapshots and removes every file
 * no kept snapshot's manifest still names, so the set's size tracks what is actually in use, not
 * `keep` Ã— the size of everything ever uploaded.
 */

export interface BlobManifestEntry {
  readonly id: string;
  readonly sha256: string;
  readonly size: number;
}

export interface PubManifestEntry {
  readonly editionId: string;
  /** Relative to that edition's publication directory, e.g. ".publication.json" or "OEBPS/s0.xhtml". */
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface SetManifest {
  readonly createdAt: string;
  readonly db: string;
  readonly blobs: readonly BlobManifestEntry[];
  readonly pubs: readonly PubManifestEntry[];
}

export interface SnapshotInfo {
  readonly ts: string;
  readonly dbFile: string;
  readonly manifestFile: string;
}

export interface PruneResult {
  readonly snapshotsRemoved: number;
  readonly filesRemoved: number;
  readonly bytesFreed: number;
}

export interface BackupSetResult {
  readonly dir: string;
  readonly ts: string;
  readonly dbFile: string;
  readonly dbBytes: number;
  readonly blobsCopied: number;
  readonly blobsTotal: number;
  readonly pubsCopied: number;
  readonly pubsTotal: number;
  readonly pruned: PruneResult;
}

const SNAPSHOT_NAME = /^bookclub-(\d{8}T\d{6}Z)\.(db\.gz|manifest\.json\.gz)$/;

/** `20261028T000000Z`: the compose kit's own daily archives are named the same way. */
function utcTimestamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function gzipFile(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGzip(), createWriteStream(dest));
}

async function gunzipFile(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest));
}

async function readManifest(setDir: string, manifestFile: string): Promise<SetManifest> {
  const bytes = await readFile(path.join(setDir, 'db', manifestFile));
  return JSON.parse(gunzipSync(bytes).toString('utf8')) as SetManifest;
}

/** A real sha256 digest (hashFile's own format): exactly what every store path below is built from. */
const SHA256_HEX = /^[a-f0-9]{64}$/;
/** A blob id or edition id as the app ever hands out one (repos/blobs.ts, repos/books.ts `newId`). */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * A manifest a restore trusts enough to build filesystem paths from (PR #13 security review):
 * `sha256`, `editionId` and a publication's relative `path` all land, unchecked, in a `path.join`
 * that normalizes `..` away — so a tampered or corrupted manifest (the local set, or an
 * overwritten `*.manifest.json.gz` in object storage) could make `restoreSet` read any file the
 * restore process can open as a "blob" or "publication", and, on the write side, land it anywhere
 * that process can write, surviving even a failed restore (the only rollback, `rm(staging)`, never
 * touches a path that escaped `staging`). Every manifest entry's filesystem-shaped fields are
 * checked, and the whole manifest rejected, before any `mkdir`/`copyFile` runs.
 */
function assertSafeManifest(manifest: SetManifest): void {
  for (const b of manifest.blobs) {
    if (!SHA256_HEX.test(b.sha256)) throw new Error(`manifest names a blob with an invalid sha256: ${JSON.stringify(b.sha256)}`);
  }
  for (const p of manifest.pubs) {
    if (!SHA256_HEX.test(p.sha256)) throw new Error(`manifest names a publication file with an invalid sha256: ${JSON.stringify(p.sha256)}`);
    if (!SAFE_ID.test(p.editionId)) throw new Error(`manifest names a publication with an invalid editionId: ${JSON.stringify(p.editionId)}`);
    const normalized = path.normalize(p.path);
    if (path.isAbsolute(p.path) || normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.startsWith('/')) {
      throw new Error(`manifest names a publication with an unsafe path: ${JSON.stringify(p.path)}`);
    }
  }
}

/** Every complete snapshot (a `.db.gz` with its `.manifest.json.gz`) in a set, oldest first. */
export async function listSnapshots(setDir: string): Promise<SnapshotInfo[]> {
  const dbDir = path.join(setDir, 'db');
  if (!existsSync(dbDir)) return [];
  const byTs = new Map<string, { dbFile?: string; manifestFile?: string }>();
  for (const name of await readdir(dbDir)) {
    const m = SNAPSHOT_NAME.exec(name);
    if (!m) continue; // a .partial from an interrupted run, or something else: never a snapshot
    const ts = m[1]!;
    const kind = m[2]!;
    const entry = byTs.get(ts) ?? {};
    if (kind === 'db.gz') entry.dbFile = name;
    else entry.manifestFile = name;
    byTs.set(ts, entry);
  }
  const out: SnapshotInfo[] = [];
  for (const [ts, entry] of byTs) {
    if (entry.dbFile && entry.manifestFile) out.push({ ts, dbFile: entry.dbFile, manifestFile: entry.manifestFile });
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Put a blob's bytes in the set, by the sha256 the database recorded for it, unless they are
 * there already. Verifies what it copies against that record: a mismatch, either way, means the
 * blob store or the backup set has been damaged, and is not swallowed.
 */
async function ensureBlobInSet(dataDir: string, filesDir: string, blob: BlobManifestEntry): Promise<boolean> {
  const dest = path.join(filesDir, 'blobs', blob.sha256.slice(0, 2), blob.sha256);
  if (existsSync(dest)) {
    const { size } = await stat(dest);
    if (size !== blob.size) throw new Error(`the backup set's copy of blob ${blob.id} (${blob.sha256}) is ${size} bytes; the database says ${blob.size}: the backup set may be damaged`);
    return false;
  }
  const src = path.join(dataDir, 'blobs', blob.id.slice(0, 2), blob.id);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.partial-${process.pid}`;
  try {
    await copyFile(src, tmp);
  } catch (err) {
    await rm(tmp, { force: true });
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`blob ${blob.id} is in the database but not at ${src}: it may have been removed since the database was snapshotted`, { cause: err });
    throw err;
  }
  const sha256 = await hashFile(tmp);
  const { size } = await stat(tmp);
  if (sha256 !== blob.sha256 || size !== blob.size) {
    await rm(tmp, { force: true });
    throw new Error(`blob ${blob.id}: copied ${size} bytes, sha256 ${sha256}; the database says ${blob.size} bytes, sha256 ${blob.sha256}`);
  }
  await rename(tmp, dest);
  return true;
}

/** Put a publication file's bytes in the set, by a sha256 computed now (nothing records one, D126). */
async function ensurePubInSet(filesDir: string, liveFile: string): Promise<{ sha256: string; size: number; copied: boolean }> {
  const sha256 = await hashFile(liveFile);
  const { size } = await stat(liveFile);
  const dest = path.join(filesDir, 'pubs', sha256.slice(0, 2), sha256);
  if (existsSync(dest)) return { sha256, size, copied: false };
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.partial-${process.pid}`;
  await copyFile(liveFile, tmp);
  await rename(tmp, dest);
  return { sha256, size, copied: true };
}

/** Every regular file under `dir`, relative to it (a link or other special file is skipped: the pub store never writes one). */
async function walkFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(path.join(dir, rel))) {
    const relPath = rel ? path.join(rel, name) : name;
    const st = await lstat(path.join(dir, relPath));
    if (st.isDirectory()) out.push(...(await walkFiles(dir, relPath)));
    else if (st.isFile()) out.push(relPath);
  }
  return out;
}

export async function backupSet(dataDir: string, setDir: string, options: { keep?: number } = {}): Promise<BackupSetResult> {
  const dbSrc = path.join(dataDir, 'bookclub.db');
  await stat(dbSrc); // ENOENT if there is no database yet
  const dbDir = path.join(setDir, 'db');
  const filesDir = path.join(setDir, 'files');
  await mkdir(dbDir, { recursive: true });
  await mkdir(filesDir, { recursive: true });
  const staging = await mkdtemp(path.join(setDir, '.backup-'));
  try {
    const stagedDb = path.join(staging, 'bookclub.db');
    const source = new DatabaseSync(dbSrc, { readOnly: true });
    try {
      source.exec(`VACUUM INTO '${stagedDb.replace(/'/g, "''")}'`);
    } finally {
      source.close();
    }

    let blobs: BlobManifestEntry[];
    const snap = new DatabaseSync(stagedDb, { readOnly: true });
    try {
      const check = snap.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error(`the snapshot's database failed integrity_check: ${check.integrity_check}`);
      blobs = snap.prepare('SELECT id, sha256, size FROM blobs').all() as unknown as BlobManifestEntry[];
    } finally {
      snap.close();
    }

    let blobsCopied = 0;
    for (const blob of blobs) {
      if (await ensureBlobInSet(dataDir, filesDir, blob)) blobsCopied++;
    }

    const pubs: PubManifestEntry[] = [];
    let pubsCopied = 0;
    const pubsDir = path.join(dataDir, 'pubs');
    if (existsSync(pubsDir)) {
      for (const editionId of await readdir(pubsDir)) {
        const editionDir = path.join(pubsDir, editionId);
        if (!(await lstat(editionDir)).isDirectory()) continue;
        for (const rel of await walkFiles(editionDir)) {
          const entry = await ensurePubInSet(filesDir, path.join(editionDir, rel));
          pubs.push({ editionId, path: rel, sha256: entry.sha256, size: entry.size });
          if (entry.copied) pubsCopied++;
        }
      }
    }

    const ts = utcTimestamp();
    const dbFile = `bookclub-${ts}.db.gz`;
    const manifestFile = `bookclub-${ts}.manifest.json.gz`;
    const dbTmp = path.join(dbDir, `${dbFile}.partial`);
    await gzipFile(stagedDb, dbTmp);
    const manifest: SetManifest = { createdAt: new Date().toISOString(), db: dbFile, blobs, pubs };
    const manifestTmp = path.join(dbDir, `${manifestFile}.partial`);
    await writeFile(manifestTmp, gzipSync(Buffer.from(JSON.stringify(manifest))));
    await rename(dbTmp, path.join(dbDir, dbFile));
    await rename(manifestTmp, path.join(dbDir, manifestFile));
    const dbBytes = (await stat(path.join(dbDir, dbFile))).size;

    const pruned = await pruneSet(setDir, options.keep ?? 14);
    return { dir: setDir, ts, dbFile, dbBytes, blobsCopied, blobsTotal: blobs.length, pubsCopied, pubsTotal: pubs.length, pruned };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Keep the newest `keep` snapshots (one at least: there is no backup set with none) and remove
 * every stored file no kept snapshot's manifest still names. Safe to run on its own (the compose
 * kit's `backup --set` does so after every run; a human can too, after lowering `keep`).
 */
export async function pruneSet(setDir: string, keep: number): Promise<PruneResult> {
  const dbDir = path.join(setDir, 'db');
  const filesDir = path.join(setDir, 'files');
  const snaps = await listSnapshots(setDir);
  const n = Math.max(1, keep);
  const toKeep = snaps.slice(Math.max(0, snaps.length - n));
  const toRemove = snaps.slice(0, snaps.length - toKeep.length);
  for (const s of toRemove) {
    await rm(path.join(dbDir, s.dbFile), { force: true });
    await rm(path.join(dbDir, s.manifestFile), { force: true });
  }

  const needed = new Set<string>();
  for (const s of toKeep) {
    const manifest = await readManifest(setDir, s.manifestFile);
    for (const b of manifest.blobs) needed.add(`blobs/${b.sha256}`);
    for (const p of manifest.pubs) needed.add(`pubs/${p.sha256}`);
  }

  let filesRemoved = 0;
  let bytesFreed = 0;
  for (const kind of ['blobs', 'pubs'] as const) {
    const base = path.join(filesDir, kind);
    if (!existsSync(base)) continue;
    for (const prefix of await readdir(base)) {
      const prefixDir = path.join(base, prefix);
      if (!(await lstat(prefixDir)).isDirectory()) continue;
      for (const sha256 of await readdir(prefixDir)) {
        if (needed.has(`${kind}/${sha256}`)) continue;
        const full = path.join(prefixDir, sha256);
        const existing = await stat(full).catch(() => undefined);
        await rm(full, { force: true });
        if (existing) {
          filesRemoved++;
          bytesFreed += existing.size;
        }
      }
      if ((await readdir(prefixDir)).length === 0) await rm(prefixDir, { recursive: true, force: true });
    }
  }
  return { snapshotsRemoved: toRemove.length, filesRemoved, bytesFreed };
}

/**
 * Restore the newest snapshot, or (`at`) the newest at or before that UTC timestamp
 * (`20261028T000000Z`, a snapshot's own name, or any prefix of one: `20261028`). As strict as the
 * one-file `restore` above: the snapshot's database is checked with `PRAGMA integrity_check`
 * before anything beside the data is touched, every blob and publication file its manifest names
 * must be in the set's stores, and the restored tree may hold only regular files under
 * `bookclub.db`, `blobs` and `pubs` (`checkUnpacked`). A damaged or incomplete set leaves the
 * current data exactly as it was.
 */
export async function restoreSet(setDir: string, dataDir: string, options: { at?: string; force?: boolean } = {}): Promise<{ dbFile: string; ts: string }> {
  const snaps = await listSnapshots(setDir);
  if (snaps.length === 0) throw new Error(`no snapshot in ${setDir}`);
  const chosen = options.at ? [...snaps].reverse().find((s) => s.ts <= options.at!) : snaps.at(-1);
  if (!chosen) throw new Error(`no snapshot at or before ${options.at} in ${setDir} (the earliest kept is ${snaps[0]!.ts})`);

  await mkdir(dataDir, { recursive: true });
  const db = path.join(dataDir, 'bookclub.db');
  const hasDb = await stat(db).then(
    () => true,
    () => false,
  );
  if (hasDb && !options.force) throw new Error(`${db} exists; pass --force to replace it`);

  const filesDir = path.join(setDir, 'files');
  const manifest = await readManifest(setDir, chosen.manifestFile);
  assertSafeManifest(manifest);
  const staging = await mkdtemp(path.join(dataDir, '.restore-'));
  try {
    const stagedDb = path.join(staging, 'bookclub.db');
    await gunzipFile(path.join(setDir, 'db', chosen.dbFile), stagedDb);
    let ids: string[];
    const check = new DatabaseSync(stagedDb, { readOnly: true });
    try {
      const result = check.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (result.integrity_check !== 'ok') throw new Error(`this snapshot's database failed integrity_check: ${result.integrity_check}`);
      ids = (check.prepare('SELECT id FROM blobs').all() as { id: string }[]).map((r) => r.id);
    } finally {
      check.close();
    }

    const bySha = new Map(manifest.blobs.map((b) => [b.id, b] as const));
    const missing = ids.filter((id) => !/^[A-Za-z0-9_-]+$/.test(id) || !bySha.has(id) || !existsSync(path.join(filesDir, 'blobs', bySha.get(id)!.sha256.slice(0, 2), bySha.get(id)!.sha256)));
    if (missing.length > 0) throw new Error(`this snapshot is missing ${missing.length} of the ${ids.length} files its database lists`);
    const missingPubs = manifest.pubs.filter((p) => !existsSync(path.join(filesDir, 'pubs', p.sha256.slice(0, 2), p.sha256)));
    if (missingPubs.length > 0) throw new Error(`this snapshot is missing ${missingPubs.length} of the ${manifest.pubs.length} publication files its manifest lists`);

    await mkdir(path.join(staging, 'blobs'), { recursive: true });
    for (const id of ids) {
      const entry = bySha.get(id)!;
      const dest = path.join(staging, 'blobs', id.slice(0, 2), id);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(filesDir, 'blobs', entry.sha256.slice(0, 2), entry.sha256), dest);
    }
    if (manifest.pubs.length > 0) await mkdir(path.join(staging, 'pubs'), { recursive: true });
    for (const pub of manifest.pubs) {
      const dest = path.join(staging, 'pubs', pub.editionId, pub.path);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(filesDir, 'pubs', pub.sha256.slice(0, 2), pub.sha256), dest);
    }
    await checkUnpacked(staging);

    const aside = await mkdtemp(path.join(dataDir, '.replaced-'));
    for (const name of REPLACED) await moveIfThere(path.join(dataDir, name), path.join(aside, name));
    for (const name of RESTORED) await moveIfThere(path.join(staging, name), path.join(dataDir, name));
    await rm(aside, { recursive: true, force: true });
    return { dbFile: chosen.dbFile, ts: chosen.ts };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
