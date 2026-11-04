import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { useBook, useClubs } from '../lib/queries';
import { calApi } from '../lib/cal-api';
import { closeCal, openCal, useCalOpen } from './calStore';
import { CalPanel } from './CalPanel';

/** A portrait phone's player header has no room left for a third button (app.css, D170) — nor,
 * since D173, for the fourth Chat would make it (ListenPage moves it into the player's own
 * content there instead, the way this file's floating launcher already takes Cal's place). */
export const NARROW_PLAYER_PX = 500;

export function useNarrow(maxWidth: number): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth <= maxWidth);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = () => setNarrow(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [maxWidth]);
  return narrow;
}

/**
 * Whether Cal is reachable for a club, and the club to ask about from wherever this is called:
 * whichever page it is (a club or book route), else the member's first club — the product is
 * built for a handful of friends in one club at a time, so this covers every real case without
 * asking the member to choose. `useClubCalContext` is shared by the floating launcher and the
 * reader/player's own "Ask Cal" header buttons, so all three agree on the same club.
 */
export function useClubCalContext(): { clubId: string | undefined; bookId: string | null; enabled: boolean } {
  const clubs = useClubs();
  const params = useParams<{ clubId?: string; bookId?: string }>();
  const book = useBook(params.bookId);
  const clubId = params.clubId ?? book.data?.clubId ?? clubs.data?.[0]?.id;
  const status = useQuery({ queryKey: ['cal-status', clubId], queryFn: () => calApi.status(clubId!), enabled: !!clubId, staleTime: 60_000 });
  return { clubId, bookId: params.bookId ?? null, enabled: !!clubId && status.data?.enabled === true };
}

/**
 * Cal, reachable from anywhere (D160): a floating button on every signed-in page except the
 * reader and the player (D170) — there it would either sit over the page's own controls (the
 * scrubber, Play) or cover the text itself, so those two pages offer "Ask Cal" from their own
 * header instead (EpubReader, PdfReader, ListenPage), opening this very same panel. Hidden
 * entirely, not just disabled, when the server has no ANTHROPIC_API_KEY (D160: "graceful
 * absence") or the page itself is a reader/player.
 */
export function CalLauncher() {
  const location = useLocation();
  const { clubId, bookId, enabled } = useClubCalContext();
  const narrowPlayer = useNarrow(NARROW_PLAYER_PX);
  // The reader (/books/:id/read) and the player (/books/:id/listen) have their own header button
  // — except a portrait phone's player, too narrow for a third header button (app.css, D170):
  // there this floating one takes over instead, as it does everywhere outside the two readers.
  const onReader = /^\/books\/[^/]+\/read(\/|$)/.test(location.pathname);
  const onPlayer = /^\/books\/[^/]+\/listen(\/|$)/.test(location.pathname);
  if ((onReader || (onPlayer && !narrowPlayer)) || !clubId || !enabled) return null;
  return (
    <button type="button" className="cal-launcher" aria-label="Ask Cal" data-testid="cal-launcher" onClick={() => openCal(clubId, bookId)}>
      <Icon name="sparkle" size={24} />
    </button>
  );
}

/**
 * The panel itself, mounted once for the whole app (D170): whichever button opened it (the
 * floating launcher, or the reader/player's own) shares the one instance, so asking Cal from the
 * reader and then opening his settings (the gear in his panel's header) from the book page acts
 * on the same conversation, not two.
 */
export function CalHost() {
  const open = useCalOpen();
  if (!open) return null;
  return <CalPanel clubId={open.clubId} bookId={open.bookId} onClose={closeCal} />;
}
