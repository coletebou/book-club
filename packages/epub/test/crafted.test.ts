import { MAX_EDITION_UNITS } from '@bookclub/shared';
import { strToU8 } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  EpubError,
  MAX_TOC_ENTRIES,
  buildPublication,
  cleanXmlText,
  imageSize,
  keepShallowest,
  measureBodyText,
  normalizeSection,
  parseNavDocument,
  parseNcx,
  sanitizeCss,
} from '../src/index';
import { BOOK_NODES, XML_LIMITS, parseXml } from '../src/xml';
import { LONG, bookOfMissingFiles, bookOfOnePage, bookOfPages, bookWithContents, bookWithLongContents, nested, nestedEncryption, nestedNcx } from './crafted-epub';
import { aliceBytes, makeEpub, opf, xhtml } from './helpers';

const DOCUMENT = 'application/xhtml+xml';
const decoder = new TextDecoder();
const ctx = { sectionPath: 'OEBPS/a.xhtml', exists: () => false };

/**
 * The time limits below are for an idle machine, the one they were set on, where sanitising half a
 * megabyte of plain paragraphs (the pace below) takes about IDLE_PACE_MS, and where the code these
 * tests replaced took several times each limit (docs/REVIEW.md SA61, SA64). All of it is timed in
 * this thread's own CPU time, the work it did: a machine busy with other work also makes a thread
 * wait, which is no work, and on the clock a wait that comes while a book is read but not while the
 * pace is counts against the book alone. Measuring coverage, or other work on the cores and caches
 * this thread shares, slows that honest page and the crafted books alike, so each limit grows with
 * the pace measured now, never shrinks below its idle value. "Now" is just before and just after
 * each book is timed: the other packages' tests, run beside these, load the machine more as they
 * get going, and a pace measured once at the start missed that (3.1 s against a limit of 2.4 s,
 * with every package's coverage measured at once).
 */
const IDLE_PACE_MS = 130;
let pace = IDLE_PACE_MS;
const PACE_PAGE = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${Array.from({ length: 30_000 }, (_, i) => `<p>w${i % 997} x${(i * 7919) % 10_007}</p>`).join('')}</body></html>`;

/** How long the honest page takes to sanitise at this moment. */
const paceNow = () => clocked(() => normalizeSection(PACE_PAGE, ctx)).ms;

beforeAll(() => {
  // A first run warms the code up.
  paceNow();
});

/** A limit set on the idle machine, in the time this machine takes now. */
function limit(idleMs: number): number {
  return idleMs * Math.max(1, pace / IDLE_PACE_MS);
}

/** What `fn` returns and how much of this thread's CPU time it takes, in milliseconds. */
function clocked<T>(fn: () => T): { ms: number; value: T } {
  const started = process.threadCpuUsage();
  const value = fn();
  const { user, system } = process.threadCpuUsage(started);
  return { ms: (user + system) / 1000, value };
}

/** What `fn` returns and how long it takes (clocked), with the pace (for `limit`) measured just before and just after it. */
function timed<T>(fn: () => T): { ms: number; value: T } {
  const before = paceNow();
  const result = clocked(fn);
  pace = Math.max(before, paceNow());
  return result;
}

/** The error `fn` throws. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected an error, got none');
}

/** A repeatable stream of numbers below `n`. */
function numbers(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % n;
  };
}

describe('a crafted table of contents', () => {
  /**
   * The contents of {@link bookWithLongContents} as kept: 12,550 entries resolve, more than the
   * contents keep, so the deepest level (the sections of each chapter) goes, and the parts and
   * chapters stay whole and in order.
   */
  const expectLongContentsKept = (pub: ReturnType<typeof buildPublication>) => {
    const chapters = LONG.parts * LONG.chaptersPerPart;
    expect(pub.toc).toHaveLength(LONG.parts + chapters);
    expect(pub.toc.length).toBeLessThanOrEqual(MAX_TOC_ENTRIES);
    expect(pub.toc.filter((e) => e.depth === 0).map((e) => e.title)).toEqual(Array.from({ length: LONG.parts }, (_, p) => `Part ${p + 1}`));
    const kept = pub.toc.filter((e) => e.depth === 1);
    expect(kept.map((e) => e.title)).toEqual(Array.from({ length: chapters }, (_, k) => `Chapter ${k + 1}`));
    expect(pub.toc.every((e) => e.depth <= 1)).toBe(true);
    // Chapter 1001 starts at the next heading of that section, after only "Opening The first words.".
    expect(pub.toc[1]).toEqual({ title: 'Chapter 1', href: 'OEBPS/text/s0.xhtml#c0', section: 0, offset: 0, depth: 1, alone: true, caption: false });
    kept.forEach((e, k) => {
      expect(e.section).toBe(k % LONG.sections);
      expect(e.offset).toBe(pub.sections[k % LONG.sections]!.idOffsets.get(`c${k % 3}`));
    });
    expect(pub.toc[2]!.offset).toBeGreaterThan(0);
  };

  it('an NCX of tens of thousands of entries, twenty thousand pointing nowhere, is read in well under a second, keeping the shallow levels', () => {
    const epub = bookWithLongContents('ncx');
    // Each entry whose file is missing used to be looked for through every section, twice over:
    // this book took about 6 s.
    const { ms, value: pub } = timed(() => buildPublication(epub));
    expect(ms).toBeLessThan(limit(1000));
    expectLongContentsKept(pub);
  });

  it('a nav document of the same costs time in proportion to its size, read as the contents and sanitised as a page', () => {
    // About 6 s before, as the NCX; what is left grows with the size of the nav.
    const epub = bookWithLongContents('nav');
    const { ms, value: pub } = timed(() => buildPublication(epub));
    expect(ms).toBeLessThan(limit(2000));
    expectLongContentsKept(pub);
  });

  it(`a single level of more than ${MAX_TOC_ENTRIES} entries keeps its start`, () => {
    const list = Array.from({ length: MAX_TOC_ENTRIES + 2000 }, (_, i) => `<li><a href="../text/s${i % 10}.xhtml">Chapter ${i + 1}</a></li>`).join('');
    const pub = buildPublication(bookWithContents(10, list));
    expect(pub.toc).toHaveLength(MAX_TOC_ENTRIES);
    expect(pub.toc.at(-1)!.title).toBe(`Chapter ${MAX_TOC_ENTRIES}`);
  });

  it('cut first to the contents a publication keeps, a list cut again by the same rule keeps what one cut would (the server keeps its units so)', () => {
    expect(MAX_TOC_ENTRIES).toBeGreaterThanOrEqual(MAX_EDITION_UNITS);
    const random = numbers(7);
    for (let run = 0; run < 500; run++) {
      const entries = Array.from({ length: random(200) }, (_, i) => ({ i, depth: random(5) }));
      expect(keepShallowest(keepShallowest(entries, 60), 20)).toEqual(keepShallowest(entries, 20));
    }
  });

  it('an entry in the wrong folder finds the first section of its file name, and an exact path wins', () => {
    const nav = '<nav epub:type="toc"><ol><li><a href="elsewhere/x.xhtml">Moved</a></li><li><a href="b/x.xhtml">Exact</a></li><li><a href="B/X.XHTML">Shouty</a></li><li><a href="gone.xhtml">Lost</a></li></ol></nav>';
    const epub = makeEpub({
      opf: opf({
        manifest: [
          { id: 'a', href: 'a/x.xhtml', type: DOCUMENT },
          { id: 'b', href: 'b/x.xhtml', type: DOCUMENT },
          { id: 'nav', href: 'nav.xhtml', type: DOCUMENT, properties: 'nav' },
        ],
        spine: [{ idref: 'a' }, { idref: 'b' }],
      }),
      files: { 'OEBPS/a/x.xhtml': xhtml('<p>A</p>'), 'OEBPS/b/x.xhtml': xhtml('<p>B</p>'), 'OEBPS/nav.xhtml': xhtml(nav) },
    });
    expect(buildPublication(epub).toc.map((e) => [e.title, e.section])).toEqual([
      ['Moved', 0],
      ['Exact', 1],
      ['Shouty', 1],
    ]);
  });
});

describe('nesting', () => {
  it(`a page nested deeper than ${XML_LIMITS.maxDepth} levels is refused at once`, () => {
    // The parser shifts its whole stack of open elements for every one it opens: these 140,000
    // levels (under 1 MiB, so the archive's own checks let them in) took over 7 s, and then the
    // sanitiser ran out of stack.
    const epub = bookOfOnePage(xhtml(nested('b', 140_000, 'deep')));
    const { ms, value: error } = timed(() => thrown(() => buildPublication(epub)));
    expect(error).toBeInstanceOf(EpubError);
    expect(error).toMatchObject({ code: 'too-large' });
    expect(ms).toBeLessThan(limit(500));
  });

  it('a page nested as deep as that is read whole', () => {
    // <html> and <body> are two of the levels.
    const pub = buildPublication(bookOfOnePage(xhtml(nested('span', XML_LIMITS.maxDepth - 2, 'deep'))));
    expect(pub.sections[0]!.textLength).toBe('deep'.length);
    expect(() => buildPublication(bookOfOnePage(xhtml(nested('span', XML_LIMITS.maxDepth - 1, 'deep'))))).toThrow(EpubError);
  });

  it('a deep page without a head, of many elements, is read in time that grows with its size', () => {
    // Looking for the head walked the whole page, paying for every level above each element: 23 s.
    const page = `<html xmlns="http://www.w3.org/1999/xhtml"><body>${nested('div', 1000, '<i>a</i>'.repeat(100_000))}</body></html>`;
    const epub = bookOfOnePage(page);
    const { ms, value: pub } = timed(() => buildPublication(epub));
    expect(pub.sections[0]!.textLength).toBe(100_000);
    expect(ms).toBeLessThan(limit(1000));
  });

  it('NCX entries nested in one another are read in time that grows with their number', () => {
    // A navPoint without a label looked for one through every point inside it: 18 s for these.
    const { ms, value } = timed(() => parseNcx(nestedNcx(1000), 'OEBPS/toc.ncx'));
    expect(value).toEqual([]);
    expect(ms).toBeLessThan(limit(200));
  });

  it('a navPoint is named by its own label, never by one of the points inside it', () => {
    const ncx =
      '<?xml version="1.0"?><ncx><navMap><navPoint><content src="a.xhtml"/>' +
      '<navPoint><navLabel><text>Inner</text></navLabel><content src="a.xhtml#x"/></navPoint>' +
      '<navLabel><text>Outer</text></navLabel></navPoint></navMap></ncx>';
    expect(parseNcx(ncx, 'OEBPS/toc.ncx').map((e) => [e.title, e.depth])).toEqual([
      ['Outer', 0],
      ['Inner', 1],
    ]);
  });

  it('a contents list nested thousands of levels deep is refused at once, and one of hundreds is read', () => {
    const list = (levels: number) => xhtml(`<nav epub:type="toc">${'<ol><li><a href="a.xhtml">x</a>'.repeat(levels)}${'</li></ol>'.repeat(levels)}</nav>`);
    const { ms, value: error } = timed(() => thrown(() => parseNavDocument(list(3000), 'OEBPS/nav.xhtml')));
    expect(error).toMatchObject({ code: 'too-large' });
    expect(ms).toBeLessThan(limit(200));
    expect(parseNavDocument(list(400), 'OEBPS/nav.xhtml').map((e) => e.depth)).toEqual(Array.from({ length: 400 }, (_, i) => i));
  });

  it('encryption entries nested in one another are read in time that grows with their number', () => {
    // Each entry looked for its method and its file through every entry inside it: 36 s for these.
    const epub = bookOfOnePage(xhtml('<p>x</p>'), { 'META-INF/encryption.xml': nestedEncryption(1000) });
    const { ms, value: pub } = timed(() => buildPublication(epub));
    expect(pub.sections).toHaveLength(1);
    expect(ms).toBeLessThan(limit(500));
  });
});

describe('patterns over text a book chooses', () => {
  // The expressions used before, kept as the reference: they backtracked over runs of spaces, in
  // time growing with the cube (stylesheets) or the square (style attributes, SVG sizes) of the run.
  const OLD_IMPORT = /@import\s+(?:url\()?\s*['"]?\s*(?:https?:)?\/\/[^;]*;?/gi;
  const OLD_STYLE = /expression\s*\(|javascript:|behavior\s*:|-moz-binding|url\s*\(\s*['"]?\s*(?:https?:|\/\/)/i;
  const oldSanitizeCss = (css: string) =>
    cleanXmlText(css).replace(OLD_IMPORT, '').replace(/expression\s*\(/gi, 'invalid(').replace(/-moz-binding\s*:/gi, 'invalid:').replace(/behavior\s*:/gi, 'invalid:');
  const oldSvgSize = (head: string) => {
    if (head.length < 10) return null;
    const svg = /<svg\b[^>]*>/i.exec(head);
    if (!svg) return null;
    const tag = svg[0];
    const num = (name: string) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(px)?\\s*["']`, 'i').exec(tag);
      return m ? Number.parseFloat(m[1]!) : null;
    };
    const positive = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
    const w = num('width');
    const h = num('height');
    if (w && h) return positive(Math.round(w), Math.round(h));
    const vb = /\bviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(tag);
    return vb ? positive(Math.round(Number.parseFloat(vb[1]!)), Math.round(Number.parseFloat(vb[2]!))) : null;
  };

  it('a run of spaces in a stylesheet costs time in proportion to its length', () => {
    // Two thousand spaces after an @import took 4.4 s; a hundred thousand would take days.
    const css = `@import${' '.repeat(100_000)}x; p { color: red }`;
    const { ms, value } = timed(() => sanitizeCss(css));
    expect(value).toBe(css);
    expect(ms).toBeLessThan(limit(100));
  });

  it('and in a style attribute', () => {
    // 16 s before.
    const page = xhtml(`<p style="background: url(${' '.repeat(100_000)}x)">a</p>`);
    const { ms, value } = timed(() => normalizeSection(page, ctx));
    expect(value.xhtml).toContain('style="background: url(');
    expect(ms).toBeLessThan(limit(200));
  });

  it('and in the head of an SVG picture', () => {
    // 28 s before: a book may hold thousands of pictures, each read for its size.
    const heads = [`<svg width='1${' '.repeat(4080)}>`, '<svg'.repeat(1024), `<svg height="2${' '.repeat(2000)}px${' '.repeat(2000)}>`].map((h) => strToU8(h));
    const { ms } = timed(() => {
      for (let i = 0; i < 1000; i++) for (const head of heads) imageSize(head);
    });
    expect(ms).toBeLessThan(limit(300));
  });

  it('remove, keep and measure exactly what the old expressions did', () => {
    const random = numbers(11);
    const pick = (tokens: readonly string[], most: number) => Array.from({ length: 1 + random(most) }, () => tokens[random(tokens.length)]!).join('');
    const css = ['@import', '@IMPORT', ' ', ' ', '\t', '\n', 'url(', 'URL(', 'url', '(', "'", '"', 'http:', 'https:', 'http', ':', '//', '/', ';', 'x', ')', 'expression', 'behavior', '-moz-binding'];
    const style = ['url', 'URL', '(', ' ', ' ', '\t', "'", 'http:', 'https:', 'HTTP:', '//', '/', 'expression', 'javascript:', 'behavior', ':', '-moz-binding', 'x', 'color: red', ';'];
    const svg = ['<svg', '<SVG', '<svgx', ' ', '\n', 'width', 'height', '=', "'", '"', '1', '2.5', '.', '0', 'px', 'PX', 'p', '>', 'viewBox', ',', '-', 'x', '<', 'stroke-', ' 0 0 '];
    for (let i = 0; i < 2000; i++) {
      const sheet = pick(css, 14);
      expect(sanitizeCss(sheet), sheet).toBe(oldSanitizeCss(sheet));
      const value = pick(style, 10);
      const kept = normalizeSection(xhtml(`<p style="${value}">a</p>`), ctx).xhtml.includes(' style="');
      expect(kept, value).toBe(!OLD_STYLE.test(value));
      const head = pick(svg, 24);
      expect(imageSize(strToU8(head)), head).toEqual(oldSvgSize(head));
    }
  });
});

describe('files a book names but does not hold', () => {
  it('are looked for in time that does not grow with the number of files in the book', () => {
    // Each was compared with every file of the book, in lower case: 7 s.
    const epub = bookOfMissingFiles({ files: 5000, links: 2000, images: 20_000, missing: 2000 });
    const { ms, value: pub } = timed(() => buildPublication(epub));
    expect(pub.sections).toHaveLength(2001);
    expect(ms).toBeLessThan(limit(1000));
  });

  it('a picture named in other letter case is still found and sized', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(png.buffer).setUint32(16, 640);
    new DataView(png.buffer).setUint32(20, 480);
    const epub = bookOfOnePage(xhtml('<p><img src="Images/PIC.PNG"/></p>'), { 'OEBPS/images/pic.png': png });
    expect(decoder.decode(buildPublication(epub).files.get('OEBPS/a.xhtml'))).toContain('width="640" height="480"');
  });
});

describe('namespace prefixes', () => {
  it('are checked in time that does not grow with the depth they are used at', () => {
    // Each looked through the declarations of every level above it: 1.5 s.
    const attributes = Array.from({ length: 200 }, (_, i) => ` x:a${i}="1"`).join('');
    const page = xhtml(nested('span', 1000, `<b${attributes}>t</b>`.repeat(1000)));
    const { ms, value } = timed(() => normalizeSection(page, ctx));
    expect(value.xhtml).not.toContain('x:a');
    expect(value.removed.attributes).toBe(200_000);
    expect(value.textLength).toBe(1000);
    expect(ms).toBeLessThan(limit(700));
  });
});

describe('the reading order', () => {
  it('may list no more documents than an EPUB may hold files', () => {
    const book = (n: number) =>
      makeEpub({
        opf: opf({ manifest: [{ id: 'a', href: 'a.xhtml', type: DOCUMENT }], spine: Array.from({ length: n }, () => ({ idref: 'a' })) }),
        files: { 'OEBPS/a.xhtml': xhtml('<p>x</p>') },
      });
    const limits = { ...DEFAULT_LIMITS, maxEntries: 100 };
    expect(buildPublication(book(100), { limits }).sections).toHaveLength(100);
    expect(thrown(() => buildPublication(book(101), { limits }))).toMatchObject({ code: 'too-large' });
    expect(thrown(() => buildPublication(book(DEFAULT_LIMITS.maxEntries + 1)))).toMatchObject({ code: 'too-large' });
  });
});

describe('the archive', () => {
  it('many pages, each compressed far beyond what a large file may be, are refused before they are unpacked', () => {
    // Sixteen pages just under a mebibyte, so that none is judged alone, in some 30 KiB: the
    // parser used to spend 6.6 s on them, and a thousand would have taken minutes.
    const page = xhtml('<i>a</i>'.repeat(131_000));
    const epub = bookOfPages(Array.from({ length: 16 }, () => page));
    expect(page.length).toBeLessThan(1024 * 1024);
    const { ms, value: error } = timed(() => thrown(() => buildPublication(epub)));
    expect(error).toMatchObject({ code: 'too-large' });
    expect(ms).toBeLessThan(limit(200));
  });
});

describe('closing tags that match nothing open', () => {
  it('are counted before parsing: a page of more of them than its node limit is refused at once, however deep', () => {
    // The parser never reports them to the DOM builder, yet looks through its whole stack of open
    // elements for each: a million of them a thousand levels deep cost it some 3 s.
    const page = `<r>${nested('b', 1000, '</x>'.repeat(XML_LIMITS.maxNodes + 1))}</r>`;
    const { ms, value: error } = timed(() => thrown(() => parseXml(page)));
    expect(error).toMatchObject({ code: 'too-large' });
    expect(ms).toBeLessThan(limit(300));
    // Up to the limit counts as before: these ten closing tags, eleven with the root's.
    expect(parseXml(`<r>${'<b/>'.repeat(3)}${'</x>'.repeat(9)}</r>`, { maxDepth: 10, maxNodes: 10 }).children).toHaveLength(1);
    expect(() => parseXml(`<r>${'</x>'.repeat(10)}</r>`, { maxDepth: 10, maxNodes: 10 })).toThrow(EpubError);
  });
});

describe('what a book marks its parts as (its story range, FR150)', () => {
  it('is read in time that grows with how many it marks, however deep', () => {
    // A hundred thousand notes inside a thousand appendices inside one another, in the back matter.
    const notes = '<aside epub:type="footnote"><p>a</p></aside>'.repeat(100_000);
    const page = xhtml(`<p>${'story '.repeat(2000)}</p>${'<section epub:type="appendix">'.repeat(1000)}${notes}${'</section>'.repeat(1000)}`);
    // (It compresses far beyond what the archive's guard lets a real book: that guard is not what is tried here.)
    const { ms, value: pub } = timed(() => buildPublication(bookOfOnePage(page), { limits: { ...DEFAULT_LIMITS, maxRatio: Infinity } }));
    expect(pub.sections[0]!.matter.length).toBe(101_000);
    expect(ms).toBeLessThan(limit(2000));
  });

  it('and with how many documents, guide references and landmarks it has', () => {
    // Two thousand documents of back matter: every one is looked at from the end, then all are kept.
    const pages = Array.from({ length: 2000 }, (_, i) => xhtml(`<section epub:type="${i === 0 ? 'chapter' : 'appendix'}"><p>w${i}</p></section>`));
    const book = bookOfPages(pages);
    const { ms: many } = timed(() => buildPublication(book));
    expect(many).toBeLessThan(limit(1000));
    // Fifty thousand references in the guide and as many landmarks, to every document.
    const refs = Array.from({ length: 50_000 }, (_, i) => `<reference type="appendix" href="p${i % 2000}.xhtml"/>`).join('');
    const marks = Array.from({ length: 50_000 }, (_, i) => `<li><a epub:type="backmatter" href="p${i % 2000}.xhtml">x</a></li>`).join('');
    const manifest = [...pages.map((_, i) => ({ id: `p${i}`, href: `p${i}.xhtml`, type: DOCUMENT })), { id: 'nav', href: 'nav.xhtml', type: DOCUMENT, properties: 'nav' }];
    const files = Object.fromEntries(pages.map((page, i) => [`OEBPS/p${i}.xhtml`, page]));
    files['OEBPS/nav.xhtml'] = xhtml(`<nav epub:type="landmarks"><ol>${marks}</ol></nav>`);
    const guided = makeEpub({ opf: opf({ manifest, spine: pages.map((_, i) => ({ idref: `p${i}` })) }).replace('</package>', `<guide>${refs}</guide></package>`), files });
    const { ms, value: pub } = timed(() => buildPublication(guided));
    // Nearly all of it marked as what follows the story: too much to be right, so the story is all of it.
    expect(pub.story.end).toBe(pub.sections.reduce((n, s) => n + s.textLength, 0));
    expect(ms).toBeLessThan(limit(2000));
  });
});

describe('a book of many documents', () => {
  it('shares one budget of nodes between them: each inside its own limit, together past the book’s, it is refused', () => {
    // Three pages of some 640 nodes, attributes and closing tags each, besides the package's own.
    const book = bookOfPages(Array.from({ length: 3 }, () => xhtml('<i>a</i>'.repeat(200))));
    expect(buildPublication(book, { bookNodes: 10_000 }).sections).toHaveLength(3);
    expect(thrown(() => buildPublication(book, { bookNodes: 1500 }))).toMatchObject({ code: 'too-large' });
    // The budget is the book's alone: reading another book after it starts afresh.
    expect(buildPublication(book, { bookNodes: 10_000 }).sections).toHaveLength(3);
  });

  it('a real book is far inside the budget: Alice reads within a five-hundredth of it (War and Peace holds some 40,000 tags)', () => {
    expect(buildPublication(aliceBytes(), { bookNodes: BOOK_NODES / 500 }).sections.length).toBeGreaterThan(10);
  });
});

describe('document size', () => {
  it(`a document of more than ${XML_LIMITS.maxNodes} nodes is refused`, () => {
    // Parsed, each node takes some 220 bytes, so a few tens of megabytes of markup would fill the
    // heap. The numbers keep the page from compressing past what the archive's own checks allow.
    const page = xhtml(Array.from({ length: XML_LIMITS.maxNodes / 2 + 1 }, (_, i) => `<b/>${i}`).join(''));
    const error = thrown(() => buildPublication(bookOfOnePage(page)));
    expect(error).toBeInstanceOf(EpubError);
    expect(error).toMatchObject({ code: 'too-large' });
    // Making a page of half a million elements takes a while itself, more so under coverage.
  }, 30_000);

  it('parsing keeps to the limits it is given, and what the package wrote itself is re-measured whatever its depth', () => {
    expect(parseXml(`<r>${'<b/>'.repeat(9)}</r>`, { maxDepth: 10, maxNodes: 10 }).children).toHaveLength(1);
    expect(() => parseXml(`<r>${'<b/>'.repeat(10)}</r>`, { maxDepth: 10, maxNodes: 10 })).toThrow(EpubError);
    expect(parseXml(nested('b', 10), { maxDepth: 10, maxNodes: 100 }).children).toHaveLength(1);
    expect(() => parseXml(nested('b', 11), { maxDepth: 10, maxNodes: 100 })).toThrow(EpubError);
    // Attributes count with the nodes, as they are read: one element may carry any number of them.
    const attributes = (n: number) => Array.from({ length: n }, (_, i) => ` a${i}=""`).join('');
    expect(parseXml(`<r${attributes(9)}/>`, { maxDepth: 10, maxNodes: 10 }).children).toHaveLength(1);
    expect(() => parseXml(`<r${attributes(10)}/>`, { maxDepth: 10, maxNodes: 10 })).toThrow(EpubError);
    // A normalised section is never refused when measured again: a book read before these limits keeps its text.
    expect(measureBodyText(xhtml(nested('span', 2 * XML_LIMITS.maxDepth, 'deep')))).toBe('deep');
  });
});
