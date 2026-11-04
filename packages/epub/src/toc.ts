import { type Element } from 'domhandler';
import { tidyLabel } from '@bookclub/shared';
import { resolveHref } from './paths';
import { attr, childElements, elements, firstElement, localName, ownElement, parseXml, textContent } from './xml';

export interface RawTocEntry {
  readonly title: string;
  /** Normalised container path of the target document. */
  readonly path: string;
  readonly fragment: string | null;
  readonly depth: number;
}

function hasNavType(el: Element, type: string): boolean {
  const value = attr(el, 'type') ?? '';
  return value.split(/\s+/).includes(type);
}

/** EPUB 3 navigation document: `<nav epub:type="toc"><ol><li><a href>…`. */
export function parseNavDocument(source: string, navPath: string): RawTocEntry[] {
  const doc = parseXml(source);
  const navs = elements(doc, 'nav');
  const toc = navs.find((n) => hasNavType(n, 'toc')) ?? navs[0];
  if (!toc) return [];
  const list = firstElement(toc, 'ol') ?? firstElement(toc, 'ul');
  if (!list) return [];
  const out: RawTocEntry[] = [];
  const visit = (ol: Element, depth: number) => {
    for (const li of childElements(ol).filter((c) => localName(c) === 'li')) {
      const anchor = childElements(li).find((c) => localName(c) === 'a' || localName(c) === 'span');
      const href = anchor && localName(anchor) === 'a' ? attr(anchor, 'href') : undefined;
      const title = tidyLabel(anchor ? textContent(anchor) : '');
      if (href && title) {
        try {
          const target = resolveHref(navPath, href);
          if (target) out.push({ title, path: target.path, fragment: target.fragment, depth });
        } catch {
          // Unsafe href: skip the entry, keep the rest of the table of contents.
        }
      }
      for (const nested of childElements(li).filter((c) => localName(c) === 'ol' || localName(c) === 'ul')) visit(nested, depth + 1);
    }
  };
  visit(list, 0);
  return out;
}

/** A landmark of an EPUB 3 navigation document: a document of the book, and what the book says it is. */
export interface RawLandmark {
  /** Normalised container path of the target document. */
  readonly path: string;
  readonly fragment: string | null;
  /** Its `epub:type` tokens, as written ("bodymatter", "copyright-page"). */
  readonly types: readonly string[];
}

/** The landmarks of an EPUB 3 navigation document: `<nav epub:type="landmarks"><ol><li><a epub:type href>…`. */
export function parseLandmarks(source: string, navPath: string): RawLandmark[] {
  const doc = parseXml(source);
  const nav = elements(doc, 'nav').find((n) => hasNavType(n, 'landmarks'));
  if (!nav) return [];
  const out: RawLandmark[] = [];
  for (const a of elements(nav, 'a')) {
    const href = attr(a, 'href');
    const types = (attr(a, 'type') ?? '').split(/\s+/).filter(Boolean);
    if (!href || types.length === 0) continue;
    try {
      const target = resolveHref(navPath, href);
      if (target) out.push({ path: target.path, fragment: target.fragment, types });
    } catch {
      // An unsafe href: no landmark.
    }
  }
  return out;
}

/** EPUB 2 NCX: `<navMap><navPoint><navLabel><text/></navLabel><content src/>…`. */
export function parseNcx(source: string, ncxPath: string): RawTocEntry[] {
  const doc = parseXml(source);
  const navMap = firstElement(doc, 'navmap');
  if (!navMap) return [];
  const out: RawTocEntry[] = [];
  const visit = (parent: Element, depth: number) => {
    for (const point of childElements(parent, 'navpoint')) {
      // Its own label: one inside a point within it names that point.
      const label = ownElement(point, 'navlabel', 'navpoint');
      const content = childElements(point, 'content')[0];
      const title = tidyLabel(label ? textContent(label) : '');
      const src = content ? attr(content, 'src') : undefined;
      if (title && src) {
        try {
          const target = resolveHref(ncxPath, src);
          if (target) out.push({ title, path: target.path, fragment: target.fragment, depth });
        } catch {
          // skip unsafe entry
        }
      }
      visit(point, depth + 1);
    }
  };
  visit(navMap, 0);
  return out;
}
