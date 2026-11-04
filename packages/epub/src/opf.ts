import { type Element } from 'domhandler';
import { normalizePath, resolveHref } from './paths';
import { EpubError, type Container, decodeText } from './zip';
import { attr, childElements, elements, firstElement, localName, ownElement, parseXml, textContent } from './xml';

export interface ManifestItem {
  readonly id: string;
  /** Normalised container path. */
  readonly path: string;
  readonly mediaType: string;
  readonly properties: readonly string[];
}

export interface SpineItem {
  readonly idref: string;
  readonly path: string;
  readonly mediaType: string;
  readonly linear: boolean;
}

export interface PackageMetadata {
  readonly title: string;
  readonly authors: readonly string[];
  readonly language: string;
  readonly identifier: string;
  readonly description: string;
  readonly publisher: string;
}

/** A reference of EPUB 2's guide: what a document of the book is (its cover, its notes, where its text starts). */
export interface GuideReference {
  readonly type: string;
  /** Normalised container path of the document. */
  readonly path: string;
  readonly fragment: string | null;
}

export interface PackageDocument {
  readonly opfPath: string;
  readonly version: string;
  readonly metadata: PackageMetadata;
  readonly manifest: ReadonlyMap<string, ManifestItem>;
  readonly spine: readonly SpineItem[];
  readonly direction: 'ltr' | 'rtl';
  /** EPUB 3 navigation document. */
  readonly navPath: string | null;
  /** EPUB 2 NCX. */
  readonly ncxPath: string | null;
  readonly coverPath: string | null;
  /** EPUB 2's guide (EPUB 3 keeps it for older readers). */
  readonly guide: readonly GuideReference[];
}

export function findOpfPath(container: Container): string {
  const xml = container.get('META-INF/container.xml');
  if (!xml) throw new EpubError('This file has no META-INF/container.xml, so it is not an EPUB.', 'not-epub');
  const doc = parseXml(decodeText(xml));
  for (const rootfile of elements(doc, 'rootfile')) {
    const fullPath = attr(rootfile, 'full-path');
    const media = attr(rootfile, 'media-type');
    if (fullPath && (!media || media === 'application/oebps-package+xml')) return normalizePath(fullPath);
  }
  throw new EpubError('The EPUB container does not name a package document.', 'not-epub');
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Project Gutenberg writes some titles of nobility before the name, in lower case ("graf Leo
 * Tolstoy"): the name alone is what readers call the author. Only a lower-case title goes, so a
 * pen name such as "Lord Dunsany" stays whole.
 */
export function tidyAuthorName(name: string): string {
  return name.replace(/^(?:graf|gräfin|count|countess|comte|comtesse|freiherr|baron|baroness|sir|lord|lady|dame|prince|princess|knyaz)\s+(?=\p{Lu})/u, '');
}

/** Authors: EPUB 3 `role` refinements or EPUB 2 `opf:role`, falling back to all creators. */
function readAuthors(metadata: Element): string[] {
  const creators = childElements(metadata, 'creator');
  const roles = new Map<string, string>();
  for (const meta of childElements(metadata, 'meta')) {
    const refines = attr(meta, 'refines');
    if (attr(meta, 'property') === 'role' && refines?.startsWith('#')) roles.set(refines.slice(1), cleanText(textContent(meta)));
  }
  const all = creators
    .map((c) => ({ name: tidyAuthorName(cleanText(textContent(c))), role: attr(c, 'role') ?? roles.get(attr(c, 'id') ?? '') ?? null }))
    .filter((c) => c.name.length > 0);
  const authors = all.filter((c) => c.role === null || c.role === 'aut');
  return (authors.length > 0 ? authors : all).map((c) => c.name);
}

export function parsePackage(container: Container, opfPath: string): PackageDocument {
  const bytes = container.get(opfPath);
  if (!bytes) throw new EpubError(`The package document ${opfPath} is missing.`, 'not-epub');
  const doc = parseXml(decodeText(bytes));
  const pkg = firstElement(doc, 'package');
  if (!pkg) throw new EpubError('The package document has no <package> element.', 'malformed');
  const metadataEl = firstElement(pkg, 'metadata');
  const manifestEl = firstElement(pkg, 'manifest');
  const spineEl = firstElement(pkg, 'spine');
  if (!manifestEl || !spineEl) throw new EpubError('The package document has no manifest or spine.', 'malformed');

  const manifest = new Map<string, ManifestItem>();
  for (const item of childElements(manifestEl, 'item')) {
    const id = attr(item, 'id');
    const href = attr(item, 'href');
    if (!id || !href) continue;
    let resolved;
    try {
      resolved = resolveHref(opfPath, href);
    } catch {
      continue;
    }
    if (!resolved) continue;
    manifest.set(id, {
      id,
      path: resolved.path,
      mediaType: (attr(item, 'media-type') ?? '').toLowerCase(),
      properties: (attr(item, 'properties') ?? '').split(/\s+/).filter(Boolean),
    });
  }

  const spine: SpineItem[] = [];
  for (const ref of childElements(spineEl, 'itemref')) {
    const idref = attr(ref, 'idref');
    const item = idref ? manifest.get(idref) : undefined;
    if (!item || !idref) continue;
    spine.push({ idref, path: item.path, mediaType: item.mediaType, linear: attr(ref, 'linear') !== 'no' });
  }
  if (spine.length === 0) throw new EpubError('The EPUB has an empty reading order (spine).', 'malformed');

  const titleEls = metadataEl ? childElements(metadataEl, 'title') : [];
  const title = cleanText(titleEls.map((t) => textContent(t)).find((t) => t.trim().length > 0) ?? '');
  const firstText = (local: string) => {
    const el = metadataEl ? childElements(metadataEl, local)[0] : undefined;
    return el ? cleanText(textContent(el)) : '';
  };

  let navPath: string | null = null;
  let coverPath: string | null = null;
  for (const item of manifest.values()) {
    if (item.properties.includes('nav')) navPath = item.path;
    if (item.properties.includes('cover-image')) coverPath = item.path;
  }
  if (!coverPath && metadataEl) {
    // EPUB 2: <meta name="cover" content="manifest-id"/>
    for (const meta of childElements(metadataEl, 'meta')) {
      if (attr(meta, 'name') === 'cover') {
        const item = manifest.get(attr(meta, 'content') ?? '');
        if (item?.mediaType.startsWith('image/')) coverPath = item.path;
      }
    }
  }
  if (!coverPath) {
    // Last resort: an image whose id or file name says cover.
    for (const item of manifest.values()) {
      if (item.mediaType.startsWith('image/') && /cover/i.test(`${item.id} ${item.path}`)) {
        coverPath = item.path;
        break;
      }
    }
  }
  const tocId = attr(spineEl, 'toc');
  const ncxItem = (tocId ? manifest.get(tocId) : undefined) ?? [...manifest.values()].find((i) => i.mediaType === 'application/x-dtbncx+xml');

  const guide: GuideReference[] = [];
  const guideEl = firstElement(pkg, 'guide');
  for (const ref of guideEl ? childElements(guideEl, 'reference') : []) {
    const type = attr(ref, 'type');
    const href = attr(ref, 'href');
    if (!type || !href) continue;
    try {
      const target = resolveHref(opfPath, href);
      if (target) guide.push({ type, path: target.path, fragment: target.fragment });
    } catch {
      // An unsafe href says nothing about the book.
    }
  }

  return {
    opfPath,
    version: attr(pkg, 'version') ?? '2.0',
    metadata: {
      title,
      authors: metadataEl ? readAuthors(metadataEl) : [],
      language: firstText('language') || 'en',
      identifier: firstText('identifier'),
      description: firstText('description'),
      publisher: firstText('publisher'),
    },
    manifest,
    spine,
    direction: attr(spineEl, 'page-progression-direction') === 'rtl' ? 'rtl' : 'ltr',
    navPath,
    ncxPath: ncxItem?.path ?? null,
    coverPath,
    guide,
  };
}

/** Reject DRM: content documents listed in encryption.xml (font obfuscation is fine). */
export function assertNotEncrypted(container: Container): void {
  const enc = container.get('META-INF/encryption.xml');
  if (!enc) return;
  const doc = parseXml(decodeText(enc));
  for (const data of elements(doc, 'encrypteddata')) {
    // Each entry's own method and file, not those of an entry inside it.
    const method = ownElement(data, 'encryptionmethod', 'encrypteddata');
    const algorithm = method ? attr(method, 'algorithm') ?? '' : '';
    const fontObfuscation =
      algorithm === 'http://www.idpf.org/2008/embedding' || algorithm === 'http://ns.adobe.com/pdf/enc#RC';
    const ref = ownElement(data, 'cipherreference', 'encrypteddata');
    const uri = ref ? attr(ref, 'uri') ?? '' : '';
    if (!fontObfuscation && !/\.(otf|ttf|woff2?)$/i.test(uri)) {
      throw new EpubError('This EPUB is protected by DRM and cannot be opened here.', 'encrypted');
    }
  }
}

export { localName };
