import { useEffect } from 'react';
import type { WidgetSnapshot } from '@bookclub/shared';
import { api } from './api';

/**
 * The iOS app's widgets and Live Activity (D188), from the page's side. Inside the app the page
 * hands native what its Home Screen and Lock Screen widgets show (your current book, your place,
 * its club's next stop: `GET /api/widget`), when it opens, when it comes back to the foreground,
 * and after your place is saved; and whether you want the Live Activity. In a browser all of this
 * does nothing. An app build without widgets ignores both messages (its bridge's `default`).
 */

const LIVE_ACTIVITY_KEY = 'bookclub:live-activity';

/** At most one snapshot every this often: a page turned every few seconds is not a widget's business. */
export const WIDGET_EVERY_MS = 60_000;

function bridge(): { postMessage(json: string): void } | null {
  return typeof window !== 'undefined' && window.BookClubNative ? window.BookClubNative : null;
}

/** The message native turns into its widgets' data (and their covers, which it fetches with the session). */
export interface WidgetsMessage {
  readonly type: 'widgets';
  readonly snapshot: WidgetSnapshot;
  /** Absolute URLs of each book's square cover (D190), current first. */
  readonly covers: Readonly<Record<string, string>>;
}

export function widgetsMessage(snapshot: WidgetSnapshot, base: string): WidgetsMessage {
  const covers: Record<string, string> = {};
  for (const book of [snapshot.current, ...snapshot.others]) {
    if (!book) continue;
    const url = new URL(book.coverUrl, base);
    url.searchParams.set('shape', 'square');
    url.searchParams.set('w', '384');
    covers[book.bookId] = url.href;
  }
  return { type: 'widgets', snapshot, covers };
}

/** Send native a fresh snapshot, at most once a minute unless `force`d. */
export function widgetSyncer(fetchSnapshot: () => Promise<WidgetSnapshot> = api.widget, now: () => number = Date.now) {
  let last = Number.NEGATIVE_INFINITY;
  let running = false;
  return async (force = false): Promise<boolean> => {
    const native = bridge();
    if (!native || running || (!force && now() - last < WIDGET_EVERY_MS)) return false;
    running = true;
    last = now();
    try {
      const snapshot = await fetchSnapshot();
      native.postMessage(JSON.stringify(widgetsMessage(snapshot, location.href)));
      return true;
    } catch {
      return false; // offline: the widgets keep what they last had
    } finally {
      running = false;
    }
  };
}

/** Whether you want the Live Activity: off until you turn it on (D188). */
export function liveActivityWanted(): boolean {
  try {
    return localStorage.getItem(LIVE_ACTIVITY_KEY) === 'on';
  } catch {
    return false;
  }
}

/** Turn the Live Activity on or off, and tell native. */
export function setLiveActivityWanted(on: boolean): void {
  try {
    localStorage.setItem(LIVE_ACTIVITY_KEY, on ? 'on' : 'off');
  } catch {
    // no storage: still tell native, for this launch
  }
  bridge()?.postMessage(JSON.stringify({ type: 'live-activity', enabled: on }));
}

const sync = widgetSyncer();

/** In the app: widgets kept fresh while it is open, and the Live Activity choice told on launch. */
export function useNativeWidgets(signedIn: boolean): void {
  useEffect(() => {
    if (!bridge() || !signedIn) return;
    bridge()?.postMessage(JSON.stringify({ type: 'live-activity', enabled: liveActivityWanted() }));
    void sync(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void sync();
    };
    // Your place saved (D20's outbox): the widgets' percentage moves with it, at most once a minute.
    const onSaved = () => void sync();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('bookclub:progress-saved', onSaved);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('bookclub:progress-saved', onSaved);
    };
  }, [signedIn]);
}
