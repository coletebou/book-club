import { type Publication, type PublicationTocEntry, readingContents } from '@bookclub/shared';

/** An entry of the reader's contents: the publication's own, under the name the club uses. */
export interface ListedEntry {
  /** Its index in the publication's contents (for its page number). */
  readonly index: number;
  readonly entry: PublicationTocEntry;
  readonly title: string;
}

const entryOf = (pub: Publication, index: number): ListedEntry => {
  const entry = pub.toc[index]!;
  return { index, entry, title: entry.chapterTitle ?? entry.title };
};

/**
 * What the reader's contents list (D77): the entries that start the book's chapters, by the names
 * the rest of the app gives them ("STAVE ONE. MARLEY’S GHOST.", "CHAPTER III." without its
 * picture's caption); not a picture's caption, a stave's subtitle or a story's part. A publication
 * read before chapters were marked lists every entry, as it did. Nothing after the story (Gutenberg's
 * licence), and of the front matter only what is reading (readingContents, D86).
 */
export function listedContents(pub: Publication): ListedEntry[] {
  return readingContents(pub).listed.map((index) => entryOf(pub, index));
}

/**
 * What the reader's contents list after the story, apart (D109): the book's own matter there, as it
 * marks it (its colophon, notes, appendices), to read or look things up in. None for Gutenberg's
 * licence, which is not the book's.
 */
export function contentsAfterStory(pub: Publication): ListedEntry[] {
  return readingContents(pub).after.map((index) => entryOf(pub, index));
}

/**
 * The entry you are in: the last listed (in reading order) whose start is at or before `at`, or
 * null before the first. By the place in the book, not by file: several chapters often share one
 * (Pride and Prejudice's 61 in a few files), and the last of a file's was taken for every one.
 */
export function currentEntry(pub: Publication, listed: readonly ListedEntry[], at: { readonly section: number; readonly offset: number }): number | null {
  const starts: number[] = [];
  let total = 0;
  for (const s of pub.sections) {
    starts.push(total);
    total += s.textLength;
  }
  const measure = (section: number, offset: number) => (starts[section] ?? total) + offset;
  const here = measure(at.section, at.offset);
  let best: number | null = null;
  let bestM = -Infinity;
  listed.forEach(({ entry }, k) => {
    const m = measure(entry.section, entry.offset);
    if (m <= here && m >= bestM) {
      best = k;
      bestM = m;
    }
  });
  return best;
}
