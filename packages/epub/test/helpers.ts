import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

export const ALICE_PATH = fileURLToPath(new URL('../../../fixtures/books/alice-gutenberg-11.epub', import.meta.url));

export function aliceBytes(): Uint8Array {
  return new Uint8Array(readFileSync(ALICE_PATH));
}

export interface EpubSpec {
  /** Path of the OPF inside the container. */
  opfPath?: string;
  opf?: string;
  container?: string | null;
  files: Record<string, string | Uint8Array>;
  /** Raw zip entry names that bypass normalisation (for zip-slip tests). */
  raw?: Record<string, string>;
}

export function xhtml(body: string, head = '<title>Section</title>'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>${head}</head>
<body>${body}</body>
</html>`;
}

export function opf(options: {
  title?: string;
  authors?: string[];
  manifest: { id: string; href: string; type: string; properties?: string }[];
  spine: { idref: string; linear?: boolean }[];
  version?: string;
  extraMetadata?: string;
  toc?: string;
}): string {
  const authors = (options.authors ?? ['Test Author']).map((a) => `<dc:creator>${a}</dc:creator>`).join('');
  const items = options.manifest
    .map((m) => `<item id="${m.id}" href="${m.href}" media-type="${m.type}"${m.properties ? ` properties="${m.properties}"` : ''}/>`)
    .join('\n');
  const spine = options.spine.map((s) => `<itemref idref="${s.idref}"${s.linear === false ? ' linear="no"' : ''}/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${options.version ?? '3.0'}" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:test</dc:identifier>
<dc:title>${options.title ?? 'Test Book'}</dc:title>
${authors}
<dc:language>en</dc:language>
${options.extraMetadata ?? ''}
</metadata>
<manifest>
${items}
</manifest>
<spine${options.toc ? ` toc="${options.toc}"` : ''}>${spine}</spine>
</package>`;
}

export function containerXml(opfPath: string): string {
  return `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
}

export function makeEpub(spec: EpubSpec): Uint8Array {
  const opfPath = spec.opfPath ?? 'OEBPS/content.opf';
  const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  };
  if (spec.container !== null) entries['META-INF/container.xml'] = strToU8(spec.container ?? containerXml(opfPath));
  if (spec.opf) entries[opfPath] = strToU8(spec.opf);
  for (const [path, content] of Object.entries(spec.files)) {
    entries[path] = typeof content === 'string' ? strToU8(content) : content;
  }
  for (const [path, content] of Object.entries(spec.raw ?? {})) entries[path] = strToU8(content);
  return zipSync(entries);
}

/** A minimal valid EPUB 3 with the given sections (body markup) and a nav document. */
export function simpleEpub(sections: string[], options: { title?: string; navBody?: string } = {}): Uint8Array {
  const files: Record<string, string> = {};
  const manifest = sections.map((_, i) => ({ id: `s${i}`, href: `text/s${i}.xhtml`, type: 'application/xhtml+xml' }));
  sections.forEach((body, i) => {
    files[`OEBPS/text/s${i}.xhtml`] = xhtml(body, `<title>Chapter ${i + 1}</title>`);
  });
  const nav =
    options.navBody ??
    `<nav epub:type="toc"><ol>${sections.map((_, i) => `<li><a href="../text/s${i}.xhtml">Chapter ${i + 1}</a></li>`).join('')}</ol></nav>`;
  files['OEBPS/nav/toc.xhtml'] = xhtml(nav);
  manifest.push({ id: 'nav', href: 'nav/toc.xhtml', type: 'application/xhtml+xml', properties: 'nav' } as never);
  return makeEpub({
    opf: opf({ title: options.title, manifest, spine: sections.map((_, i) => ({ idref: `s${i}` })) }),
    files,
  });
}
