import { useCallback, useEffect, useState } from 'react';
import type { BookDetail, Edition, Publication } from '@bookclub/shared';
import { clearLocalData, db } from './db';
import { currentUser } from './outbox';
import { keepPdfjsResources } from './pdf-resources';

/**
 * Offline books. Each edition gets its own Cache Storage bucket holding real HTTP responses (the
 * service worker answers media requests from it, including byte ranges for audio). A small
 * registry in IndexedDB lists what is saved.
 */
export const editionCacheName = (editionId: string) => `bc-ed-${editionId}`;
export const API_CACHE = 'bc-api';

export function editionUrls(book: BookDetail, edition: Edition, publication?: Publication | null): string[] {
  const urls = [`/api/books/${book.id}`, `/api/books/${book.id}/comments`, `/api/books/${book.id}/progress`];
  urls.push(`${book.coverUrl}&w=320`, `${book.coverUrl}&w=640`);
  if (edition.kind === 'epub' && edition.publicationUrl) {
    urls.push(edition.publicationUrl);
    if (publication) for (const r of publication.resources) urls.push(`${publication.baseUrl}${r.split('/').map(encodeURIComponent).join('/')}`);
  }
  if (edition.kind === 'pdf' && edition.fileUrl) urls.push(edition.fileUrl);
  if (edition.kind === 'audio') for (const t of edition.tracks) urls.push(t.url);
  return urls;
}

export interface SaveProgress {
  readonly done: number;
  readonly total: number;
}

/**
 * Download every file of an edition into its cache. Already cached files are skipped. Stops, and
 * drops what it kept, when the person signed in changes meanwhile (a shared device, D44).
 */
export async function saveEditionOffline(
  book: BookDetail,
  edition: Edition,
  publication: Publication | null,
  onProgress?: (p: SaveProgress) => void,
): Promise<number> {
  if (!('caches' in window)) throw new Error('This browser cannot keep books offline.');
  const owner = currentUser();
  const cache = await caches.open(editionCacheName(edition.id));
  const urls = editionUrls(book, edition, publication);
  let bytes = 0;
  let done = 0;
  for (const url of urls) {
    const existing = await cache.match(url);
    if (existing) {
      bytes += Number(existing.headers.get('content-length') ?? 0);
    } else {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Could not download ${url} (${res.status}).`);
      bytes += Number(res.headers.get('content-length') ?? 0);
      if (currentUser() !== owner) {
        await caches.delete(editionCacheName(edition.id));
        throw new Error('The signed-in person changed while the book was being saved.');
      }
      await cache.put(url, res);
    }
    done++;
    onProgress?.({ done, total: urls.length });
  }
  // A PDF is drawn with pdf.js's decoders, fonts and maps: kept too, or a scan's pages would draw
  // white with no network (D102). Once for every PDF.
  if (edition.kind === 'pdf') await keepPdfjsResources();
  try {
    await (await db()).put('offline', { editionId: edition.id, bookId: book.id, title: book.title, bytes, savedAt: Date.now() });
  } catch {
    // registry is best effort
  }
  window.dispatchEvent(new CustomEvent('bc-offline-changed'));
  return bytes;
}

const keeping = new Map<string, Promise<void>>();

/**
 * Keep an edition on this device in the background, as opening a book does: one save per edition
 * at a time, and leaving the page does not stop it (a reader who opens a book and goes back to
 * the club at once still has it on the train). Failures are left for the next opening.
 */
export function keepOffline(book: BookDetail, edition: Edition, publication: Publication | null): Promise<void> {
  const running = keeping.get(edition.id);
  if (running) return running;
  const task = saveEditionOffline(book, edition, publication)
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => keeping.delete(edition.id));
  keeping.set(edition.id, task);
  return task;
}

export async function removeEditionOffline(editionId: string): Promise<void> {
  if ('caches' in window) await caches.delete(editionCacheName(editionId));
  try {
    await (await db()).delete('offline', editionId);
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent('bc-offline-changed'));
}

/** The books kept on this device, one entry per book, newest first. */
export async function keptBooks(): Promise<{ bookId: string; title: string }[]> {
  try {
    const all = (await (await db()).getAll('offline')).sort((a, b) => b.savedAt - a.savedAt);
    const seen = new Set<string>();
    return all.filter((e) => !seen.has(e.bookId) && seen.add(e.bookId)).map((e) => ({ bookId: e.bookId, title: e.title }));
  } catch {
    return [];
  }
}

export async function isEditionOffline(editionId: string): Promise<boolean> {
  try {
    return (await (await db()).get('offline', editionId)) !== undefined;
  } catch {
    return false;
  }
}

export function useEditionOffline(editionId: string | undefined): [boolean, () => void] {
  const [saved, setSaved] = useState(false);
  const refresh = useCallback(() => {
    if (!editionId) return;
    void isEditionOffline(editionId).then(setSaved);
  }, [editionId]);
  useEffect(() => {
    refresh();
    window.addEventListener('bc-offline-changed', refresh);
    return () => window.removeEventListener('bc-offline-changed', refresh);
  }, [refresh]);
  return [saved, refresh];
}

/** Forget everything on this device: caches, IndexedDB, local storage (sign-out). */
export async function wipeDevice(): Promise<void> {
  navigator.serviceWorker?.controller?.postMessage({ type: 'wipe' });
  if ('caches' in window) {
    for (const name of await caches.keys()) if (name.startsWith('bc-')) await caches.delete(name);
  }
  await clearLocalData();
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('bookclub') || key.startsWith('tus::')) localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
