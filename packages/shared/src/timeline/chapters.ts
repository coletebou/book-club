import { formatPercent } from '../format';
import { calmCaps, isBookList, numberedAs, shortChapterName, tidyLabel } from '../text/titles';
import { frontMatterCount } from './align';

export interface ChapterLike {
  readonly title: string;
  readonly t: number;
}

/**
 * Index of the chapter containing timeline position t (the latest start at or before it), or -1
 * before the first chapter. Chapters keep the book's contents order, which is not always the
 * reading order, so every chapter is looked at.
 */
export function chapterIndexAt(chapters: readonly ChapterLike[], t: number): number {
  let found = -1;
  let best = -Infinity;
  for (let i = 0; i < chapters.length; i++) {
    const start = chapters[i]!.t;
    if (start <= t + 1e-12 && start >= best) {
      best = start;
      found = i;
    }
  }
  return found;
}

/** frontMatterCount of each list of chapters, worked out once: labels ask for it on every place. */
const frontMatter = new WeakMap<readonly ChapterLike[], number>();

/**
 * How many of a book's first chapters are its front matter rather than story (frontMatterCount,
 * D74): a title page's lines, an edition's note, the contents, a list of its pictures.
 */
export function frontMatterOf(chapters: readonly ChapterLike[]): number {
  let front = frontMatter.get(chapters);
  if (front === undefined) {
    front = chapters.length > 1 ? frontMatterCount(chapters) : 0;
    frontMatter.set(chapters, front);
  }
  return front;
}

/**
 * Whether a place lies before the story's first chapter: in the front matter (a title page, an
 * edition's note, the contents, a preface) or before the contents' first entry (D77).
 */
export function beforeStory(chapters: readonly ChapterLike[], t: number): boolean {
  if (chapters.length === 0) return false;
  const i = chapterIndexAt(chapters, t);
  return i < 0 || i < frontMatterOf(chapters);
}

/** What a place before the story is called: "Before Chapter 1", "Before Stave 1". */
export function beforeStoryName(chapters: readonly ChapterLike[]): string {
  return `Before ${chapterNames(chapters)[frontMatterOf(chapters)] ?? shortChapterName('')}`;
}

/** A chapter's short name, or before the story, the story's first chapter's ("Before Stave 1", D77). */
function nameAt(chapters: readonly ChapterLike[], i: number): string {
  const front = frontMatterOf(chapters);
  const names = chapterNames(chapters);
  return i < front ? `Before ${names[front]!}` : names[i]!;
}

/** The words a division's number is said with: "Part 2", "Book 1", "Volume 3". */
const DIVISION_WORDS: Readonly<Record<string, string>> = { part: 'Part', book: 'Book', volume: 'Volume' };

/** chapterNames of each list of chapters, worked out once. */
const namesOf = new WeakMap<readonly ChapterLike[], readonly string[]>();

/** A division's name as it qualifies its chapters: its number ("Part 2"), else its title, without its subtitle and not shouting ("First Epilogue"). */
function divisionName(title: string, numbering: ReturnType<typeof numberedAs>): string {
  if (numbering && DIVISION_WORDS[numbering.counts]) return `${DIVISION_WORDS[numbering.counts]} ${numbering.n}`;
  const calm = calmCaps(tidyLabel(title).split(/\s*[:—–]\s*|\s+-\s+/)[0]!.trim());
  return calm.length <= 24 ? calm : `${calm.slice(0, 23).trimEnd()}…`;
}

/**
 * Each chapter's short name, as places and stops say it (D86): "Chapter 3", "Stave 1". Where a book
 * numbers its chapters afresh in each of its parts, books or volumes (Crime and Punishment's six
 * parts, War and Peace's fifteen books, the Divine Comedy's three canticles), a numbered chapter
 * is named with the division it is in, the nearest heading before it that numbers a part, a book or
 * a volume, or after the front matter numbers nothing: "Part 2, Chapter 1", "Book 1, Chapter 1",
 * "First Epilogue, Chapter 3", "Purgatory, Canto 1". "The end of Chapter 1" six times over named
 * no stop. A book numbered straight through keeps "Chapter 24".
 */
export function chapterNames(chapters: readonly ChapterLike[]): readonly string[] {
  let names = namesOf.get(chapters);
  if (names) return names;
  const numbering = chapters.map((c) => numberedAs(c.title));
  const shorts = chapters.map((c) => shortChapterName(c.title));
  // Afresh when a numbered chapter's name comes again: Frankenstein's letters 1 to 4 and chapters 1
  // to 24 are numbered apart, but no name repeats.
  const used = new Set<string>();
  let afresh = false;
  numbering.forEach((x, i) => {
    if (x?.counts !== 'chapter') return;
    if (used.has(shorts[i]!)) afresh = true;
    used.add(shorts[i]!);
  });
  const front = afresh ? frontMatterOf(chapters) : 0;
  let division: string | null = null;
  names = chapters.map((c, i) => {
    const x = numbering[i];
    const short = shorts[i]!;
    if (!afresh) return short;
    if (x?.counts === 'chapter') return division ? `${division}, ${short}` : short;
    // A heading over chapters: a part, a book or a volume numbered, or after the front matter one
    // that numbers nothing (an epilogue's, a canticle's), but never the book's own contents.
    const next = numbering[i + 1];
    if ((x && DIVISION_WORDS[x.counts]) || (x === null && i >= front - 1 && next?.counts === 'chapter' && !isBookList(c.title))) division = divisionName(c.title, x);
    return short;
  });
  namesOf.set(chapters, names);
  return names;
}

/**
 * The division a place's chapter is named with (chapterNames: "Part 2"), for a heading that shows
 * the chapter's own title; null in a book numbered straight through.
 */
export function divisionAt(chapters: readonly ChapterLike[], t: number): string | null {
  const i = chapterIndexAt(chapters, t);
  if (i < 0) return null;
  const name = chapterNames(chapters)[i]!;
  const own = shortChapterName(chapters[i]!.title);
  return name !== own && name.endsWith(`, ${own}`) ? name.slice(0, -own.length - 2) : null;
}

/**
 * A short, format-independent position label: "Chapter 3 · 24%", or in the front matter, "Before
 * Chapter 1 · 0%": a title page, an edition's note or the contents name no place in the story
 * (Gutenberg's A Christmas Carol opens with a note of 200 characters about its other editions).
 */
export function chapterLabel(chapters: readonly ChapterLike[], t: number): string {
  const i = chapterIndexAt(chapters, t);
  const percent = formatPercent(t);
  if (i >= 0) return `${nameAt(chapters, i)} · ${percent}`;
  // Before the first entry of the contents (a book's very start, a character before its title page).
  return chapters.length > 0 ? `${beforeStoryName(chapters)} · ${percent}` : percent;
}

/**
 * The label of a place heard in an audiobook: as chapterLabel, except in the moments before a
 * chapter's words at the start of its own track (the recording's announcement, "Chapter four"),
 * which belong to that chapter (`trackChapter`, the chapter the track's unit is lined up with), not
 * to the end of the one before it on the timeline.
 */
export function listeningLabel(chapters: readonly ChapterLike[], t: number, trackChapter: number | null): string {
  const i = chapterIndexAt(chapters, t);
  const own = trackChapter !== null && trackChapter > i && trackChapter < chapters.length;
  return own ? `${chapterNames(chapters)[trackChapter]!} · ${formatPercent(t)}` : chapterLabel(chapters, t);
}

/** Name of the chapter at t ("Chapter 3", "Before Chapter 1"), or null before the first chapter. */
export function chapterNameAt(chapters: readonly ChapterLike[], t: number): string | null {
  const i = chapterIndexAt(chapters, t);
  return i >= 0 ? nameAt(chapters, i) : null;
}
