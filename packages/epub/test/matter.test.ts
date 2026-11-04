import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPublication, matterOf, matterTypes, normalizeSection } from '../src/index';
import { makeEpub, opf, xhtml } from './helpers';

/*
 * The story range by what a book marks as its story and as the matter around it (FR150, D109):
 * Standard Ebooks' colophon and licence after the story, its title page and imprint before it, as
 * EPUB 3 types them, as the landmarks say, and as EPUB 2's guide says. Gutenberg's books, which
 * mark nothing, keep the range D26 gives them.
 */

const DOC = 'application/xhtml+xml';

/** A document with this body, its attributes (`epub:type="backmatter"`) and its content. */
const doc = (content: string, bodyAttrs = '') =>
  `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><title>t</title></head><body${bodyAttrs ? ` ${bodyAttrs}` : ''}>\n\t\t${content}\n\t</body></html>`;

/** A chapter's words: enough of them that a chapter outweighs the matter around it, as in a book. */
const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');

interface Part {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly bodyAttrs?: string;
  readonly linear?: boolean;
}

/** A book of these documents, in this reading order, with contents listing each, and these landmarks or guide references. */
function book(parts: readonly Part[], options: { landmarks?: string; guide?: string; version?: string } = {}): Uint8Array {
  const files: Record<string, string> = {};
  for (const p of parts) files[`OEBPS/text/${p.id}.xhtml`] = doc(p.content, p.bodyAttrs);
  const toc = parts.map((p) => `<li><a href="text/${p.id}.xhtml">${p.title}</a></li>`).join('');
  files['OEBPS/toc.xhtml'] = xhtml(`<nav epub:type="toc"><ol>${toc}</ol></nav>${options.landmarks ? `<nav epub:type="landmarks"><ol>${options.landmarks}</ol></nav>` : ''}`);
  const manifest = [...parts.map((p) => ({ id: p.id, href: `text/${p.id}.xhtml`, type: DOC })), { id: 'nav', href: 'toc.xhtml', type: DOC, properties: 'nav' }];
  let pkg = opf({ manifest, spine: parts.map((p) => ({ idref: p.id, linear: p.linear ?? true })), version: options.version });
  if (options.guide) pkg = pkg.replace('</package>', `<guide>${options.guide}</guide></package>`);
  return makeEpub({ opf: pkg, files });
}

const chapter = (n: number, extra = '') => ({ id: `chapter-${n}`, title: `Chapter ${n}`, content: `<section id="chapter-${n}" epub:type="chapter"><h2 epub:type="title">Chapter ${n}</h2><p>${words(400, `w${n}x`)}</p>${extra}</section>`, bodyAttrs: 'epub:type="bodymatter z3998:fiction"' });

/** Standard Ebooks' shape: a title page and imprint before the story, a colophon and its licence after it. */
const standardEbook = () => [
  { id: 'titlepage', title: 'Titlepage', content: '<section id="titlepage" epub:type="titlepage"><h1 epub:type="title">The Book</h1><p>By Its Author.</p></section>', bodyAttrs: 'epub:type="frontmatter"' },
  { id: 'imprint', title: 'Imprint', content: `<section id="imprint" epub:type="imprint"><h2 epub:type="title">Imprint</h2><p>${words(60, 'imprint')}</p></section>`, bodyAttrs: 'epub:type="frontmatter"' },
  chapter(1),
  chapter(2),
  chapter(3),
  { id: 'colophon', title: 'Colophon', content: `<section id="colophon" epub:type="colophon"><h2 epub:type="title">Colophon</h2><p>${words(80, 'colophon')}</p></section>`, bodyAttrs: 'epub:type="backmatter"' },
  { id: 'uncopyright', title: 'Uncopyright', content: `<section id="uncopyright" epub:type="copyright-page"><h2 epub:type="title">Uncopyright</h2><p>${words(120, 'licence')}</p></section>`, bodyAttrs: 'epub:type="backmatter"' },
];

/** Where each document starts in the book's measure, and the whole. */
function measure(pub: ReturnType<typeof buildPublication>) {
  const starts: number[] = [];
  let total = 0;
  for (const s of pub.sections) {
    starts.push(total);
    total += s.textLength;
  }
  const of = (id: string) => pub.sections.findIndex((s) => s.path.endsWith(`/${id}.xhtml`));
  return { starts, total, start: (id: string) => starts[of(id)]!, end: (id: string) => starts[of(id)]! + pub.sections[of(id)]!.textLength };
}

describe('the story is what a book does not mark as matter around it (FR150)', () => {
  it('ends before Standard Ebooks’ colophon and licence, and starts after its title page and imprint', () => {
    const pub = buildPublication(book(standardEbook()));
    const m = measure(pub);
    expect(pub.story).toEqual({ start: m.start('chapter-1'), end: m.end('chapter-3') });
    // What follows the story is the book's own, readable, after it.
    expect(pub.backMatter).toEqual({ start: m.end('chapter-3'), end: m.total });
    expect(pub.sections.map((s) => s.path.split('/').pop())).toContain('uncopyright.xhtml');
    expect(pub.files.has('OEBPS/text/colophon.xhtml')).toBe(true);
    // Its contents still list every document, each where it is.
    const listed = pub.toc.map((e) => [e.title, m.starts[e.section]! + e.offset]);
    expect(listed.filter(([, at]) => (at as number) >= pub.story.start && (at as number) < pub.story.end).map(([t]) => t)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    expect(listed.map(([t]) => t)).toEqual(['Titlepage', 'Imprint', 'Chapter 1', 'Chapter 2', 'Chapter 3', 'Colophon', 'Uncopyright']);
  });

  it('reads the same marks from DPUB-ARIA roles', () => {
    const parts = standardEbook().map((p) => ({ ...p, bodyAttrs: '', content: p.content.replace(/epub:type="(colophon|copyright-page)"/, (_, t: string) => `role="doc-${t === 'colophon' ? 'colophon' : 'credits'}"`) }));
    const pub = buildPublication(book(parts));
    const m = measure(pub);
    expect(pub.story).toEqual({ start: m.start('chapter-1'), end: m.end('chapter-3') });
  });

  it('reads them from the landmarks where the documents say nothing: the back matter runs on from where it starts', () => {
    const plain = (id: string, title: string, n: number) => ({ id, title, content: `<h2>${title}</h2><p>${words(n, id)}</p>` });
    const parts = [plain('title', 'The Book', 10), plain('one', 'One', 400), plain('two', 'Two', 400), plain('thanks', 'Acknowledgments', 60), plain('about', 'About the Author', 60), plain('next', 'A Preview of the Next Book', 100)];
    const landmarks =
      '<li><a epub:type="titlepage" href="text/title.xhtml">Title Page</a></li><li><a epub:type="bodymatter" href="text/one.xhtml">Start</a></li><li><a epub:type="backmatter" href="text/thanks.xhtml">Back matter</a></li>';
    const pub = buildPublication(book(parts, { landmarks }));
    const m = measure(pub);
    expect(pub.story).toEqual({ start: m.start('one'), end: m.end('two') });
    expect(pub.backMatter).toEqual({ start: m.end('two'), end: m.total });
  });

  it('reads them from EPUB 2’s guide: its title page, where its text starts, its notes and colophon', () => {
    const plain = (id: string, title: string, n: number) => ({ id, title, content: `<h2>${title}</h2><p>${words(n, id)}</p>` });
    const parts = [plain('title', 'Title', 10), plain('copyright', 'Copyright', 40), plain('one', 'One', 1500), plain('two', 'Two', 1500), plain('notes', 'Notes', 120), plain('colophon', 'Colophon', 30)];
    const guide =
      '<reference type="title-page" href="text/title.xhtml" title="Title"/><reference type="copyright-page" href="text/copyright.xhtml"/><reference type="text" href="text/one.xhtml"/><reference type="notes" href="text/notes.xhtml"/><reference type="colophon" href="text/colophon.xhtml"/>';
    const pub = buildPublication(book(parts, { guide, version: '2.0' }));
    const m = measure(pub);
    expect(pub.story).toEqual({ start: m.start('one'), end: m.end('two') });
  });

  it('leaves endnotes after the story, still readable from the story’s links to them', () => {
    const parts = [
      chapter(1, '<p>A word.<a href="endnotes.xhtml#note-1" id="noteref-1" epub:type="noteref">1</a></p>'),
      chapter(2),
      { id: 'endnotes', title: 'Endnotes', content: `<section id="endnotes" epub:type="endnotes"><h2 epub:type="title">Endnotes</h2><ol><li id="note-1" epub:type="endnote"><p>${words(100, 'note')} <a href="chapter-1.xhtml#noteref-1" epub:type="backlink">↩</a></p></li></ol></section>`, bodyAttrs: 'epub:type="backmatter"' },
    ];
    const pub = buildPublication(book(parts));
    const m = measure(pub);
    expect(pub.story.end).toBe(m.end('chapter-2'));
    expect(pub.backMatter).toEqual({ start: m.end('chapter-2'), end: m.total });
    // The note is where the story's link goes.
    const notes = pub.sections.find((s) => s.path.endsWith('endnotes.xhtml'))!;
    expect(notes.idOffsets.get('note-1')).toBeGreaterThan(0);
    expect(new TextDecoder().decode(pub.files.get(pub.sections[0]!.path))).toContain('href="endnotes.xhtml#note-1"');
  });

  it('leaves an appendix after the story, but keeps one between chapters, and an epilogue the back matter holds', () => {
    const appendix = (id: string) => ({ id, title: 'Appendix', content: `<section id="${id}" epub:type="appendix"><h2>Appendix</h2><p>${words(150, id)}</p></section>`, bodyAttrs: 'epub:type="backmatter"' });
    const trailing = buildPublication(book([chapter(1), chapter(2), appendix('appendix-a'), appendix('appendix-b')]));
    expect(trailing.story.end).toBe(measure(trailing).end('chapter-2'));
    const between = buildPublication(book([chapter(1), appendix('appendix-a'), chapter(2)]));
    expect(between.story).toEqual({ start: 0, end: measure(between).total });
    const epilogue = { id: 'epilogue', title: 'Epilogue', content: `<section id="epilogue" epub:type="epilogue"><h2>Epilogue</h2><p>${words(200, 'epilogue')}</p></section>`, bodyAttrs: 'epub:type="backmatter"' };
    const ending = buildPublication(book([chapter(1), chapter(2), epilogue, appendix('appendix-a')]));
    expect(ending.story.end).toBe(measure(ending).end('epilogue'));
  });

  it('keeps front matter that is reading: a dedication, a preface', () => {
    const parts = [
      standardEbook()[0]!,
      { id: 'dedication', title: 'Dedication', content: '<section id="dedication" epub:type="dedication"><p>For my friends.</p></section>', bodyAttrs: 'epub:type="frontmatter"' },
      { id: 'preface', title: 'Preface', content: `<section id="preface" epub:type="preface"><h2>Preface</h2><p>${words(200, 'preface')}</p></section>`, bodyAttrs: 'epub:type="frontmatter"' },
      chapter(1),
      chapter(2),
    ];
    const pub = buildPublication(book(parts));
    expect(pub.story.start).toBe(measure(pub).start('dedication'));
  });

  it('cuts only the runs at the ends: unmarked text between matter and matter stays the story’s', () => {
    const colophon = standardEbook()[5]!;
    const loose = { id: 'loose', title: 'The Last Word', content: `<p>${words(60, 'loose')}</p>` };
    const pub = buildPublication(book([chapter(1), chapter(2), colophon, loose, standardEbook()[6]!]));
    expect(pub.story.end).toBe(measure(pub).end('loose'));
  });

  it('reads the parts of a book made of one document', () => {
    const one = {
      id: 'book',
      title: 'The Book',
      content:
        '<section epub:type="titlepage"><h1>The Book</h1></section>' +
        `<section id="c1" epub:type="chapter"><h2>One</h2><p>${words(300, 'a')}</p></section>` +
        `<section id="c2" epub:type="chapter"><h2>Two</h2><p>${words(300, 'b')}</p></section>` +
        `<section id="colophon" epub:type="colophon"><p>${words(50, 'c')}</p></section>`,
    };
    const pub = buildPublication(book([one]));
    const section = pub.sections[0]!;
    expect(pub.story).toEqual({ start: section.idOffsets.get('c1'), end: section.idOffsets.get('colophon') });
  });

  it('ignores marks that would leave less than half of the story (a landmark gone wrong)', () => {
    const plain = (id: string, n: number) => ({ id, title: id, content: `<p>${words(n, id)}</p>` });
    const landmarks = '<li><a epub:type="backmatter" href="text/two.xhtml">Back matter</a></li>';
    const pub = buildPublication(book([plain('one', 200), plain('two', 300), plain('three', 300)], { landmarks }));
    expect(pub.story).toEqual({ start: 0, end: measure(pub).total });
    expect(pub.backMatter).toBeNull();
  });

  it('takes no mark of the guide or the landmarks for more of a document than it says', () => {
    const plain = (id: string, n: number) => ({ id, title: id, content: `<p>${words(n, id)}</p><h2 id="later">Later</h2><p>${words(n, `${id}later`)}</p>` });
    const guided = (guide: string, parts = [plain('one', 200), plain('two', 200), plain('three', 200)]) => buildPublication(book(parts, { guide, version: '2.0' }));
    // A mark into a document says nothing of the document around it.
    const into = guided('<reference type="colophon" href="text/three.xhtml#later"/>');
    expect(into.story.end).toBe(measure(into).total);
    // A cover is a picture at the top of what follows: a cover named on a document with words is not all of it.
    expect(guided('<reference type="cover" href="text/one.xhtml"/>').story.start).toBe(0);
    // A title page, a copyright page or a colophon is short: one named on a long document is not.
    expect(guided('<reference type="title-page" href="text/one.xhtml"/>').story.start).toBe(0);
    const short = guided('<reference type="title-page" href="text/title.xhtml"/>', [{ id: 'title', title: 'Title', content: '<h1>The Book</h1>' }, plain('one', 200), plain('two', 200)]);
    expect(short.story.start).toBe(measure(short).start('one'));
    // Notes may be long: the last document named as notes is after the story.
    const notes = guided('<reference type="notes" href="text/three.xhtml"/>');
    expect(notes.story.end).toBe(measure(notes).end('two'));
  });

  it('takes no mark for a document whose contents list more of it than its heading', () => {
    const files: Record<string, string> = {
      'OEBPS/one.xhtml': doc(`<p>${words(300, 'one')}</p>`),
      'OEBPS/two.xhtml': doc(`<h2 id="a">Notes</h2><p>${words(100, 'two')}</p><h2 id="b">More of the story</h2><p>${words(300, 'more')}</p>`),
      'OEBPS/toc.xhtml': xhtml('<nav epub:type="toc"><ol><li><a href="one.xhtml">One</a></li><li><a href="two.xhtml#a">Notes</a></li><li><a href="two.xhtml#b">More</a></li></ol></nav>'),
    };
    const manifest = [
      { id: 'one', href: 'one.xhtml', type: DOC },
      { id: 'two', href: 'two.xhtml', type: DOC },
      { id: 'nav', href: 'toc.xhtml', type: DOC, properties: 'nav' },
    ];
    const pkg = opf({ manifest, spine: [{ idref: 'one' }, { idref: 'two' }] }).replace('</package>', '<guide><reference type="notes" href="two.xhtml"/></guide></package>');
    const pub = buildPublication(makeEpub({ opf: pkg, files }));
    expect(pub.story.end).toBe(measure(pub).total);
  });

  it('leaves a document outside the reading order (linear="no") out where it ends the book', () => {
    const notes = { id: 'notes', title: 'Notes', content: `<p>${words(100, 'n')}</p>`, linear: false };
    const pub = buildPublication(book([chapter(1), chapter(2), notes]));
    expect(pub.story.end).toBe(measure(pub).end('chapter-2'));
  });

  it('keeps the range Gutenberg’s books had: they mark nothing but their header and licence (D26)', () => {
    const fixture = (name: string) => buildPublication(new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../fixtures/books/${name}`, import.meta.url)))));
    // As before this change (the corpus of 30 Gutenberg books was checked the same way).
    expect(fixture('alice-gutenberg-11.epub').story).toEqual({ start: 906, end: 146070 });
    expect(fixture('carol-gutenberg-46.epub').story).toEqual({ start: 1021, end: 187763 });
    expect(fixture('crime-gutenberg-2554.epub').story).toEqual({ start: 918, end: 1279820 });
    expect(fixture('alice-gutenberg-11.epub').backMatter).toBeNull();
  });
});

describe('what a part of a book says it is', () => {
  const el = (attrs: string) => {
    const section = normalizeSection(doc(`<section ${attrs}><p>Words.</p></section>`), { sectionPath: 'a.xhtml', exists: () => false });
    return section.matter;
  };

  it('reads epub:type and roles, with their vocabularies’ prefixes, and nothing it does not know', () => {
    expect(el('epub:type="z3998:fiction chapter"')[0]!.types).toEqual(['chapter']);
    expect(el('role="doc-colophon"')[0]!.types).toEqual(['colophon']);
    expect(el('epub:type="se:name.publication.book"')).toEqual([]);
    expect(el('class="colophon"')).toEqual([]);
    const body = normalizeSection(doc('<p>x</p>', 'epub:type="backmatter"'), { sectionPath: 'a.xhtml', exists: () => false }).matter;
    expect(body).toEqual([{ start: 0, end: body[0]!.end, depth: 0, types: ['backmatter'] }]);
  });

  it('decides by the innermost part that says what it is, the story first, then by the partition', () => {
    expect(matterOf([['epilogue'], ['backmatter']])).toBe('story');
    expect(matterOf([['endnotes'], ['chapter']])).toBe('back');
    expect(matterOf([[], ['backmatter']])).toBe('back');
    expect(matterOf([['chapter', 'endnotes']])).toBe('story');
    expect(matterOf([['dedication'], ['frontmatter']])).toBe('neutral');
    expect(matterOf([['copyright-page'], ['backmatter']])).toBe('around');
    expect(matterOf([[], [], ['bodymatter']])).toBe('story');
    expect(matterOf([[], []])).toBeNull();
    expect(matterTypes({ attribs: { 'epub:type': 'acknowledgements Other.Afterword' } } as never)).toEqual(['acknowledgments', 'afterword']);
  });
});
