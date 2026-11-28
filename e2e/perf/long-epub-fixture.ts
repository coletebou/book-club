import { prose, storedZip } from '../helpers/api';

/** A deterministic long spine, similar in length to the public benchmark without a download. */
export function longEpubFixture(): Buffer {
  const chapters = Array.from({ length: 368 }, (_, i) => ({
    id: `part${i + 1}`,
    title: `Chapter ${i + 1}`,
    paragraphs: Array.from({ length: 14 }, (_, p) => prose(9, i * 100 + p + 99)),
  }));
  const files: Record<string, string> = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  };
  for (const { id, title, paragraphs } of chapters) {
    files[`${id}.xhtml`] = `<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${paragraphs.map((p) => `<p>${p}</p>`).join('')}</body></html>`;
  }
  const contents = chapters.map(({ id, title }) => `<li><a href="${id}.xhtml">${title}</a></li>`).join('');
  files['toc.xhtml'] = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${contents}</ol></nav></body></html>`;
  const items = chapters.map(({ id }) => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`).join('');
  const spine = chapters.map(({ id }) => `<itemref idref="${id}"/>`).join('');
  files['content.opf'] = `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:bookclub:perf</dc:identifier><dc:title>Library performance fixture</dc:title><dc:creator>Sample Text</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items}</manifest><spine>${spine}</spine></package>`;
  return storedZip(files);
}
