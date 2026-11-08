import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WidgetSnapshot } from '@bookclub/shared';
import { WIDGET_EVERY_MS, liveActivityWanted, setLiveActivityWanted, signedOutMessage, widgetSyncer, widgetsMessage } from './native-widgets';

const book = { bookId: 'b1', clubId: 'c1', clubName: 'Rabbit Hole', title: 'Alice', author: 'Carroll', coverUrl: '/media/books/b1/cover?v=x', t: 0.25, percent: 25, label: 'Chapter 3 · 25%', format: 'epub' as const, finished: false, at: 1, stop: null };
const snapshot: WidgetSnapshot = { generatedAt: 1, current: book, others: [{ ...book, bookId: 'b2', coverUrl: '/media/books/b2/cover?v=generated' }] };
let sent: Record<string, unknown>[];

beforeEach(() => {
  sent = [];
  localStorage.clear();
  window.BookClubNative = { postMessage: (json) => void sent.push(JSON.parse(json) as Record<string, unknown>) };
});
afterEach(() => {
  delete window.BookClubNative;
});

describe('the iOS app’s widgets, from the page (D188)', () => {
  it('sends the snapshot with each book’s square cover, absolute', () => {
    const message = widgetsMessage(snapshot, 'https://books.example/');
    expect(message.covers).toEqual({ b1: 'https://books.example/media/books/b1/cover?v=x&shape=square&w=384', b2: 'https://books.example/media/books/b2/cover?v=generated&shape=square&w=384' });
  });

  it('at most once a minute, unless forced; never in a browser', async () => {
    let now = 0;
    const fetch = vi.fn(() => Promise.resolve(snapshot));
    const sync = widgetSyncer(fetch, () => now);
    expect(await sync(true)).toBe(true);
    expect(await sync()).toBe(false);
    now += WIDGET_EVERY_MS;
    expect(await sync()).toBe(true);
    expect(sent.map((m) => m.type)).toEqual(['widgets', 'widgets']);
    delete window.BookClubNative;
    expect(await sync(true)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps what the widgets had when offline', async () => {
    const sync = widgetSyncer(() => Promise.reject(new Error('offline')));
    expect(await sync(true)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('the Live Activity is off until turned on, and native is told', () => {
    expect(liveActivityWanted()).toBe(false);
    setLiveActivityWanted(true);
    expect(liveActivityWanted()).toBe(true);
    expect(sent).toEqual([{ type: 'live-activity', enabled: true }]);
  });
});

describe('signed out (D188, D220, D221)', () => {
  it('is nobody’s reading and no covers: what native reads as signed out, clearing what it kept', () => {
    expect(signedOutMessage(5)).toEqual({ type: 'widgets', snapshot: { generatedAt: 5, current: null, others: [] }, covers: {} });
  });
});
