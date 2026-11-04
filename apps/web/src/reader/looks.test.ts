import { describe, expect, it } from 'vitest';
import { PAGES_TO_READ_ON, type SeenPage, pastWhereRead, readPage, readRuns, turnIsReading } from './looks';

/** PDF-like pages: page n is [n, n + 1) in its edition's measure. */
const page = (n: number): SeenPage<number> => ({ start: n, end: n + 1, from: n, to: n + 1 });

describe('a page past where you have read (D72)', () => {
  // Pages of about 0.4 % of the book, as a phone's are in Alice.
  const at = (start: number) => ({ start, end: start + 0.004 });

  it('starts more than a page beyond the furthest point read', () => {
    // Fay has read to 3 %: chapter X, at 77 %, is past it.
    expect(pastWhereRead(at(0.77), 0.03)).toBe(true);
    expect(pastWhereRead(at(0.039), 0.03)).toBe(true);
  });

  it('is not the page just after it, a page or so on, nor anything before', () => {
    expect(pastWhereRead(at(0.03), 0.03)).toBe(false);
    expect(pastWhereRead(at(0.033), 0.03)).toBe(false);
    expect(pastWhereRead(at(0.034), 0.03)).toBe(false);
    expect(pastWhereRead(at(0.01), 0.03)).toBe(false);
    // Re-reading a book you have finished: nothing is past where you have read.
    expect(pastWhereRead(at(0.77), 1)).toBe(false);
  });

  it('never the front matter, which is all at the start of the timeline', () => {
    expect(pastWhereRead({ start: 0, end: 0 }, 0)).toBe(false);
  });
});

describe('the pages read during a look', () => {
  it('are each page turned on from, once, in order', () => {
    let read = readPage([], page(40));
    read = readPage(read, page(41));
    read = readPage(read, page(40));
    expect(read.map((p) => p.start)).toEqual([40, 41]);
    // Back a page, and on from there.
    expect(readPage(read, page(39)).map((p) => p.start)).toEqual([39, 40, 41]);
  });

  it('count a page laid out again (it starts inside one read already) once', () => {
    const read = readPage([], { start: 1000, end: 2000, from: 1000, to: 2000 });
    expect(readPage(read, { start: 1500, end: 2600, from: 1500, to: 2600 })).toBe(read);
    expect(readPage(read, { start: 2000, end: 3000, from: 2000, to: 3000 })).toHaveLength(2);
  });

  it('are counted as stretches of touching pages', () => {
    const read = [page(39), page(40), page(41), page(44)].reduce<readonly SeenPage<number>[]>(readPage, []);
    expect(readRuns(read)).toEqual([
      { from: 39, to: 42 },
      { from: 44, to: 45 },
    ]);
    expect(readRuns([])).toEqual([]);
    // A page laid out larger than one before it reaches further.
    expect(readRuns([{ start: 0, end: 10, from: 'a', to: 'b' }, { start: 5, end: 12, from: 'c', to: 'd' }])).toEqual([{ from: 'a', to: 'd' }]);
  });
});

describe('a page turned during a look', () => {
  const ahead = { fromAhead: true, toAhead: true };
  const behind = { fromAhead: false, toAhead: false };
  // Fay has read to 3 %, and looks at chapter X, at 77 %.
  const peek = { from: { start: 0.77, end: 0.774 }, furthest: 0.03, place: ahead };

  it(`past where you have read is reading only once ${PAGES_TO_READ_ON} pages are read there`, () => {
    expect(turnIsReading({ ...peek, forward: true, pagesRead: 1 })).toBe(false);
    expect(turnIsReading({ ...peek, forward: true, pagesRead: 2 })).toBe(false);
    expect(turnIsReading({ ...peek, forward: true, pagesRead: 3 })).toBe(true);
    // Turning back is never reading on, however much was read.
    expect(turnIsReading({ ...peek, forward: false, pagesRead: 5 })).toBe(false);
  });

  it('just ahead of where you have read is reading on there (D62)', () => {
    const near = { from: { start: 0.032, end: 0.036 }, furthest: 0.032, place: ahead, pagesRead: 1 };
    expect(turnIsReading({ ...near, forward: true })).toBe(true);
    expect(turnIsReading({ ...near, forward: false })).toBe(true);
    // Behind where you have read too, ahead of your place: re-reading on from a chapter.
    expect(turnIsReading({ ...near, furthest: 1, forward: true })).toBe(true);
  });

  it('behind your place is reading only forward through it (D62)', () => {
    const back = { from: { start: 0.2, end: 0.204 }, furthest: 0.6, pagesRead: 4 };
    expect(turnIsReading({ ...back, place: behind, forward: true })).toBe(false);
    expect(turnIsReading({ ...back, place: behind, forward: false })).toBe(false);
    expect(turnIsReading({ ...back, place: { fromAhead: false, toAhead: true }, forward: true })).toBe(true);
    expect(turnIsReading({ ...back, place: { fromAhead: false, toAhead: true }, forward: false })).toBe(false);
  });

  it('is reading with no place to come back to', () => {
    expect(turnIsReading({ ...peek, place: null, forward: true, pagesRead: 0 })).toBe(true);
  });
});
