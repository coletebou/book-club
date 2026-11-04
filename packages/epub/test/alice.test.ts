import { describe, expect, it } from 'vitest';
import { buildPublication, measureBodyText, readEpubPreview } from '../src/index';
import { aliceBytes } from './helpers';

const decoder = new TextDecoder();

describe('Gutenberg Alice (real fixture)', () => {
  const pub = buildPublication(aliceBytes());

  it('reads title, author and language from the OPF', () => {
    expect(pub.metadata.title).toBe("Alice's Adventures in Wonderland");
    expect(pub.metadata.author).toBe('Lewis Carroll');
    expect(pub.metadata.language).toBe('en');
  });

  it('finds the declared cover image', () => {
    expect(pub.cover?.mediaType).toBe('image/jpeg');
    expect(pub.cover?.bytes.byteLength).toBe(104775);
  });

  it('keeps the whole spine in order', () => {
    expect(pub.sections).toHaveLength(15);
    expect(pub.sections[0]!.path).toBe('OEBPS/wrap0000.xhtml');
    expect(pub.sections[2]!.title).toBe('CHAPTER I. Down the Rabbit-Hole');
  });

  it('resolves every table-of-contents entry to a section and an offset', () => {
    const chapters = pub.toc.filter((e) => e.title.startsWith('CHAPTER'));
    expect(chapters).toHaveLength(12);
    chapters.forEach((entry, i) => {
      expect(entry.section).toBe(i + 2);
      // Each chapter's TOC target is the chapter <div> at the very start of its section.
      expect(entry.offset).toBe(0);
    });
    const contents = pub.toc.find((e) => e.title === 'Contents');
    expect(contents?.section).toBe(1);
    expect(contents!.offset).toBeGreaterThan(500);
  });

  it('puts the story between the Gutenberg header and the licence', () => {
    const starts: number[] = [];
    let at = 0;
    for (const s of pub.sections) {
      starts.push(at);
      at += s.textLength;
    }
    const total = at;
    // The story starts inside the header section, right after the boilerplate <header>.
    expect(pub.story.start).toBeGreaterThan(starts[1]!);
    expect(pub.story.start).toBeLessThan(starts[2]!);
    // It ends where the licence section starts.
    expect(pub.story.end).toBe(starts[14]);
    expect(pub.story.end).toBeLessThan(total);
    const headerText = measureBodyText(decoder.decode(pub.files.get('OEBPS/4040227324556390537_11-h-0.htm.xhtml')));
    const offsetInHeader = pub.story.start - starts[1]!;
    expect(headerText.slice(offsetInHeader).trimStart()).toMatch(/^Alice’s Adventures in Wonderland/);
  });

  it('normalised documents re-measure to the recorded text lengths', () => {
    for (const s of pub.sections) {
      const doc = pub.files.get(s.path);
      expect(doc, s.path).toBeDefined();
      expect(measureBodyText(decoder.decode(doc)).length).toBe(s.textLength);
    }
  });

  it('serves stylesheets and the cover image, never the OPF', () => {
    expect(pub.files.has('OEBPS/pgepub.css')).toBe(true);
    expect(pub.files.has('OEBPS/7981341119032183217_cover.jpg')).toBe(true);
    expect(pub.files.has('OEBPS/content.opf')).toBe(false);
    expect(pub.files.has('META-INF/container.xml')).toBe(false);
  });

  it('chapter text starts where the reader expects it', () => {
    const ch1 = decoder.decode(pub.files.get(pub.sections[2]!.path));
    const text = measureBodyText(ch1);
    expect(text).toContain('Alice was beginning to get very tired of sitting by her sister on the bank');
  });
});

describe('readEpubPreview (upload form)', () => {
  it('returns title, author and cover without building the publication', () => {
    const preview = readEpubPreview(aliceBytes());
    expect(preview.title).toBe("Alice's Adventures in Wonderland");
    expect(preview.author).toBe('Lewis Carroll');
    expect(preview.cover?.bytes.byteLength).toBe(104775);
  });
});
