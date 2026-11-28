import { type RefObject, useEffect } from 'react';
import type { BookDetail, Edition } from '@bookclub/shared';
import { type NativeQueue, sendNativeQueue } from './native-bridge';
import { trackLabel } from './tracks';
import type { AudioState } from './AudioProvider';

export function nativeQueue(book: BookDetail, edition: Edition, userId: string | undefined, inParty: boolean, sleepAtTrackEnd: boolean): NativeQueue {
  return {
    bookId: book.id,
    editionId: edition.id,
    // Whose listening native keeps on the device while the page sleeps (D196).
    userId: userId ?? null,
    advance: !inParty && !sleepAtTrackEnd, // Legacy shells still use this combined permission.
    inParty,
    acceptsHandoff: true,
    acceptsSelectedRate: true,
    tracks: edition.tracks.map((tr) => ({ url: new URL(tr.url, location.href).href, title: trackLabel(edition, book.chapters, tr.index) ?? book.title })),
  };
}

/**
 * Inside the iOS app (D181): what native may do by itself while this page sleeps. With the phone
 * locked, iOS stops a WebView's scripts while native audio plays on, so the `ended` handler that
 * loads the next track, the sleep timer and the five-second saves would all wait for the app to
 * be opened again. Native is told the tracks to play on into (none in a party, whose shared clock
 * moves everyone, or when sleeping at this track's end) and each track's lock-screen title.
 * This page follows whatever native did when it wakes. Nothing in a browser.
 */
export function useNativeQueue(audioRef: RefObject<HTMLAudioElement | null>, state: AudioState, inParty: boolean, userId: string | undefined): void {
  const { book, edition, sleepAtTrackEnd } = state;
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!book || !edition) {
      sendNativeQueue(el, null);
      return;
    }
    sendNativeQueue(el, nativeQueue(book, edition, userId, inParty, sleepAtTrackEnd));
  }, [audioRef, book, edition, inParty, sleepAtTrackEnd, userId]);
}
