import { type ChapterLike, type MeetingStop, calmCaps, meetingStops, tidyLabel } from '@bookclub/shared';

/*
 * The next stop's choices name each chapter's title beside its number ("The end of Chapter 7 · A
 * Mad Tea-Party", D92). The stops themselves, and the label a stop is saved and shown with, are
 * meetingStops' own: only the chooser's lines gain the title.
 */

const EPS = 1e-6;

/** A number as a book writes a chapter's: digits, a Roman numeral, or words ("TWENTY-ONE"). */
const NUMBER = String.raw`(?:\d+|[ivxlcdm]+\b|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?\b)`;
/**
 * A heading that numbers its chapter before anything else it says: "CHAPTER VII.", "Stave One:",
 * and in a book in parts, "Part 2, Chapter 1".
 */
const NUMBERED = new RegExp(
  String.raw`^(?:(?:part|book|volume|vol)\.?\s*${NUMBER}\s*[.,:;\-–—]?\s*)?(?:chapters?|chapt|chap|ch|staves?|cantos?)\.?\s*[-–:#]?\s*${NUMBER}`,
  'i',
);

/**
 * What a chapter's heading says beyond its number, if anything: "CHAPTER VII. A Mad Tea-Party" →
 * "A Mad Tea-Party", "STAVE ONE. MARLEY’S GHOST." → "Marley’s Ghost". Null for a heading that is
 * its number ("CHAPTER I.", "II") or a title with no number ("Preface"), whose name says it all.
 */
export function chapterSubtitle(title: string): string | null {
  const tidy = tidyLabel(title);
  const head = NUMBERED.exec(tidy);
  if (!head) return null;
  const rest = tidy
    .slice(head[0].length)
    .replace(/^[\s.,:;\-–—)\]]+/, '')
    .replace(/[\s.,:;\-–—]+$/, '');
  return /\p{L}/u.test(rest) ? calmCaps(rest) : null;
}

/**
 * The chapter a stop is the end of: the one that starts last before it. Where a part's heading and
 * its first chapter start at one place (War and Peace's "BOOK ONE: 1805", then "CHAPTER I"), the
 * chapter, which the contents list after it. None at the end of the book, which is no chapter's.
 */
function chapterEndingAt<C extends ChapterLike>(chapters: readonly C[], t: number): C | undefined {
  if (t >= 1 - EPS) return undefined;
  let found: C | undefined;
  for (const c of chapters) if (c.t < t - EPS && (!found || c.t >= found.t - EPS)) found = c;
  return found;
}

/** A stop as the chooser lists it: its label, and beside it the title of the chapter it ends, if it has one. */
export interface StopChoice extends MeetingStop {
  readonly text: string;
}

/** The stops a club can choose (meetingStops), each as the chooser lists it. */
export function stopChoices(chapters: readonly ChapterLike[]): StopChoice[] {
  return meetingStops(chapters).map((stop) => {
    const label = stop.label.charAt(0).toUpperCase() + stop.label.slice(1);
    const chapter = chapterEndingAt(chapters, stop.t);
    const title = chapter ? chapterSubtitle(chapter.title) : null;
    return { ...stop, text: title ? `${label} · ${title}` : label };
  });
}
