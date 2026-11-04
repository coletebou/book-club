import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Publication } from '@bookclub/shared';
import { buildPublication } from '@bookclub/epub';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLocalData, db } from '../../lib/db';
import { DEFAULT_SETTINGS, layoutSignature, pageGeometry } from './layout';
import { type PageCounts, PageCounter, bookPage, clearPageCountMemory, sectionOf, storySections, tocPageNumbers } from './pagecount';

/*
 * A small book shaped like a Gutenberg EPUB:
 *   section 0  cover            10 characters  (outside the story)
 *   section 1  header + title 1000 characters  (the story starts at offset 600: character 610)
 *   section 2  chapter I      2000 characters  ("A poem" starts inside it, at offset 900)
 *   section 3  chapter II     3000 characters
 *   section 4  licence         500 characters  (outside the story, which ends at character 6010)
 */
const book: Publication = {
  editionId: 'ed_epub_1',
  baseUrl: '/media/ed_epub_1/',
  title: 'A Small Book',
  author: 'Someone',
  language: 'en',
  direction: 'ltr',
  sections: [
    { index: 0, href: 'OEBPS/cover.xhtml', textLength: 10, linear: true },
    { index: 1, href: 'OEBPS/header.xhtml', textLength: 1000, linear: true },
    { index: 2, href: 'OEBPS/ch1.xhtml', textLength: 2000, linear: true },
    { index: 3, href: 'OEBPS/ch2.xhtml', textLength: 3000, linear: true },
    { index: 4, href: 'OEBPS/licence.xhtml', textLength: 500, linear: true },
  ],
  toc: [
    { title: 'Contents', href: 'OEBPS/header.xhtml#contents', section: 1, offset: 700, depth: 0 },
    { title: 'CHAPTER I', href: 'OEBPS/ch1.xhtml', section: 2, offset: 0, depth: 0 },
    { title: 'A poem', href: 'OEBPS/ch1.xhtml#poem', section: 2, offset: 900, depth: 1 },
    { title: 'CHAPTER II', href: 'OEBPS/ch2.xhtml', section: 3, offset: 0, depth: 0 },
    { title: 'Licence', href: 'OEBPS/licence.xhtml', section: 4, offset: 0, depth: 0 },
  ],
  story: { start: 610, end: 6010 },
  resources: [],
};

/*
 * Its pages at one layout: 1, 3, 5, 7 and 2 pages. The header's first page is Gutenberg's
 * boilerplate; the story begins on its second page (index 1); the contents are on its third.
 */
const counts: PageCounts = {
  signature: 'test',
  sectionPages: [1, 3, 5, 7, 2],
  tocPages: [2, 0, 3, 0, 0],
  storyStart: { section: 1, page: 1 },
};

/** Every (section, page) of a publication in reading order. */
function* allPages(pub: Publication, c: PageCounts) {
  for (const s of pub.sections) for (let p = 0; p < (c.sectionPages[s.index] ?? 0); p++) yield { section: s.index, page: p };
}

describe('sectionOf', () => {
  it('finds the section and offset of a position in the whole book', () => {
    expect(sectionOf(book, 0)).toEqual({ section: 0, offset: 0 });
    expect(sectionOf(book, 9)).toEqual({ section: 0, offset: 9 });
    expect(sectionOf(book, 610)).toEqual({ section: 1, offset: 600 });
    expect(sectionOf(book, 3009)).toEqual({ section: 2, offset: 1999 });
  });

  it('puts a position on a section boundary at the start of the next section', () => {
    expect(sectionOf(book, 10)).toEqual({ section: 1, offset: 0 });
    expect(sectionOf(book, 6010)).toEqual({ section: 4, offset: 0 });
  });

  it('skips sections without text (an image-only page)', () => {
    const pub = { ...book, sections: [{ index: 0, href: 'a', textLength: 0, linear: true }, { index: 1, href: 'b', textLength: 5, linear: true }] };
    expect(sectionOf(pub, 0)).toEqual({ section: 1, offset: 0 });
  });

  it('keeps positions past the end in the last section', () => {
    expect(sectionOf(book, 7000)).toEqual({ section: 4, offset: 990 });
  });
});

describe('storySections', () => {
  it('counts the sections that overlap the story, not the cover or the licence', () => {
    expect(storySections(book)).toEqual([false, true, true, true, false]);
  });

  it('counts every section of a book without a known story range', () => {
    expect(storySections({ ...book, story: { start: 0, end: 0 } })).toEqual([true, true, true, true, true]);
  });
});

describe('tocPageNumbers', () => {
  it('gives each contents entry the page bookPage gives it, in one pass', () => {
    expect(tocPageNumbers(book, counts)).toEqual(book.toc.map((entry, i) => bookPage(book, counts, entry.section, counts.tocPages[i] ?? 0).page));
  });

  it('stays quick for a contents list of thousands of entries', () => {
    const long = { ...book, toc: Array.from({ length: 20_000 }, (_, i) => ({ ...book.toc[i % book.toc.length]!, title: `Entry ${i}` })) };
    const many = { ...counts, tocPages: Array.from({ length: 20_000 }, (_, i) => counts.tocPages[i % counts.tocPages.length] ?? 0) };
    const started = performance.now();
    expect(tocPageNumbers(long, many)).toHaveLength(20_000);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('bookPage', () => {
  it('numbers pages from the first page of the story', () => {
    expect(bookPage(book, counts, 1, 1)).toMatchObject({ page: 1, total: 14 });
    expect(bookPage(book, counts, 1, 2)).toMatchObject({ page: 2 });
    expect(bookPage(book, counts, 2, 0)).toMatchObject({ page: 3 });
    expect(bookPage(book, counts, 3, 0)).toMatchObject({ page: 8 });
    expect(bookPage(book, counts, 3, 6)).toMatchObject({ page: 14, total: 14 });
  });

  it('gives no page number outside the story: the cover, the boilerplate before it, the licence', () => {
    expect(bookPage(book, counts, 0, 0)).toEqual({ page: null, total: 14, chapterPage: null, chapterPages: null, chapterTitle: null, beforeStory: null });
    expect(bookPage(book, counts, 1, 0).page).toBeNull();
    expect(bookPage(book, counts, 4, 1).page).toBeNull();
  });

  it('numbers every story page exactly once, in order, from 1 to the total', () => {
    const numbers = [...allPages(book, counts)].map(({ section, page }) => bookPage(book, counts, section, page).page).filter((n) => n !== null);
    expect(numbers).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });

  it('gives the chapter, the page in it and its length, chapters starting at their TOC targets', () => {
    const at = (section: number, page: number) => {
      const r = bookPage(book, counts, section, page);
      return [r.page, r.chapterTitle, r.chapterPage, r.chapterPages];
    };
    expect(at(1, 1)).toEqual([1, null, null, null]); // the title page, before the first TOC entry
    expect(at(1, 2)).toEqual([2, 'Contents', 1, 1]);
    expect(at(2, 0)).toEqual([3, 'CHAPTER I', 1, 3]);
    expect(at(2, 2)).toEqual([5, 'CHAPTER I', 3, 3]);
    // A chapter that begins inside a section.
    expect(at(2, 3)).toEqual([6, 'A poem', 1, 2]);
    expect(at(2, 4)).toEqual([7, 'A poem', 2, 2]);
    // The last chapter runs to the end of the story, not into the licence.
    expect(at(3, 0)).toEqual([8, 'CHAPTER II', 1, 7]);
    expect(at(3, 6)).toEqual([14, 'CHAPTER II', 7, 7]);
  });

  it('counts no chapter from an entry that starts none (a picture’s caption, D77), and names a chapter as the book’s chapters do', () => {
    const pub: Publication = {
      ...book,
      toc: book.toc.map((e) => (e.title === 'A poem' ? { ...e, chapter: false } : e.title === 'CHAPTER I' ? { ...e, chapterTitle: 'CHAPTER I. A Beginning' } : e)),
    };
    const at = (section: number, page: number) => {
      const r = bookPage(pub, counts, section, page);
      return [r.page, r.chapterTitle, r.chapterPage, r.chapterPages];
    };
    expect(at(2, 0)).toEqual([3, 'CHAPTER I. A Beginning', 1, 5]);
    // Past the picture, still chapter I: its count does not start again.
    expect(at(2, 3)).toEqual([6, 'CHAPTER I. A Beginning', 4, 5]);
    expect(at(2, 4)).toEqual([7, 'CHAPTER I. A Beginning', 5, 5]);
    expect(at(3, 0)).toEqual([8, 'CHAPTER II', 1, 7]);
  });

  it('names a page by the last of several TOC entries that start on it (a part and its first chapter)', () => {
    const pub = { ...book, toc: [{ title: 'PART ONE', href: 'OEBPS/ch1.xhtml', section: 2, offset: 0, depth: 0 }, ...book.toc] };
    const c = { ...counts, tocPages: [0, ...counts.tocPages] };
    expect(bookPage(pub, c, 2, 0)).toMatchObject({ chapterTitle: 'CHAPTER I', chapterPage: 1, chapterPages: 3 });
  });

  it('ignores a TOC entry that points back before the previous one', () => {
    const pub = { ...book, toc: [...book.toc.slice(0, 4), { title: 'Back to the start', href: 'OEBPS/ch1.xhtml', section: 2, offset: 0, depth: 0 }] };
    const c = { ...counts, tocPages: [2, 0, 3, 0, 0] };
    expect(bookPage(pub, c, 3, 6)).toMatchObject({ chapterTitle: 'CHAPTER II', chapterPage: 7 });
  });

  it('counts from the very first page in a book without boilerplate', () => {
    const plain = { ...book, story: { start: 0, end: 0 } };
    const c = { ...counts, storyStart: { section: 0, page: 0 } };
    expect(bookPage(plain, c, 0, 0)).toMatchObject({ page: 1, total: 18 });
    expect(bookPage(plain, c, 4, 1)).toMatchObject({ page: 18 });
  });
});

describe('bookPage on the Gutenberg Alice', () => {
  const built = buildPublication(new Uint8Array(readFileSync(path.resolve(import.meta.dirname, '../../../../../fixtures/books/alice-gutenberg-11.epub'))));
  const alice: Publication = {
    editionId: 'ed_alice',
    baseUrl: '/media/ed_alice/',
    title: built.metadata.title,
    author: built.metadata.author,
    language: built.metadata.language,
    direction: built.metadata.direction,
    sections: built.sections.map((s) => ({ index: s.index, href: s.path, textLength: s.textLength, linear: s.linear })),
    toc: built.toc.map((e) => ({ title: e.title, href: e.href, section: e.section, offset: e.offset, depth: e.depth })),
    story: built.story,
    resources: [...built.files.keys()],
  };
  // Pages of about 1500 characters, the way a phone lays this book out.
  const pageOf = (offset: number) => Math.floor(offset / 1500);
  const start = sectionOf(alice, alice.story.start);
  const aliceCounts: PageCounts = {
    signature: 'phone',
    sectionPages: alice.sections.map((s) => Math.max(1, Math.ceil(s.textLength / 1500))),
    tocPages: alice.toc.map((e) => pageOf(e.offset)),
    storyStart: { section: start.section, page: pageOf(start.offset) },
  };

  it('starts the story inside the Gutenberg header section and ends it before the licence', () => {
    expect(start.section).toBe(1);
    expect(start.offset).toBeGreaterThan(0);
    const inStory = storySections(alice);
    expect(inStory).toEqual(alice.sections.map((_, i) => i >= 1 && i <= 13));
  });

  it('numbers every page of the story once, from 1 to the total', () => {
    const numbers = [...allPages(alice, aliceCounts)].map(({ section, page }) => bookPage(alice, aliceCounts, section, page).page).filter((n) => n !== null);
    const total = bookPage(alice, aliceCounts, 2, 0).total;
    expect(numbers).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  it('starts each of the twelve chapters on its first page and runs it to the next', () => {
    const chapters = alice.toc.map((e, i) => ({ e, i })).filter(({ e }) => e.title.startsWith('CHAPTER'));
    expect(chapters).toHaveLength(12);
    let pagesInChapters = 0;
    for (const { e } of chapters) {
      const first = bookPage(alice, aliceCounts, e.section, aliceCounts.tocPages[alice.toc.indexOf(e)]!);
      expect(first.chapterTitle).toBe(e.title);
      expect(first.chapterPage).toBe(1);
      // Each chapter is one section here, so it has that section's pages.
      expect(first.chapterPages).toBe(aliceCounts.sectionPages[e.section]);
      pagesInChapters += first.chapterPages!;
    }
    const last = bookPage(alice, aliceCounts, 13, aliceCounts.sectionPages[13]! - 1);
    expect(last.page).toBe(last.total);
    expect(last.chapterTitle).toMatch(/^CHAPTER XII/);
    expect(last.chapterPage).toBe(last.chapterPages);
    // Everything from chapter I on is in some chapter.
    expect(last.total - bookPage(alice, aliceCounts, 2, 0).page! + 1).toBe(pagesInChapters);
  });

  it('counts no chapter before the story, by the book’s own contents, and names the chapter it starts with (D81)', () => {
    // The title page, the edition's note and the contents share the first section's first pages.
    const first = bookPage(alice, aliceCounts, start.section, aliceCounts.storyStart.page);
    expect(first.page).toBe(1);
    expect(first).toMatchObject({ chapterPage: null, chapterPages: null, chapterTitle: null, beforeStory: 'Chapter 1' });
    const one = bookPage(alice, aliceCounts, 2, 0);
    expect(one).toMatchObject({ chapterTitle: 'CHAPTER I. Down the Rabbit-Hole', chapterPage: 1, beforeStory: null });
  });
});

describe('PageCounter', () => {
  const geometry = pageGeometry(390, 844);
  let host: HTMLElement;

  beforeEach(async () => {
    await clearLocalData();
    clearPageCountMemory();
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  const save = async (signature: string, entry: { sectionPages: number[]; tocPages: number[]; storyStart?: { section: number; page: number } }) =>
    (await db()).put('pagecounts', { key: `${book.editionId}|${signature}`, createdAt: 1, ...entry });


  it('peeks synchronously from memory after a cache hit (D198: no Counting flash on reopen)', async () => {
    const signature = layoutSignature(geometry, DEFAULT_SETTINGS);
    await save(signature, { sectionPages: [...counts.sectionPages], tocPages: [...counts.tocPages], storyStart: counts.storyStart });
    const counter = new PageCounter(host, book, (i) => `/media/ed_epub_1/s${i}.xhtml`);
    expect(counter.peek(geometry, DEFAULT_SETTINGS)).toBeNull(); // cold memory
    const t0 = performance.now();
    await expect(counter.count(geometry, DEFAULT_SETTINGS)).resolves.toEqual({ ...counts, signature });
    const idbMs = performance.now() - t0;
    const t1 = performance.now();
    const warm = counter.peek(geometry, DEFAULT_SETTINGS);
    const peekMs = performance.now() - t1;
    expect(warm).toEqual({ ...counts, signature });
    expect(peekMs).toBeLessThan(1);
    // Documented in the PR: IDB hit is async; peek is sync and sub-millisecond.
    expect(idbMs).toBeGreaterThanOrEqual(0);
  });
  it('uses the counts cached for this edition and layout, without measuring anything', async () => {
    const signature = layoutSignature(geometry, DEFAULT_SETTINGS);
    await save(signature, { sectionPages: [...counts.sectionPages], tocPages: [...counts.tocPages], storyStart: counts.storyStart });
    const counter = new PageCounter(host, book, (i) => `/media/ed_epub_1/s${i}.xhtml`);
    await expect(counter.count(geometry, DEFAULT_SETTINGS)).resolves.toEqual({ ...counts, signature });
    expect(host.querySelector('iframe')).toBeNull();
  });

  it.each([
    ['another layout', layoutSignature(geometry, { ...DEFAULT_SETTINGS, fontScale: 120 }), { sectionPages: [1, 3, 5, 7, 2], tocPages: [2, 0, 3, 0, 0], storyStart: { section: 1, page: 1 } }],
    ['fewer sections than the book has', layoutSignature(geometry, DEFAULT_SETTINGS), { sectionPages: [1, 3, 5], tocPages: [2, 0, 3, 0, 0], storyStart: { section: 1, page: 1 } }],
    ['no story start (an older cache)', layoutSignature(geometry, DEFAULT_SETTINGS), { sectionPages: [1, 3, 5, 7, 2], tocPages: [2, 0, 3, 0, 0] }],
  ])('measures again, in a hidden frame, rather than use counts for %s', async (_what, signature, entry) => {
    await save(signature, entry);
    const counter = new PageCounter(host, book, (i) => `/media/ed_epub_1/s${i}.xhtml`);
    const counting = counter.count(geometry, DEFAULT_SETTINGS);
    await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull());
    const frame = host.querySelector('iframe')!;
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    // Sandboxed like the visible frame: WebKit loads no section from the service worker otherwise.
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-scripts');
    expect(frame.getAttribute('src')).toBe('/media/ed_epub_1/s0.xhtml');
    // jsdom loads no frames, so the measurement never finishes: cancelling it gives up cleanly.
    counter.cancel();
    await expect(counting).resolves.toBeNull();
    expect(host.querySelector('iframe')).toBeNull();
  });

  // BUG (reader/epub/pagecount.ts, PageCounter.count): a count answered from the cache bumps the
  // generation but returns before `this.frame?.destroy()`, so a measurement already under way for
  // an earlier layout keeps its hidden frame: in a browser that measurement finishes loading its
  // section, sees it was superseded and returns null without calling done(), leaving the frame
  // (a whole section document) in the reader until the next measurement or cancel(). Reached by
  // changing the font size and changing it back before the first count finishes.
  it('stops an earlier measurement, and removes its frame, when a later count comes from the cache', async () => {
    const counter = new PageCounter(host, book, (i) => `/media/ed_epub_1/s${i}.xhtml`);
    const first = counter.count(geometry, { ...DEFAULT_SETTINGS, fontScale: 120 });
    await vi.waitFor(() => expect(host.querySelector('iframe')).not.toBeNull());
    const signature = layoutSignature(geometry, DEFAULT_SETTINGS);
    await save(signature, { sectionPages: [...counts.sectionPages], tocPages: [...counts.tocPages], storyStart: counts.storyStart });
    try {
      await expect(counter.count(geometry, DEFAULT_SETTINGS)).resolves.toMatchObject({ signature });
      expect(host.querySelector('iframe')).toBeNull();
    } finally {
      counter.cancel();
      await first;
    }
  });
});
