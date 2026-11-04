import { tidyAuthorName } from '../src/opf';
import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  EpubError,
  SERVED_MEDIA_TYPES,
  UnsafePathError,
  buildPublication,
  imageSize,
  measureBodyText,
  normalizePath,
  normalizeSection,
  parseNavDocument,
  parseNcx,
  sanitizeSvg,
  readEpubPreview,
  relativeHref,
  resolveHref,
  unzipEpub,
} from '../src/index';
import { containerXml, makeEpub, opf, simpleEpub, xhtml } from './helpers';

const decoder = new TextDecoder();
const ctx = (sectionPath = 'OEBPS/text/s.xhtml', existing: string[] = []) => ({
  sectionPath,
  exists: (p: string) => existing.includes(p),
});

describe('paths (v1 lesson: TOC hrefs versus spine hrefs)', () => {
  it('resolves ../ relative to the referring document', () => {
    expect(resolveHref('OEBPS/nav/toc.xhtml', '../Text/ch1.xhtml#start')).toEqual({ path: 'OEBPS/Text/ch1.xhtml', fragment: 'start' });
  });

  it('decodes percent-escapes so encoded and plain names compare equal', () => {
    expect(resolveHref('OEBPS/content.opf', 'Text/Chapter%20One.xhtml')!.path).toBe('OEBPS/Text/Chapter One.xhtml');
    expect(resolveHref('OEBPS/content.opf', './Text/./Chapter One.xhtml')!.path).toBe('OEBPS/Text/Chapter One.xhtml');
  });

  it('treats URLs with a scheme as external', () => {
    expect(resolveHref('a.xhtml', 'https://example.com/x')).toBeNull();
    expect(resolveHref('a.xhtml', '//cdn.example.com/x')).toBeNull();
    expect(resolveHref('a.xhtml', 'mailto:a@b.c')).toBeNull();
  });

  it('a bare fragment points at the same document', () => {
    expect(resolveHref('OEBPS/a.xhtml', '#note1')).toEqual({ path: 'OEBPS/a.xhtml', fragment: 'note1' });
  });

  it('refuses paths that escape the container', () => {
    expect(() => normalizePath('../../etc/passwd')).toThrow(UnsafePathError);
    expect(() => normalizePath('a/\u0000b')).toThrow(UnsafePathError);
    expect(normalizePath('a\\b\\c.xhtml')).toBe('a/b/c.xhtml');
  });

  it('builds relative hrefs', () => {
    expect(relativeHref('OEBPS/Text/a.xhtml', 'OEBPS/Images/b c.png')).toBe('../Images/b%20c.png');
    expect(relativeHref('OEBPS/a.xhtml', 'OEBPS/b.xhtml')).toBe('b.xhtml');
  });
});

describe('table of contents', () => {
  it('maps a nav document in another folder onto the spine', () => {
    const pub = buildPublication(simpleEpub(['<p>One</p>', '<p>Two</p>', '<p>Three</p>']));
    expect(pub.toc.map((e) => [e.title, e.section])).toEqual([
      ['Chapter 1', 0],
      ['Chapter 2', 1],
      ['Chapter 3', 2],
    ]);
  });

  it('resolves fragment targets to text offsets inside a section', () => {
    const body = '<p>Intro text.</p><h2 id="part-b">Part B</h2><p>More.</p>';
    const nav = '<nav epub:type="toc"><ol><li><a href="../text/s0.xhtml#part-b">Part B</a></li></ol></nav>';
    const pub = buildPublication(simpleEpub([body], { navBody: nav }));
    expect(pub.toc[0]!.offset).toBe('Intro text.'.length);
    expect(pub.toc[0]!.href).toBe('OEBPS/text/s0.xhtml#part-b');
  });

  it('keeps nested entries with their depth', () => {
    const nav = `<nav epub:type="toc"><ol><li><a href="a.xhtml">Part One</a><ol><li><a href="a.xhtml#c1">Chapter 1</a></li></ol></li></ol></nav>`;
    const entries = parseNavDocument(xhtml(nav), 'OEBPS/nav.xhtml');
    expect(entries.map((e) => [e.title, e.depth])).toEqual([
      ['Part One', 0],
      ['Chapter 1', 1],
    ]);
  });

  it('reads an EPUB 2 NCX when there is no nav document', () => {
    const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
      <navPoint id="p1"><navLabel><text>First</text></navLabel><content src="Text/a.xhtml"/>
        <navPoint id="p2"><navLabel><text>Inner</text></navLabel><content src="Text/a.xhtml#x"/></navPoint>
      </navPoint></navMap></ncx>`;
    expect(parseNcx(ncx, 'OEBPS/toc.ncx')).toEqual([
      { title: 'First', path: 'OEBPS/Text/a.xhtml', fragment: null, depth: 0 },
      { title: 'Inner', path: 'OEBPS/Text/a.xhtml', fragment: 'x', depth: 1 },
    ]);
    const epub = makeEpub({
      opf: opf({
        version: '2.0',
        manifest: [
          { id: 'a', href: 'Text/a.xhtml', type: 'application/xhtml+xml' },
          { id: 'ncx', href: 'toc.ncx', type: 'application/x-dtbncx+xml' },
        ],
        spine: [{ idref: 'a' }],
        toc: 'ncx',
      }),
      files: { 'OEBPS/Text/a.xhtml': xhtml('<p>Hello</p><p id="x">World</p>'), 'OEBPS/toc.ncx': ncx },
    });
    const pub = buildPublication(epub);
    expect(pub.toc.map((e) => [e.title, e.section, e.offset])).toEqual([
      ['First', 0, 0],
      ['Inner', 0, 'Hello'.length],
    ]);
  });

  it('synthesises a table of contents from section titles when there is none', () => {
    const epub = makeEpub({
      opf: opf({ manifest: [{ id: 'a', href: 'a.xhtml', type: 'application/xhtml+xml' }], spine: [{ idref: 'a' }] }),
      files: { 'OEBPS/a.xhtml': xhtml('<p>Hi</p>', '<title>Only Chapter</title>') },
    });
    // Its one section holds hardly more than its title: "Hi".
    expect(buildPublication(epub).toc).toEqual([{ title: 'Only Chapter', href: 'OEBPS/a.xhtml', section: 0, offset: 0, depth: 0, alone: true, caption: false }]);
  });

  it('matches case-mismatched paths (books made on Windows)', () => {
    const nav = '<nav epub:type="toc"><ol><li><a href="../TEXT/S0.XHTML">Shouty</a></li></ol></nav>';
    const pub = buildPublication(simpleEpub(['<p>x</p>'], { navBody: nav }));
    expect(pub.toc[0]!.section).toBe(0);
  });
});

describe('sanitising (no script ever runs)', () => {
  it('removes scripts, event handlers and javascript: URLs', () => {
    const out = normalizeSection(
      xhtml(
        `<p onclick="steal()">Hello <a href="javascript:alert(1)">link</a></p><script>alert(1)</script>` +
          `<img src="x.png" onerror="alert(1)"/><iframe src="https://evil.example"></iframe><form><input value="x"/>kept</form>`,
        '<title>t</title><script src="evil.js"></script>',
      ),
      ctx('OEBPS/text/s.xhtml', ['OEBPS/text/x.png']),
    );
    expect(out.xhtml).not.toMatch(/script|onclick|onerror|javascript:|iframe|<input|<form/i);
    expect(measureBodyText(out.xhtml)).toBe('Hello linkkept');
    expect(out.removed.elements).toBeGreaterThanOrEqual(3);
    expect(out.removed.attributes).toBeGreaterThanOrEqual(3);
  });

  it('drops remote images but keeps external links for the reader to open outside', () => {
    const out = normalizeSection(
      xhtml('<p><img src="https://tracker.example/p.gif"/><a href="https://www.gutenberg.org">Gutenberg</a></p>'),
      ctx(),
    );
    expect(out.xhtml).not.toContain('tracker.example');
    expect(out.xhtml).toContain('href="https://www.gutenberg.org"');
  });

  it('strips dangerous inline styles and remote CSS imports', () => {
    const out = normalizeSection(
      xhtml(
        '<p style="width: expression(alert(1))">a</p><p style="color: red">b</p>',
        '<title>t</title><style>@import url(https://evil.example/x.css); p { color: blue }</style>',
      ),
      ctx(),
    );
    expect(out.xhtml).not.toContain('expression');
    expect(out.xhtml).toContain('style="color: red"');
    expect(out.xhtml).not.toContain('evil.example');
    expect(out.xhtml).toContain('p { color: blue }');
  });

  it('moves body <style> into the head so it is not counted as text', () => {
    const out = normalizeSection(xhtml('<style>p{margin:0}</style><p>text</p>'), ctx());
    expect(measureBodyText(out.xhtml)).toBe('text');
    expect(out.xhtml).toMatch(/<head>.*<style>p\{margin:0\}<\/style>.*<\/head>/s);
  });

  it('serves no scripts or SVGs with script from the archive', () => {
    const epub = makeEpub({
      opf: opf({
        manifest: [
          { id: 'a', href: 'a.xhtml', type: 'application/xhtml+xml' },
          { id: 'js', href: 'evil.js', type: 'application/javascript' },
          { id: 'svg', href: 'bad.svg', type: 'image/svg+xml' },
          { id: 'ok', href: 'ok.svg', type: 'image/svg+xml' },
        ],
        spine: [{ idref: 'a' }],
      }),
      files: {
        'OEBPS/a.xhtml': xhtml('<p>x</p>'),
        'OEBPS/evil.js': 'alert(1)',
        'OEBPS/bad.svg': '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
        'OEBPS/ok.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"/>',
      },
    });
    const pub = buildPublication(epub);
    expect(pub.files.has('OEBPS/evil.js')).toBe(false);
    // An SVG is served only as its sanitised copy: the picture stays, the handler goes.
    const bad = new TextDecoder().decode(pub.files.get('OEBPS/bad.svg'));
    expect(bad).toContain('<svg');
    expect(bad).not.toMatch(/onload|alert/);
    expect(pub.files.has('OEBPS/ok.svg')).toBe(true);
    expect(new TextDecoder().decode(pub.files.get('OEBPS/ok.svg'))).toContain('width="10"');
  });

  it('decides what each file is served as itself, whatever the EPUB declares', () => {
    const epub = makeEpub({
      opf: opf({
        manifest: [
          { id: 'a', href: 'a.xhtml', type: 'text/html;charset=utf-8' },
          { id: 'b', href: 'b.xml', type: 'application/xml' },
          { id: 'c', href: 'c.html', type: 'text/plain' },
          { id: 'n', href: 'notes.txt', type: 'text/plain' },
          { id: 'p', href: 'pic.png', type: 'application/xhtml+xml' },
        ],
        spine: [{ idref: 'a' }, { idref: 'b' }],
      }),
      files: {
        'OEBPS/a.xhtml': xhtml('<p>one</p><script>alert(1)</script>'),
        'OEBPS/b.xml': xhtml('<p onclick="alert(2)">two</p>'),
        'OEBPS/c.html': xhtml('<p>three</p><script>alert(3)</script>'),
        'OEBPS/notes.txt': '<script>alert(4)</script>',
        'OEBPS/pic.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      },
    });
    const pub = buildPublication(epub);
    // Reading-order items are always sanitised documents, served as XHTML.
    for (const path of ['OEBPS/a.xhtml', 'OEBPS/b.xml', 'OEBPS/c.html']) {
      expect(pub.mediaTypes.get(path)).toBe('application/xhtml+xml');
      expect(new TextDecoder().decode(pub.files.get(path))).not.toMatch(/<script|onclick|alert/);
    }
    // Nothing outside documents, styles, pictures and fonts is served; pictures go by extension.
    expect(pub.files.has('OEBPS/notes.txt')).toBe(false);
    expect(pub.mediaTypes.get('OEBPS/pic.png')).toBe('image/png');
    for (const type of pub.mediaTypes.values()) expect(SERVED_MEDIA_TYPES.has(type)).toBe(true);
  });

  it('checks links whatever prefix a book gives XLink, and drops prefixes it does not know', () => {
    const page =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:x="http://www.w3.org/1999/xlink" xmlns:evil="urn:made-up" xmlns:epub="http://www.idpf.org/2007/ops">' +
      '<head><title>t</title></head><body>' +
      '<svg xmlns="http://www.w3.org/2000/svg"><a x:href="javascript:alert(1)"><circle r="4"/></a><a x:href="#ok"><circle r="2"/></a></svg>' +
      '<p evil:onclick="alert(2)" evil:data="x" epub:type="chapter">Text</p>' +
      '</body></html>';
    const out = normalizeSection(page, ctx());
    expect(out.xhtml).not.toMatch(/javascript|alert|xmlns:x=|xmlns:evil|evil:/);
    // The book's own XLink links are gone with their unknown prefix; the EPUB vocabulary stays.
    expect(out.xhtml).not.toContain('x:href');
    expect(out.xhtml).toContain('epub:type="chapter"');
    expect(out.xhtml).toContain('xmlns:epub="http://www.idpf.org/2007/ops"');
    expect(out.textLength).toBe('Text'.length);
    // The output is still well-formed XML.
    expect(() => measureBodyText(out.xhtml)).not.toThrow();
  });

  it('sanitises standalone SVG the way it sanitises a page', () => {
    const svg = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
        '<style>circle { fill: gold }</style>' +
        '<svg:script>alert(1)</svg:script>' +
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>' +
        '<a xlink:href="jav&#97;script:alert(2)"><circle r="4"/></a>' +
        '<a href="#"><set attributeName="href" to="javascript:alert(3)"/><animate attributeName="href" values="javascript:alert(4)"/></a>' +
        '<image href="https://example.com/x.png"/><image href="pic.png"/>' +
        '<rect onmouseover="alert(5)" width="2" height="2"/>' +
        '</svg>',
    )!;
    expect(svg).toMatch(/^<\?xml/);
    expect(svg).not.toMatch(/script|alert|foreignObject|<set|<animate|onmouseover|example\.com/i);
    expect(svg).toContain('<circle r="4"/>'.replace('/>', '></circle>'));
    expect(svg).toContain('href="pic.png"');
    expect(svg).toContain('fill: gold');
    expect(sanitizeSvg('<html xmlns="http://www.w3.org/1999/xhtml"/>')).toBeNull();
  });
});

describe('text measurement agrees with the browser', () => {
  it('decodes HTML named entities that an XML parser would not know', () => {
    const out = normalizeSection(xhtml('<p>a&nbsp;b &mdash; c &amp; d &#8212; e &#x2014;</p>'), ctx());
    expect(measureBodyText(out.xhtml)).toBe('a b — c & d — e —');
    expect(out.textLength).toBe('a b — c & d — e —'.length);
  });

  it('normalises CRLF the way the XML parser will', () => {
    const out = normalizeSection(xhtml('<p>line one\r\nline two\rthree</p>'), ctx());
    expect(measureBodyText(out.xhtml)).toBe('line one\nline two\nthree');
  });

  it('removes characters XML forbids (they would blank the whole page)', () => {
    const out = normalizeSection(xhtml('<p>bad\u0001char￿ and lone \uD800 surrogate, ok 😀</p>'), ctx());
    expect(measureBodyText(out.xhtml)).toBe('badchar and lone  surrogate, ok 😀');
  });

  it('keeps CDATA text literally', () => {
    const out = normalizeSection(xhtml('<p><![CDATA[x < y & z]]></p>'), ctx());
    expect(measureBodyText(out.xhtml)).toBe('x < y & z');
  });

  it('records element id offsets for TOC targets and internal links', () => {
    const out = normalizeSection(xhtml('<h1 id="t">Title</h1><p>One <span id="s">two</span></p>'), ctx());
    expect(out.idOffsets.get('t')).toBe(0);
    expect(out.idOffsets.get('s')).toBe('TitleOne '.length);
  });

  it('keeps self-closing anchors as empty elements (Gutenberg <a id="chap01"/>)', () => {
    const out = normalizeSection(xhtml('<h2><a id="chap01"/>CHAPTER I.<br/>Down</h2><p>Text</p>'), ctx());
    expect(measureBodyText(out.xhtml)).toBe('CHAPTER I.DownText');
    expect(out.xhtml).toContain('<a id="chap01"></a>');
  });

  it('keeps content that tag soup nested inside a void element', () => {
    const out = normalizeSection('<html><body><p>a<br>b</p></body></html>', ctx());
    expect(measureBodyText(out.xhtml)).toBe('ab');
    expect(out.xhtml).toContain('<br/>');
  });
});

describe('namespaces (an undeclared prefix would make the browser reject the page)', () => {
  it('drops attributes with undeclared prefixes and keeps declared ones', () => {
    const out = normalizeSection(xhtml('<p ibooks:x="1" epub:type="chapter" xml:lang="en">hi</p>'), ctx());
    expect(out.xhtml).not.toContain('ibooks:x');
    expect(out.xhtml).toContain('epub:type="chapter"');
    expect(out.xhtml).toContain('xml:lang="en"');
  });

  it('adds the SVG and MathML namespaces when missing', () => {
    const out = normalizeSection(xhtml('<svg width="10" height="10"><rect/></svg><math><mi>x</mi></math>'), ctx());
    expect(out.xhtml).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(out.xhtml).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML"');
  });

  it('carries extra namespace declarations from the root', () => {
    const src = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:m="http://www.w3.org/1998/Math/MathML"><head><title>t</title></head><body><m:math><m:mi>x</m:mi></m:math></body></html>`;
    const out = normalizeSection(src, ctx());
    expect(out.xhtml).toContain('xmlns:m="http://www.w3.org/1998/Math/MathML"');
    expect(out.xhtml).toContain('<m:math>');
  });

  it('strips an undeclared element prefix rather than emitting invalid XML', () => {
    const out = normalizeSection('<html><body><foo:bar>text</foo:bar></body></html>', ctx());
    expect(out.xhtml).toContain('<bar>text</bar>');
  });
});

describe('images', () => {
  it('writes intrinsic width/height and an empty alt when missing', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(png.buffer).setUint32(16, 640);
    new DataView(png.buffer).setUint32(20, 480);
    const out = normalizeSection(xhtml('<p><img src="../images/a.png"/></p>'), {
      sectionPath: 'OEBPS/text/s.xhtml',
      exists: () => true,
      imageSize: (p) => (p === 'OEBPS/images/a.png' ? imageSize(png) : null),
    });
    expect(out.xhtml).toContain('alt=""');
    expect(out.xhtml).toContain('width="640"');
    expect(out.xhtml).toContain('height="480"');
  });

  it('reads JPEG, GIF, WebP and SVG dimensions', () => {
    // JPEG: SOI, APP0 (length 16), SOF0 with height 300, width 200.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0),
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x00, 0xc8, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 200, height: 300 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x00, 0x10, 0x00, 0, 0]);
    expect(imageSize(gif)).toEqual({ width: 32, height: 16 });
    const webp = new Uint8Array(30);
    webp.set(strToU8('RIFF'), 0);
    webp.set(strToU8('WEBP'), 8);
    webp.set(strToU8('VP8X'), 12);
    webp.set([99, 0, 0, 49, 0, 0], 24);
    expect(imageSize(webp)).toEqual({ width: 100, height: 50 });
    expect(imageSize(strToU8('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"></svg>'))).toEqual({ width: 120, height: 80 });
    expect(imageSize(strToU8('<svg width="12px" height="7"></svg>'))).toEqual({ width: 12, height: 7 });
    expect(imageSize(new Uint8Array(4))).toBeNull();
    expect(imageSize(strToU8('not an image at all, just text'))).toBeNull();
  });
});

describe('archive safety and errors', () => {
  it('rejects files that are not ZIPs', () => {
    expect(() => buildPublication(strToU8('%PDF-1.7 not a zip'))).toThrow(EpubError);
    expect(() => readEpubPreview(strToU8('nope'))).toThrow(EpubError);
  });

  it('rejects ZIPs without container.xml', () => {
    expect(() => buildPublication(makeEpub({ container: null, files: { 'a.txt': 'x' } }))).toThrow(/container\.xml/);
  });

  it('rejects DRM-encrypted content but accepts font obfuscation', () => {
    const base = {
      opf: opf({ manifest: [{ id: 'a', href: 'a.xhtml', type: 'application/xhtml+xml' }], spine: [{ idref: 'a' }] }),
      files: { 'OEBPS/a.xhtml': xhtml('<p>x</p>') },
    };
    const drm = `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
      <enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
      <enc:CipherData><enc:CipherReference URI="OEBPS/a.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`;
    const fonts = drm.replace('http://www.w3.org/2001/04/xmlenc#aes128-cbc', 'http://www.idpf.org/2008/embedding').replace('OEBPS/a.xhtml', 'OEBPS/f.otf');
    expect(() => buildPublication(makeEpub({ ...base, files: { ...base.files, 'META-INF/encryption.xml': drm } }))).toThrow(/DRM/);
    expect(() => buildPublication(makeEpub({ ...base, files: { ...base.files, 'META-INF/encryption.xml': fonts } }))).not.toThrow();
    // The upload's preview says so before anything is uploaded.
    expect(() => readEpubPreview(makeEpub({ ...base, files: { ...base.files, 'META-INF/encryption.xml': drm } }))).toThrow(/DRM/);
    expect(() => readEpubPreview(makeEpub({ ...base, files: { ...base.files, 'META-INF/encryption.xml': fonts } }))).not.toThrow();
  });

  it('never accepts zip-slip entry names', () => {
    const zip = makeEpub({ files: {}, raw: { '../../evil.txt': 'x', 'ok/file.txt': 'y' } });
    const entries = unzipEpub(zip);
    expect([...entries.keys()].some((k) => k.includes('..'))).toBe(false);
    expect(entries.has('ok/file.txt')).toBe(true);
  });

  it('bounds the unpacked size', () => {
    const zip = makeEpub({ files: { 'big.txt': 'x'.repeat(10_000) } });
    expect(() => unzipEpub(zip, { maxTotalBytes: 1000, maxEntries: 100, maxRatio: 1000 })).toThrow(/too large/);
    expect(() => unzipEpub(zip, { maxTotalBytes: 1e9, maxEntries: 1, maxRatio: 1000 })).toThrow(/too many/);
  });

  it('reports an empty spine', () => {
    const epub = makeEpub({ opf: opf({ manifest: [], spine: [] }), files: {} });
    expect(() => buildPublication(epub)).toThrow(/empty reading order/);
  });

  it('accepts a container naming an OPF in the root', () => {
    const epub = makeEpub({
      opfPath: 'package.opf',
      container: containerXml('package.opf'),
      opf: opf({ title: 'Root OPF', manifest: [{ id: 'a', href: 'a.xhtml', type: 'application/xhtml+xml' }], spine: [{ idref: 'a' }] }),
      files: { 'a.xhtml': xhtml('<p>root</p>') },
    });
    const pub = buildPublication(epub);
    expect(pub.metadata.title).toBe('Root OPF');
    expect(decoder.decode(pub.files.get('a.xhtml'))).toContain('root');
  });
});

describe('metadata', () => {
  it('prefers creators with the author role', () => {
    const epub = makeEpub({
      opf: opf({
        authors: [],
        extraMetadata:
          '<dc:creator id="c1">Ed Itor</dc:creator><meta refines="#c1" property="role">edt</meta><dc:creator id="c2">Real Author</dc:creator><meta refines="#c2" property="role">aut</meta>',
        manifest: [{ id: 'a', href: 'a.xhtml', type: 'application/xhtml+xml' }],
        spine: [{ idref: 'a' }],
      }),
      files: { 'OEBPS/a.xhtml': xhtml('<p>x</p>') },
    });
    expect(buildPublication(epub).metadata.author).toBe('Real Author');
  });

  it('falls back to an EPUB 2 cover meta and to the first image of the first page', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(20).fill(1)]);
    const withMeta = makeEpub({
      opf: opf({
        version: '2.0',
        extraMetadata: '<meta name="cover" content="img"/>',
        manifest: [
          { id: 'a', href: 'a.xhtml', type: 'application/xhtml+xml' },
          { id: 'img', href: 'pic.png', type: 'image/png' },
        ],
        spine: [{ idref: 'a' }],
      }),
      files: { 'OEBPS/a.xhtml': xhtml('<p>x</p>'), 'OEBPS/pic.png': png },
    });
    expect(buildPublication(withMeta).cover?.path).toBe('OEBPS/pic.png');
    const firstImage = makeEpub({
      opf: opf({
        manifest: [
          { id: 'a', href: 'a.xhtml', type: 'application/xhtml+xml' },
          { id: 'img', href: 'art/front.png', type: 'image/png' },
        ],
        spine: [{ idref: 'a' }],
      }),
      files: { 'OEBPS/a.xhtml': xhtml('<p><img src="art/front.png" alt="x"/></p>'), 'OEBPS/art/front.png': png },
    });
    expect(buildPublication(firstImage).cover?.path).toBe('OEBPS/art/front.png');
  });

  it('a book without boilerplate has its whole text as the story', () => {
    const pub = buildPublication(simpleEpub(['<p>abc</p>', '<p>defg</p>']));
    expect(pub.story).toEqual({ start: 0, end: 7 });
  });

  it('marks linear="no" spine items', () => {
    const epub = makeEpub({
      opf: opf({
        manifest: [
          { id: 'a', href: 'a.xhtml', type: 'application/xhtml+xml' },
          { id: 'n', href: 'notes.xhtml', type: 'application/xhtml+xml' },
        ],
        spine: [{ idref: 'a' }, { idref: 'n', linear: false }],
      }),
      files: { 'OEBPS/a.xhtml': xhtml('<p>x</p>'), 'OEBPS/notes.xhtml': xhtml('<p>note</p>') },
    });
    expect(buildPublication(epub).sections.map((s) => s.linear)).toEqual([true, false]);
  });
});

describe('author names', () => {
  it('drops a lower-case title Gutenberg writes before the name, and keeps pen names whole', () => {
    expect(tidyAuthorName('graf Leo Tolstoy')).toBe('Leo Tolstoy');
    expect(tidyAuthorName('freiherr von Eichendorff')).toBe('freiherr von Eichendorff');
    expect(tidyAuthorName('Lord Dunsany')).toBe('Lord Dunsany');
    expect(tidyAuthorName('Lewis Carroll')).toBe('Lewis Carroll');
    expect(tidyAuthorName('sir Walter Scott')).toBe('Walter Scott');
  });
});
