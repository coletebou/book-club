import { useCallback, useEffect, useRef } from 'react';
import { type BookDetail, type Edition, type Locator, type ReadSpanInput, chapterLabel } from '@bookclub/shared';
import { beaconProgress } from '../lib/api';
import { flushOutbox, saveProgress, saveProgressNow } from '../lib/outbox';
import { realtime } from '../lib/realtime';
import { savedFromHere } from '../lib/saved-here';
import { useAudioState } from '../player/AudioProvider';
import { tOf } from './position';

/**
 * Reports what the reader has on screen: live presence at once (throttled by the realtime client),
 * saved progress shortly after the page settles (queued locally first, so it survives being
 * offline), and whatever is pending when the page is hidden or closed.
 *
 * Book and edition are read through refs: a refetched book (a new object) must never look like
 * leaving the book, or presence would flicker to "away" on every live update.
 */
export function useReadingReport(book: BookDetail | undefined, edition: Edition | undefined) {
  /** What to save: your place, since when you have been there (`at`), and the pages shown meanwhile. */
  const pending = useRef<{ locator: Locator; at: number; spans: ReadSpanInput[] } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bookRef = useRef(book);
  const editionRef = useRef(edition);
  bookRef.current = book;
  editionRef.current = edition;
  // Reading along while the audiobook plays: the player says where you are, so presence does not
  // flip between the page and the voice.
  const audio = useAudioState();
  const listening = useRef(false);
  listening.current = audio.playing;

  /** Save what is pending now; `immediate` also sends it. Settles once that is done. */
  const flush = useCallback((immediate = false): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    const b = bookRef.current;
    const e = editionRef.current;
    if (!p || !b || !e) return immediate ? flushOutbox() : Promise.resolve();
    pending.current = null;
    return saveProgress({ bookId: b.id, editionId: e.id, locator: p.locator, at: p.at, spans: p.spans }).then(() => (immediate ? flushOutbox() : undefined));
  }, []);

  const report = useCallback(
    (start: Locator, end: Locator, options: { urgent?: boolean; look?: boolean; place?: Locator; placeAt?: number | null; pages?: readonly [number, number] } = {}) => {
      const b = bookRef.current;
      const e = editionRef.current;
      if (!b || !e) return;
      // Your place: the page's start, unless the reader says it stays where it was (the page was
      // only laid out again, or opened there on this device).
      const place = options.place ?? start;
      const label = chapterLabel(b.chapters, tOf(e, place));
      if (!listening.current) realtime()?.setReading({ bookId: b.id, editionId: e.id, locator: place, label });
      // A look (a link followed, a note visited) shows where you are, but is not reading:
      // it neither moves your saved place nor counts the page as read.
      if (options.look) return;
      // When it was read, and the pages this device showed there: your own history (D191).
      const spans = [...(pending.current?.spans ?? []), { from: start, to: end, at: Date.now(), ...(options.pages ? { pages: [options.pages[0], options.pages[1]] as [number, number] } : {}) }];
      // Since when you have been at that place (D196): a page turned to now, or, for a place the
      // reader keeps (opened there, laid out again), whenever you came to it. Saved with that time,
      // never the moment the save goes out, so a place kept from long ago cannot outrank a newer one
      // saved meanwhile (the narrator's, while the pages followed them).
      pending.current = { locator: place, at: options.placeAt || Date.now(), spans };
      savedFromHere(b.id, tOf(e, place));
      if (timer.current) clearTimeout(timer.current);
      if (options.urgent) void flush(true);
      else timer.current = setTimeout(() => void flush(), 600);
    },
    [flush],
  );

  useEffect(() => {
    const send = () => {
      const p = pending.current;
      const b = bookRef.current;
      const e = editionRef.current;
      if (!p || !b || !e) return;
      pending.current = null;
      // Kept at once on the device too, in case the page closes before anything else finishes (or
      // the beacon is dropped, as it is offline): the next start sends it.
      saveProgressNow({ bookId: b.id, editionId: e.id, locator: p.locator, at: p.at, spans: p.spans });
      beaconProgress(b.id, { editionId: e.id, locator: p.locator, readSpans: p.spans, at: p.at });
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') send();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', send);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', send);
      // Leaving the reader (unmount): save what is pending and stop showing as reading.
      void flush(true);
      realtime()?.setReading(null);
    };
  }, [flush]);

  return { report, flush };
}
