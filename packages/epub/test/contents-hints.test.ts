import { chaptersFromContents } from '@bookclub/shared';
import { describe, expect, it } from 'vitest';
import { buildPublication } from '../src/index';
import { simpleEpub } from './helpers';

const para = (text: string, times = 40) => `<p>${Array.from({ length: times }, () => text).join(' ')}</p>`;

/** A stave as Gutenberg's illustrated A Christmas Carol prints it: heading, subtitle, text, a picture and its caption. */
function stave(n: number, word: string, subtitle: string, picture: string): string {
  return (
    `<hr/><h2 id="stave${n}"><a id="link${n}">STAVE ${word}.</a></h2><hr/><h4 id="sub${n}"> ${subtitle} </h4>${para('Marley was dead: to begin with.')}` +
    `<p><br/><br/><a id="fig${n}"> </a></p><div class="fig" style="width:80%"><img alt="${picture}" src="p${n}.jpg" width="100%"/><br/></div>` +
    `<h4 id="cap${n}"> <i>${picture}</i> </h4><p><br/></p>${para('The same face: the very same.')}`
  );
}

describe('what each contents entry’s place holds (D77)', () => {
  const nav = `<nav epub:type="toc"><ol>
    <li><a href="../text/s0.xhtml#title">A CHRISTMAS CAROL</a></li>
    <li><a href="../text/s0.xhtml#preface">PREFACE</a></li>
    <li><a href="../text/s0.xhtml#stave1">STAVE ONE.</a><ol><li><a href="../text/s0.xhtml#sub1">MARLEY’S GHOST.</a></li><li><a href="../text/s0.xhtml#cap1">Marley’s Ghost</a></li></ol></li>
    <li><a href="../text/s1.xhtml#stave2">STAVE TWO.</a><ol><li><a href="../text/s1.xhtml#sub2">THE FIRST OF THE THREE SPIRITS.</a></li><li><a href="../text/s1.xhtml#cap2">Mr. Fezziwig’s Ball</a></li></ol></li>
  </ol></nav>`;
  const book = simpleEpub(
    [
      `<h1 id="title">A CHRISTMAS CAROL</h1><h3 id="preface">PREFACE</h3>${para('I have endeavoured in this Ghostly little book.', 3)}${stave(1, 'ONE', 'MARLEY’S GHOST.', 'Marley’s Ghost')}`,
      stave(2, 'TWO', 'THE FIRST OF THE THREE SPIRITS.', 'Mr. Fezziwig’s Ball'),
    ],
    { navBody: nav },
  );

  it('tells a heading that holds only its title, and a picture’s caption, from the entries with text', () => {
    const pub = buildPublication(book);
    expect(pub.toc.map((e) => [e.title, e.alone, e.caption])).toEqual([
      ['A CHRISTMAS CAROL', true, false],
      ['PREFACE', false, false],
      ['STAVE ONE.', true, false],
      ['MARLEY’S GHOST.', false, false],
      ['Marley’s Ghost', false, true],
      ['STAVE TWO.', true, false],
      ['THE FIRST OF THE THREE SPIRITS.', false, false],
      ['Mr. Fezziwig’s Ball', false, true],
    ]);
  });

  it('so that the book’s chapters are its staves, each under its heading and subtitle', () => {
    const names = [
      ['ONE', 'MARLEY’S GHOST.', 'Marley’s Ghost'],
      ['TWO', 'THE FIRST OF THE THREE SPIRITS.', 'Mr. Fezziwig’s Ball'],
      ['THREE', 'THE SECOND OF THE THREE SPIRITS.', 'Scrooge’s Third Visitor'],
      ['FOUR', 'THE LAST OF THE SPIRITS.', 'The Last of the Spirits'],
      ['FIVE', 'THE END OF IT.', 'Scrooge and Bob Cratchit'],
    ] as const;
    const list = names
      .map(([word, subtitle, picture], i) => `<li><a href="../text/s${i}.xhtml#stave${i + 1}">STAVE ${word}.</a><ol><li><a href="../text/s${i}.xhtml#sub${i + 1}">${subtitle}</a></li><li><a href="../text/s${i}.xhtml#cap${i + 1}">${picture}</a></li></ol></li>`)
      .join('');
    const pub = buildPublication(simpleEpub(names.map(([word, subtitle, picture], i) => stave(i + 1, word, subtitle, picture)), { navBody: `<nav epub:type="toc"><ol>${list}</ol></nav>` }));
    const starts: number[] = [];
    let at = 0;
    for (const s of pub.sections) {
      starts.push(at);
      at += s.textLength;
    }
    const entries = pub.toc.map((e) => ({ title: e.title, m: starts[e.section]! + e.offset, depth: e.depth, alone: e.alone, caption: e.caption }));
    expect(chaptersFromContents(entries, pub.story).map((c) => [c.title, c.m])).toEqual(names.map(([word, subtitle], i) => [`STAVE ${word}. ${subtitle}`, starts[i]]));
  });

  it('takes a heading after a picture it does not describe for a heading (an illustrated chapter’s opening)', () => {
    const pub = buildPublication(
      simpleEpub([`<div><img alt="A drawing of a rabbit" src="r.jpg"/></div><h2 id="c1">CHAPTER I. Down the Rabbit-Hole</h2>${para('Alice was beginning to get very tired.')}`], {
        navBody: '<nav epub:type="toc"><ol><li><a href="../text/s0.xhtml#c1">CHAPTER I. Down the Rabbit-Hole</a></li></ol></nav>',
      }),
    );
    expect(pub.toc.map((e) => [e.title, e.alone, e.caption])).toEqual([['CHAPTER I. Down the Rabbit-Hole', false, false]]);
  });

  it('takes a heading with words between it and a picture for a heading, even with the picture’s words', () => {
    const pub = buildPublication(
      simpleEpub([`<div><img alt="The Garden" src="g.jpg"/></div><p>Some words.</p><h2 id="g">The Garden</h2>${para('The garden was quiet.')}`], {
        navBody: '<nav epub:type="toc"><ol><li><a href="../text/s0.xhtml#g">The Garden</a></li></ol></nav>',
      }),
    );
    expect(pub.toc[0]).toMatchObject({ title: 'The Garden', caption: false, alone: false });
  });

  it('reads an entry’s place across a section’s end: a part’s title page of its own holds only its title', () => {
    const pub = buildPublication(
      simpleEpub(['<h1 id="p1">PART ONE</h1>', `<h2 id="c1">Chapter 1</h2>${para('It was a dark and stormy night.')}`], {
        navBody: '<nav epub:type="toc"><ol><li><a href="../text/s0.xhtml#p1">PART ONE</a></li><li><a href="../text/s1.xhtml#c1">Chapter 1</a></li></ol></nav>',
      }),
    );
    expect(pub.toc.map((e) => [e.title, e.alone])).toEqual([
      ['PART ONE', true],
      ['Chapter 1', false],
    ]);
  });
});

describe('a row of stars between scenes (D86)', () => {
  const xhtmlOf = (pub: ReturnType<typeof buildPublication>) => new TextDecoder().decode(pub.files.get(pub.sections[0]!.path));

  it('is marked for the reader to keep its lines whole, with its widest line’s width, its text untouched', () => {
    const row = '*\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0*\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0*';
    const pub = buildPublication(simpleEpub([`<p>Before.</p><p class="asterism">${row}<br/>${row}</p><p>After.</p>`]));
    // Three stars and twelve no-break spaces: 3 × 0.55 em + 12 × 0.12 em.
    expect(xhtmlOf(pub)).toMatch(/<p class="asterism" style="--bc-row: 3.1" data-bc-asterism="">/);
    expect(pub.sections[0]!.textLength).toBe('Before.'.length + 2 * row.length + 'After.'.length);
    // Words with a star, or a single star, are text like any other.
    const plain = buildPublication(simpleEpub(['<p>* A note, starred.</p><p>*</p>']));
    expect(xhtmlOf(plain)).not.toContain('data-bc-asterism');
  });

  it('measures each line as it is drawn, Alice’s rows as Gutenberg sets them, and keeps a style of its own', () => {
    const gap = '\u00a0'.repeat(6);
    const seven = Array.from({ length: 7 }, () => '*').join(gap);
    const six = `\u00a0\u00a0\u00a0\u00a0${Array.from({ length: 6 }, () => '*').join(gap)}`;
    // Gutenberg's Alice (#11): seven stars, six indented, seven, a blank line between each.
    const alice = buildPublication(simpleEpub([`<p class="asterism">\n${seven}<br/>\n<br/>\n${six}<br/>\n<br/>\n${seven}<br/>\n</p>`]));
    // The widest is seven stars and 36 no-break spaces: 3.85 em + 4.32 em.
    expect(xhtmlOf(alice)).toContain('style="--bc-row: 8.2"');
    // Ordinary spaces run together as they are drawn, and none at either end; spans are read through.
    const spaced = buildPublication(simpleEpub(['<div style="margin-top: 2em;">  *     *     <span>*</span>  </div>']));
    expect(xhtmlOf(spaced)).toContain('<div style="margin-top: 2em; --bc-row: 1.9" data-bc-asterism="">');
  });
});
