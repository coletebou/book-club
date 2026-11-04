import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { newId } from '../lib/crypto';

/**
 * Everything on disk lives under one data directory:
 *
 *   bookclub.db        SQLite database (+ -wal, -shm)
 *   blobs/ab/<id>      original files, content-checked, never modified
 *   pubs/<edition>/…   sanitised EPUB publications, served as-is
 *   uploads/…          in-flight tus uploads
 *   derived/…          cover thumbnails and other caches (safe to delete)
 *   tmp/…              scratch space
 */
export class Storage {
  readonly root: string;
  readonly dbFile: string;
  readonly blobsDir: string;
  readonly pubsDir: string;
  readonly uploadsDir: string;
  readonly derivedDir: string;
  readonly tmpDir: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.dbFile = path.join(this.root, 'bookclub.db');
    this.blobsDir = path.join(this.root, 'blobs');
    this.pubsDir = path.join(this.root, 'pubs');
    this.uploadsDir = path.join(this.root, 'uploads');
    this.derivedDir = path.join(this.root, 'derived');
    this.tmpDir = path.join(this.root, 'tmp');
  }

  async init(): Promise<void> {
    for (const dir of [this.root, this.blobsDir, this.pubsDir, this.uploadsDir, this.derivedDir, this.tmpDir]) {
      await mkdir(dir, { recursive: true });
    }
  }

  blobPath(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`bad blob id ${id}`);
    return path.join(this.blobsDir, id.slice(0, 2), id);
  }

  pubDir(editionId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(editionId)) throw new Error(`bad edition id ${editionId}`);
    return path.join(this.pubsDir, editionId);
  }

  /** Resolve a container path inside a publication, refusing anything that escapes it. */
  pubFile(editionId: string, containerPath: string): string | null {
    const dir = this.pubDir(editionId);
    const full = path.resolve(dir, containerPath);
    return full.startsWith(dir + path.sep) ? full : null;
  }

  /** Move a file (an upload) into the blob store, hashing it on the way. */
  async adopt(src: string): Promise<{ id: string; sha256: string; size: number }> {
    const id = newId();
    const { sha256 } = await this.measure(src);
    await this.moveInto(src, id);
    const { size } = await stat(this.blobPath(id));
    return { id, sha256, size };
  }

  /** A file's SHA-256 and size, where it lies. */
  async measure(file: string): Promise<{ sha256: string; size: number }> {
    const sha256 = await hashFile(file);
    const { size } = await stat(file);
    return { sha256, size };
  }

  /** Move a file into the blob store under the id it was recorded with. */
  async moveInto(src: string, id: string): Promise<void> {
    const dest = this.blobPath(id);
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await rename(src, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await copyFile(src, dest);
      await unlink(src);
    }
  }

  async putBytes(bytes: Uint8Array): Promise<{ id: string; sha256: string; size: number }> {
    const id = newId();
    const dest = this.blobPath(id);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
    return { id, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
  }

  async removeBlob(id: string): Promise<void> {
    await rm(this.blobPath(id), { force: true });
  }

  async removePub(editionId: string): Promise<void> {
    await rm(this.pubDir(editionId), { recursive: true, force: true });
  }

  async writePubFile(editionId: string, containerPath: string, data: Uint8Array | string): Promise<void> {
    const full = this.pubFile(editionId, containerPath);
    if (!full) throw new Error(`unsafe publication path ${containerPath}`);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }
}

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
