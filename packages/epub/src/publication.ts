import { MAX_EDITION_UNITS, normalizeTitle } from '@bookclub/shared';
import { unzipSync } from 'fflate';
import { imageSize } from './imagesize';
import { type Matter, type MatterRange, isPartition, kindOf, matterKind, normalizeMatterType, partitionOf } from './matter';
import { type BoilerplateRange, normalizeSection, sanitizeCss, sanitizeSvg } from './normalize';
import { type PackageDocument, assertNotEncrypted, findOpfPath, parsePackage } from './opf';
import { normalizePath, pathFinder } from './paths';
import { type RawTocEntry, parseLandmarks, parseNavDocument, parseNcx } from './toc';
import { DEFAULT_LIMITS, EpubError, type UnzipLimits, decodeText, looksLikeZip, unzipEpub } from './zip';
import { BOOK_NODES, attr, elements, firstElement, parseXml, textContent, withBookBudget } from './xml';

export interface BuiltSection {
  readonly index: number;
  readonly path: string;
  readonly linear: boolean;
  readonly textLength: number;
  readonly title: string | null;
  readonly idOffsets: ReadonlyMap<string, number>;
  readonly boilerplate: readonly BoilerplateRange[];
  /** What the document says its parts are (`epub:type`, roles), over their text (NormalizedSection.matter). */
  readonly matter: readonly MatterRange[];
}

export interface BuiltTocEntry {
  readonly title: string;
  /** Container path of the target section plus fragment, as the reader should request it. */
  readonly href: string;
  readonly section: number;
  readonly offset: number;
  readonly depth: number;
  /** Its place holds nothing but its title: the next entry's text follows it at once (D77). */
  readonly alone: boolean;
  /** It names a picture: the heading it points at repeats the description of the picture right above (D77). */
  readonly caption: boolean;
}

/** An entry's place is read only this far to tell whether it holds more than its title. */
const ALONE_READ = 600;
/** Letters and digits beyond its title an entry's place may hold and still hold only its title ("BY", "BEING"). */
const ALONE_SLACK = 12;

const letters = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, '').length;

/**
 * What each entry's place holds (D77), from the sections' text: nothing but its title, up to the
 * next entry; or the caption of the picture above it.
 */
function withHints(
  toc: readonly Omit<BuiltTocEntry, 'alone' | 'caption'>[],
  sections: readonly BuiltSection[],
  docOf: (path: string) => { readonly text: string; readonly afterPicture: ReadonlyMap<string, string> } | null,
): BuiltTocEntry[] {
  const starts: number[] = [];
  let total = 0;
  for (const s of sections) {
    starts.push(total);
    total += s.textLength;
  }
  const at = toc.map((e) => starts[e.section]! + e.offset);
  const ordered = [...at].sort((a, b) => a - b);
  /** The first index of an increasing list whose value is greater than `value`. */
  const after = (list: readonly number[], value: number) => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]! > value) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  /** The text from `from` to `to` (a few hundred characters at most), across sections. */
  const textBetween = (from: number, to: number) => {
    let out = '';
    for (let i = Math.max(0, after(starts, from) - 1); i < sections.length && starts[i]! < to; i++) {
      const s = sections[i]!;
      const start = starts[i]!;
      if (start + s.textLength <= from) continue;
      out += (docOf(s.path)?.text ?? '').slice(Math.max(0, from - start), Math.min(s.textLength, to - start));
    }
    return out;
  };
  return toc.map((e, i) => {
    const m = at[i]!;
    // The next place an entry starts at, past this one (entries at one place share it).
    const next = ordered[after(ordered, m)] ?? total;
    const alone = next - m <= ALONE_READ && letters(textBetween(m, next)) <= letters(e.title) + ALONE_SLACK;
    const fragment = e.href.includes('#') ? e.href.slice(e.href.indexOf('#') + 1) : null;
    const picture = fragment ? docOf(sections[e.section]!.path)?.afterPicture.get(fragment) : undefined;
    const caption = picture !== undefined && normalizeTitle(picture) !== '' && normalizeTitle(picture) === normalizeTitle(e.title);
    return { ...e, alone, caption };
  });
}

export interface BuiltPublication {
  readonly metadata: {
    readonly title: string;
    readonly author: string;
    readonly authors: readonly string[];
    readonly language: string;
    readonly description: string;
    readonly publisher: string;
    readonly identifier: string;
    readonly direction: 'ltr' | 'rtl';
  };
  readonly cover: { readonly path: string; readonly mediaType: string; readonly bytes: Uint8Array } | null;
  readonly sections: readonly BuiltSection[];
  readonly toc: readonly BuiltTocEntry[];
  /**
   * The story inside the linear measure (characters), excluding Gutenberg's header and licence and
   * what the book marks as no part of it before and after it (storyRange).
   */
  readonly story: { readonly start: number; readonly end: number };
  /** The book's own matter right after the story, as it marks it (its colophon, notes, appendices), or null. */
  readonly backMatter: { readonly start: number; readonly end: number } | null;
  /** Every file to serve, keyed by container path: sanitised documents and original resources. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly mediaTypes: ReadonlyMap<string, string>;
}

const encoder = new TextEncoder();

const MEDIA_BY_EXT: Record<string, string> = {
  xhtml: 'application/xhtml+xml', html: 'application/xhtml+xml', htm: 'application/xhtml+xml',
  css: 'text/css', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', otf: 'font/otf', ttf: 'font/ttf', woff: 'font/woff',
  woff2: 'font/woff2', ncx: 'application/x-dtbncx+xml', opf: 'application/oebps-package+xml',
};

export function mediaTypeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_BY_EXT[ext] ?? 'application/octet-stream';
}

function isDocumentType(mediaType: string): boolean {
  return mediaType === 'application/xhtml+xml' || mediaType === 'text/html';
}

/** Files served as they are: pictures and fonts (nothing a browser runs). */
const RAW_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'font/otf', 'font/ttf', 'font/woff', 'font/woff2']);

/** Every media type a publication file is ever served as. */
export const SERVED_MEDIA_TYPES: ReadonlySet<string> = new Set(['application/xhtml+xml', 'text/css', 'image/svg+xml', ...RAW_TYPES]);

/** Files we never serve: scripts, the package and navigation control files, DRM metadata. */
function servable(path: string, mediaType: string): boolean {
  if (path.startsWith('META-INF/')) return false;
  if (/\.(js|mjs|cjs)$/i.test(path) || mediaType.includes('javascript')) return false;
  if (mediaType === 'application/oebps-package+xml' || /\.opf$/i.test(path)) return false;
  return true;
}

/** The story's range without Gutenberg's header and licence (D26). */
function gutenbergRange(sections: readonly BuiltSection[]): { start: number; end: number } {
  const total = sections.reduce((s, x) => s + x.textLength, 0);
  if (total === 0) return { start: 0, end: 0 };
  const intervals: BoilerplateRange[] = [];
  let at = 0;
  for (const s of sections) {
    for (const b of s.boilerplate) intervals.push({ start: at + b.start, end: at + b.end });
    at += s.textLength;
  }
  let start = 0;
  let end = total;
  for (const b of intervals) {
    if (b.start <= total * 0.2) start = Math.max(start, b.end);
  }
  for (const b of intervals) {
    if (b.end >= total * 0.6 && b.start >= start) end = Math.min(end, b.start);
  }
  if (!(end > start)) return { start: 0, end: total };
  return { start, end };
}

/** What the guide or the landmarks say a document of the reading order is, from its start (D109). */
export interface SectionMark {
  readonly section: number;
  /** Its types, as matter.ts knows them ("colophon", "bodymatter"). */
  readonly types: readonly string[];
}

/**
 * A mark of the guide or the landmarks says what a document is, not where that ends: it is taken
 * for the document only where its contents list nothing further into it than this (its heading).
 */
const MARKED_ALONE = 200;

/** The most of a book a document the guide or the landmarks name as matter around the story may hold (a title page, a colophon). */
const MARKED_SHORT = 0.05;

/** The least of the story (Gutenberg's range) that what the book marks around its story may leave. */
const MIN_STORY_SHARE = 0.5;

/** A stretch of a section's text with one meaning for the story range. */
interface Stretch {
  /** In the linear measure. */
  readonly start: number;
  readonly end: number;
  readonly matter: Matter | null;
  /** Nothing to read (space, a picture, Gutenberg's boilerplate): it neither starts nor stops a run. */
  readonly transparent: boolean;
}

/** A typed element open at a place, with what it and the elements around it make that place (matterOf, worked out once). */
interface Open {
  readonly end: number;
  /** The innermost kind it or an element around it says (kindOf). */
  readonly kind: Matter | null;
  /** The innermost partition it or an element around it says (partitionOf). */
  readonly partition: Matter | null;
}

/**
 * A section's stretches in reading order: its text cut wherever a typed element or Gutenberg's
 * boilerplate starts or ends, each stretch with what the types around it make it (matterOf: the
 * innermost element's first, out to the body's, then the document's marks and the partition it is
 * in). Typed elements come from a document's serialisation, so they nest: one sweep with a stack of
 * the elements open at each cut, each knowing what it and those around it say, finds every
 * stretch's in time that does not grow with how deep they nest.
 */
function stretchesOf(section: BuiltSection, base: number, text: string, marks: readonly string[], partition: readonly string[]): Stretch[] {
  if (section.textLength === 0) return [];
  const points = new Set<number>([0, section.textLength]);
  for (const r of section.matter) points.add(r.start).add(r.end);
  for (const b of section.boilerplate) points.add(b.start).add(b.end);
  const cuts = [...points].filter((x) => x >= 0 && x <= section.textLength).sort((a, b) => a - b);
  // By where they start, the outer of two that start together first (NormalizedSection.matter).
  const ranges = section.matter;
  const open: Open[] = [];
  const marked = kindOf(marks);
  const partitioned = partitionOf(partition);
  let next = 0;
  let boiler = 0;
  const out: Stretch[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k]!;
    const b = cuts[k + 1]!;
    while (open.length > 0 && open[open.length - 1]!.end <= a) open.pop();
    while (next < ranges.length && ranges[next]!.start <= a) {
      const r = ranges[next++]!;
      if (r.end <= a) continue;
      const around = open[open.length - 1];
      open.push({ end: r.end, kind: kindOf(r.types) ?? around?.kind ?? null, partition: partitionOf(r.types) ?? around?.partition ?? null });
    }
    while (boiler < section.boilerplate.length && section.boilerplate[boiler]!.end <= a) boiler++;
    const inBoilerplate = boiler < section.boilerplate.length && section.boilerplate[boiler]!.start <= a;
    const inner = open[open.length - 1];
    const said = inner?.kind ?? marked ?? inner?.partition ?? partitioned;
    // A document outside the reading order (linear="no") is not the story where it opens or ends the book (D26).
    const matter = section.linear || said === 'story' ? said : 'around';
    out.push({ start: base + a, end: base + b, matter, transparent: inBoilerplate || !/[\p{L}\p{N}]/u.test(text.slice(a, b)) });
  }
  return out;
}

/**
 * The story inside the linear measure, and the book's own matter right after it (D26, D109).
 * Gutenberg's boilerplate lies outside the story, as before. So does what the book itself marks
 * as no part of its story where it opens or ends the book: before the story, a title page, an
 * imprint, a copyright page, its printed contents; after it, those, its colophon and its licence,
 * its notes and appendices, an afterword, acknowledgments, about the author, a preview of another
 * book. What the book marks as reading (a preface, a dedication) or as story (an epilogue in its
 * back matter) stops the cut, and so does anything it does not mark: only the runs of marked
 * matter at the very start and the very end go, never what lies between stretches of story, and
 * never so much that less than half of the story would be left (marks gone wrong). The marks are
 * the documents' own types (`epub:type` on `<body>` and the elements in it, DPUB-ARIA roles), then
 * what the landmarks and EPUB 2's guide say of a document, then the partition (front, body or back
 * matter) the landmarks put it in.
 */
function storyRange(
  sections: readonly BuiltSection[],
  marks: readonly SectionMark[],
  toc: readonly { readonly section: number; readonly offset: number }[],
  textOf: (section: BuiltSection) => string,
): { story: { start: number; end: number }; backMatter: { start: number; end: number } | null } {
  const gutenberg = gutenbergRange(sections);
  const starts: number[] = [];
  let total = 0;
  for (const s of sections) {
    starts.push(total);
    total += s.textLength;
  }
  // Each document's marks, looked up once: a guide or a navigation document may hold any number.
  const bySection = new Map<number, string[]>();
  for (const m of marks) {
    const list = bySection.get(m.section);
    if (list) list.push(...m.types);
    else bySection.set(m.section, [...m.types]);
  }
  // A document whose contents list more of it than its heading holds more than a mark can say.
  const listedInside = new Set(toc.filter((e) => e.offset > MARKED_ALONE).map((e) => e.section));
  // A partition the landmarks start at a document runs on to the next one they start.
  const kinds: (readonly string[])[] = [];
  const partitions: (readonly string[])[] = [];
  let partition: readonly string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const here = bySection.get(i) ?? [];
    if (here.some(isPartition)) partition = here.filter(isPartition);
    // A title page, an imprint, a copyright page, a colophon, the printed contents is short: a mark
    // naming one on a long document, or naming a cover (a picture, set at the top of a title page or
    // a first chapter), says what it starts with, not what it is.
    const small = sections[i]!.textLength <= MARKED_SHORT * total;
    kinds.push(listedInside.has(i) ? [] : here.filter((t) => !isPartition(t) && t !== 'cover' && (small || matterKind(t) !== 'around')));
    partitions.push(listedInside.has(i) ? [] : partition);
  }
  const stretches = (i: number) => stretchesOf(sections[i]!, starts[i]!, textOf(sections[i]!), kinds[i]!, partitions[i]!);

  // From the start: what is marked as no part of the story, up to the first stretch that may be. The
  // story starts no later than the document that stretch is in (where its contents entry points).
  let start = 0;
  let front = false;
  leading: for (let i = 0; i < sections.length; i++) {
    for (const s of stretches(i)) {
      if (s.transparent) continue;
      if (s.matter !== 'around') {
        if (front) start = Math.max(start, starts[i]!);
        break leading;
      }
      front = true;
      start = s.end;
    }
  }
  // From the end: what is marked as no part of the story, or as what follows it, back to the story,
  // which ends no earlier than the document of its last stretch does.
  let end = total;
  let backEnd: number | null = null;
  trailing: for (let i = sections.length - 1; i >= 0; i--) {
    const own = stretches(i);
    for (let k = own.length - 1; k >= 0; k--) {
      const s = own[k]!;
      if (s.transparent) continue;
      if (s.matter !== 'around' && s.matter !== 'back') {
        if (backEnd !== null) end = Math.min(end, starts[i]! + sections[i]!.textLength);
        break trailing;
      }
      // The book's own matter after the story runs to the end of the document it ends in.
      backEnd ??= starts[i]! + sections[i]!.textLength;
      end = s.start;
    }
  }
  const marked = { start: Math.max(gutenberg.start, start), end: Math.min(gutenberg.end, end) };
  const moved = marked.start !== gutenberg.start || marked.end !== gutenberg.end;
  if (!moved || marked.end - marked.start < MIN_STORY_SHARE * (gutenberg.end - gutenberg.start)) return { story: gutenberg, backMatter: null };
  const back = backEnd !== null && marked.end === end && backEnd > end ? { start: end, end: Math.min(backEnd, gutenberg.end) } : null;
  return { story: marked, backMatter: back && back.end > back.start ? back : null };
}

/** What the landmarks of the navigation document and the package's guide say documents of the reading order are (D109). */
function sectionMarks(container: ReadonlyMap<string, Uint8Array>, pkg: PackageDocument, sections: readonly BuiltSection[]): SectionMark[] {
  const raw: { path: string; fragment: string | null; types: readonly string[] }[] = pkg.guide.map((g) => ({ path: g.path, fragment: g.fragment, types: [g.type] }));
  const nav = pkg.navPath ? container.get(pkg.navPath) : undefined;
  if (pkg.navPath && nav) for (const landmark of parseLandmarks(decodeText(nav), pkg.navPath)) raw.push(landmark);
  const byPath = new Map<string, BuiltSection>();
  for (const s of sections) if (!byPath.has(s.path)) byPath.set(s.path, s);
  const find = pathFinder(byPath);
  const out: SectionMark[] = [];
  for (const mark of raw) {
    const path = find(mark.path);
    const section = path ? byPath.get(path) : undefined;
    // From the document's start only: a mark further into a document says nothing of the rest of it.
    if (!section || (mark.fragment !== null && section.idOffsets.get(mark.fragment) !== 0)) continue;
    const types = mark.types.map(normalizeMatterType).filter((t): t is string => t !== null);
    if (types.length > 0) out.push({ section: section.index, types });
  }
  return out;
}

/**
 * Most entries a publication's contents keep: room for any real book's (a Bible's books and
 * chapters are some 1,250), and a bound on what every reader is sent. It is five times the units
 * an edition keeps, which the server takes from these entries by the same rule as
 * {@link keepShallowest}, so cutting the contents here changes none of them.
 */
export const MAX_TOC_ENTRIES = 5 * MAX_EDITION_UNITS;

/**
 * At most `max` entries of a table of contents: when there are more, the deepest levels go first,
 * as many as must, then the tail of what is left (a level that alone has too many).
 */
export function keepShallowest<T extends { readonly depth: number }>(entries: readonly T[], max: number): readonly T[] {
  if (entries.length <= max) return entries;
  const perDepth = new Map<number, number>();
  for (const e of entries) perDepth.set(e.depth, (perDepth.get(e.depth) ?? 0) + 1);
  const depths = [...perDepth.keys()].sort((a, b) => a - b);
  let deepest = depths[0]!;
  let count = perDepth.get(deepest)!;
  for (const depth of depths.slice(1)) {
    count += perDepth.get(depth)!;
    if (count > max) break;
    deepest = depth;
  }
  return entries.filter((e) => e.depth <= deepest).slice(0, max);
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Each entry is looked up in maps built once: a table of contents may hold tens of thousands. */
function resolveToc(raw: readonly RawTocEntry[], sections: readonly BuiltSection[]): Omit<BuiltTocEntry, 'alone' | 'caption'>[] {
  const byPath = new Map(sections.map((s) => [s.path, s] as const));
  const find = pathFinder(byPath);
  // Last resort for broken books: same file name in another folder (the first section of that name).
  const byFileName = new Map<string, BuiltSection>();
  for (const s of sections) {
    const name = fileName(s.path);
    if (!byFileName.has(name)) byFileName.set(name, s);
  }
  const out: Omit<BuiltTocEntry, 'alone' | 'caption'>[] = [];
  for (const entry of raw) {
    const exact = find(entry.path);
    const section = (exact ? byPath.get(exact) : undefined) ?? byFileName.get(fileName(entry.path));
    if (!section) continue;
    const offset = entry.fragment ? section.idOffsets.get(entry.fragment) ?? 0 : 0;
    out.push({
      title: entry.title,
      href: entry.fragment ? `${section.path}#${entry.fragment}` : section.path,
      section: section.index,
      offset,
      depth: entry.depth,
    });
  }
  return out;
}

/** A table of contents from section titles, for books that ship without one. */
function syntheticToc(sections: readonly BuiltSection[]): Omit<BuiltTocEntry, 'alone' | 'caption'>[] {
  return sections
    .filter((s) => s.linear && s.textLength > 0 && s.title)
    .map((s) => ({ title: s.title!, href: s.path, section: s.index, offset: 0, depth: 0 }));
}

function readToc(container: ReadonlyMap<string, Uint8Array>, pkg: PackageDocument): RawTocEntry[] {
  if (pkg.navPath) {
    const nav = container.get(pkg.navPath);
    if (nav) {
      const entries = parseNavDocument(decodeText(nav), pkg.navPath);
      if (entries.length > 0) return entries;
    }
  }
  if (pkg.ncxPath) {
    const ncx = container.get(pkg.ncxPath);
    if (ncx) return parseNcx(decodeText(ncx), pkg.ncxPath);
  }
  return [];
}

/** The cover: declared cover image, else the first image of the first spine document. */
function findCover(container: ReadonlyMap<string, Uint8Array>, pkg: PackageDocument, find: (path: string) => string | null) {
  const declared = pkg.coverPath ? find(pkg.coverPath) : null;
  if (declared) {
    const item = [...pkg.manifest.values()].find((i) => i.path === pkg.coverPath);
    return { path: declared, mediaType: item?.mediaType || mediaTypeForPath(declared), bytes: container.get(declared)! };
  }
  const first = pkg.spine[0];
  const bytes = first ? container.get(first.path) : undefined;
  if (!first || !bytes) return null;
  const doc = parseXml(decodeText(bytes));
  for (const el of elements(doc)) {
    const name = el.name.toLowerCase();
    const src = name.endsWith('img') ? attr(el, 'src') : name.endsWith('image') ? attr(el, 'href') : undefined;
    if (!src) continue;
    try {
      const dir = first.path.includes('/') ? first.path.slice(0, first.path.lastIndexOf('/') + 1) : '';
      const path = find(normalizePath(dir + src.split('#')[0]));
      if (path && mediaTypeForPath(path).startsWith('image/')) return { path, mediaType: mediaTypeForPath(path), bytes: container.get(path)! };
    } catch {
      // unsafe path, ignore
    }
  }
  return null;
}

export interface BuildOptions {
  readonly limits?: UnzipLimits;
  /** Nodes, attributes and closing tags all the book's documents may hold together (BOOK_NODES). */
  readonly bookNodes?: number;
}

/**
 * Turn an uploaded EPUB into a sanitised publication: metadata, cover, sections with exact text
 * lengths, a resolved table of contents, the story range, and the files to serve.
 */
export function buildPublication(bytes: Uint8Array, options: BuildOptions = {}): BuiltPublication {
  return withBookBudget(options.bookNodes ?? BOOK_NODES, () => build(bytes, options));
}

function build(bytes: Uint8Array, options: BuildOptions): BuiltPublication {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const container = unzipEpub(bytes, limits);
  assertNotEncrypted(container);
  const pkg = parsePackage(container, findOpfPath(container));
  // A well-made book lists each document of its reading order once, and no archive holds more
  // files than this: a longer reading order only repeats or misses files, and would weigh on
  // every reader with its sections.
  if (pkg.spine.length > limits.maxEntries) throw new EpubError('The EPUB’s reading order is too long.', 'too-large');
  // Every picture, stylesheet and reading-order entry is looked up in the archive: in one index.
  const find = pathFinder(container);

  const sizes = new Map<string, ReturnType<typeof imageSize>>();
  const sizeOf = (path: string) => {
    const real = find(path);
    if (!real) return null;
    if (!sizes.has(real)) sizes.set(real, imageSize(container.get(real)!));
    return sizes.get(real) ?? null;
  };
  const exists = (path: string) => find(path) !== null;

  const files = new Map<string, Uint8Array>();
  const sections: BuiltSection[] = [];
  const normalizedDocs = new Map<string, ReturnType<typeof normalizeSection>>();
  const normalizeDoc = (path: string) => {
    let result = normalizedDocs.get(path);
    if (!result) {
      const source = container.get(path);
      if (!source) return null;
      result = normalizeSection(decodeText(source), { sectionPath: path, exists, imageSize: sizeOf });
      normalizedDocs.set(path, result);
    }
    return result;
  };

  pkg.spine.forEach((item, index) => {
    const real = find(item.path);
    const normalized = real ? normalizeDoc(real) : null;
    sections.push({
      index,
      path: real ?? item.path,
      linear: item.linear,
      textLength: normalized?.textLength ?? 0,
      title: normalized?.title ?? null,
      idOffsets: normalized?.idOffsets ?? new Map(),
      boilerplate: normalized?.boilerplate ?? [],
      matter: normalized?.matter ?? [],
    });
  });
  if (sections.every((s) => s.textLength === 0) && !sections.some((s) => container.has(s.path))) {
    throw new EpubError('The EPUB reading order points at files that are not in the archive.', 'malformed');
  }

  // What each file is served as is decided here, never taken from the upload's own manifest: an
  // item of the reading order is always a (sanitised) document; anything else goes by its
  // extension, and only documents, styles, pictures and fonts are served at all.
  const spine = new Set(sections.map((s) => s.path));
  const mediaTypes = new Map<string, string>();
  for (const [path, data] of container) {
    const mediaType = spine.has(path) ? 'application/xhtml+xml' : mediaTypeForPath(path);
    if (!servable(path, mediaType)) continue;
    if (isDocumentType(mediaType)) {
      const normalized = normalizeDoc(path);
      if (!normalized) continue;
      files.set(path, encoder.encode(normalized.xhtml));
      mediaTypes.set(path, 'application/xhtml+xml');
    } else if (mediaType === 'text/css') {
      files.set(path, encoder.encode(sanitizeCss(decodeText(data))));
      mediaTypes.set(path, mediaType);
    } else if (mediaType === 'image/svg+xml') {
      const clean = sanitizeSvg(decodeText(data));
      if (!clean) continue;
      files.set(path, encoder.encode(clean));
      mediaTypes.set(path, mediaType);
    } else if (RAW_TYPES.has(mediaType)) {
      files.set(path, data);
      mediaTypes.set(path, mediaType);
    }
  }

  const rawToc = readToc(container, pkg);
  let toc = resolveToc(rawToc, sections);
  if (toc.length === 0) toc = syntheticToc(sections);
  const { story, backMatter } = storyRange(sections, sectionMarks(container, pkg, sections), toc, (section) => normalizedDocs.get(section.path)?.text ?? '');

  const authors = pkg.metadata.authors;
  return {
    metadata: {
      title: pkg.metadata.title || sections.find((s) => s.title)?.title || 'Untitled',
      author: authors.join(', '),
      authors,
      language: pkg.metadata.language,
      description: pkg.metadata.description,
      publisher: pkg.metadata.publisher,
      identifier: pkg.metadata.identifier,
      direction: pkg.direction,
    },
    cover: findCover(container, pkg, find),
    sections,
    toc: withHints(keepShallowest(toc, MAX_TOC_ENTRIES), sections, (path) => normalizedDocs.get(path) ?? null),
    story,
    backMatter,
    files,
    mediaTypes,
  };
}

export interface EpubPreview {
  readonly title: string;
  readonly author: string;
  readonly language: string;
  readonly cover: { readonly mediaType: string; readonly bytes: Uint8Array } | null;
}

/**
 * Quick metadata read for the upload form (runs in the browser): only container.xml, the OPF
 * and the cover image are inflated.
 */
export function readEpubPreview(bytes: Uint8Array): EpubPreview {
  if (!looksLikeZip(bytes)) throw new EpubError('This file is not an EPUB.', 'not-zip');
  let first: Record<string, Uint8Array>;
  try {
    first = unzipSync(bytes, { filter: (f) => f.name === 'META-INF/container.xml' || f.name === 'META-INF/encryption.xml' || /\.opf$/i.test(f.name) });
  } catch {
    throw new EpubError('The EPUB archive is damaged.', 'not-zip');
  }
  const container = new Map(Object.entries(first).map(([k, v]) => [normalizePath(k), v] as const));
  // A book locked with DRM is said so before it is uploaded, not after (the server refuses it too).
  assertNotEncrypted(container);
  const pkg = parsePackage(container, findOpfPath(container));
  let cover: EpubPreview['cover'] = null;
  if (pkg.coverPath) {
    const wanted = pkg.coverPath;
    const found = unzipSync(bytes, {
      filter: (f) => {
        try {
          return normalizePath(f.name) === wanted;
        } catch {
          return false;
        }
      },
    });
    const data = Object.values(found)[0];
    const item = [...pkg.manifest.values()].find((i) => i.path === wanted);
    if (data) cover = { mediaType: item?.mediaType || mediaTypeForPath(wanted), bytes: data };
  }
  return {
    title: pkg.metadata.title || 'Untitled',
    author: pkg.metadata.authors.join(', '),
    language: pkg.metadata.language,
    cover,
  };
}

/** First heading text of a document, used for chapter names when the TOC is missing. */
export function firstHeading(source: string): string | null {
  const doc = parseXml(source);
  const body = firstElement(doc, 'body') ?? doc;
  for (const el of elements(body)) {
    if (/^h[1-6]$/.test(el.name.toLowerCase())) {
      const t = textContent(el).replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
  }
  return null;
}
