import { type AudioPlace, type ProgressTarget } from '../audio/BackgroundProgress';
import { type KeptQueue, bookmarkPlace } from './model';

export type BookmarkTarget = ProgressTarget & { readonly locator: AudioPlace; readonly trackUrl: string };

/**
 * The audiobooks CarPlay can play (D221): each book's queue as the page last sent it (its tracks'
 * URLs and titles) with the book's title, author and cover, kept on the device beside the kept
 * place (D196), so the car can start a book with no page open. The newest few books only, and none
 * once the person signs out (`clear`).
 */
export const KEPT_QUEUES_MAX = 6;

/**
 * The kept list with `queue` as its newest entry (one per book), at most KEPT_QUEUES_MAX. A queue of
 * someone else than the kept ones' (another person signed in on this phone) leaves theirs behind.
 */
export function withQueue(list: readonly KeptQueue[], queue: KeptQueue): KeptQueue[] {
  const same = list.filter((q) => q.userId === queue.userId);
  return [withBookmark(queue, same.find((q) => q.bookId === queue.bookId)), ...same.filter((q) => q.bookId !== queue.bookId)].sort((a, b) => b.at - a.at).slice(0, KEPT_QUEUES_MAX);
}

function withBookmark(queue: KeptQueue, prior: KeptQueue | undefined): KeptQueue {
  if (queue.bookmark || !prior?.bookmark || prior.userId !== queue.userId || prior.editionId !== queue.editionId) return queue;
  const updated = { ...queue, bookmark: prior.bookmark };
  return bookmarkPlace(updated) ? updated : queue;
}

/** The kept list from its file, dropping anything malformed (an older build's, or a torn write). */
export function parseKeptQueues(json: string | null): KeptQueue[] {
  if (!json) return [];
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  return Array.isArray(value) ? value.filter(isKeptQueue).slice(0, KEPT_QUEUES_MAX) : [];
}

function isKeptQueue(v: unknown): v is KeptQueue {
  if (!v || typeof v !== 'object') return false;
  const q = v as Partial<KeptQueue>;
  return typeof q.bookId === 'string' && typeof q.editionId === 'string' && (q.userId === null || typeof q.userId === 'string')
    && typeof q.title === 'string' && typeof q.author === 'string' && (q.artworkUrl === null || typeof q.artworkUrl === 'string')
    && typeof q.at === 'number' && Array.isArray(q.tracks) && q.tracks.length > 0
    && q.tracks.every((t) => !!t && typeof t.url === 'string' && typeof t.title === 'string');
}

export interface KeptQueueFile {
  read(): Promise<string | null>;
  write(json: string): Promise<void>;
  remove(): Promise<void>;
}

/** The kept queues, in memory and in their file; every change is written through. */
export class KeptQueues {
  private list: KeptQueue[] = [];
  /** Signed out before the file was read: nothing in it is kept. */
  private cleared = false;
  private loading: Promise<void> | null = null;
  private loaded = false;
  private dirty = false;
  private generation = 0;
  /** The file's writes and its removal, one after another, so a late write never undoes a removal. */
  private ops: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: KeptQueueFile, private readonly onChange: () => void = () => {}) {
    void this.readQueues();
  }

  get ready(): Promise<void> {
    return this.loading ?? Promise.resolve();
  }

  /** Recheck an unavailable or empty store after the device becomes accessible (D241). */
  reload(): Promise<void> {
    // An unlock can overlap a read started while the file was still protected.
    return this.loading ? this.loading.then(() => this.readQueues()) : this.readQueues();
  }

  private readQueues(): Promise<void> {
    if (this.cleared || (this.loaded && this.list.length > 0)) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = this.file.read().then(
      (json) => {
        if (this.cleared) return;
        const stored = parseKeptQueues(json);
        const newest = this.list[0] ?? stored[0];
        const fresh = this.list.map((q) => withBookmark(q, stored.find((saved) => saved.bookId === q.bookId)));
        // A queue kept while reading wins, including its account, over the saved copy.
        this.list = stored.filter((q) => q.userId === newest?.userId)
          .reduce((acc, q) => acc.some((a) => a.bookId === q.bookId) ? acc : withQueue(acc, q), fresh);
        this.loaded = true;
        if (this.dirty) void this.run(() => this.writeQueues());
        this.onChange();
      },
      () => undefined,
    ).finally(() => { this.loading = null; });
    return this.loading;
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.ops.then(op);
    this.ops = result.catch(() => undefined);
    return result;
  }

  private async writeQueues(): Promise<void> {
    await this.ready;
    // A file that could not be read may contain bookmarks. Wait for a successful reload.
    if (!this.dirty || (!this.loaded && !this.cleared)) return;
    const queues = this.list;
    await this.file.write(JSON.stringify(queues));
    if (this.list === queues) this.dirty = false;
  }

  all(): readonly KeptQueue[] {
    return this.list;
  }

  get(bookId: string): KeptQueue | undefined {
    return this.list.find((q) => q.bookId === bookId);
  }

  keep(queue: KeptQueue): void {
    // A new metadata report can arrive after first unlock without a new connection (D252).
    if (!this.loaded) void this.reload();
    const prev = this.get(queue.bookId);
    // The newest book's same queue again (its metadata comes with every track) is not news; the
    // same queue of a book listened to earlier is: that book is the newest now.
    if (prev && sameQueue(prev, queue) && this.list[0]?.bookId === queue.bookId) return;
    if (this.list.length > 0 && this.list[0]?.userId !== queue.userId) this.generation++;
    this.list = withQueue(this.list, queue);
    this.dirty = true;
    void this.run(() => this.writeQueues());
    this.onChange();
  }

  saveBookmark(place: BookmarkTarget): Promise<boolean> {
    const generation = this.generation;
    const owns = (queue: KeptQueue | undefined): queue is KeptQueue => generation === this.generation
      && !!place.userId && queue?.userId === place.userId && queue.editionId === place.editionId;
    return this.run(async () => {
      await this.ready;
      const queue = this.get(place.bookId);
      if (!owns(queue) || (!this.loaded && !this.cleared)) return false;
      const bookmark = { trackUrl: place.trackUrl, ms: place.locator.ms };
      if (!bookmarkPlace({ ...queue, bookmark })) return false;
      await this.file.write(JSON.stringify(this.list.map((entry) => entry === queue ? { ...entry, bookmark } : entry)));
      const current = this.get(place.bookId);
      if (!owns(current) || !bookmarkPlace({ ...current, bookmark })) return false;
      this.list = this.list.map((entry) => entry === current ? { ...entry, bookmark } : entry);
      this.onChange();
      return true;
    });
  }

  /** Signing out (D9 of the web app's offline rules): nothing of this person's is kept for the car. */
  clear(): void {
    // Even with nothing read yet: the file may still hold the last person's.
    this.cleared = true;
    this.generation++;
    const had = this.list.length > 0;
    this.list = [];
    void this.run(() => this.file.remove());
    if (had) this.onChange();
  }
}

function sameQueue(a: KeptQueue, b: KeptQueue): boolean {
  return a.editionId === b.editionId && a.userId === b.userId && a.title === b.title && a.author === b.author && a.artworkUrl === b.artworkUrl
    && a.tracks.length === b.tracks.length && a.tracks.every((t, i) => t.url === b.tracks[i]!.url && t.title === b.tracks[i]!.title);
}
