import {
  type BookDetail,
  type BookProgress,
  type CommentView,
  type Edition,
  type EditionGeometry,
  type Locator,
  type MyProgress,
  type SyncMap,
  linearSyncMap,
  syncMapFromTiePoints,
  tToLocator,
} from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import type { LocalPosition } from '../lib/db';
import { commentLocatorIn, startPosition, tOf, timelineOf, translatePlace } from './position';

/*
 * One book in three formats, placed on the timeline the way the server places them:
 *
 * - EPUB (the reference edition): sections of 100 (cover), 1000, 2000, 3000 and 400 (licence)
 *   characters. The story runs from character 100 to 6100, mapped linearly onto t ∈ [0, 1]
 *   (the server's `linearSyncMap(story.start, story.end)`).
 * - Audiobook: tracks of 60 s, 120 s and 120 s aligned to chapters at t = 0, 0.2 and 0.6.
 * - PDF: 50 pages, linear.
 */
const epubGeometry: EditionGeometry = { kind: 'epub', sectionLengths: [100, 1000, 2000, 3000, 400] };
const audioGeometry: EditionGeometry = { kind: 'audio', trackDurationsMs: [60_000, 120_000, 120_000] };
const pdfGeometry: EditionGeometry = { kind: 'pdf', pageCount: 50 };

const audioSync = syncMapFromTiePoints([
  { m: 0, t: 0 },
  { m: 60_000, t: 0.2 },
  { m: 180_000, t: 0.6 },
  { m: 300_000, t: 1 },
]);

function edition(id: string, kind: Edition['kind'], geometry: EditionGeometry | null, sync: SyncMap | null, status: Edition['status'] = 'ready'): Edition {
  return {
    id,
    kind,
    status,
    error: null,
    createdAt: '2026-10-20T10:00:00.000Z',
    addedBy: 'user_ana',
    sizeBytes: 1000,
    geometry,
    sync,
    alignment: { method: kind === 'epub' ? 'reference' : 'count', unitToChapter: [] },
    units: [],
    publicationUrl: kind === 'epub' ? `/api/editions/${id}/publication` : null,
    fileUrl: kind === 'pdf' ? `/api/editions/${id}/file` : null,
    tracks: [],
    durationMs: kind === 'audio' ? 300_000 : null,
    pageCount: kind === 'pdf' ? 50 : null,
    readAlong: null,
  };
}

const EPUB = edition('ed_epub_1', 'epub', epubGeometry, linearSyncMap(100, 6100));
const AUDIO = edition('ed_audio_1', 'audio', audioGeometry, audioSync);
const PDF = edition('ed_pdf_1', 'pdf', pdfGeometry, linearSyncMap(0, 50));
const PROCESSING = edition('ed_epub_2', 'epub', null, null, 'processing');

const book: BookDetail = {
  id: 'book_alice',
  clubId: 'club_123',
  title: "Alice's Adventures in Wonderland",
  author: 'Lewis Carroll',
  coverUrl: '/api/books/book_alice/cover?v=1',
  hasCover: true,
  kinds: ['epub', 'audio', 'pdf'],
  createdAt: '2026-10-20T10:00:00.000Z',
  addedBy: 'user_ana',
  commentCount: 0, meeting: null,
  progress: [],
  chapters: [
    { index: 0, title: 'Down the Rabbit-Hole', t: 0 },
    { index: 1, title: 'The Pool of Tears', t: 0.2 },
    { index: 2, title: 'A Caucus-Race', t: 0.6 },
  ],
  editions: [EPUB, AUDIO, PDF, PROCESSING],
  referenceEditionId: EPUB.id,
};

const epub = (section: number, offset: number): Locator => ({ kind: 'epub', section, offset });

/** What the server says about my place. `t` is the server's own timeline value for it. */
function server(editionId: string, locator: Locator, t: number, at: number): BookProgress {
  const mine: MyProgress = { editionId, locator, t, label: '', readRanges: [], furthest: t, finished: false, at };
  return { mine, members: [] };
}

const device = (editionId: string, locator: Locator, at: number, bookId = book.id): LocalPosition => ({ bookId, editionId, locator, at });

describe('timelineOf and tOf', () => {
  it('place a position on the book timeline through the edition’s sync map', () => {
    expect(timelineOf(EPUB)).toEqual({ geometry: epubGeometry, sync: linearSyncMap(100, 6100) });
    // Character 2500 of the book (section 2, offset 1400) is 40 % into the story.
    expect(tOf(EPUB, epub(2, 1400))).toBeCloseTo(0.4, 12);
    // 2 min into the audiobook: halfway through track 1, which runs from t 0.2 to 0.6.
    expect(tOf(AUDIO, { kind: 'audio', track: 1, ms: 60_000 })).toBeCloseTo(0.4, 12);
    expect(tOf(PDF, { kind: 'pdf', page: 20, y: 0 })).toBeCloseTo(0.4, 12);
  });

  it('put the cover and the licence outside the story at its ends', () => {
    expect(tOf(EPUB, epub(0, 50))).toBe(0);
    expect(tOf(EPUB, epub(4, 200))).toBe(1);
  });

  it('give 0 for an edition still being processed, or a position in another format', () => {
    expect(timelineOf(PROCESSING)).toBeNull();
    expect(tOf(PROCESSING, epub(2, 1400))).toBe(0);
    expect(tOf(EPUB, { kind: 'audio', track: 1, ms: 60_000 })).toBe(0);
  });
});

describe('startPosition', () => {
  it('opens at the beginning when nothing is saved', () => {
    expect(startPosition(book, EPUB, undefined, undefined, null)).toEqual({ locator: null, source: 'beginning', at: null });
    expect(startPosition(book, EPUB, { mine: null, members: [] }, undefined, null)).toEqual({ locator: null, source: 'beginning', at: null });
  });

  it('opens at the beginning of an edition without a timeline, whatever is saved', () => {
    const progress = server(EPUB.id, epub(3, 500), 0.6, 2_000);
    expect(startPosition(book, PROCESSING, progress, device(EPUB.id, epub(3, 600), 3_000), 0.5)).toEqual({ locator: null, source: 'beginning', at: null });
  });

  it('opens where the server says I am, for this edition', () => {
    expect(startPosition(book, EPUB, server(EPUB.id, epub(3, 500), 0.5, 2_000), undefined, null)).toEqual({ locator: epub(3, 500), source: 'server', at: 2_000 });
  });

  it('opens at this device’s place when it is newer than the server’s (read offline)', () => {
    const result = startPosition(book, EPUB, server(EPUB.id, epub(3, 500), 0.5, 2_000), device(EPUB.id, epub(3, 900), 3_000), null);
    expect(result).toEqual({ locator: epub(3, 900), source: 'device', at: 3_000 });
  });

  it('opens at the server’s place when it is newer (read on another device since)', () => {
    const result = startPosition(book, EPUB, server(EPUB.id, epub(3, 500), 0.5, 4_000), device(EPUB.id, epub(1, 10), 3_000), null);
    expect(result).toEqual({ locator: epub(3, 500), source: 'server', at: 4_000 });
  });

  it('ignores a device position saved for another book', () => {
    const result = startPosition(book, EPUB, undefined, device(EPUB.id, epub(3, 900), 3_000, 'book_other'), null);
    expect(result).toEqual({ locator: null, source: 'beginning', at: null });
  });

  it('translates a place saved while listening into the matching EPUB position', () => {
    // The server reports t 0.4 for 2:00 into the audiobook; t 0.4 is character 2500: section 2, offset 1400.
    const fromServer = startPosition(book, EPUB, server(AUDIO.id, { kind: 'audio', track: 1, ms: 60_000 }, 0.4, 2_000), undefined, null);
    expect(fromServer).toEqual({ locator: epub(2, 1400), source: 'other-format', at: 2_000 });
    // The same place saved on this device is translated through the audiobook's own sync map.
    const fromDevice = startPosition(book, EPUB, undefined, device(AUDIO.id, { kind: 'audio', track: 1, ms: 60_000 }, 2_000), null);
    expect(fromDevice).toEqual({ locator: epub(2, 1400), source: 'other-format', at: 2_000 });
  });

  it('translates an EPUB place into the matching audio position, and a PDF page into the EPUB', () => {
    const listening = startPosition(book, AUDIO, server(EPUB.id, epub(2, 1400), 0.4, 2_000), undefined, null);
    expect(listening.source).toBe('other-format');
    expect(listening.locator).toEqual({ kind: 'audio', track: 1, ms: 60_000 });

    const reading = startPosition(book, EPUB, undefined, device(PDF.id, { kind: 'pdf', page: 20, y: 0 }, 2_000), null);
    expect(reading).toEqual({ locator: epub(2, 1400), source: 'other-format', at: 2_000 });
  });

  it('opens at a link’s place, and remembers where it would otherwise have opened', () => {
    const progress = server(EPUB.id, epub(3, 500), 0.5, 2_000);
    expect(startPosition(book, EPUB, progress, undefined, 0.4)).toEqual({ locator: epub(2, 1400), source: 'link', at: null, resume: epub(3, 500), resumeAt: 2_000 });
    // A newer device position is the place to come back to.
    expect(startPosition(book, EPUB, progress, device(EPUB.id, epub(3, 900), 3_000), 0.4).resume).toEqual(epub(3, 900));
    // With nothing saved, there is nothing to come back to.
    expect(startPosition(book, EPUB, undefined, undefined, 0.4)).toEqual({ locator: epub(2, 1400), source: 'link', at: null, resume: null, resumeAt: null });
  });

  it('keeps a link inside the story', () => {
    // Past the end: the story's end (where the licence section begins).
    expect(startPosition(book, EPUB, undefined, undefined, 1.7).locator).toEqual(epub(4, 0));
    // Before the start: the story's first character, after the cover (section 1, offset 0).
    expect(startPosition(book, EPUB, undefined, undefined, -0.5).locator).toEqual(epub(1, 0));
  });

  it('says when the place it opens at was saved, so a reader opening there never outranks that save (D196)', () => {
    // Saved while listening at 2 000; opened in the EPUB, the page's place is still the one saved then.
    const listened = server(AUDIO.id, { kind: 'audio', track: 1, ms: 60_000 }, 0.4, 2_000);
    expect(startPosition(book, EPUB, listened, device(EPUB.id, epub(1, 10), 1_000), null).at).toBe(2_000);
    // On a tie the server's copy is the one opened (it is the same moment, said by the server).
    const tie = startPosition(book, AUDIO, listened, device(EPUB.id, epub(2, 1400), 2_000), null);
    expect(tie).toEqual({ locator: { kind: 'audio', track: 1, ms: 60_000 }, source: 'server', at: 2_000 });
  });

  it('ignores a link without a usable place', () => {
    const progress = server(EPUB.id, epub(3, 500), 0.5, 2_000);
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(startPosition(book, EPUB, progress, undefined, bad)).toEqual({ locator: epub(3, 500), source: 'server', at: 2_000 });
    }
  });
});

// Chapter II starts at t 0.2 in the EPUB (its heading at character 1300: section 2, offset 200),
// a hair later in the audiobook (its track's first matched word, after the announcement) and in
// the PDF (its heading a little way down page 11).
const units = (ms: readonly number[]) => ms.map((m, i) => ({ title: `Chapter ${i + 1}`, m }));
const epub2: Edition = { ...EPUB, units: units([100, 1300, 3700]), alignment: { method: 'reference', unitToChapter: [0, 1, 2] } };
const audio2: Edition = {
  ...AUDIO,
  sync: syncMapFromTiePoints([
    { m: 0, t: 0 },
    { m: 60_000, t: 0.2005 },
    { m: 180_000, t: 0.6004 },
    { m: 300_000, t: 1 },
  ]),
  units: units([0, 60_000, 180_000]),
  alignment: { method: 'forced', unitToChapter: [0, 1, 2] },
};
const pdf2: Edition = { ...PDF, units: units([0, 10.02, 30.01]), alignment: { method: 'forced', unitToChapter: [0, 1, 2] } };
const book2: BookDetail = { ...book, editions: [epub2, audio2, pdf2] };

describe('a format switch at a chapter’s very start (FR142, D93)', () => {
  const fromEpub = (section: number, offset: number, t: number, to: Edition) => startPosition(book2, to, server(epub2.id, epub(section, offset), t, 2_000), undefined, null).locator;

  it('opens the other formats at their own start of the chapter, not in the last moments of the one before', () => {
    // At the heading: in the audiobook the start of chapter II's track, in the PDF its heading's page.
    expect(fromEpub(2, 200, 0.2, audio2)).toEqual({ kind: 'audio', track: 1, ms: 0 });
    expect(fromEpub(2, 200, 0.2, pdf2)).toMatchObject({ kind: 'pdf', page: 10 });
    // A page opening a few lines above the heading is at the chapter's start too.
    expect(fromEpub(2, 0, 0.2 - 200 / 6000, audio2)).toEqual({ kind: 'audio', track: 1, ms: 0 });
  });

  it('leaves a place before a chapter, or into it, where it is', () => {
    // Four hundred characters before the heading (beyond a few lines): the end of chapter I, heard
    // in its own track, well into it.
    const before = fromEpub(1, 800, 0.2 - 400 / 6000, audio2) as Extract<Locator, { kind: 'audio' }>;
    expect(before.track).toBe(0);
    expect(before.ms).toBeGreaterThan(35_000);
    // Two pages into chapter II: translated as ever.
    expect(fromEpub(2, 1200, 0.2 + 1000 / 6000, audio2)).toMatchObject({ kind: 'audio', track: 1 });
    expect(fromEpub(2, 1200, 0.2 + 1000 / 6000, audio2)).not.toEqual({ kind: 'audio', track: 1, ms: 0 });
    // From the audiobook's first seconds of chapter II, the EPUB's own start is before it: translated.
    const reading = startPosition(book2, epub2, server(audio2.id, { kind: 'audio', track: 1, ms: 3_000 }, 0.2006, 2_000), undefined, null);
    expect(reading.locator).toMatchObject({ kind: 'epub', section: 2 });
  });

  it('takes a listener in a track’s preamble, before its narrator reads the heading, as at the chapter’s start', () => {
    // 26.5 s into chapter II's track the narrator reads its heading, which the transcript lines up a
    // hair before the PDF's own start of the chapter: the PDF opens on its first page, not the page before.
    const listening = server(audio2.id, { kind: 'audio', track: 1, ms: 26_500 }, 0.2004 - 1e-6, 2_000);
    expect(startPosition(book2, pdf2, listening, undefined, null).locator).toMatchObject({ kind: 'pdf', page: 10 });
    // A minute and more in, a listener is in the chapter: translated as ever.
    const later = startPosition(book2, pdf2, server(audio2.id, { kind: 'audio', track: 1, ms: 90_000 }, 0.35, 2_000), undefined, null).locator;
    expect(later).toMatchObject({ kind: 'pdf', page: 17 });
  });

  it('opens a lined-up PDF on its first chapter’s page, not its title page, both at the story’s start', () => {
    // Nothing of the title page matches the EPUB's story: page 1 and page 2's top are both at t 0.
    const lined: Edition = {
      ...pdf2,
      sync: syncMapFromTiePoints([
        { m: 0, t: 0 },
        { m: 1, t: 0 },
        { m: 50, t: 1 },
      ]),
      units: units([1, 10.02, 30.01]),
    };
    const book3: BookDetail = { ...book, editions: [epub2, audio2, lined] };
    expect(startPosition(book3, lined, server(epub2.id, epub(1, 0), 0, 2_000), undefined, null).locator).toEqual({ kind: 'pdf', page: 1, y: 0 });
  });

  it('does the same for a place the club’s progress tells by its format and t (moved on another device, D70)', () => {
    // My place, read on to chapter II's first page on the phone, heard of in the player here.
    expect(translatePlace(book2, audio2, { t: 0.2, kind: 'epub' })).toEqual({ kind: 'audio', track: 1, ms: 0 });
    expect(translatePlace(book2, pdf2, { t: 0.2, kind: 'epub' })).toMatchObject({ kind: 'pdf', page: 10 });
    // In the same format, as it is.
    expect(translatePlace(book2, epub2, { t: 0.2, kind: 'epub' })).toEqual(epub(2, 200));
    // Without a timeline here, nowhere.
    expect(translatePlace(book2, PROCESSING, { t: 0.2, kind: 'epub' })).toBeNull();
  });

  it('leaves formats without a chapter match as they were', () => {
    const unmatched: Edition = { ...audio2, alignment: { method: 'none', unitToChapter: [null, null, null] } };
    const book3: BookDetail = { ...book, editions: [epub2, unmatched, pdf2] };
    const at = startPosition(book3, unmatched, server(epub2.id, epub(2, 200), 0.2, 2_000), undefined, null).locator as Extract<Locator, { kind: 'audio' }>;
    expect(at.track).toBe(0);
  });
});

/** A comment's base fields, the only ones `commentLocatorIn` reads (locators.ts). */
const note = (editionId: string, locator: Locator, t: number): Pick<CommentView, 't' | 'editionId' | 'kind' | 'locator'> => ({
  t,
  editionId,
  kind: locator.kind,
  locator,
});

describe('a place in its own edition (D196)', () => {
  // Track 1 opens with 10 s of announcement the text does not have: all of it at chapter II's
  // start on the timeline (a flat stretch of the map), as the recogniser lines LibriVox up.
  const announced: Edition = {
    ...AUDIO,
    id: 'ed_audio_flat',
    sync: syncMapFromTiePoints([
      { m: 0, t: 0 },
      { m: 60_000, t: 0.2 },
      { m: 70_000, t: 0.2 },
      { m: 180_000, t: 0.6 },
      { m: 300_000, t: 1 },
    ]),
  };
  const flatBook: BookDetail = { ...book, editions: [EPUB, announced, PDF] };
  const heard = { kind: 'audio', track: 1, ms: 8_000 } as const;

  it('is that very place, to the millisecond, not the timeline’s way back to it', () => {
    const t = tOf(announced, heard);
    // Through the timeline, 8 s into the announcement comes back at the track's first second.
    expect(tToLocator(timelineOf(announced)!, t)).toEqual({ kind: 'audio', track: 1, ms: 0 });
    expect(translatePlace(flatBook, announced, { t, editionId: announced.id, locator: heard })).toEqual(heard);
  });

  it('opens there in the player, and from the book page’s Read along (alongStart), unchanged', () => {
    const progress = server(announced.id, heard, tOf(announced, heard), 5_000);
    expect(startPosition(flatBook, announced, progress, undefined, null)).toEqual({ locator: heard, source: 'server', at: 5_000 });
  });

  it('still goes through the timeline for a place the club tells only by its format and t', () => {
    expect(translatePlace(flatBook, announced, { t: tOf(announced, heard), kind: 'audio' })).toEqual({ kind: 'audio', track: 1, ms: 0 });
  });
});

describe('commentLocatorIn', () => {
  it('uses the note’s own locator when it was made in this very edition', () => {
    expect(commentLocatorIn(book, EPUB, note(EPUB.id, epub(2, 1400), 0.4))).toEqual(epub(2, 1400));
  });

  it('translates a note made in another format onto this edition, through the timeline', () => {
    // 2:00 into the audiobook is t 0.4, character 2500 of the book: section 2, offset 1400.
    expect(commentLocatorIn(book, EPUB, note(AUDIO.id, { kind: 'audio', track: 1, ms: 60_000 }, 0.4))).toEqual(epub(2, 1400));
  });

  it('is null in an edition without a timeline (still processing)', () => {
    expect(commentLocatorIn(book, PROCESSING, note(EPUB.id, epub(2, 1400), 0.4))).toBeNull();
  });

  // A note made right at a chapter's start in one format must mark inside that chapter in every
  // other format too, not a hair before it in the chapter already read past: the bug behind
  // "sometimes a note shows in the header but never inline" (its margin marker requires a locator
  // in the section on screen, D93; the club bar only ever needs `t`, so it never notices).
  describe('a note at a chapter boundary that two editions’ sync maps place a hair apart', () => {
    // One chapter per section/track, each 1000 characters / 100 s. The audiobook's own sync map
    // puts its track II's very start (m 100 000) a hair before the EPUB's own chapter II (t 0.5,
    // not 0.49): the two maps' usual disagreement at a boundary (D93's whole reason to exist).
    const epub3: Edition = {
      ...edition('ed_epub_3', 'epub', { kind: 'epub', sectionLengths: [1000, 1000] }, linearSyncMap(0, 2000)),
      units: [{ title: 'Chapter I', m: 0 }, { title: 'Chapter II', m: 1000 }],
      alignment: { method: 'reference', unitToChapter: [0, 1] },
    };
    const audio3: Edition = {
      ...edition('ed_audio_3', 'audio', { kind: 'audio', trackDurationsMs: [100_000, 100_000] }, syncMapFromTiePoints([{ m: 0, t: 0 }, { m: 100_000, t: 0.49 }, { m: 200_000, t: 1 }])),
      units: [{ title: 'Chapter I', m: 0 }, { title: 'Chapter II', m: 100_000 }],
      alignment: { method: 'forced', unitToChapter: [0, 1] },
    };
    const book3: BookDetail = { ...book, editions: [epub3, audio3] };
    const heardAtChapterTwo = note(audio3.id, { kind: 'audio', track: 1, ms: 0 }, 0.49);

    it('a raw timeline translation lands a hair into chapter I’s section, already read past', () => {
      expect(tToLocator(timelineOf(epub3)!, 0.49)).toEqual({ kind: 'epub', section: 0, offset: 980 });
    });

    it('commentLocatorIn snaps it to chapter II’s own start instead, on the page the listener meant', () => {
      expect(commentLocatorIn(book3, epub3, heardAtChapterTwo)).toEqual({ kind: 'epub', section: 1, offset: 0 });
    });
  });

  it('leaves a note made well inside a chapter translated as ever, with no snap', () => {
    // Two pages into chapter II already: no boundary to snap across.
    const placed = commentLocatorIn(book2, audio2, note(epub2.id, epub(2, 1200), 0.2 + 1000 / 6000));
    expect(placed).toMatchObject({ kind: 'audio', track: 1 });
    expect(placed).not.toEqual({ kind: 'audio', track: 1, ms: 0 });
  });
});
