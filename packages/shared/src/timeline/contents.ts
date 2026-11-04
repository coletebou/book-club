import { type Publication } from '../api/schemas';
import { isBookList, numberedAs, withoutCaption } from '../text/titles';
import { type TextSpan } from '../text/words';
import { frontMatterCount } from './align';

/** An entry of an edition's contents (an EPUB's table of contents), in reading order. */
export interface ContentsEntry {
  readonly title: string;
  /** Where it starts, in the edition's measure. */
  readonly m: number;
  readonly depth: number;
  /** Its place holds nothing but its own title: a heading whose text the next entry's follows. */
  readonly alone?: boolean;
  /** It names an illustration: its heading repeats the description of the picture right above it. */
  readonly caption?: boolean;
}

/** A chapter of the book: the contents entry that starts it, and what it is called. */
export interface ContentsChapter {
  /** The entry's index in the contents. */
  readonly index: number;
  readonly title: string;
  readonly m: number;
}

/**
 * The most of the story a heading's sections may hold, folded into one chapter: more is a part of
 * the book, or the book's own title over all of it, whose sections are its chapters.
 */
export const MAX_FOLDED_SHARE = 0.4;

/** A section's number alone ("I.", "2"): no subtitle to name a chapter by. */
const BARE_NUMERAL = /^\s*(?:[ivxlcdm]+|\d+)\s*\.?\s*$/i;

/** A heading and its subtitle as one title: "STAVE ONE." and "MARLEY’S GHOST." → "STAVE ONE. MARLEY’S GHOST.". */
function joined(heading: string, subtitle: string): string {
  return `${heading}${/[.:;!?—–-]$/.test(heading) ? ' ' : ': '}${subtitle}`;
}

/**
 * Which entries of an edition's contents start the book's chapters, and what each is called (D77).
 * A book's contents list more than its chapters: the lines of its title page, the pictures of an
 * illustrated edition, a chapter's heading apart from its subtitle (Gutenberg's A Christmas Carol
 * lists "STAVE ONE.", then "MARLEY’S GHOST." a few characters on, then the picture "Marley’s Ghost"
 * halfway through the stave), the parts of a story. Taken as chapters, they were stops nobody
 * would choose, labels from the middle of a stave, page counts that started again at a picture,
 * and an audiobook's last track squeezed between a stave's heading and its subtitle.
 *
 * - A picture's caption is no chapter: its place is in the chapter around it.
 * - Under a heading that holds nothing but its title (and is not a part, a book or a volume, which
 *   number what holds chapters), the entries below it are its sections, unless they number chapters
 *   themselves, or the heading would hold more than MAX_FOLDED_SHARE of the story: a stave's
 *   subtitle and pictures, a story's parts ("I.", "II.", "III." under "I. A SCANDAL IN BOHEMIA").
 *   Its first section, a subtitle, joins its title.
 * - A chapter's number alone, followed at its own level by a subtitle, is one chapter with it.
 * - A caption printed in a chapter's heading leaves its title (withoutCaption).
 *
 * Entries without the hints (`alone`, `caption`) are taken as they are, but for that last rule.
 */
export function chaptersFromContents(entries: readonly ContentsEntry[], story: { readonly start: number; readonly end: number }): ContentsChapter[] {
  const n = entries.length;
  const numbering = entries.map((e) => numberedAs(e.title));
  const numbersChapter = (i: number) => numbering[i]?.counts === 'chapter';
  const isDivision = (i: number) => numbering[i] !== null && numbering[i]!.counts !== 'chapter';
  const subtitle = (i: number) => numbering[i] === null && !BARE_NUMERAL.test(entries[i]!.title) && !entries[i]!.caption;
  const kept = entries.map((e, i) => !(e.caption && i > 0 && !numbersChapter(i)));
  const titles = entries.map((e) => e.title);
  /** Headings that took their sections in: their subtitle, if any, is taken. */
  const folded = entries.map(() => false);
  const storyLength = Math.max(0, story.end - story.start);

  for (let p = 0; p < n; p++) {
    const heading = entries[p]!;
    if (!kept[p] || !heading.alone || isDivision(p)) continue;
    let last = p;
    while (last + 1 < n && entries[last + 1]!.depth > heading.depth) last++;
    if (last === p) continue;
    const end = last + 1 < n ? entries[last + 1]!.m : story.end;
    if (storyLength > 0 && end - heading.m > MAX_FOLDED_SHARE * storyLength) continue;
    let chapters = false;
    for (let c = p + 1; c <= last; c++) if (kept[c] && numbersChapter(c)) chapters = true;
    if (chapters) continue;
    const first = kept.findIndex((k, c) => k && c > p && c <= last);
    if (first !== -1 && subtitle(first)) titles[p] = joined(titles[p]!, titles[first]!);
    for (let c = p + 1; c <= last; c++) kept[c] = false;
    folded[p] = true;
    p = last;
  }

  // A chapter's number alone, and the subtitle right after it at its level, in the story.
  for (let i = 0; i + 1 < n; i++) {
    const j = i + 1;
    if (!kept[i] || folded[i] || !entries[i]!.alone || !numbersChapter(i) || !kept[j]) continue;
    if (entries[j]!.depth !== entries[i]!.depth || !subtitle(j) || entries[j]!.alone || entries[j]!.m >= story.end) continue;
    titles[i] = joined(titles[i]!, titles[j]!);
    kept[j] = false;
  }

  const out: ContentsChapter[] = [];
  for (let i = 0; i < n; i++) if (kept[i]) out.push({ index: i, title: withoutCaption(titles[i]!), m: entries[i]!.m });
  return out;
}

/** The least a piece of front matter holds to be reading (listed in the reader's contents, read aloud): about two pages. */
export const MIN_FRONT_CHARS = 2000;

/** What a heading over chapters numbers (numberedAs): a story may open with one that holds only its title. */
const DIVISIONS = new Set(['part', 'book', 'volume']);

/** What of a publication's contents is reading, in its own text measure (readingContents). */
export interface ReadingContents {
  /**
   * The entries a reader goes to (indices into the publication's contents), in order: those that
   * start chapters (D77), up to the story's end, and of the front matter only what is reading.
   */
  readonly listed: readonly number[];
  /** The book's own matter after the story (its colophon, notes, appendices), listed after it (D109). */
  readonly after: readonly number[];
  /**
   * The stretches of the story's text that are no reading: the scraps of its front matter (a title
   * page's lines, an edition's note) and the book's own printed contents and list of pictures, which
   * the reader's contents stand for and no recording reads (D86, D110).
   */
  readonly unread: readonly TextSpan[];
}

/**
 * What of a publication's contents is reading (D86): the entries that start the story's chapters,
 * by the book's own chapter starts; before them, its front matter, of which only what holds two
 * pages or more and is not the book's own printed contents or list of pictures is reading (a
 * preface is; a title page's lines are not); a part's, a book's or a volume's heading the story
 * opens with is the story's, though it holds only its title (Crime and Punishment's Part I).
 * Nothing after the story is (Gutenberg's licence), but for the book's own matter there, which it
 * marks as such (D109): listed apart, after the story.
 */
export function readingContents(pub: Pick<Publication, 'sections' | 'toc' | 'story' | 'backMatter'>): ReadingContents {
  const starts: number[] = [];
  let total = 0;
  for (const s of pub.sections) {
    starts.push(total);
    total += s.textLength;
  }
  const at = (e: Publication['toc'][number]) => (starts[e.section] ?? total) + e.offset;
  const { start, end } = pub.story.end > pub.story.start ? pub.story : { start: 0, end: total };
  const chapters = pub.toc.flatMap((entry, index) => (entry.chapter === false ? [] : [{ index, title: entry.chapterTitle ?? entry.title, m: at(entry) }]));
  const inStory = chapters.filter((c) => c.m < end);
  const length = Math.max(1, end - start);
  const front = inStory.length > 1 ? frontMatterCount(inStory.map(({ title, m }) => ({ title, t: Math.max(0, m - start) / length }))) : 0;
  let opens = front;
  while (opens > 0 && DIVISIONS.has(numberedAs(inStory[opens - 1]!.title)?.counts ?? '')) opens--;
  const listed: number[] = [];
  const unread: TextSpan[] = [];
  const unreadSpan = (from: number, to: number) => {
    const span = { start: Math.max(from, start), end: Math.min(to, end) };
    if (span.end > span.start) unread.push(span);
  };
  // Before the contents' first entry, a few lines (a title page's) are no reading either.
  const first = inStory[0];
  if (first && first.m - start < MIN_FRONT_CHARS) unreadSpan(start, first.m);
  inStory.forEach((c, k) => {
    const until = inStory[k + 1]?.m ?? end;
    if (k >= opens || (!isBookList(c.title) && until - c.m >= MIN_FRONT_CHARS)) listed.push(c.index);
    else unreadSpan(c.m, until);
  });
  // The book's own matter after the story, at the shallowest level it lists (its notes, not each note).
  const back = pub.backMatter;
  const afterStory = back ? pub.toc.flatMap((entry, index) => (at(entry) >= back.start && at(entry) < back.end ? [{ index, depth: entry.depth }] : [])) : [];
  const shallowest = afterStory.reduce((min, e) => Math.min(min, e.depth), Infinity);
  return { listed, after: afterStory.filter((e) => e.depth === shallowest).map((e) => e.index), unread };
}
