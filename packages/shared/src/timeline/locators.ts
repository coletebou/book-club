import { type SyncMap, mToT, tToM } from './syncmap';

/**
 * Native positions inside one edition. They never depend on layout (font size, screen size),
 * so they survive reloads, other devices and other fonts. Their schemas, which validate input,
 * are in locator-schemas.ts: the app's reader uses this module without the schema library.
 */
export interface EpubLocator {
  kind: 'epub';
  /** Spine index. */
  section: number;
  /** UTF-16 offset into the concatenated text of the section's `<body>`. */
  offset: number;
}

export interface PdfLocator {
  kind: 'pdf';
  /** Zero-based page index. */
  page: number;
  /** Vertical position on the page, 0 = top, 1 = bottom. */
  y: number;
}

export interface AudioLocator {
  kind: 'audio';
  /** Index into the edition's ordered tracks. */
  track: number;
  /** Milliseconds into the track. */
  ms: number;
}

export type Locator = EpubLocator | PdfLocator | AudioLocator;
export type EditionKind = Locator['kind'];

/** The shape of an edition along its own linear measure. */
export type EditionGeometry =
  | { kind: 'epub'; sectionLengths: number[] }
  | { kind: 'pdf'; pageCount: number }
  | { kind: 'audio'; trackDurationsMs: number[] };

export class LocatorError extends Error {
  override name = 'LocatorError';
}

function prefixSums(values: readonly number[]): number[] {
  const out = new Array<number>(values.length + 1);
  out[0] = 0;
  for (let i = 0; i < values.length; i++) out[i + 1] = out[i]! + values[i]!;
  return out;
}

export function totalMeasure(geometry: EditionGeometry): number {
  switch (geometry.kind) {
    case 'epub':
      return geometry.sectionLengths.reduce((s, x) => s + x, 0);
    case 'pdf':
      return geometry.pageCount;
    case 'audio':
      return geometry.trackDurationsMs.reduce((s, x) => s + x, 0);
  }
}

/** Start of each unit (section or track) along the measure, plus the total at the end. */
export function unitStarts(geometry: EditionGeometry): number[] {
  switch (geometry.kind) {
    case 'epub':
      return prefixSums(geometry.sectionLengths);
    case 'pdf':
      return Array.from({ length: geometry.pageCount + 1 }, (_, i) => i);
    case 'audio':
      return prefixSums(geometry.trackDurationsMs);
  }
}

/** Linear measure of a locator. Throws when the locator is for another kind of edition. */
export function locatorToM(geometry: EditionGeometry, locator: Locator): number {
  if (geometry.kind !== locator.kind) {
    throw new LocatorError(`a ${locator.kind} locator cannot be used with a ${geometry.kind} edition`);
  }
  switch (locator.kind) {
    case 'epub': {
      const g = geometry as Extract<EditionGeometry, { kind: 'epub' }>;
      const n = g.sectionLengths.length;
      if (n === 0) return 0;
      const starts = prefixSums(g.sectionLengths);
      const section = Math.min(locator.section, n - 1);
      const len = g.sectionLengths[section]!;
      return starts[section]! + Math.min(locator.offset, len);
    }
    case 'pdf': {
      const g = geometry as Extract<EditionGeometry, { kind: 'pdf' }>;
      if (g.pageCount === 0) return 0;
      const page = Math.min(locator.page, g.pageCount - 1);
      return page + locator.y;
    }
    case 'audio': {
      const g = geometry as Extract<EditionGeometry, { kind: 'audio' }>;
      const n = g.trackDurationsMs.length;
      if (n === 0) return 0;
      const starts = prefixSums(g.trackDurationsMs);
      const track = Math.min(locator.track, n - 1);
      return starts[track]! + Math.min(locator.ms, g.trackDurationsMs[track]!);
    }
  }
}

/**
 * Index of the unit containing m: the last unit whose start is <= m. A position exactly on a
 * boundary belongs to the unit that starts there (the start of the next page or track).
 */
function unitForM(starts: readonly number[], m: number): number {
  let lo = 0;
  let hi = starts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= m) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Native locator for a linear measure (clamped to the edition). */
export function mToLocator(geometry: EditionGeometry, m: number): Locator {
  const total = totalMeasure(geometry);
  const x = Math.min(Math.max(m, 0), total);
  switch (geometry.kind) {
    case 'epub': {
      if (geometry.sectionLengths.length === 0) return { kind: 'epub', section: 0, offset: 0 };
      const starts = prefixSums(geometry.sectionLengths);
      const section = unitForM(starts, x);
      const offset = Math.round(x - starts[section]!);
      return { kind: 'epub', section, offset: Math.min(offset, geometry.sectionLengths[section]!) };
    }
    case 'pdf': {
      if (geometry.pageCount === 0) return { kind: 'pdf', page: 0, y: 0 };
      const page = Math.min(Math.floor(x), geometry.pageCount - 1);
      return { kind: 'pdf', page, y: Math.min(1, x - page) };
    }
    case 'audio': {
      if (geometry.trackDurationsMs.length === 0) return { kind: 'audio', track: 0, ms: 0 };
      const starts = prefixSums(geometry.trackDurationsMs);
      const track = unitForM(starts, x);
      return { kind: 'audio', track, ms: Math.min(x - starts[track]!, geometry.trackDurationsMs[track]!) };
    }
  }
}

/** An edition placed on the book timeline. */
export interface EditionTimeline {
  readonly geometry: EditionGeometry;
  readonly sync: SyncMap;
}

export function locatorToT(edition: EditionTimeline, locator: Locator): number {
  return mToT(edition.sync, locatorToM(edition.geometry, locator));
}

export function tToLocator(edition: EditionTimeline, t: number): Locator {
  return mToLocator(edition.geometry, tToM(edition.sync, t));
}

/** Convert a position in one edition to the matching position in another edition of the book. */
export function translateLocator(from: EditionTimeline, to: EditionTimeline, locator: Locator): Locator {
  return tToLocator(to, locatorToT(from, locator));
}
