import { useSyncExternalStore } from 'react';

/**
 * Whether the full audio-only player page is allowed (D198). Default off: a book with text
 * always opens as text, and /listen redirects there with the audiobook docked. A book that is
 * only an audiobook still uses the player. Kept on this device (like reader settings).
 */
const KEY = 'bookclub:allow-audio-only';

const listeners = new Set<() => void>();
let snapshot: string | null = null;

function raw(): string {
  try {
    return localStorage.getItem(KEY) ?? '0';
  } catch {
    return '0';
  }
}

function notify(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

export function allowAudioOnly(): boolean {
  return raw() === '1';
}

export function setAllowAudioOnly(allowed: boolean): void {
  try {
    localStorage.setItem(KEY, allowed ? '1' : '0');
  } catch {
    // private mode: choice lasts for this visit via memory only if we mirrored it; skip
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function storeSnapshot(): string {
  return (snapshot ??= raw());
}

export function useAllowAudioOnly(): { allowed: boolean; set: (allowed: boolean) => void } {
  useSyncExternalStore(subscribe, storeSnapshot, storeSnapshot);
  return { allowed: allowAudioOnly(), set: setAllowAudioOnly };
}

export const ALLOW_AUDIO_ONLY_KEY = KEY;

/**
 * Where /listen goes when audio-only is off and the book has text (D198): the reader with this
 * audiobook along, keeping at/comment so history and note links still land correctly.
 */
export function readAlongFromListen(bookId: string, alongEditionId: string, search: URLSearchParams): string {
  const next = new URLSearchParams();
  next.set('along', alongEditionId);
  const at = search.get('at');
  const comment = search.get('comment');
  if (at) next.set('at', at);
  if (comment) next.set('comment', comment);
  return `/books/${bookId}/read?${next}`;
}
