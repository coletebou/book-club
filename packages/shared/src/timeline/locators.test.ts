import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { type AudioLocatorSchema, type EpubLocatorSchema, LocatorSchema, type PdfLocatorSchema } from './locator-schemas';
import {
  type AudioLocator,
  type EpubLocator,
  type Locator,
  LocatorError,
  type PdfLocator,
  type EditionGeometry,
  type EditionTimeline,
  locatorToM,
  locatorToT,
  mToLocator,
  tToLocator,
  totalMeasure,
  translateLocator,
  unitStarts,
} from './locators';
import { linearSyncMap, syncMapFromTiePoints } from './syncmap';

const epub: EditionGeometry = { kind: 'epub', sectionLengths: [100, 0, 400, 500] };
const pdf: EditionGeometry = { kind: 'pdf', pageCount: 10 };
const audio: EditionGeometry = { kind: 'audio', trackDurationsMs: [60_000, 120_000] };

describe('totalMeasure and unitStarts', () => {
  it('sums sections, pages and tracks', () => {
    expect(totalMeasure(epub)).toBe(1000);
    expect(totalMeasure(pdf)).toBe(10);
    expect(totalMeasure(audio)).toBe(180_000);
    expect(unitStarts(epub)).toEqual([0, 100, 100, 500, 1000]);
    expect(unitStarts(pdf)).toHaveLength(11);
    expect(unitStarts(audio)).toEqual([0, 60_000, 180_000]);
  });
});

describe('locatorToM', () => {
  it('EPUB: section start plus offset, offsets clamped to the section', () => {
    expect(locatorToM(epub, { kind: 'epub', section: 2, offset: 50 })).toBe(150);
    expect(locatorToM(epub, { kind: 'epub', section: 0, offset: 999 })).toBe(100);
    expect(locatorToM(epub, { kind: 'epub', section: 99, offset: 0 })).toBe(500);
  });

  it('PDF: page plus vertical fraction', () => {
    expect(locatorToM(pdf, { kind: 'pdf', page: 3, y: 0.5 })).toBe(3.5);
    expect(locatorToM(pdf, { kind: 'pdf', page: 40, y: 0 })).toBe(9);
  });

  it('audio: track start plus ms', () => {
    expect(locatorToM(audio, { kind: 'audio', track: 1, ms: 30_000 })).toBe(90_000);
    expect(locatorToM(audio, { kind: 'audio', track: 0, ms: 999_999 })).toBe(60_000);
  });

  it('rejects a locator for another kind of edition', () => {
    expect(() => locatorToM(epub, { kind: 'audio', track: 0, ms: 0 })).toThrow(LocatorError);
  });

  it('handles empty editions', () => {
    expect(locatorToM({ kind: 'epub', sectionLengths: [] }, { kind: 'epub', section: 0, offset: 5 })).toBe(0);
    expect(locatorToM({ kind: 'pdf', pageCount: 0 }, { kind: 'pdf', page: 0, y: 0.5 })).toBe(0);
    expect(locatorToM({ kind: 'audio', trackDurationsMs: [] }, { kind: 'audio', track: 0, ms: 5 })).toBe(0);
  });
});

describe('mToLocator', () => {
  it('round-trips EPUB positions, skipping empty sections', () => {
    expect(mToLocator(epub, 150)).toEqual({ kind: 'epub', section: 2, offset: 50 });
    // 100 is the end of section 0, the (empty) section 1 and the start of section 2.
    expect(mToLocator(epub, 100)).toEqual({ kind: 'epub', section: 2, offset: 0 });
    expect(mToLocator(epub, 1000)).toEqual({ kind: 'epub', section: 3, offset: 500 });
    expect(mToLocator(epub, -5)).toEqual({ kind: 'epub', section: 0, offset: 0 });
  });

  it('round-trips PDF and audio positions', () => {
    expect(mToLocator(pdf, 3.25)).toEqual({ kind: 'pdf', page: 3, y: 0.25 });
    expect(mToLocator(pdf, 10)).toEqual({ kind: 'pdf', page: 9, y: 1 });
    expect(mToLocator(audio, 90_000)).toEqual({ kind: 'audio', track: 1, ms: 30_000 });
    expect(mToLocator(audio, 60_000)).toEqual({ kind: 'audio', track: 1, ms: 0 });
  });

  it('returns a zero locator for empty editions', () => {
    expect(mToLocator({ kind: 'epub', sectionLengths: [] }, 3)).toEqual({ kind: 'epub', section: 0, offset: 0 });
    expect(mToLocator({ kind: 'pdf', pageCount: 0 }, 3)).toEqual({ kind: 'pdf', page: 0, y: 0 });
    expect(mToLocator({ kind: 'audio', trackDurationsMs: [] }, 3)).toEqual({ kind: 'audio', track: 0, ms: 0 });
  });
});

describe('cross-format translation', () => {
  // EPUB: 100 chars of front matter, then two chapters of 400 and 500 chars.
  const book: EditionTimeline = {
    geometry: { kind: 'epub', sectionLengths: [100, 400, 500] },
    sync: linearSyncMap(100, 1000),
  };
  // Audio: one track per chapter, 60 s and 120 s; chapter 2 starts at t = 400/900.
  const listen: EditionTimeline = {
    geometry: { kind: 'audio', trackDurationsMs: [60_000, 120_000] },
    sync: syncMapFromTiePoints([
      { m: 0, t: 0 },
      { m: 60_000, t: 400 / 900 },
      { m: 180_000, t: 1 },
    ]),
  };

  it('the start of chapter 2 in the EPUB is the start of track 2', () => {
    const loc = translateLocator(book, listen, { kind: 'epub', section: 2, offset: 0 });
    expect(loc).toEqual({ kind: 'audio', track: 1, ms: 0 });
  });

  it('half-way through chapter 2 is half-way through track 2, and back', () => {
    const audioLoc = translateLocator(book, listen, { kind: 'epub', section: 2, offset: 250 });
    expect(audioLoc.kind).toBe('audio');
    if (audioLoc.kind !== 'audio') return;
    expect(audioLoc.track).toBe(1);
    expect(audioLoc.ms).toBeCloseTo(60_000, 6);
    expect(translateLocator(listen, book, audioLoc)).toEqual({ kind: 'epub', section: 2, offset: 250 });
  });

  it('front matter clamps to the start of the timeline', () => {
    expect(locatorToT(book, { kind: 'epub', section: 0, offset: 50 })).toBe(0);
    expect(tToLocator(book, 0)).toEqual({ kind: 'epub', section: 1, offset: 0 });
  });
});

describe('LocatorSchema', () => {
  it('parses each kind and rejects bad shapes', () => {
    expect(LocatorSchema.parse({ kind: 'epub', section: 1, offset: 2 })).toEqual({ kind: 'epub', section: 1, offset: 2 });
    expect(LocatorSchema.safeParse({ kind: 'pdf', page: 1, y: 2 }).success).toBe(false);
    expect(LocatorSchema.safeParse({ kind: 'audio', track: -1, ms: 0 }).success).toBe(false);
    expect(LocatorSchema.safeParse({ kind: 'epub', section: 1.5, offset: 0 }).success).toBe(false);
    expect(LocatorSchema.safeParse({ kind: 'video' }).success).toBe(false);
  });

  it('describes exactly the locator types the timeline code uses', () => {
    expectTypeOf<z.infer<typeof EpubLocatorSchema>>().toEqualTypeOf<EpubLocator>();
    expectTypeOf<z.infer<typeof PdfLocatorSchema>>().toEqualTypeOf<PdfLocator>();
    expectTypeOf<z.infer<typeof AudioLocatorSchema>>().toEqualTypeOf<AudioLocator>();
    expectTypeOf<z.infer<typeof LocatorSchema>>().toEqualTypeOf<Locator>();
  });
});
