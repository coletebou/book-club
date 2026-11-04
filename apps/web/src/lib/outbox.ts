import type { QueryClient } from '@tanstack/react-query';
import { type BookProgress, LIMITS, type Locator, type ReadSpanInput, type SessionInfo } from '@bookclub/shared';
import { ApiError, api, getPageUser } from './api';
import { type LocalPosition, type OutboxEntry, db } from './db';
import { keys, mergeComment, mergeRevealed } from './queries';
import { forgetPendingNote, pendingNotes } from './pending-notes';
import { sendUnsentSpeeds } from '../player/speed-memory';
import { sendUnsentAudioControls } from '../player/audio-controls';

/**
 * Merge a new progress report into a pending one. Positions are last-writer-wins by timestamp;
 * spans accumulate (the server unions them, so order and duplicates do not matter) and none is
 * ever dropped: past the per-request limit, overlapping ones are coalesced and the rest go out
 * in several requests (see `sendQueued`).
 */
export function outboxKey(userId: string | undefined, bookId: string, editionId: string): string {
  return `${userId ?? ''}|${bookId}|${editionId}`;
}

export function mergeEntry(existing: OutboxEntry | undefined, next: Omit<OutboxEntry, 'key' | 'updatedAt' | 'rev'>): OutboxEntry {
  const key = outboxKey(next.userId, next.bookId, next.editionId);
  // Someone else's entry under the same key (it cannot be, with per-person keys) is never merged into.
  const base = existing && existing.userId === next.userId ? existing : undefined;
  const newer = !base || next.at >= base.at;
  let spans = [...(base?.spans ?? []), ...next.spans];
  if (spans.length > LIMITS.readSpansPerUpdate) spans = coalesceSpans(spans);
  return {
    key,
    bookId: next.bookId,
    editionId: next.editionId,
    locator: newer ? next.locator : base.locator,
    at: newer ? next.at : base.at,
    spans,
    updatedAt: Date.now(),
    rev: (base?.rev ?? 0) + 1,
    ...(next.userId ? { userId: next.userId } : {}),
  };
}

function order(l: Locator): number[] {
  return l.kind === 'epub' ? [l.section, l.offset] : l.kind === 'pdf' ? [l.page, l.y] : [l.track, l.ms];
}

function cmp(a: Locator, b: Locator): number {
  const x = order(a);
  const y = order(b);
  return x[0]! - y[0]! || x[1]! - y[1]!;
}

/** Merge overlapping or touching spans (same edition, so locators are comparable). */
function earliest(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

export function coalesceSpans(spans: readonly ReadSpanInput[]): ReadSpanInput[] {
  const sorted = [...spans].sort((a, b) => cmp(a.from, b.from));
  const out: ReadSpanInput[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && cmp(s.from, last.to) <= 0) {
      // Run together, they keep when they were read (D191): from the first's start to the last's end.
      const since = earliest(last.since ?? last.at, s.since ?? s.at);
      const at = Math.max(last.at ?? 0, s.at ?? 0) || undefined;
      const further = cmp(s.to, last.to) > 0;
      // Pages only where both ends are known: the first's start, and the end of whichever goes further.
      const endPages = further ? s.pages : last.pages;
      const pages = last.pages && endPages ? ([last.pages[0], endPages[1]] as [number, number]) : undefined;
      out[out.length - 1] = { from: last.from, to: further ? s.to : last.to, ...(since !== undefined ? { since } : {}), ...(at !== undefined ? { at } : {}), ...(pages ? { pages } : {}) };
    } else out.push(s);
  }
  return out;
}

export async function rememberPosition(position: LocalPosition): Promise<void> {
  try {
    const tx = (await db()).transaction('positions', 'readwrite');
    const kept = await tx.store.get(position.bookId);
    // Never an older place over a newer one (progress a closing page kept is adopted later), nor,
    // at the same moment, another format's copy of it over the place kept (D196).
    if (!kept || kept.userId !== position.userId || kept.at < position.at || (kept.at === position.at && kept.editionId === position.editionId)) await tx.store.put(position);
    await tx.done;
  } catch {
    // private mode without IndexedDB: the server copy still works when online
  }
}

/**
 * The place this device last had a book open at, if the person signed in now left it there: the
 * newer of what the database has and what a closing page kept (its write may never have finished).
 */
export async function localPosition(bookId: string): Promise<LocalPosition | undefined> {
  const userId = currentUser();
  let stored: LocalPosition | undefined;
  try {
    const p = await (await db()).get('positions', bookId);
    stored = p && p.userId === userId ? p : undefined;
  } catch {
    stored = undefined;
  }
  const kept = keptOnClosing().filter((e) => e.bookId === bookId && e.userId === userId);
  const newest = kept.reduce<(typeof kept)[number] | undefined>((a, e) => (!a || e.at > a.at ? e : a), undefined);
  if (newest && userId && (!stored || newest.at > stored.at)) return { bookId, editionId: newest.editionId, locator: newest.locator, at: newest.at, userId };
  return stored;
}

let flushing: Promise<void> | null = null;
let queryClient: QueryClient | null = null;

/** Let the outbox know whose session this is (called while the signed-in area renders). */
export function bindOutbox(qc: QueryClient): void {
  queryClient = qc;
}

/**
 * Whose reading this page records: the person the signed-in area shows (never someone another
 * tab has just signed in), or, outside it, the person the session query last saw.
 */
export function currentUser(): string | null {
  const page = getPageUser();
  if (page !== undefined) return page;
  return queryClient?.getQueryData<SessionInfo>(keys.session)?.user?.id ?? null;
}

/**
 * Record progress locally, then try to send it. Kept with whose it is; with nobody signed in
 * (a player still reporting after sign-out) nothing is kept at all.
 */
export async function saveProgress(entry: { bookId: string; editionId: string; locator: Locator; at: number; spans: ReadSpanInput[] }): Promise<void> {
  const userId = currentUser();
  if (!userId) return;
  await rememberPosition({ bookId: entry.bookId, editionId: entry.editionId, locator: entry.locator, at: entry.at, userId });
  try {
    const d = await db();
    const tx = d.transaction('outbox', 'readwrite');
    const key = outboxKey(userId, entry.bookId, entry.editionId);
    const merged = mergeEntry(await tx.store.get(key), { ...entry, userId });
    await tx.store.put(merged);
    await tx.done;
  } catch {
    // No IndexedDB: send directly.
    await api.putProgress(entry.bookId, { editionId: entry.editionId, locator: entry.locator, readSpans: entry.spans, at: entry.at }).catch(() => {});
    return;
  }
  void flushOutbox();
}

export async function pendingCount(): Promise<number> {
  try {
    return await (await db()).count('outbox');
  } catch {
    return 0;
  }
}

let again = false;

/**
 * Send every queued report. Network failures keep the entry; the server refusing it drops it.
 * Reports queued while a send is under way go out in the same call: the promise settles once
 * the queue is empty or the network is gone.
 */
export function flushOutbox(): Promise<void> {
  if (flushing) {
    again = true;
    return flushing;
  }
  flushing = (async () => {
    try {
      do {
        again = false;
        if (!(await sendQueued())) break;
      } while (again);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** One pass over the queue; false when the network failed (try again later). */
async function sendQueued(): Promise<boolean> {
  try {
    const d = await db();
    const me = currentUser();
    for (const entry of await d.getAll('outbox')) {
      // Someone else's reading, left on a shared device: never sent under this session.
      if (!me || entry.userId !== me) {
        if (me) await d.delete('outbox', entry.key);
        continue;
      }
      try {
        // The server takes so many spans per request: a long offline stretch goes in several.
        let result: Awaited<ReturnType<typeof api.putProgress>> | null = null;
        for (let i = 0; i === 0 || i < entry.spans.length; i += LIMITS.readSpansPerUpdate) {
          const part = await api.putProgress(
            entry.bookId,
            { editionId: entry.editionId, locator: entry.locator, readSpans: entry.spans.slice(i, i + LIMITS.readSpansPerUpdate), at: entry.at },
            entry.userId,
          );
          result = result ? { ...part, revealed: [...result.revealed, ...part.revealed] } : part;
        }
        if (!result) continue;
        // Only delete what we sent: a newer report may have been merged in meanwhile.
        const tx = d.transaction('outbox', 'readwrite');
        const current = await tx.store.get(entry.key);
        if (current && current.rev === entry.rev && current.updatedAt === entry.updatedAt) await tx.store.delete(entry.key);
        else again = true;
        await tx.done;
        if (queryClient) {
          mergeRevealed(queryClient, entry.bookId, result.revealed);
          queryClient.setQueryData<BookProgress>(keys.progress(entry.bookId), (old) => (old ? { ...old, mine: result.mine } : old));
        }
        // Your place reached the server: the iOS app's widgets may say so (D188, lib/native-widgets.ts).
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('bookclub:progress-saved'));
      } catch (err) {
        // A refusal drops the report; but not being signed in, being rate-limited or the device's
        // session having become someone else's keep it (that person's reading is not theirs).
        const kept = !(err instanceof ApiError) || err.status < 400 || err.status >= 500 || err.status === 401 || err.status === 429 || err.code === 'session_changed';
        if (kept) return false;
        await d.delete('outbox', entry.key);
      }
    }
    return true;
  } catch {
    // IndexedDB unavailable
    return false;
  }
}

const UNSAVED_KEY = 'bookclub:unsaved-progress';

type ProgressEntry = { bookId: string; editionId: string; locator: Locator; at: number; spans: ReadSpanInput[] };

/**
 * Progress the page cannot wait to save, because it is closing: kept at once where the next start
 * finds it, as well as sent on its usual way. A page being closed may never finish writing to the
 * database or sending, and offline the send fails for sure.
 */
export function saveProgressNow(entry: ProgressEntry): void {
  const userId = currentUser();
  if (!userId) return;
  try {
    const kept = JSON.parse(localStorage.getItem(UNSAVED_KEY) ?? '[]') as unknown[];
    kept.push({ ...entry, userId });
    localStorage.setItem(UNSAVED_KEY, JSON.stringify(kept.slice(-50)));
  } catch {
    // No storage: only the usual way.
  }
  void saveProgress(entry);
}

/** What closing pages kept (see saveProgressNow), well-formed entries only. */
function keptOnClosing(): (ProgressEntry & { userId: string })[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(UNSAVED_KEY) ?? '[]');
    const isEntry = (e: unknown): e is ProgressEntry & { userId: string } =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as { bookId?: unknown }).bookId === 'string' &&
      typeof (e as { editionId?: unknown }).editionId === 'string' &&
      typeof (e as { userId?: unknown }).userId === 'string' &&
      typeof (e as { at?: unknown }).at === 'number' &&
      Array.isArray((e as { spans?: unknown }).spans);
    return Array.isArray(kept) ? kept.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/** At start: progress kept while a page was closing goes on its usual way (this person's only). */
export async function adoptUnsavedProgress(): Promise<void> {
  const raw = localStorage.getItem(UNSAVED_KEY);
  if (raw === null) return;
  const entries = keptOnClosing();
  const userId = currentUser();
  const others = entries.filter((e) => e.userId !== userId);
  if (others.length > 0) localStorage.setItem(UNSAVED_KEY, JSON.stringify(others));
  else localStorage.removeItem(UNSAVED_KEY);
  for (const e of entries.filter((x) => x.userId === userId)) {
    await saveProgress({ bookId: e.bookId, editionId: e.editionId, locator: e.locator, at: e.at, spans: e.spans });
  }
}

/** Flush on reconnect, when the app comes back to the foreground, and periodically. */
/**
 * Pin the notes kept on this device while there was no network (lib/pending-notes.ts), oldest
 * first; one the server refuses (its book gone, the reader no longer a member) is dropped.
 */
export async function flushPendingNotes(): Promise<number> {
  const userId = currentUser();
  if (!userId) return 0;
  let sent = 0;
  for (const note of pendingNotes(userId)) {
    try {
      const created = await api.createComment(note.bookId, note.body, { keep: false });
      if (queryClient) mergeComment(queryClient, note.bookId, created);
      forgetPendingNote(userId, note.body.clientId);
      sent++;
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) forgetPendingNote(userId, note.body.clientId);
      else return sent;
    }
  }
  return sent;
}

export function startOutbox(qc: QueryClient): () => void {
  bindOutbox(qc);
  void adoptUnsavedProgress();
  const flush = () => {
    void flushOutbox();
    void flushPendingNotes();
    // A listening speed chosen offline (D195) goes with the reading chosen offline, and so does
    // hiding or showing the audiobook's controls (D197).
    void sendUnsentSpeeds(getPageUser());
    void sendUnsentAudioControls(getPageUser());
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') flush();
  };
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(flush, 15_000);
  flush();
  return () => {
    window.removeEventListener('online', flush);
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(timer);
  };
}
