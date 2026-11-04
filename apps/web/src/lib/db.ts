import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { Locator, ProgressUpdateBody, ReadSpanInput } from '@bookclub/shared';

export interface OutboxEntry {
  /** `${userId}|${bookId}|${editionId}`: one person's reports never merge with another's. */
  key: string;
  bookId: string;
  editionId: string;
  locator: Locator;
  at: number;
  spans: ReadSpanInput[];
  updatedAt: number;
  /** Bumped on every merge, so a send can tell "unchanged since I read it" exactly (clocks tie). */
  rev?: number;
  /** Whose reading this is: never sent under someone else's session. */
  userId?: string;
}

export interface LocalPosition {
  bookId: string;
  editionId: string;
  locator: Locator;
  at: number;
  userId?: string;
}

export interface PageCountEntry {
  /** `${editionId}|${layoutSignature}` */
  key: string;
  /** Pages per spine section at that layout. */
  sectionPages: number[];
  /** Page index (within its section) of each TOC target, by TOC index. */
  tocPages: number[];
  /** Section of the story's first character and its page there. */
  storyStart?: { section: number; page: number };
  createdAt: number;
}

export interface ReaderPrefs {
  key: 'reader';
  fontScale: number;
  theme: string;
  lineHeight: number;
  font: string;
}

interface Schema extends DBSchema {
  outbox: { key: string; value: OutboxEntry };
  positions: { key: string; value: LocalPosition };
  pagecounts: { key: string; value: PageCountEntry };
  prefs: { key: string; value: ReaderPrefs };
  offline: { key: string; value: { editionId: string; bookId: string; title: string; bytes: number; savedAt: number } };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

export function db(): Promise<IDBPDatabase<Schema>> {
  if (dbPromise) return dbPromise;
  const opening: Promise<IDBPDatabase<Schema>> = openDB<Schema>('bookclub', 1, {
    upgrade(database) {
      database.createObjectStore('outbox', { keyPath: 'key' });
      database.createObjectStore('positions', { keyPath: 'bookId' });
      database.createObjectStore('pagecounts', { keyPath: 'key' });
      database.createObjectStore('prefs', { keyPath: 'key' });
      database.createObjectStore('offline', { keyPath: 'editionId' });
    },
    // Another tab is forgetting the device (sign-out): let go, so its delete is not held up.
    blocking() {
      if (dbPromise === opening) dbPromise = null;
      void opening.then(
        (d) => d.close(),
        () => undefined,
      );
    },
  });
  dbPromise = opening;
  void opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}

/** Remove every local trace (sign-out). */
export async function clearLocalData(): Promise<void> {
  try {
    const d = await db();
    d.close();
  } catch {
    // never opened
  }
  dbPromise = null;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('bookclub');
    req.onsuccess = req.onerror = () => resolve();
    // Other tabs close their connections when asked (`blocking` above); a tab that cannot
    // (frozen in the background) delays the delete, which then completes when it closes.
    req.onblocked = () => setTimeout(resolve, 3000);
  });
}

export type { ProgressUpdateBody };
