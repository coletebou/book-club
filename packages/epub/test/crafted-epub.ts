import { makeEpub, opf, xhtml } from './helpers';

/**
 * EPUBs made to cost the parser far more than their size: each is small, and each kept the old
 * parser busy for seconds or minutes (the numbers are in crafted.test.ts).
 */

const DOCUMENT = 'application/xhtml+xml';

/** One section's body: three headings, `c0`, `c1` and `c2`, for contents entries to point at. */
const SECTION_BODY = '<h2 id="c0">Opening</h2><p>The first words.</p><h3 id="c1">Middle</h3><p>More words.</p><h3 id="c2">End</h3><p>Last words.</p>';

/** `count` sections, `OEBPS/text/s<i>.xhtml`, with their manifest items and reading order. */
function sections(count: number) {
  const files: Record<string, string> = {};
  const manifest: { id: string; href: string; type: string; properties?: string }[] = [];
  for (let i = 0; i < count; i++) {
    files[`OEBPS/text/s${i}.xhtml`] = xhtml(SECTION_BODY, `<title>Section ${i + 1}</title>`);
    manifest.push({ id: `s${i}`, href: `text/s${i}.xhtml`, type: DOCUMENT });
  }
  return { files, manifest, spine: manifest.map((m) => ({ idref: m.id })) };
}

/** A book of `count` sections and a nav document (`OEBPS/nav/toc.xhtml`) holding this list. */
export function bookWithContents(count: number, navList: string): Uint8Array {
  const { files, manifest, spine } = sections(count);
  files['OEBPS/nav/toc.xhtml'] = xhtml(`<nav epub:type="toc"><ol>${navList}</ol></nav>`);
  manifest.push({ id: 'nav', href: 'nav/toc.xhtml', type: DOCUMENT, properties: 'nav' });
  return makeEpub({ opf: opf({ manifest, spine }), files });
}

/** The shape of {@link bookWithLongContents}. */
export const LONG = { sections: 1000, parts: 50, chaptersPerPart: 50, sectionsPerChapter: 4, lostPerChapter: 6, lostPerPart: 100 } as const;

/**
 * A book of 1,000 sections whose contents, an EPUB 3 nav document or an EPUB 2 NCX, are three
 * levels deep: 50 parts of 50 chapters of 4 sections (12,550 entries), and 20,000 entries more
 * whose files are not in the book. Chapter k (from 0) points at section k % 1000, at its heading
 * `c<k % 3>`.
 */
export function bookWithLongContents(form: 'nav' | 'ncx'): Uint8Array {
  const entry = (title: string, href: string, inner = '') =>
    form === 'nav'
      ? `<li><a href="${href}">${title}</a>${inner ? `<ol>${inner}</ol>` : ''}</li>`
      : `<navPoint><navLabel><text>${title}</text></navLabel><content src="${href}"/>${inner}</navPoint>`;
  let parts = '';
  for (let p = 0; p < LONG.parts; p++) {
    let chapters = '';
    for (let c = 0; c < LONG.chaptersPerPart; c++) {
      const k = p * LONG.chaptersPerPart + c;
      const s = k % LONG.sections;
      let inner = '';
      for (let j = 0; j < LONG.sectionsPerChapter; j++) inner += entry(`Section ${k + 1}.${j + 1}`, `text/s${s}.xhtml#c${j % 3}`);
      for (let j = 0; j < LONG.lostPerChapter; j++) inner += entry(`Lost ${k + 1}.${j + 1}`, `lost/l${k}-${j}.xhtml`);
      chapters += entry(`Chapter ${k + 1}`, `text/s${s}.xhtml#c${k % 3}`, inner);
    }
    for (let d = 0; d < LONG.lostPerPart; d++) chapters += entry('Lost chapter', `lost/p${p}-${d}.xhtml`);
    parts += entry(`Part ${p + 1}`, `text/s${(p * 10) % LONG.sections}.xhtml`, chapters);
  }
  const { files, manifest, spine } = sections(LONG.sections);
  if (form === 'nav') {
    files['OEBPS/toc.xhtml'] = xhtml(`<nav epub:type="toc"><ol>${parts}</ol></nav>`);
    manifest.push({ id: 'toc', href: 'toc.xhtml', type: DOCUMENT, properties: 'nav' });
  } else {
    files['OEBPS/toc.ncx'] = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${parts}</navMap></ncx>`;
    manifest.push({ id: 'toc', href: 'toc.ncx', type: 'application/x-dtbncx+xml' });
  }
  return makeEpub({ opf: opf({ version: form === 'nav' ? '3.0' : '2.0', manifest, spine, toc: form === 'ncx' ? 'toc' : undefined }), files });
}

/** `n` elements named `tag`, each inside the one before, around `inner`. */
export function nested(tag: string, n: number, inner = ''): string {
  return `${`<${tag}>`.repeat(n)}${inner}${`</${tag}>`.repeat(n)}`;
}

/** A book whose sections hold these pages. */
export function bookOfPages(pages: readonly string[]): Uint8Array {
  const manifest = pages.map((_, i) => ({ id: `p${i}`, href: `p${i}.xhtml`, type: DOCUMENT }));
  const files = Object.fromEntries(pages.map((page, i) => [`OEBPS/p${i}.xhtml`, page]));
  return makeEpub({ opf: opf({ manifest, spine: manifest.map((m) => ({ idref: m.id })) }), files });
}

/** A book of one section (`OEBPS/a.xhtml`) holding this page, and these other files. */
export function bookOfOnePage(page: string, others: Record<string, string | Uint8Array> = {}): Uint8Array {
  return makeEpub({
    opf: opf({ manifest: [{ id: 'a', href: 'a.xhtml', type: DOCUMENT }], spine: [{ idref: 'a' }] }),
    files: { 'OEBPS/a.xhtml': page, ...others },
  });
}

/** An NCX of `levels` navPoints, each inside the one before, with no labels. */
export function nestedNcx(levels: number): string {
  const points = `${'<navPoint><content src="a.xhtml"/>'.repeat(levels)}${'</navPoint>'.repeat(levels)}`;
  return `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${points}</navMap></ncx>`;
}

/** An encryption.xml of `levels` font-obfuscation entries, each inside the one before. */
export function nestedEncryption(levels: number): string {
  const entry = '<enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>';
  return (
    '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">' +
    `${entry.repeat(levels)}${'</enc:EncryptedData>'.repeat(levels)}</encryption>`
  );
}

/**
 * A book of `files` small stylesheets whose one page links `links` times to a stylesheet that is
 * not there and shows `images` pictures that are not there, and whose reading order lists the page
 * and then `missing` documents that are not there either.
 */
export function bookOfMissingFiles(options: { files: number; links: number; images: number; missing: number }): Uint8Array {
  const files: Record<string, string> = {
    'OEBPS/a.xhtml': xhtml(`<p>${'<img src="nope.png"/>'.repeat(options.images)}</p>`, `<title>t</title>${'<link rel="stylesheet" href="nope.css"/>'.repeat(options.links)}`),
  };
  for (let i = 0; i < options.files; i++) files[`OEBPS/styles/${i}.css`] = 'p { margin: 0 }';
  const manifest = [
    { id: 'a', href: 'a.xhtml', type: DOCUMENT },
    { id: 'gone', href: 'gone.xhtml', type: DOCUMENT },
  ];
  const spine = [{ idref: 'a' }, ...Array.from({ length: options.missing }, () => ({ idref: 'gone' }))];
  return makeEpub({ opf: opf({ manifest, spine }), files });
}
