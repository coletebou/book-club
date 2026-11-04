import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { type BookDetail, type Edition, type Locator } from '@bookclub/shared';
import { audiobookFor, needsStartTap, playFrom } from '../lib/two-formats';
import { allowAudioOnly } from '../player/allow-audio-only';
import { useAudio, useAudioState } from '../player/AudioProvider';
import { tOf, translatePlace } from './position';

/** The page on screen, on the book's timeline, and where it begins in its own edition. */
export interface PageOnScreen {
  readonly startT: number;
  readonly endT: number;
  readonly start: Locator;
}

/**
 * The audiobook from inside a reader (D186, D194; text first, D197). The book is always the text;
 * the audiobook is played over it, docked in the footer while this book's audiobook is in the
 * player (`docked`), playing or paused.
 *
 * - Listen (`listen`): the audiobook starts at the page you are reading, unless it is already on
 *   this page or about to come to it (`playFrom`): read ten pages since you stopped listening, and
 *   it reads on from here, not ten pages back. Loaded and started in the tap that asks for it.
 * - Stop (`stop`): the audiobook stops, its place saved, and goes from the footer; the page stays.
 * - The full player (`openPlayer`): its track list and listening together, the audiobook going on
 *   as it is (started at this page if it was not in the player).
 * - Listening asked for with `along` (the book page's Listen, a link): the audiobook is started at
 *   this page, or where it already is. A browser that plays only on a tap may refuse; then
 *   `startTap` is set and the reader shows one obvious Play.
 */
export function useReaderAudio(book: BookDetail, edition: Edition, page: PageOnScreen | null, along: string | null, flush?: () => Promise<unknown>) {
  const audio = useAudio();
  const state = useAudioState();
  const navigate = useNavigate();
  const docked = state.book?.id === book.id && !!state.edition;
  const audiobook = audiobookFor(book.editions, edition);
  const pageRef = useRef(page);
  pageRef.current = page;

  /** Where the audiobook would start for the page on screen, in `listen`. */
  const placeAtPage = useCallback(
    (listen: Edition) => {
      const p = pageRef.current;
      if (!p) return null;
      const to = translatePlace(book, listen, { t: p.startT, editionId: edition.id, locator: p.start });
      return to?.kind === 'audio' ? to : null;
    },
    [book, edition.id],
  );

  const play = useCallback(() => {
    const p = pageRef.current;
    const s = audio.state;
    if (!s.edition || s.book?.id !== book.id || !p) {
      void audio.play();
      return;
    }
    const here = audio.locator();
    if (playFrom(here ? tOf(s.edition, here) : null, p) === 'resume') {
      void audio.play();
      return;
    }
    const to = translatePlace(book, s.edition, { t: p.startT, editionId: edition.id, locator: p.start });
    if (to?.kind === 'audio') audio.setTrack(to.track, to.ms / 1000, true);
    else void audio.play();
  }, [audio, book, edition.id]);

  /** Listen from here, from a tap: the audiobook over the page and playing from this page, in this tap. */
  const listen = useCallback(() => {
    const s = audio.state;
    if (s.book?.id === book.id && s.edition) {
      if (!s.playing) play();
      return;
    }
    if (!audiobook) return;
    audio.load(book, audiobook, placeAtPage(audiobook), { play: true });
  }, [audio, book, audiobook, play, placeAtPage]);

  /** Stop listening: the audiobook stops (its place saved first) and leaves the footer; the page stays. */
  const stop = useCallback(() => audio.stop(), [audio]);

  /** The full player, the audiobook going on as it is; from a tap, started at this page if it was not in the player. */
  const openPlayer = useCallback(() => {
    const s = audio.state;
    const inPlayer = s.book?.id === book.id && s.edition ? s.edition : null;
    const listening = inPlayer ?? audiobook;
    if (!listening) return;
    if (!inPlayer) {
      const at = placeAtPage(listening);
      audio.load(book, listening, at, { play: true });
    }
    // Full player only when the setting allows it (D198); otherwise the docked controls are enough.
    if (!allowAudioOnly()) return;
    void (flush?.() ?? Promise.resolve())
      .catch(() => undefined)
      .finally(() => navigate(`/books/${book.id}/listen?edition=${listening.id}`));
  }, [audio, book, audiobook, placeAtPage, flush, navigate]);

  // Listening asked for (`along`): started at this page once it is known, or where it already is
  // (the tap that asked may already have started it, D194).
  const askedAlong = useRef(false);
  const [asked, setAsked] = useState(false);
  const startT = page?.startT;
  useEffect(() => {
    if (!along || askedAlong.current || startT === undefined) return;
    const listening = book.editions.find((e) => e.id === along && e.kind === 'audio' && e.status === 'ready');
    if (!listening) return;
    askedAlong.current = true;
    setAsked(true);
    if (audio.state.edition?.id === listening.id) {
      if (!audio.state.playing) void audio.play();
      return;
    }
    audio.load(book, listening, placeAtPage(listening), { play: true });
  }, [along, startT, book, audio, placeAtPage]);
  // Once it plays, the ask is answered: a pause later is a pause, not a start to prompt for.
  useEffect(() => {
    if (asked && state.playing) setAsked(false);
  }, [asked, state.playing]);

  return { play, listen, stop, openPlayer, docked, audiobook, startTap: needsStartTap(docked, state, asked) };
}
