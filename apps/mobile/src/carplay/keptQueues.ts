import { type KeptQueue } from './model';

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
  return [queue, ...same.filter((q) => q.bookId !== queue.bookId)].sort((a, b) => b.at - a.at).slice(0, KEPT_QUEUES_MAX);
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
  /** The file's writes and its removal, one after another, so a late write never undoes a removal. */
  private ops: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(private readonly file: KeptQueueFile, private readonly onChange: () => void = () => {}) {
    this.ready = file.read().then(
      (json) => {
        if (this.cleared) return;
        // A queue kept while the file was being read is newer than anything in it.
        this.list = parseKeptQueues(json).reduce((acc, q) => (acc.some((a) => a.bookId === q.bookId) ? acc : withQueue(acc, q)), this.list);
        this.onChange();
      },
      () => undefined,
    );
  }

  private run(op: () => Promise<void>): void {
    this.ops = this.ops.then(op).catch(() => undefined);
  }

  all(): readonly KeptQueue[] {
    return this.list;
  }

  get(bookId: string): KeptQueue | undefined {
    return this.list.find((q) => q.bookId === bookId);
  }

  keep(queue: KeptQueue): void {
    const prev = this.get(queue.bookId);
    // The newest book's same queue again (its metadata comes with every track) is not news; the
    // same queue of a book listened to earlier is: that book is the newest now.
    if (prev && sameQueue(prev, queue) && this.list[0]?.bookId === queue.bookId) return;
    this.list = withQueue(this.list, queue);
    const json = JSON.stringify(this.list);
    this.run(() => this.file.write(json));
    this.onChange();
  }

  /** Signing out (D9 of the web app's offline rules): nothing of this person's is kept for the car. */
  clear(): void {
    // Even with nothing read yet: the file may still hold the last person's.
    this.cleared = true;
    const had = this.list.length > 0;
    this.list = [];
    this.run(() => this.file.remove());
    if (had) this.onChange();
  }
}

function sameQueue(a: KeptQueue, b: KeptQueue): boolean {
  return a.editionId === b.editionId && a.userId === b.userId && a.title === b.title && a.author === b.author && a.artworkUrl === b.artworkUrl
    && a.tracks.length === b.tracks.length && a.tracks.every((t, i) => t.url === b.tracks[i]!.url && t.title === b.tracks[i]!.title);
}
