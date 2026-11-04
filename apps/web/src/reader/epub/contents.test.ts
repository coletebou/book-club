import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildPublication } from '@bookclub/epub';
import type { Publication } from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import { contentsAfterStory, currentEntry, listedContents } from './contents';

/** Three chapters in one file and two in the next, with a picture's caption and a subtitle that start none (D77). */
const pub: Publication = {
  editionId: 'ed_1',
  baseUrl: '/media/ed_1/',
  title: 'A Book',
  author: 'Someone',
  language: 'en',
  direction: 'ltr',
  sections: [
    { index: 0, href: 'OEBPS/a.xhtml', textLength: 30_000, linear: true },
    { index: 1, href: 'OEBPS/b.xhtml', textLength: 20_000, linear: true },
  ],
  toc: [
    { title: 'Chapter I.', href: 'OEBPS/a.xhtml#c1', section: 0, offset: 0, depth: 0 },
    { title: 'He rode a black horse. CHAPTER II.', href: 'OEBPS/a.xhtml#c2', section: 0, offset: 10_000, depth: 0, chapterTitle: 'CHAPTER II.' },
    { title: 'A picture', href: 'OEBPS/a.xhtml#p', section: 0, offset: 15_000, depth: 1, chapter: false },
    { title: 'CHAPTER III.', href: 'OEBPS/a.xhtml#c3', section: 0, offset: 20_000, depth: 0 },
    { title: 'STAVE FOUR.', href: 'OEBPS/b.xhtml#c4', section: 1, offset: 0, depth: 0, chapterTitle: 'STAVE FOUR. THE LAST OF THE SPIRITS.' },
    { title: 'THE LAST OF THE SPIRITS.', href: 'OEBPS/b.xhtml#s4', section: 1, offset: 12, depth: 1, chapter: false },
  ],
  story: { start: 0, end: 50_000 },
  resources: [],
};

/** A publication as the server keeps it, from an EPUB of the fixtures. */
function fixture(name: string): Publication {
  const built = buildPublication(new Uint8Array(readFileSync(path.resolve(import.meta.dirname, `../../../../../fixtures/books/${name}`))));
  return {
    editionId: 'ed_1',
    baseUrl: '/media/ed_1/',
    title: built.metadata.title,
    author: built.metadata.author,
    language: built.metadata.language,
    direction: built.metadata.direction,
    sections: built.sections.map((s) => ({ index: s.index, href: s.path, textLength: s.textLength, linear: s.linear })),
    toc: built.toc.map((e) => ({ title: e.title, href: e.href, section: e.section, offset: e.offset, depth: e.depth })),
    story: built.story,
    ...(built.backMatter ? { backMatter: built.backMatter } : {}),
    resources: [],
  };
}

describe('the reader’s contents (D77)', () => {
  it('lists neither the licence after the story nor the scraps and lists of the front matter (D81)', () => {
    const alice = listedContents(fixture('alice-gutenberg-11.epub')).map((e) => e.title);
    expect(alice[0]).toBe('CHAPTER I. Down the Rabbit-Hole');
    expect(alice).toHaveLength(12);
    expect(alice.some((t) => /LICENSE/.test(t))).toBe(false);
  });

  it('lists the heading of the part a story opens with, though it holds only its title (D86)', () => {
    // Crime and Punishment (Gutenberg #2554): its title pages go, its preface and Part I stay.
    const crime = listedContents(fixture('crime-gutenberg-2554.epub')).map((e) => e.title);
    expect(crime.slice(0, 3)).toEqual(['TRANSLATOR’S PREFACE', 'PART I', 'CHAPTER I']);
    expect(crime.filter((t) => /^PART [IV]+$/.test(t))).toEqual(['PART I', 'PART II', 'PART III', 'PART IV', 'PART V', 'PART VI']);
  });

  it('lists the chapters by the names the club uses, and nothing that starts none', () => {
    expect(listedContents(pub).map((e) => [e.index, e.title])).toEqual([
      [0, 'Chapter I.'],
      [1, 'CHAPTER II.'],
      [3, 'CHAPTER III.'],
      [4, 'STAVE FOUR. THE LAST OF THE SPIRITS.'],
    ]);
    // A publication read before chapters were marked lists every entry, as it did.
    const old = { ...pub, toc: pub.toc.map(({ chapter: _c, chapterTitle: _t, ...e }) => e) };
    expect(listedContents(old)).toHaveLength(6);
  });

  it('lists the book’s own matter after the story apart, never Gutenberg’s licence (D109)', () => {
    // Standard Ebooks' colophon and licence, after the story's chapters.
    const se: Publication = {
      ...pub,
      sections: [...pub.sections, { index: 2, href: 'OEBPS/colophon.xhtml', textLength: 900, linear: true }, { index: 3, href: 'OEBPS/uncopyright.xhtml', textLength: 1400, linear: true }],
      toc: [...pub.toc, { title: 'Colophon', href: 'OEBPS/colophon.xhtml', section: 2, offset: 0, depth: 0 }, { title: 'Uncopyright', href: 'OEBPS/uncopyright.xhtml', section: 3, offset: 0, depth: 0 }],
      backMatter: { start: 50_000, end: 52_300 },
    };
    expect(listedContents(se).map((e) => e.title)).toEqual(['Chapter I.', 'CHAPTER II.', 'CHAPTER III.', 'STAVE FOUR. THE LAST OF THE SPIRITS.']);
    expect(contentsAfterStory(se).map((e) => [e.index, e.title])).toEqual([
      [6, 'Colophon'],
      [7, 'Uncopyright'],
    ]);
    // In the colophon, it is the entry you are in.
    const all = [...listedContents(se), ...contentsAfterStory(se)];
    expect(all[currentEntry(se, all, { section: 2, offset: 100 })!]!.title).toBe('Colophon');
    expect(contentsAfterStory(fixture('alice-gutenberg-11.epub'))).toEqual([]);
  });

  it('marks the chapter you are in by your place, not by the file it shares with others', () => {
    const listed = listedContents(pub);
    const at = (section: number, offset: number) => listed[currentEntry(pub, listed, { section, offset }) ?? -1]?.title ?? null;
    expect(at(0, 0)).toBe('Chapter I.');
    expect(at(0, 9_999)).toBe('Chapter I.');
    expect(at(0, 10_000)).toBe('CHAPTER II.');
    // Past the picture, still chapter II.
    expect(at(0, 16_000)).toBe('CHAPTER II.');
    expect(at(0, 29_999)).toBe('CHAPTER III.');
    expect(at(1, 5_000)).toBe('STAVE FOUR. THE LAST OF THE SPIRITS.');
    // Before the first chapter: none.
    const late = { ...pub, toc: pub.toc.map((e, i) => (i === 0 ? { ...e, offset: 500 } : e)) };
    expect(currentEntry(late, listedContents(late), { section: 0, offset: 100 })).toBeNull();
  });
});
