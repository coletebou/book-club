import { type AnyNode, type ChildNode, type Document, DomHandler, Element, isCDATA, isTag, isText } from 'domhandler';
import { decodeHTML } from 'entities/decode';
import { Parser } from 'htmlparser2';
import { EpubError } from './zip';

/** What one document may hold; past it, the document is refused rather than parsed. */
export interface XmlLimits {
  /** Deepest nesting of elements. */
  readonly maxDepth: number;
  /** Most nodes (elements, text, comments and the rest) and attributes, together. */
  readonly maxNodes: number;
}

/**
 * The limits of a document from a book. Real books nest a few dozen levels deep and hold far
 * fewer nodes and attributes in any one document, so anything past these was made to cost: the
 * parser searches its stack of open elements at every closing tag and shifts all of it at every
 * opening one, so its time per tag grows with the depth, and a parsed node takes some 220 bytes.
 */
export const XML_LIMITS: XmlLimits = { maxDepth: 1024, maxNodes: 1_000_000 };

/**
 * No limits, for documents this package wrote itself (normalised sections): measuring one again
 * must never fail, whatever it holds, or a book read before these limits would lose its text.
 */
export const OWN_DOCUMENT: XmlLimits = { maxDepth: Infinity, maxNodes: Infinity };

/**
 * Nodes, attributes and closing tags all the documents of one book may hold together. Each document
 * is limited on its own, but a book of many documents just inside that limit, nested deep, would
 * still keep its reader busy for minutes. War and Peace holds some 40,000 tags in all.
 */
export const BOOK_NODES = 5_000_000;

/** What the book being read has left of its budget (withBookBudget), if one is being read. */
let book: { left: number } | null = null;

/** Run `read` with one budget of nodes shared by every document it parses (one book's). */
export function withBookBudget<T>(total: number, read: () => T): T {
  const outer = book;
  book = { left: total };
  try {
    return read();
  } finally {
    book = outer;
  }
}

function spend(n: number): void {
  if (book && (book.left -= n) < 0) throw new EpubError('The EPUB holds too much to read.', 'too-large');
}

/** The DOM builder of `parseDocument`, refusing a document past its limits as it goes. */
class LimitedHandler extends DomHandler {
  private nodes = 0;

  constructor(private readonly limits: XmlLimits) {
    super(undefined, { xmlMode: true });
  }

  override onopentag(name: string, attribs: Record<string, string>): void {
    // The stack holds the document and every element open around this one.
    if (this.tagStack.length > this.limits.maxDepth) throw new EpubError('The EPUB has a document nested too deeply to read.', 'too-large');
    super.onopentag(name, attribs);
  }

  /** Each attribute, as the parser reads it: one element may carry any number of them. */
  onattribute(): void {
    this.count();
  }

  protected override addNode(node: ChildNode): void {
    this.count();
    super.addNode(node);
  }

  private count(): void {
    if (++this.nodes > this.limits.maxNodes) throw new EpubError('The EPUB has a document too large to read.', 'too-large');
    if (this.limits !== OWN_DOCUMENT) spend(1);
  }
}

/**
 * The closing tags in `source`, refused past the document's limit. One that matches nothing open is
 * never reported to the DOM builder, yet the parser looks through its whole stack of open elements
 * for it, so they are counted before parsing. A real document closes no more tags than it has
 * elements, so this refuses nothing the node limit lets through.
 */
function countClosingTags(source: string, limits: XmlLimits): void {
  if (limits === OWN_DOCUMENT) return;
  let closing = 0;
  for (let at = source.indexOf('</'); at !== -1; at = source.indexOf('</', at + 2)) {
    if (++closing > limits.maxNodes) throw new EpubError('The EPUB has a document too large to read.', 'too-large');
  }
  spend(closing);
}

/**
 * Parse XML or XHTML leniently. Entities are left encoded by the tokenizer and decoded by us
 * with the full HTML table, because EPUB XHTML routinely uses `&nbsp;`-style named entities that
 * an XML parser without the DTD would reject or leave undecoded.
 */
export function parseXml(source: string, limits: XmlLimits = XML_LIMITS): Document {
  countClosingTags(source, limits);
  const handler = new LimitedHandler(limits);
  new Parser(handler, { xmlMode: true, decodeEntities: false, recognizeSelfClosing: true, recognizeCDATA: true }).end(source);
  return handler.root;
}

/** Decode entities in raw text or attribute values. */
export function decodeEntities(raw: string): string {
  return raw.includes('&') ? decodeHTML(raw) : raw;
}

/** Local name of an element (`dc:title` → `title`), lowercased. */
export function localName(el: Element): string {
  const name = el.name;
  const colon = name.indexOf(':');
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

/** Attribute by local name, ignoring any namespace prefix (`epub:type` matches `type`). */
export function attr(el: Element, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(el.attribs)) {
    const k = key.toLowerCase();
    const local = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k;
    if (k === wanted || local === wanted) return decodeEntities(value);
  }
  return undefined;
}

/** Exact attribute name match (keeps prefixes: `epub:type` vs `type`). */
export function attrExact(el: Element, name: string): string | undefined {
  const value = el.attribs[name];
  return value === undefined ? undefined : decodeEntities(value);
}

/**
 * Every node under `node`, itself first, in document order. A stack rather than recursion: each
 * node costs the same however deep it lies (nested generators passed every node up through each
 * level above it).
 */
export function* walk(node: AnyNode): Generator<AnyNode> {
  const stack: AnyNode[] = [node];
  while (stack.length > 0) {
    const next = stack.pop()!;
    yield next;
    if ('children' in next) for (let i = next.children.length - 1; i >= 0; i--) stack.push(next.children[i]!);
  }
}

export function elements(root: AnyNode, local?: string): Element[] {
  const out: Element[] = [];
  for (const n of walk(root)) if (isTag(n) && (local === undefined || localName(n) === local)) out.push(n);
  return out;
}

export function firstElement(root: AnyNode, local: string): Element | undefined {
  for (const n of walk(root)) if (isTag(n) && localName(n) === local) return n;
  return undefined;
}

/**
 * The first element named `local` below `root` that is not inside an element named `fence` (the
 * label of an NCX navPoint, not that of a point within it). Each such element is searched in its
 * own part of the tree only, so searching every one of them costs no more than the tree does.
 */
export function ownElement(root: Element, local: string, fence: string): Element | undefined {
  const stack: AnyNode[] = [...root.children].reverse();
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (!isTag(next)) continue;
    const name = localName(next);
    if (name === local) return next;
    if (name !== fence) for (let i = next.children.length - 1; i >= 0; i--) stack.push(next.children[i]!);
  }
  return undefined;
}

export function childElements(el: Element | Document, local?: string): Element[] {
  return el.children.filter((c): c is Element => isTag(c) && (local === undefined || localName(c) === local));
}

/** Decoded text content of a subtree. */
export function textContent(node: AnyNode): string {
  let out = '';
  for (const n of walk(node)) {
    if (isText(n)) out += decodeEntities(n.data);
  }
  return out;
}

export function isElement(node: ChildNode | AnyNode): node is Element {
  return node instanceof Element;
}

export { isCDATA, isTag, isText };
