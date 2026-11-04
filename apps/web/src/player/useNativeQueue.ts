import { type RefObject, useEffect } from 'react';
import { sendNativeQueue, sendNativeSleep } from './native-bridge';
import { trackLabel } from './tracks';
import type { AudioState } from './AudioProvider';

/**
 * Inside the iOS app (D181): what native may do by itself while this page sleeps. With the phone
 * locked, iOS stops a WebView's scripts while native audio plays on, so the `ended` handler that
 * loads the next track, the sleep timer and the five-second saves would all wait for the app to
 * be opened again. Native is told the tracks to play on into (none in a party, whose shared clock
 * moves everyone, or when sleeping at this track's end), each track's lock-screen title, and when
 * the sleep timer ends; this page follows whatever native did when it wakes. Nothing in a browser.
 */
export function useNativeQueue(audioRef: RefObject<HTMLAudioElement | null>, state: AudioState, inParty: boolean, userId: string | undefined): void {
  const { book, edition, sleepAtTrackEnd, sleepUntil } = state;
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!book || !edition) {
      sendNativeQueue(el, null);
      return;
    }
    sendNativeQueue(el, {
      bookId: book.id,
      editionId: edition.id,
      // Whose listening native keeps on the device while the page sleeps (D196): sent again once known.
      userId: userId ?? null,
      advance: !inParty && !sleepAtTrackEnd,
      tracks: edition.tracks.map((tr) => ({ url: new URL(tr.url, location.href).href, title: trackLabel(edition, book.chapters, tr.index) ?? book.title })),
    });
  }, [audioRef, book, edition, inParty, sleepAtTrackEnd, userId]);
  useEffect(() => {
    const el = audioRef.current;
    if (el) sendNativeSleep(el, sleepUntil);
  }, [audioRef, sleepUntil]);
}
