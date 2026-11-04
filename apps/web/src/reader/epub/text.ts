/**
 * Text offsets inside a rendered section. The offset of a position is the number of UTF-16 code
 * units of `<body>` text before it, counting every text node in document order: exactly the
 * measure the server recorded when it normalised the section (packages/epub normalize.ts).
 */
export interface TextIndex {
  readonly nodes: readonly Text[];
  /** Offset at which each node starts. */
  readonly starts: readonly number[];
  readonly length: number;
}

export function buildTextIndex(doc: Document): TextIndex {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let length = 0;
  const body = doc.body ?? doc.getElementsByTagName('body')[0];
  if (!body) return { nodes, starts, length };
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    nodes.push(t);
    starts.push(length);
    length += t.data.length;
  }
  return { nodes, starts, length };
}

/** Index of the node containing `offset` (the last node starting at or before it). */
function nodeIndexFor(index: TextIndex, offset: number): number {
  let lo = 0;
  let hi = index.nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface DomPoint {
  readonly node: Text;
  readonly offset: number;
}

/** DOM position of a text offset (clamped to the section). */
export function pointAt(index: TextIndex, offset: number): DomPoint | null {
  if (index.nodes.length === 0) return null;
  const clamped = Math.max(0, Math.min(offset, index.length));
  let i = nodeIndexFor(index, clamped);
  // Prefer the start of the next node over the end of an empty one.
  while (i < index.nodes.length - 1 && index.starts[i + 1] === clamped && index.nodes[i]!.data.length === clamped - index.starts[i]!) i++;
  const node = index.nodes[i]!;
  return { node, offset: Math.min(node.data.length, clamped - index.starts[i]!) };
}

/** Text offset of a DOM boundary point (any container/offset pair, e.g. from a Selection). */
export function offsetOfPoint(doc: Document, container: Node, offset: number): number {
  const body = doc.body ?? doc.getElementsByTagName('body')[0];
  if (!body) return 0;
  if (!body.contains(container) && container !== body) return container.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING ? 0 : buildTextIndex(doc).length;
  const range = doc.createRange();
  range.setStart(body, 0);
  range.setEnd(container, offset);
  return range.toString().length;
}

/** A DOM range covering text offsets [start, end). */
export function rangeFor(doc: Document, index: TextIndex, start: number, end: number): Range | null {
  const a = pointAt(index, start);
  const b = pointAt(index, Math.max(start, end));
  if (!a || !b) return null;
  const range = doc.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

/** The text between two offsets (for quotes). */
export function textBetween(index: TextIndex, start: number, end: number): string {
  let out = '';
  for (let i = 0; i < index.nodes.length; i++) {
    const s = index.starts[i]!;
    const data = index.nodes[i]!.data;
    const e = s + data.length;
    if (e <= start) continue;
    if (s >= end) break;
    out += data.slice(Math.max(0, start - s), Math.min(data.length, end - s));
  }
  return out;
}
