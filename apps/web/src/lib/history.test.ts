import { describe, expect, it } from 'vitest';
import type { Edition, HistoryEntry } from '@bookclub/shared';
import { type HistoryBookDetail, chaptersLabel, clockLabel, dayLabel, entryHref, entryMeta, entryTitle, groupByDay, spentLabel, totalsLabel, totalsOf } from './history';

const chapters = ['Contents', 'CHAPTER I. Down the Rabbit-Hole', 'CHAPTER II. The Pool of Tears', 'CHAPTER III. A Caucus-Race', 'CHAPTER IV. The Rabbit Sends in a Little Bill'].map((title, i) => ({ title, t: i === 0 ? 0 : (i - 1) * 0.25 + 0.0001 }));
// An audiobook of two tracks an hour and a half each, lined up linearly with the book.
const audio = {
  id: 'ea', kind: 'audio', status: 'ready',
  tracks: [{ index: 0, durationMs: 5_400_000 }, { index: 1, durationMs: 5_400_000 }],
  geometry: { kind: 'audio', trackDurationsMs: [5_400_000, 5_400_000] },
  sync: { points: [{ m: 0, t: 0 }, { m: 10_800_000, t: 1 }] },
} as unknown as Edition;
const epub = { id: 'ee', kind: 'epub', status: 'ready' } as unknown as Edition;
const book: HistoryBookDetail = { id: 'b1', clubId: 'c1', title: 'Alice', author: 'Lewis Carroll', coverUrl: '/c', chapters, editions: [epub, audio] };
const base: HistoryEntry = {
  id: 'h1', bookId: 'b1', editionId: 'ee', kind: 'epub', device: 'iPhone',
  startedAt: new Date(2026, 8, 12, 13, 30).getTime(), endedAt: new Date(2026, 8, 12, 14, 30).getTime(), activeMs: 3_600_000,
  from: { kind: 'epub', section: 3, offset: 0 }, to: { kind: 'epub', section: 5, offset: 10 }, fromT: 0.3, toT: 0.45, pages: { from: 100, to: 146 },
};

describe('a line of your history (D191)', () => {
  it('reading: the pages the device showed', () => {
    expect(entryTitle(base, book)).toBe('Read pages 100–146');
    expect(entryTitle({ ...base, pages: { from: 12, to: 12 } }, book)).toBe('Read page 12');
  });

  it('reading where the device said no pages: the chapters and how far through', () => {
    expect(entryTitle({ ...base, pages: null }, book)).toBe('Read ch. 2 · 30–45%');
    expect(entryTitle({ ...base, pages: null, fromT: 0.1, toT: 0.6 }, book)).toBe('Read ch. 1–3 · 10–60%');
  });

  it('a PDF: its own pages', () => {
    expect(entryTitle({ ...base, kind: 'pdf', pages: null, from: { kind: 'pdf', page: 9, y: 0 }, to: { kind: 'pdf', page: 29, y: 1 } }, book)).toBe('Read pages 10–30');
  });

  it('listening: where in the whole audiobook, as a clock, with its chapters', () => {
    const heard: HistoryEntry = { ...base, kind: 'audio', editionId: 'ea', pages: null, from: { kind: 'audio', track: 1, ms: 2_640_000 }, to: { kind: 'audio', track: 1, ms: 5_330_000 }, fromT: 0.7444, toT: 0.9935 };
    expect(entryTitle(heard, book)).toBe('Listened 2:14:00–2:58:50 (ch. 3–4)');
  });

  it('under it: when it began, how long, on what', () => {
    expect(entryMeta(base, 'en-US')).toBe('1:30 PM · 1 hr · iPhone');
    expect(entryMeta({ ...base, activeMs: 48 * 60_000 + 20_000 }, 'en-US')).toBe('1:30 PM · 48 min · iPhone');
  });

  it('says a duration as a person would', () => {
    expect([spentLabel(20_000), spentLabel(90_000), spentLabel(3_600_000), spentLabel(4_500_000)]).toEqual(['under a minute', '2 min', '1 hr', '1 hr 15 min']);
    expect([clockLabel(65_000, false), clockLabel(65_000, true), clockLabel(8_040_000, true)]).toEqual(['1:05', '0:01:05', '2:14:00']);
  });

  it('names chapters short, and nothing before the story', () => {
    expect(chaptersLabel(chapters, 0, 0.0001)).toBeNull();
    expect(chaptersLabel(chapters, 0.3, 0.6)).toBe('ch. 2–3');
    expect(chaptersLabel(chapters, 0.3, 0.5001)).toBe('ch. 2'); // ending where chapter 3 starts
    const staves = [{ title: 'Stave One', t: 0 }, { title: 'Stave Two', t: 0.5 }];
    expect(chaptersLabel(staves, 0.2, 0.7)).toBe('Stave 1 – Stave 2');
  });
});

describe('days and totals', () => {
  const now = new Date(2026, 8, 13, 20, 0).getTime();
  const listened: HistoryEntry = { ...base, id: 'h2', kind: 'audio', editionId: 'ea', startedAt: new Date(2026, 8, 13, 8, 0).getTime(), activeMs: 48 * 60_000 };
  const earlier: HistoryEntry = { ...base, id: 'h3', startedAt: new Date(2026, 8, 12, 9, 0).getTime(), activeMs: 20 * 60_000 };
  it('groups by the day each began, newest first, with each day’s totals', () => {
    const days = groupByDay([earlier, base, listened], now, 'en-US');
    expect(days.map((d) => [d.label, d.entries.map((e) => e.id), totalsLabel(d.totals)])).toEqual([
      ['Today', ['h2'], '48 min listened'],
      ['Yesterday', ['h1', 'h3'], '1 hr 20 min read'],
    ]);
    expect(totalsLabel(totalsOf([earlier, base, listened]))).toBe('1 hr 20 min read · 48 min listened');
  });
  it('names older days by their date, and another year’s with its year', () => {
    expect(dayLabel(new Date(2026, 8, 1, 12).getTime(), now, 'en-US')).toBe('Tue, Sep 1');
    expect(dayLabel(new Date(2025, 11, 31, 12).getTime(), now, 'en-US')).toBe('Wed, Dec 31, 2025');
  });
});

describe('where a line takes you', () => {
  it('to where the stretch began, in its own format and edition; or the other format at the same place', () => {
    expect(entryHref(base, 'same', book)).toBe('/books/b1/read?edition=ee&at=0.3');
    expect(entryHref(base, 'other', book)).toBe('/books/b1/listen?at=0.3');
    const heard = { ...base, kind: 'audio' as const, editionId: 'ea' };
    expect(entryHref(heard, 'same', book)).toBe('/books/b1/listen?edition=ea&at=0.3');
    expect(entryHref(heard, 'other', book)).toBe('/books/b1/read?at=0.3');
  });
  it('offers no other format a book does not have', () => {
    expect(entryHref(base, 'other', { ...book, editions: [epub] })).toBeNull();
  });
});
