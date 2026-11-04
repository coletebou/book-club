import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type NormalizeContext, buildPublication, measureBodyText, normalizeSection } from '@bookclub/epub';
import { describe, expect, it } from 'vitest';
import { type TextIndex, buildTextIndex, offsetOfPoint, pointAt, rangeFor, textBetween } from './text';

/*
 * The text measure is the contract between server and client: the server records every comment
 * anchor, TOC target and story boundary as a UTF-16 offset into a section's <body> text, measured
 * while it normalises the section; the reader finds those places by measuring the same section in
 * the browser. If the two measures ever differ by one character, every note after that point
 * lands in the wrong place. So: the server normalises the publisher's XHTML, the browser (here
 * jsdom) parses the result as application/xhtml+xml, exactly as the reader's frame does, and the
 * two must agree on every character.
 */

const ctx: NormalizeContext = {
  sectionPath: 'OEBPS/text/chapter.xhtml',
  exists: () => true,
  imageSize: () => ({ width: 600, height: 800 }),
};

const source = (body: string, head = '<title>Chapter</title>') =>
  `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">\n<head>${head}</head>\n<body>${body}</body>\n</html>\n`;

function parse(xhtml: string): Document {
  const doc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml');
  const errors = doc.getElementsByTagName('parsererror');
  expect(errors.length, errors[0]?.textContent ?? '').toBe(0);
  // Parsed as XML, as the reader's frame does: no HTML parser repairs or re-reads anything.
  expect(doc.contentType).toBe('application/xhtml+xml');
  expect(doc.documentElement.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
  return doc;
}

const textOf = (index: TextIndex) => index.nodes.map((n) => n.data).join('');

/** Offsets to try in a section: its ends, every text node boundary, and a sample in between. */
function probeOffsets(index: TextIndex, samples = 60): number[] {
  const out = new Set<number>([0, index.length]);
  for (const s of index.starts) out.add(s);
  for (let i = 1; i <= samples; i++) out.add(Math.floor((index.length * i) / (samples + 1)));
  return [...out].sort((a, b) => a - b);
}

/** Server and client agree on the text, the offsets of ids, and every DOM position. */
function expectSameMeasure(xhtml: string, textLength: number, idOffsets: ReadonlyMap<string, number>, label: string): void {
  const doc = parse(xhtml);
  const index = buildTextIndex(doc);
  expect(index.length, `${label}: length`).toBe(textLength);
  const serverText = measureBodyText(xhtml);
  expect(textOf(index), `${label}: text`).toBe(serverText);

  for (const [id, offset] of idOffsets) {
    const el = doc.getElementById(id);
    expect(el, `${label}: #${id}`).not.toBeNull();
    expect(offsetOfPoint(doc, el!, 0), `${label}: offset of #${id}`).toBe(offset);
  }

  for (const offset of probeOffsets(index)) {
    const point = pointAt(index, offset);
    if (index.length === 0) {
      expect(point).toBeNull();
      continue;
    }
    expect(point, `${label}: point at ${offset}`).not.toBeNull();
    expect(offsetOfPoint(doc, point!.node, point!.offset), `${label}: round trip of ${offset}`).toBe(offset);
  }
}

const documents: [string, string][] = [
  ['entities (named HTML ones too, which XML lacks)', '<p>Tom &amp; Jerry &lt;3 &#8220;quoted&#8221;&nbsp;non&#xA0;breaking, &eacute;t&eacute; &copy; 2026&hellip; &#x1F600;</p>'],
  ['unknown entities and bare ampersands', '<p>AT&T and &foo; and a lone &amp at the end &</p>'],
  ['nested inline elements', '<p>A <em>very <strong>nested <a href="#n1">link <span class="x">deep <code>code</code></span></a></strong> text</em>.</p>'],
  ['whitespace, tabs, newlines and Windows line ends', '<div>\n  <p>  Leading  and   multiple   spaces  </p>\n\t<p>tabs\tand\nnewlines\r\nand CRLF\rand CR</p>\n</div>\n\n'],
  ['line breaks', '<p>line one<br/>line two<br />line three</p><p>tag soup<br>after a void element</br>and on</p>'],
  ['images, figures and SVG', '<p>Before <img src="../images/fig1.png"/> after</p><figure><img src="a.jpg" alt="An alt text is not text"/><figcaption>Caption</figcaption></figure><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>dropped</title><text x="1" y="5">SVG text</text></svg>'],
  ['scripts, styles, forms and other removed content', '<script>var x = "<p>not text</p>";</script><style>p { color: red }</style><noscript>no</noscript><form action="/x"><label>Kept label</label> <input value="dropped"/><button>Dropped</button><textarea>dropped</textarea></form><p onclick="evil()">kept</p>'],
  ['CDATA sections', '<p><![CDATA[1 < 2 && 3 > 2 ]]> and after</p>'],
  ['comments and processing instructions', '<p>a<!-- a comment -->b<?pi some data?>c</p>'],
  ['characters outside the BMP (two UTF-16 units each)', '<p>Emoji 😀👩‍👩‍👧 and 𝒜𝓁𝒾𝒸ℯ, then ﬁ ligatures</p>'],
  ['characters XML forbids', '<p>bell\u0007 vertical\u000Btab form\u000Cfeed ￾ end</p>'],
  ['text that looks like markup', '<p>x &lt;b&gt;not bold&lt;/b&gt; ]]&gt; y &gt; z</p>'],
  ['undeclared namespace prefixes and EPUB switches', '<p>a <foo:bar>prefixed</foo:bar> b</p><epub:switch id="sw"><epub:case required-namespace="x">case</epub:case><epub:default>default</epub:default></epub:switch>'],
  ['preformatted text', '<pre>  preformatted\n    code\n\n</pre>'],
  ['tables and lists', '<table><tr><td>a</td><td>b</td></tr><tr><td colspan="2">c</td></tr></table><ul><li>one</li><li>two<ol><li>nested</li></ol></li></ul>'],
  ['ids for anchors', '<h1 id="title">Title</h1><p id="p1">First <span id="inner">inner</span> paragraph.</p><p id="empty"></p><p id="last">Last</p>'],
  ['an empty body', ''],
  ['a body of whitespace only', '\n\n   \n'],
  ['Gutenberg boilerplate', '<section id="pg-header" class="pg-boilerplate"><p>The Project Gutenberg eBook of …</p></section><p id="start">The story.</p>'],
  ['a right-to-left paragraph with marks', '<p dir="rtl">‏שלום‎ world ‫embedded‬</p>'],
];

describe('the client measures section text exactly as the server did', () => {
  it.each(documents)('%s', (label, body) => {
    const normalized = normalizeSection(source(body), ctx);
    expectSameMeasure(normalized.xhtml, normalized.textLength, normalized.idOffsets, label);
  });

  it('for a document without <body> (a bare fragment)', () => {
    const normalized = normalizeSection('<p>No body element, <em>just</em> a fragment.</p><p>Two paragraphs.</p>', ctx);
    expectSameMeasure(normalized.xhtml, normalized.textLength, normalized.idOffsets, 'fragment');
    expect(normalized.textLength).toBe('No body element, just a fragment.Two paragraphs.'.length);
  });

  it('counts what a reader would expect in a simple case', () => {
    const normalized = normalizeSection(source('<p>Tom &amp; Jerry</p>\n<p>caf&eacute; 😀</p>'), ctx);
    expect(normalized.textLength).toBe('Tom & Jerry\ncafé 😀'.length);
    expect(buildTextIndex(parse(normalized.xhtml)).length).toBe(19);
  });
});

describe('the real Gutenberg Alice', () => {
  const decoder = new TextDecoder();
  const pub = buildPublication(new Uint8Array(readFileSync(path.resolve(import.meta.dirname, '../../../../../fixtures/books/alice-gutenberg-11.epub'))));
  const docs = pub.sections.map((s) => ({ section: s, xhtml: decoder.decode(pub.files.get(s.path)) }));

  it('has its fifteen sections, served as normalised XHTML', () => {
    expect(docs).toHaveLength(15);
    for (const { section, xhtml } of docs) expect(xhtml.length, section.path).toBeGreaterThan(0);
  });

  it.each(docs.map((d) => [d.section.index, d.section.path, d] as const))('section %i (%s) measures to the recorded length, text and anchors', (_i, p, { section, xhtml }) => {
    expectSameMeasure(xhtml, section.textLength, section.idOffsets, p);
  });

  it('finds every table-of-contents target where the server put it', () => {
    for (const entry of pub.toc) {
      const fragment = entry.href.split('#')[1];
      if (!fragment) {
        expect(entry.offset).toBe(0);
        continue;
      }
      const doc = parse(docs[entry.section]!.xhtml);
      expect(offsetOfPoint(doc, doc.getElementById(fragment)!, 0), entry.title).toBe(entry.offset);
    }
  });

  it('shows the same words at the story start as the server recorded', () => {
    let at = 0;
    const starts = pub.sections.map((s) => ((at += s.textLength), at - s.textLength));
    const section = 1;
    const offset = pub.story.start - starts[section]!;
    const index = buildTextIndex(parse(docs[section]!.xhtml));
    expect(textBetween(index, offset, offset + 60).trimStart()).toMatch(/^Alice’s Adventures in Wonderland/);
  });

  it('quotes the same text as the server for any range (what a comment quotes)', () => {
    const doc = parse(docs[2]!.xhtml); // CHAPTER I
    const index = buildTextIndex(doc);
    const serverText = measureBodyText(docs[2]!.xhtml);
    for (const [start, end] of [
      [0, 40],
      [100, 101],
      [1234, 1600],
      [index.length - 50, index.length],
      [500, 500],
    ] as const) {
      expect(textBetween(index, start, end)).toBe(serverText.slice(start, end));
      expect(rangeFor(doc, index, start, end)!.toString()).toBe(serverText.slice(start, end));
    }
    expect(serverText).toContain('Alice was beginning to get very tired of sitting by her sister on the bank');
  });
});

describe('pointAt, offsetOfPoint, rangeFor and textBetween', () => {
  const normalized = normalizeSection(source('<p id="a">Hello <em>brave</em> new</p><p id="b">world</p>'), ctx);
  const doc = parse(normalized.xhtml);
  const index = buildTextIndex(doc);
  // Text nodes: "Hello " (0), "brave" (6), " new" (11), "world" (15); 20 characters.

  it('index the text nodes of <body> in document order', () => {
    expect(index.nodes.map((n) => n.data)).toEqual(['Hello ', 'brave', ' new', 'world']);
    expect(index.starts).toEqual([0, 6, 11, 15]);
    expect(index.length).toBe(20);
  });

  it('ignore text outside <body> (the title)', () => {
    expect(doc.title).toBe('Chapter');
    expect(textOf(index)).not.toContain('Chapter');
  });

  it('put an offset on a node boundary at the start of the next node', () => {
    expect(pointAt(index, 6)).toEqual({ node: index.nodes[1], offset: 0 });
    expect(pointAt(index, 15)).toEqual({ node: index.nodes[3], offset: 0 });
    expect(pointAt(index, 7)).toEqual({ node: index.nodes[1], offset: 1 });
  });

  it('clamp offsets to the section', () => {
    expect(pointAt(index, -5)).toEqual({ node: index.nodes[0], offset: 0 });
    expect(pointAt(index, 99)).toEqual({ node: index.nodes[3], offset: 5 });
  });

  it('have no position in a section without text', () => {
    const empty = buildTextIndex(parse(normalizeSection(source('<img src="a.png"/>'), ctx).xhtml));
    expect(empty.length).toBe(0);
    expect(pointAt(empty, 0)).toBeNull();
    expect(textBetween(empty, 0, 10)).toBe('');
  });

  it('measure element boundary points (a selection that starts or ends between elements)', () => {
    const body = doc.body;
    expect(offsetOfPoint(doc, body, 0)).toBe(0);
    expect(offsetOfPoint(doc, body, 1)).toBe(15); // after the first paragraph
    expect(offsetOfPoint(doc, body, body.childNodes.length)).toBe(20);
    const a = doc.getElementById('a')!;
    expect(offsetOfPoint(doc, a, 2)).toBe(11); // after "Hello " and <em>
  });

  it('measure a point before <body> (in the head) as the start of the section', () => {
    const titleText = doc.getElementsByTagName('title')[0]!.firstChild!;
    expect(offsetOfPoint(doc, titleText, 3)).toBe(0);
  });

  it('cover exactly the requested text, across elements', () => {
    expect(rangeFor(doc, index, 3, 13)!.toString()).toBe('lo brave n');
    expect(textBetween(index, 3, 13)).toBe('lo brave n');
    expect(textBetween(index, 11, 20)).toBe(' newworld');
    // A reversed range is empty rather than an error.
    expect(rangeFor(doc, index, 10, 4)!.toString()).toBe('');
  });

  it('agree with each other at every offset', () => {
    for (let o = 0; o <= index.length; o++) {
      const p = pointAt(index, o)!;
      expect(offsetOfPoint(doc, p.node, p.offset)).toBe(o);
      expect(textBetween(index, 0, o)).toBe(rangeFor(doc, index, 0, o)!.toString());
    }
  });
});
