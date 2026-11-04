import { type Publication, chapterNames, frontMatterCount } from '@bookclub/shared';
import { type PageCountEntry, db } from '../../lib/db';
import { SectionFrame } from './frame';
import { type PageGeometry, type ReaderSettings, layoutSignature } from './layout';

export interface PageCounts {
  readonly signature: string;
  /** Pages of every spine section at this layout. */
  readonly sectionPages: readonly number[];
  /** Page (inside its section) of every TOC entry, by TOC index. */
  readonly tocPages: readonly number[];
  /** Section holding the first character of the story, and that character's page in it. */
  readonly storyStart: { readonly section: number; readonly page: number };
}

/** Section and in-section offset of a linear measure (the story start). */
export function sectionOf(pub: Publication, m: number): { section: number; offset: number } {
  let at = 0;
  for (const s of pub.sections) {
    if (m < at + s.textLength || s.index === pub.sections.length - 1) return { section: s.index, offset: Math.max(0, m - at) };
    at += s.textLength;
  }
  return { section: 0, offset: 0 };
}

/** Sections that count towards book-wide page numbers: those that overlap the story. */
export function storySections(pub: Publication): boolean[] {
  let at = 0;
  return pub.sections.map((s) => {
    const start = at;
    at += s.textLength;
    const end = at;
    if (pub.story.end <= pub.story.start) return true;
    return end > pub.story.start && start < pub.story.end;
  });
}

export interface BookPage {
  /** 1-based page number in the book, or null outside the story (cover, licence). */
  readonly page: number | null;
  readonly total: number;
  /** Chapter page (1-based) and pages in the chapter, from the TOC. */
  readonly chapterPage: number | null;
  readonly chapterPages: number | null;
  readonly chapterTitle: string | null;
  /**
   * Before the book's story, by its own contents (its title page, its edition's note, its contents
   * list: D81): the name of the chapter the story starts with ("Chapter 1", "Part 1, Chapter 1",
   * D86); there no chapter is counted in.
   */
  readonly beforeStory: string | null;
}

/**
 * The story's pages: how many, and the book-wide number of a section's page (null outside the
 * story: a section that is not part of it, or a Gutenberg header sharing the story's first one).
 */
function storyPages(pub: Publication, counts: PageCounts): { total: number; number: (section: number, page: number) => number | null } {
  const inStory = storySections(pub);
  // Pages before the story's first page (a Gutenberg header sharing its section) do not count.
  const skip = counts.storyStart.page;
  const before: number[] = [];
  let acc = 0;
  for (let i = 0; i < pub.sections.length; i++) {
    before.push(acc - (i > counts.storyStart.section ? skip : 0));
    if (inStory[i]) acc += counts.sectionPages[i] ?? 0;
  }
  const number = (section: number, page: number): number | null => {
    const beforeStory = section < counts.storyStart.section || (section === counts.storyStart.section && page < skip);
    return inStory[section] && !beforeStory ? before[section]! + page + 1 - (section === counts.storyStart.section ? skip : 0) : null;
  };
  return { total: acc - skip, number };
}

/** Each contents entry's book-wide page (null outside the story), in one pass over the book. */
export function tocPageNumbers(pub: Publication, counts: PageCounts): (number | null)[] {
  const { number } = storyPages(pub, counts);
  return pub.toc.map((entry, i) => number(entry.section, counts.tocPages[i] ?? 0));
}

/**
 * Book-wide page arithmetic. "Page X of Y" counts pages of story sections only; chapters start at
 * their TOC targets (a chapter may begin inside a section) and run to the next chapter. Entries
 * that start no chapter (a picture's caption, a stave's subtitle, D77) count none.
 */
export function bookPage(pub: Publication, counts: PageCounts, section: number, page: number): BookPage {
  const { total, number } = storyPages(pub, counts);
  const pageNumber = number(section, page);
  // Chapter starts as book-wide page numbers, for TOC entries inside the story.
  let starts: { page: number; title: string }[] = [];
  pub.toc.forEach((entry, i) => {
    if (entry.chapter === false) return;
    const p = number(entry.section, counts.tocPages[i] ?? 0);
    if (p === null) return;
    const title = entry.chapterTitle ?? entry.title;
    const prev = starts[starts.length - 1];
    if (prev && prev.page === p) starts[starts.length - 1] = { page: p, title };
    else if (!prev || p > prev.page) starts.push({ page: p, title });
  });
  // The front matter, by the book's own chapters (frontMatterCount on their pages): no chapter to
  // count in, whatever chapters the book's timeline was given (an audiobook's, when it came first).
  const chapters = starts.map((st) => ({ title: st.title, t: (st.page - 1) / Math.max(1, total) }));
  const front = starts.length > 1 ? frontMatterCount(chapters) : 0;
  const story = starts[front];
  const beforeStory = front > 0 && story && pageNumber !== null && pageNumber < story.page ? chapterNames(chapters)[front]! : null;
  if (front > 0) starts = starts.slice(front);
  let chapterPage: number | null = null;
  let chapterPages: number | null = null;
  let chapterTitle: string | null = null;
  if (pageNumber !== null) {
    for (let i = starts.length - 1; i >= 0; i--) {
      const s = starts[i]!;
      if (s.page <= pageNumber) {
        const next = starts[i + 1]?.page ?? total + 1;
        chapterPage = pageNumber - s.page + 1;
        chapterPages = next - s.page;
        chapterTitle = s.title;
        break;
      }
    }
  }
  return { page: pageNumber, total, chapterPage, chapterPages, chapterTitle, beforeStory };
}

/** In-memory page counts for this visit (D198): reopen without waiting on IndexedDB. */
const memoryCache = new Map<string, PageCountEntry>();

/** Tests and sign-out: drop the same-visit cache. */
export function clearPageCountMemory(): void {
  memoryCache.clear();
}

function cachedSync(key: string): PageCountEntry | undefined {
  return memoryCache.get(key);
}

async function cached(key: string): Promise<PageCountEntry | undefined> {
  const warm = memoryCache.get(key);
  if (warm) return warm;
  try {
    const hit = await (await db()).get('pagecounts', key);
    if (hit) memoryCache.set(key, hit);
    return hit;
  } catch {
    return undefined;
  }
}

async function store(entry: PageCountEntry): Promise<void> {
  memoryCache.set(entry.key, entry);
  try {
    await (await db()).put('pagecounts', entry);
  } catch {
    // no IndexedDB: memory still serves this visit
  }
}

const idle = () =>
  new Promise<void>((resolve) => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(() => resolve(), { timeout: 200 });
    else setTimeout(resolve, 16);
  });

/** How long the counter may keep the page busy before it lets the reader have a turn. */
const SLICE_MS = 40;

/**
 * Measures every section for one layout signature in a hidden frame and caches the result. A
 * section's own load already gives the page back, so it waits for an idle moment only every
 * SLICE_MS (once per section was 16 ms × 368 sections of War and Peace in WebKit). Its sections
 * come from the HTTP cache: opening a book keeps every file of it on the device at once (D19). A
 * new signature always starts from nothing: counts are never appended to an earlier layout's.
 */
export class PageCounter {
  private frame: SectionFrame | null = null;
  private generation = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly publication: Publication,
    private readonly urlOf: (section: number) => string,
  ) {}

  /**
   * Counts already known for this layout (memory, then nothing): used so reopen paints page
   * numbers immediately without a "Counting…" flash (D198).
   */
  peek(geometry: PageGeometry, settings: ReaderSettings): PageCounts | null {
    const signature = layoutSignature(geometry, settings);
    const key = `${this.publication.editionId}|${signature}`;
    const hit = cachedSync(key);
    if (hit && hit.sectionPages.length === this.publication.sections.length && hit.storyStart) {
      return { signature, sectionPages: hit.sectionPages, tocPages: hit.tocPages, storyStart: hit.storyStart };
    }
    return null;
  }

  async count(geometry: PageGeometry, settings: ReaderSettings, onProgress?: (done: number, total: number) => void): Promise<PageCounts | null> {
    const generation = ++this.generation;
    const signature = layoutSignature(geometry, settings);
    const key = `${this.publication.editionId}|${signature}`;
    const hit = await cached(key);
    if (hit && hit.sectionPages.length === this.publication.sections.length && hit.storyStart) {
      // An earlier measurement (of another layout) still running is of no use now.
      this.frame?.destroy();
      this.frame = null;
      return { signature, sectionPages: hit.sectionPages, tocPages: hit.tocPages, storyStart: hit.storyStart };
    }
    this.frame?.destroy();
    const frame = new SectionFrame(this.host, false);
    this.frame = frame;
    const done = () => {
      frame.destroy();
      if (this.frame === frame) this.frame = null;
    };
    const sectionPages: number[] = new Array<number>(this.publication.sections.length).fill(0);
    const tocPages: number[] = new Array<number>(this.publication.toc.length).fill(0);
    const sections = this.publication.sections;
    const start = sectionOf(this.publication, this.publication.story.start);
    const storyStart = { section: start.section, page: 0 };
    let sliceStart = performance.now();
    for (let i = 0; i < sections.length; i++) {
      if (performance.now() - sliceStart > SLICE_MS) {
        await idle();
        sliceStart = performance.now();
      }
      if (generation !== this.generation) return null;
      try {
        await frame.load(this.urlOf(i), 'Pagination', sections[i]!.textLength);
      } catch {
        // Superseded, or a section that will not load (offline, not saved): that makes every
        // total wrong, so show no numbers rather than wrong ones, and keep nothing.
        done();
        return null;
      }
      if (generation !== this.generation) return null;
      sectionPages[i] = await frame.layout(geometry, settings);
      this.publication.toc.forEach((entry, t) => {
        if (entry.section === i) tocPages[t] = frame.pageOfOffset(entry.offset);
      });
      if (i === start.section) storyStart.page = frame.pageOfOffset(start.offset);
      onProgress?.(i + 1, sections.length);
    }
    done();
    if (generation !== this.generation) return null;
    await store({ key, sectionPages, tocPages, storyStart, createdAt: Date.now() });
    return { signature, sectionPages, tocPages, storyStart };
  }

  cancel(): void {
    this.generation++;
    this.frame?.destroy();
    this.frame = null;
  }
}
