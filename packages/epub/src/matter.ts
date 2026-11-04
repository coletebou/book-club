import { type Element } from 'domhandler';
import { decodeEntities } from './xml';

/**
 * What a book marks a part of itself as, read for its story range (D26, D109): its own words for
 * its parts, in EPUB 3's `epub:type` (the Structural Semantics Vocabulary), the DPUB-ARIA roles
 * (`doc-colophon`), EPUB 2's guide and the landmarks of its navigation document.
 *
 * - `story`: the story itself (a chapter, a part, an epilogue; the body matter).
 * - `around`: matter that is never the story, before or after it: a title page, an imprint, a
 *   copyright page, a colophon, the printed contents.
 * - `back`: matter that follows the story and is not it: notes, appendices, an afterword,
 *   acknowledgments, an index, about the author, a preview of another book; the back matter.
 * - `neutral`: front matter that is reading, kept in the story: a preface, a foreword, a
 *   dedication, an epigraph, an introduction; the front matter as a whole.
 */
export type Matter = 'story' | 'around' | 'back' | 'neutral';

/** A stretch of a section's text the book types (an element with an `epub:type` or a role it gives). */
export interface MatterRange {
  readonly start: number;
  readonly end: number;
  /** How many elements it lies inside, under `<body>` (the body itself is 0). */
  readonly depth: number;
  /** Its types, as {@link matterTypes} reads them. */
  readonly types: readonly string[];
}

/** The partitions of a publication (EPUB 3 Structural Semantics, "Document partitions"). */
const PARTITIONS: ReadonlyMap<string, Matter> = new Map([
  ['bodymatter', 'story'],
  ['backmatter', 'back'],
  ['frontmatter', 'neutral'],
]);

/** Every other type a part of a book can say it is, and what that makes it. */
const KINDS: ReadonlyMap<string, Matter> = new Map(
  Object.entries({
    // The story: its divisions, and what opens or closes it as part of it.
    story: ['chapter', 'part', 'volume', 'division', 'subchapter', 'prologue', 'epilogue', 'conclusion'],
    // Never the story, at either end.
    around: [
      'cover', 'titlepage', 'halftitlepage', 'imprint', 'imprimatur', 'copyright-page', 'seriespage', 'toc', 'toc-brief',
      'landmarks', 'loa', 'loi', 'lot', 'lov', 'page-list', 'colophon', 'credits', 'other-credits', 'contributors', 'errata',
      'revision-history',
    ],
    // After the story, and not it. Endnotes are reached from the story by its links, and stay readable
    // there; an appendix is supplementary by definition (the vocabulary's own word), read after the
    // story or consulted, so "100%" comes at the story's last words, not the last appendix's. Then the
    // names publishers give what they add after the story, outside the vocabulary.
    back: [
      'endnotes', 'endnote', 'rearnotes', 'rearnote', 'footnotes', 'footnote', 'appendix', 'afterword', 'acknowledgments',
      'bibliography', 'glossary', 'index', 'about-the-author', 'about-author', 'author-bio', 'teaser', 'excerpt', 'preview',
      'advertisement', 'adcard', 'also-by',
    ],
    // Front matter that is reading.
    neutral: ['foreword', 'preface', 'introduction', 'preamble', 'dedication', 'epigraph', 'abstract'],
  } satisfies Record<Matter, string[]>).flatMap(([matter, types]) => types.map((t) => [t, matter as Matter] as const)),
);

/** The same types under the names EPUB 2's guide and DPUB-ARIA give them. */
const SYNONYMS: ReadonlyMap<string, string> = new Map([
  ['title-page', 'titlepage'],
  ['acknowledgements', 'acknowledgments'],
  ['notes', 'endnotes'],
  ['pagelist', 'page-list'],
  // EPUB 2's guide: where the text of the book starts.
  ['text', 'bodymatter'],
]);

/**
 * A type as this module knows it, or null: lower case, without the prefix of the vocabulary it is
 * from (`z3998:`, a guide's `other.`), a role's `doc-`, and under its usual name.
 */
export function normalizeMatterType(raw: string): string | null {
  let token = raw.trim().toLowerCase();
  token = token.slice(token.lastIndexOf(':') + 1);
  if (token.startsWith('other.')) token = token.slice('other.'.length);
  if (token.startsWith('doc-')) token = token.slice('doc-'.length);
  token = SYNONYMS.get(token) ?? token;
  return KINDS.has(token) || PARTITIONS.has(token) ? token : null;
}

/**
 * The types an element gives itself, in its `epub:type` and its role, that this module knows. Read
 * for every element of a book: the attributes are looked up by their names (XHTML's are written in
 * lower case), not walked.
 */
export function matterTypes(el: Element): string[] {
  const a = el.attribs;
  const said = [a['epub:type'], a['ops:type'], a.role];
  if (said[0] === undefined && said[1] === undefined && said[2] === undefined) return [];
  const out: string[] = [];
  for (const value of said) {
    if (value === undefined) continue;
    for (const raw of decodeEntities(value).split(/\s+/)) {
      const token = raw && normalizeMatterType(raw);
      if (token && !out.includes(token)) out.push(token);
    }
  }
  return out;
}

/** What a part's own types say it is (the story first where they say two things), or null when none says. */
export function kindOf(types: readonly string[]): Matter | null {
  let found: Matter | null = null;
  for (const t of types) {
    const kind = KINDS.get(t);
    if (kind === 'story') return 'story';
    if (kind === 'back' || (kind === 'around' && found !== 'back') || (kind === 'neutral' && found === null)) found = kind;
  }
  return found;
}

/** The partition a part's own types put it in, or null. */
export function partitionOf(types: readonly string[]): Matter | null {
  for (const t of types) {
    const partition = PARTITIONS.get(t);
    if (partition) return partition;
  }
  return null;
}

/**
 * What a place in a book is, from the types around it, innermost first (an element's, the elements
 * around it, its document's body, what the guide or landmarks say of its document, the partition
 * the landmarks put it in). The innermost that says what kind of part it is decides (a story's
 * epilogue in the back matter is story; a chapter's own notes are notes), the story first where one
 * says two things; failing that, the innermost partition. Null where the book says nothing.
 */
export function matterOf(chain: readonly (readonly string[])[]): Matter | null {
  for (const types of chain) {
    const kind = kindOf(types);
    if (kind) return kind;
  }
  for (const types of chain) {
    const partition = partitionOf(types);
    if (partition) return partition;
  }
  return null;
}

/** What a type that is no partition makes a part of a book (KINDS), or null for a partition. */
export function matterKind(type: string): Matter | null {
  return KINDS.get(type) ?? null;
}

/** Whether a type is a partition (it says where a run of documents starts: the landmarks' and the guide's). */
export function isPartition(type: string): boolean {
  return PARTITIONS.has(type);
}
