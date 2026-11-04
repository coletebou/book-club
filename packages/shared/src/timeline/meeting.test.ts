import { describe, expect, it } from 'vitest';
import { linearSyncMap } from './syncmap';
import {
  PDF_PAGE_MINUTES,
  READING_CHARS_PER_MINUTE,
  chapterEnd,
  chaptersToGo,
  formatDay,
  formatRoughDuration,
  hasReached,
  isCalendarDay,
  meetingStops,
  stopLabel,
  timeToGo,
} from './meeting';

// Four chapters, listed out of reading order (as some books' contents are).
const chapters = [
  { title: 'CHAPTER I. Down the Rabbit-Hole', t: 0 },
  { title: 'CHAPTER III. A Caucus-Race', t: 0.5 },
  { title: 'CHAPTER II. The Pool of Tears', t: 0.25 },
  { title: 'CHAPTER IV. The Rabbit Sends in a Little Bill', t: 0.8 },
];

describe('meeting points', () => {
  it('knows where each chapter ends, whatever order the contents list them in', () => {
    expect(chapters.map((_, i) => chapterEnd(chapters, i))).toEqual([0.25, 0.8, 0.5, 1]);
  });

  it('offers the end of every chapter, in reading order, the end of the book last', () => {
    expect(meetingStops(chapters)).toEqual([
      { t: 0.25, label: 'the end of Chapter 1' },
      { t: 0.5, label: 'the end of Chapter 2' },
      { t: 0.8, label: 'the end of Chapter 3' },
      { t: 1, label: 'the end of the book' },
    ]);
    // A book without chapters gets quarters.
    expect(meetingStops([]).map((s) => s.label)).toEqual(['25%', '50%', '75%', 'the end of the book']);
  });

  it('leaves out the front matter a book’s contents also list (a title page, the contents)', () => {
    const alice = [
      { title: 'Alice’s Adventures in Wonderland', t: 0.00003 },
      { title: 'THE MILLENNIUM FULCRUM EDITION 3.0', t: 0.00037 },
      { title: 'Contents', t: 0.00062 },
      { title: 'CHAPTER I. Down the Rabbit-Hole', t: 0.00373 },
      { title: 'CHAPTER II. The Pool of Tears', t: 0.08329 },
      { title: 'CHAPTER III. A Caucus-Race and a Long Tale', t: 0.15885 },
      { title: 'CHAPTER IV. The Rabbit Sends in a Little Bill', t: 0.22496 },
    ];
    expect(meetingStops(alice).map((s) => s.label)).toEqual(['the end of Chapter 1', 'the end of Chapter 2', 'the end of Chapter 3', 'the end of the book']);
    // From the very start, the end of chapter 2 is two chapters away, not five.
    expect(chaptersToGo(alice, 0, 0.15885)).toBe(2);
    // A book of many short chapters keeps every one of them.
    const many = Array.from({ length: 365 }, (_, i) => ({ title: `Chapter ${i + 1}`, t: i / 365 }));
    expect(meetingStops(many)).toHaveLength(365);
  });

  it('offers the end of each stave of A Christmas Carol and nothing of its front matter (D77)', () => {
    // Its chapters as its contents give them now: the front matter a note, title-page lines, a
    // preface under the author's name, the contents and the pictures' list; then five staves.
    const carol = [
      { title: 'There are several editions of this ebook in the Project Gutenberg collection.', t: 0 },
      { title: 'A CHRISTMAS CAROL', t: 0.0032 },
      { title: 'IN PROSE', t: 0.0034 },
      { title: 'A Ghost Story of Christmas', t: 0.0037 },
      { title: 'CHARLES DICKENS: WITH ILLUSTRATIONS BY JOHN LEECH', t: 0.004 },
      { title: 'CONTENTS', t: 0.0066 },
      { title: 'ILLUSTRATIONS', t: 0.0079 },
      { title: 'STAVE ONE. MARLEY’S GHOST.', t: 0.0123 },
      { title: 'STAVE TWO. THE FIRST OF THE THREE SPIRITS.', t: 0.2393 },
      { title: 'STAVE THREE. THE SECOND OF THE THREE SPIRITS.', t: 0.4515 },
      { title: 'STAVE FOUR. THE LAST OF THE SPIRITS.', t: 0.7367 },
      { title: 'STAVE FIVE. THE END OF IT.', t: 0.9208 },
    ];
    expect(meetingStops(carol)).toEqual([
      { t: 0.2393, label: 'the end of Stave 1' },
      { t: 0.4515, label: 'the end of Stave 2' },
      { t: 0.7367, label: 'the end of Stave 3' },
      { t: 0.9208, label: 'the end of Stave 4' },
      { t: 1, label: 'the end of the book' },
    ]);
    expect(chaptersToGo(carol, 0, 0.4515)).toBe(2);
  });

  it('names each stop with its part where the book numbers its chapters afresh in each (D86)', () => {
    const crime = [
      { title: 'PART I', t: 0.005 },
      { title: 'CHAPTER I', t: 0.0051 },
      { title: 'CHAPTER II', t: 0.07 },
      { title: 'PART II', t: 0.15 },
      { title: 'CHAPTER I', t: 0.1501 },
      { title: 'CHAPTER II', t: 0.2 },
    ];
    const labels = meetingStops(crime).map((s) => s.label);
    // The last chapter ends with the book.
    expect(labels).toEqual(['the end of Part 1, Chapter 1', 'the end of Part 1, Chapter 2', 'the end of Part 2, Chapter 1', 'the end of the book']);
    expect(new Set(labels).size).toBe(labels.length);
    expect(stopLabel(crime, 0.2)).toBe('the end of Part 2, Chapter 1');
  });

  it('stays fast with a contents list of tens of thousands of entries', () => {
    const huge = Array.from({ length: 60_000 }, (_, i) => ({ title: `Chapter ${i + 1}`, t: i / 60_000 }));
    const started = performance.now();
    expect(meetingStops(huge)).toHaveLength(60_000);
    expect(stopLabel(huge, 30_000 / 60_000)).toBe('the end of Chapter 30000');
    expect(chaptersToGo(huge, 0, 0.5)).toBe(30_000);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('names a stop, and any other place by its percentage', () => {
    expect(stopLabel(chapters, 0.5)).toBe('the end of Chapter 2');
    expect(stopLabel(chapters, 0.5 + 1e-9)).toBe('the end of Chapter 2');
    expect(stopLabel(chapters, 1)).toBe('the end of the book');
    expect(stopLabel(chapters, 0.62)).toBe('62%');
  });

  it('counts who is there: read as far, or finished', () => {
    expect(hasReached({ furthest: 0.5, finished: false }, 0.5)).toBe(true);
    expect(hasReached({ furthest: 0.4999999, finished: false }, 0.5)).toBe(true);
    expect(hasReached({ furthest: 0.49, finished: false }, 0.5)).toBe(false);
    expect(hasReached({ furthest: 0.1, finished: true }, 0.5)).toBe(true);
  });

  it('counts the chapters left, the rest of the current one included', () => {
    expect(chaptersToGo(chapters, 0, 0.5)).toBe(2);
    expect(chaptersToGo(chapters, 0.3, 0.5)).toBe(1);
    expect(chaptersToGo(chapters, 0.1, 0.8)).toBe(3);
    expect(chaptersToGo(chapters, 0.25, 0.5)).toBe(1);
    expect(chaptersToGo(chapters, 0.5, 0.5)).toBe(0);
    expect(chaptersToGo(chapters, 0.9, 0.5)).toBe(0);
  });

  it('estimates the time left reading the EPUB and listening to the audiobook', () => {
    const epub = { kind: 'epub' as const, status: 'ready' as const, sync: linearSyncMap(0, 135_000) };
    const audio = { kind: 'audio' as const, status: 'ready' as const, sync: linearSyncMap(0, 3 * 3600_000) };
    const { readingMs, listeningMs } = timeToGo([epub, audio], 0.2, 0.7);
    // Half the book: 67,500 characters and an hour and a half of audio.
    expect(readingMs).toBeCloseTo((67_500 / READING_CHARS_PER_MINUTE) * 60_000, 3);
    expect(listeningMs).toBeCloseTo(1.5 * 3600_000, 3);
    // Without an EPUB, the PDF's pages; formats still processing do not count.
    const pdf = { kind: 'pdf' as const, status: 'ready' as const, sync: linearSyncMap(0, 100) };
    expect(timeToGo([pdf, { ...audio, status: 'processing' as const }], 0, 0.1)).toEqual({ readingMs: 10 * PDF_PAGE_MINUTES * 60_000, listeningMs: null });
    expect(timeToGo([epub], 0.7, 0.2).readingMs).toBe(0);
  });

  it('says roughly how long', () => {
    expect(formatRoughDuration(20_000)).toBe('under a minute');
    expect(formatRoughDuration(25 * 60_000)).toBe('25 min');
    expect(formatRoughDuration(70 * 60_000)).toBe('1 h 10 min');
    expect(formatRoughDuration(122 * 60_000)).toBe('2 h');
    expect(formatRoughDuration(178 * 60_000)).toBe('3 h');
  });

  it('accepts calendar days only', () => {
    expect(isCalendarDay('2026-10-25')).toBe(true);
    expect(isCalendarDay('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-30', '2026-13-01', '26-10-25', '2026-10-25T10:00', '', 'Sunday']) expect(isCalendarDay(bad), bad).toBe(false);
  });

  it('says a day as friends would, from today', () => {
    const now = new Date(2026, 9, 23, 21, 30); // a Friday evening
    expect(formatDay('2026-10-23', now)).toBe('today');
    expect(formatDay('2026-10-24', now)).toBe('tomorrow');
    expect(formatDay('2026-10-22', now)).toBe('yesterday');
    expect(formatDay('2026-10-25', now)).toBe('Sunday');
    expect(formatDay('2026-11-02', now)).toBe('Monday 2 November');
    expect(formatDay('2026-10-19', now)).toBe('Monday 19 October');
    expect(formatDay('2027-01-08', now)).toBe('Friday 8 January 2027');
  });
});
