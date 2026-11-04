import { type AnyNode, type Element, isCDATA, isTag, isText } from 'domhandler';
import { type MatterRange, matterTypes } from './matter';
import { isExternalHref, resolveHref } from './paths';
import { OWN_DOCUMENT, attr, decodeEntities, firstElement, localName, parseXml, textContent } from './xml';

/**
 * Section normalisation.
 *
 * Input: one spine document as written by the publisher (XHTML, often slightly broken).
 * Output: clean, well-formed XHTML that
 *   - contains no script, no event handlers, no `javascript:` URLs, no forms or plugins,
 *     no remote images or styles;
 *   - has explicit image dimensions and `alt` text attributes;
 *   - has exactly the text nodes we measured, so that a text offset computed here equals the
 *     offset the browser computes by walking `<body>`'s text nodes after parsing this output as
 *     `application/xhtml+xml`.
 *
 * The text measure of a section is the UTF-16 length of the concatenated data of all text nodes
 * under `<body>`, in document order, after entity decoding and XML end-of-line normalisation.
 */

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const EPUB_NS = 'http://www.idpf.org/2007/ops';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * Elements removed together with everything inside them. SVG animation elements go too: they
 * can rewrite an attribute (an `href`) after sanitising has looked at it.
 */
const DROP_WITH_CONTENT = new Set([
  'script', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'audio', 'video', 'canvas', 'base', 'input', 'select', 'textarea', 'button', 'portal', 'dialog',
  'head', 'title', 'meta', 'link', 'param', 'source', 'track', 'foreignobject',
  'set', 'animate', 'animatemotion', 'animatetransform', 'animatecolor', 'handler', 'listener',
]);

/** Elements removed but whose children are kept. */
const UNWRAP = new Set(['form', 'label', 'fieldset', 'legend', 'html', 'body', 'blink', 'marquee']);

const VOID = new Set(['area', 'br', 'col', 'hr', 'img', 'wbr']);

/** Attributes holding a URL, by local name: `href` is one whatever prefix a book gives it. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'poster', 'background', 'longdesc', 'cite', 'data', 'action']);

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export interface NormalizeContext {
  /** Container path of the section being normalised. */
  readonly sectionPath: string;
  /** Whether a container path exists (resources, other sections). */
  readonly exists: (path: string) => boolean;
  /** Intrinsic size of an image in the container, if known. */
  readonly imageSize?: (path: string) => ImageSize | null;
  /** Media type of a container path, if known. */
  readonly mediaType?: (path: string) => string | undefined;
}

export interface BoilerplateRange {
  readonly start: number;
  readonly end: number;
}

export interface NormalizedSection {
  readonly xhtml: string;
  readonly textLength: number;
  /** Element id → text offset where the element starts. */
  readonly idOffsets: ReadonlyMap<string, number>;
  /** The section's text, as its offsets count it. */
  readonly text: string;
  /**
   * Element id → the description (alt) of the picture right before the element, with only space
   * between them: a heading that repeats it is the picture's caption (D77).
   */
  readonly afterPicture: ReadonlyMap<string, string>;
  readonly title: string | null;
  readonly language: string | null;
  /** Text ranges inside Project Gutenberg boilerplate (`#pg-header`, `#pg-footer`, `.pg-boilerplate`). */
  readonly boilerplate: readonly BoilerplateRange[];
  /**
   * What the document says its parts are (D109): `<body>`'s types over all of it, and each element's
   * that gives itself one (`epub:type="colophon"`, `role="doc-chapter"`), over its text, in document order.
   */
  readonly matter: readonly MatterRange[];
  readonly removed: { readonly elements: number; readonly attributes: number };
}

/** Characters XML 1.0 forbids; a single one makes the browser refuse the whole document. */
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanXmlText(input: string): string {
  return input.replace(/\r\n?/g, '\n').replace(INVALID_XML_CHARS, '');
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dangerousUrl(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- browsers ignore control characters inside schemes
  const v = value.replace(/[\s\0-\x1f]+/g, '').toLowerCase();
  return v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html') || v.startsWith('data:application');
}

function dangerousStyle(value: string): boolean {
  // Each run of spaces can be matched one way only: two runs side by side, either taking any part
  // of the spaces, made a long run cost its length squared.
  return /expression\s*\(|javascript:|behavior\s*:|-moz-binding|url\s*\(\s*(?:['"]\s*)?(?:https?:|\/\/)/i.test(value);
}

function isBoilerplateElement(el: Element): boolean {
  const id = attr(el, 'id') ?? '';
  const cls = (attr(el, 'class') ?? '').split(/\s+/);
  return id === 'pg-header' || id === 'pg-footer' || cls.includes('pg-boilerplate');
}

interface State {
  out: string;
  length: number;
  /** The text written so far: `length` characters. */
  text: string;
  ids: Map<string, number>;
  /** The description of the last picture written, until text other than space follows it. */
  picture: string | null;
  afterPicture: Map<string, string>;
  boilerplate: BoilerplateRange[];
  matter: MatterRange[];
  /** Elements open around the one being written, under `<body>`. */
  depth: number;
  styles: string[];
  removedElements: number;
  removedAttributes: number;
  /** Namespace prefixes declared by each element on the output path from the root to the current one. */
  scopes: Set<string>[];
  /** How many of those declare each prefix, so that a lookup costs the same at any depth. */
  declared: Map<string, number>;
}

function prefixInScope(state: State, prefix: string): boolean {
  if (prefix === 'xml' || prefix === 'xmlns') return true;
  return state.declared.has(prefix);
}

function enterScope(state: State, prefixes: Set<string>): void {
  state.scopes.push(prefixes);
  for (const p of prefixes) state.declared.set(p, (state.declared.get(p) ?? 0) + 1);
}

function leaveScope(state: State): void {
  for (const p of state.scopes.pop() ?? []) {
    const left = state.declared.get(p)! - 1;
    if (left === 0) state.declared.delete(p);
    else state.declared.set(p, left);
  }
}

function declaredPrefixes(attrs: readonly [string, string][]): Set<string> {
  const out = new Set<string>();
  for (const [k] of attrs) if (k.startsWith('xmlns:')) out.add(k.slice(6));
  return out;
}

/** Drop attributes whose namespace prefix is not declared (the XML parser would reject the page). */
function scopedAttributes(attrs: [string, string][], state: State): [string, string][] {
  return attrs.filter(([k]) => {
    const colon = k.indexOf(':');
    if (colon === -1) return true;
    const ok = prefixInScope(state, k.slice(0, colon));
    if (!ok) state.removedAttributes++;
    return ok;
  });
}

/**
 * The namespaces a book may give a prefix, and the prefixes it may use for them. Any other
 * declaration is dropped, and with it every attribute and element name using that prefix: a
 * made-up prefix for XLink (`x:href`) must not slip a link past the checks below.
 */
const ALLOWED_PREFIXES = new Map<string, readonly string[]>([
  [XLINK_NS, ['xlink']],
  [EPUB_NS, ['epub', 'ops']],
  [SVG_NS, ['svg']],
  [MATHML_NS, ['m', 'mml', 'math']],
  [XHTML_NS, ['html', 'h', 'xhtml']],
]);

function allowedDeclaration(key: string, value: string): boolean {
  const prefix = key.slice('xmlns:'.length);
  return ALLOWED_PREFIXES.get(value.trim())?.includes(prefix) ?? false;
}

function cleanAttributes(el: Element, state: State): [string, string][] {
  const name = localName(el);
  const out: [string, string][] = [];
  for (const [key, rawValue] of Object.entries(el.attribs)) {
    const lower = key.toLowerCase();
    const local = lower.slice(lower.indexOf(':') + 1);
    const value = cleanXmlText(decodeEntities(rawValue));
    if (lower.startsWith('xmlns:') && !allowedDeclaration(key, value)) {
      state.removedAttributes++;
      continue;
    }
    if (local.startsWith('on') || local === 'srcset' || local === 'formaction' || local === 'http-equiv') {
      state.removedAttributes++;
      continue;
    }
    if (local === 'style' && dangerousStyle(value)) {
      state.removedAttributes++;
      continue;
    }
    if (URL_ATTRIBUTES.has(local) && !lower.startsWith('xmlns')) {
      if (dangerousUrl(value)) {
        state.removedAttributes++;
        continue;
      }
      if (isExternalHref(value)) {
        // External links stay (the reader opens them outside the book); external resources go.
        if (!(name === 'a' && local === 'href' && /^(https?:|mailto:)/i.test(value.trim()))) {
          state.removedAttributes++;
          continue;
        }
      }
    }
    out.push([key, value]);
  }
  return out;
}

function sizeForSrc(ctx: NormalizeContext, src: string): ImageSize | null {
  try {
    const target = resolveHref(ctx.sectionPath, src);
    return target && ctx.imageSize ? ctx.imageSize(target.path) : null;
  } catch {
    return null;
  }
}

function imageAttributes(el: Element, attrs: [string, string][], ctx: NormalizeContext): [string, string][] {
  const name = localName(el);
  if (name !== 'img') return attrs;
  const has = (k: string) => attrs.some(([a]) => a.toLowerCase() === k);
  const result = [...attrs];
  if (!has('alt')) result.push(['alt', '']);
  if (ctx.imageSize && (!has('width') || !has('height'))) {
    const src = attrs.find(([a]) => a.toLowerCase() === 'src')?.[1];
    if (src) {
      const size = sizeForSrc(ctx, src);
      if (size && size.width > 0 && size.height > 0) {
        if (!has('width')) result.push(['width', String(size.width)]);
        if (!has('height')) result.push(['height', String(size.height)]);
      }
    }
  }
  return result;
}

function ensureNamespace(el: Element, attrs: [string, string][]): [string, string][] {
  const name = localName(el);
  const prefixed = el.name.includes(':');
  if (prefixed) return attrs;
  const hasXmlns = attrs.some(([k]) => k === 'xmlns');
  if (name === 'svg' && !hasXmlns) return [['xmlns', SVG_NS], ...attrs];
  if (name === 'math' && !hasXmlns) return [['xmlns', MATHML_NS], ...attrs];
  return attrs;
}

function serializeChildren(node: AnyNode, ctx: NormalizeContext, state: State): void {
  if (!('children' in node)) return;
  for (const child of node.children) serializeNode(child, ctx, state);
}

/** Characters a row between scenes is drawn with: stars, an asterism, bullets. */
const STARS = /^[*⁂∗✱•·]+$/u;

/**
 * How wide a star and a space are drawn in a row between scenes, in em, once the reader has drawn
 * them 0.15 em closer (`layout.ts`): a little more than any of its fonts needs (D86).
 */
const ROW_STAR_EM = 0.55;
const ROW_SPACE_EM = 0.12;

/**
 * Whether an element is a row of stars between scenes ("*      *      *", with no-break spaces
 * between them, as Gutenberg sets them): three stars or more and nothing else but space and line
 * breaks. If it is, how wide its widest line is drawn, in em, for the reader to fit it to the page;
 * otherwise null. Read through at most 64 nodes and 600 characters, so that a large or deep element
 * costs no more than that.
 */
function asterismWidth(el: Element): number | null {
  if (el.children.length > 64) return null;
  let nodes = 0;
  let length = 0;
  // Lines in reverse (a stack reads the last child first), which leaves each line's characters as they are.
  const lines = [''];
  const stack: AnyNode[] = [...el.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (++nodes > 64) return null;
    if (isText(node)) {
      const text = decodeEntities(node.data);
      length += text.length;
      if (length > 600) return null;
      lines[lines.length - 1] += text;
    } else if (isTag(node)) {
      if (localName(node) === 'br') lines.push('');
      else if (localName(node) !== 'span' || node.children.length > 64) return null;
      else stack.push(...node.children);
    }
  }
  const stars = lines.join('').replace(/[\s\u00a0]+/g, '');
  if (stars.length < 3 || !STARS.test(stars)) return null;
  let widest = 0;
  for (const line of lines) {
    // As the line is drawn: runs of white space are one space, none at either end; no-break spaces stay.
    const drawn = line.replace(/[ \t\n\r\f]+/g, ' ').replace(/^ | $/g, '');
    const spaces = drawn.replace(/[^ \u00a0]/g, '').length;
    widest = Math.max(widest, ([...drawn].length - spaces) * ROW_STAR_EM + spaces * ROW_SPACE_EM);
  }
  return Math.ceil(widest * 10) / 10;
}

function writeText(raw: string, state: State, decode: boolean): void {
  const text = cleanXmlText(decode ? decodeEntities(raw) : raw);
  if (text.length === 0) return;
  state.out += escapeText(text);
  state.length += text.length;
  state.text += text;
  if (state.picture !== null && /\S/.test(text)) state.picture = null;
}

function serializeNode(node: AnyNode, ctx: NormalizeContext, state: State): void {
  if (isText(node)) {
    writeText(node.data, state, true);
    return;
  }
  if (isCDATA(node)) {
    for (const c of node.children) if (isText(c)) writeText(c.data, state, false);
    return;
  }
  if (!isTag(node)) return; // comments, processing instructions, directives

  const name = localName(node);
  if (name === 'style') {
    state.styles.push(cleanXmlText(textContent(node)));
    return;
  }
  if (DROP_WITH_CONTENT.has(name)) {
    state.removedElements++;
    return;
  }
  const boiler = isBoilerplateElement(node);
  const types = matterTypes(node);
  const startLength = state.length;
  const depth = ++state.depth;
  if (UNWRAP.has(name)) {
    serializeChildren(node, ctx, state);
  } else {
    let attrs = cleanAttributes(node, state);
    attrs = imageAttributes(node, attrs, ctx);
    // A row of stars between scenes, marked so the reader keeps each of its lines whole and inside
    // the page: `--bc-row` is its widest line, in em (D86).
    const row = name === 'p' || name === 'div' ? asterismWidth(node) : null;
    if (row !== null) {
      const style = attrs.find(([k]) => k === 'style')?.[1]?.trim().replace(/;$/, '');
      attrs = [...attrs.filter(([k]) => k !== 'style'), ['style', `${style ? `${style}; ` : ''}--bc-row: ${row}`], ['data-bc-asterism', '']];
    }
    attrs = ensureNamespace(node, attrs);
    enterScope(state, declaredPrefixes(attrs));
    attrs = scopedAttributes(attrs, state);
    const id = attrs.find(([k]) => k === 'id')?.[1];
    if (id && !state.ids.has(id)) {
      state.ids.set(id, state.length);
      if (state.picture) state.afterPicture.set(id, state.picture);
    }
    const colon = node.name.indexOf(':');
    const tag = colon !== -1 && !prefixInScope(state, node.name.slice(0, colon)) ? node.name.slice(colon + 1) : node.name;
    const attrText = attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
    if (VOID.has(name)) {
      state.out += `<${tag}${attrText}/>`;
      leaveScope(state);
      if (name === 'img') state.picture = (attrs.find(([k]) => k.toLowerCase() === 'alt')?.[1] ?? '').trim() || null;
      // Tag soup: content wrongly nested in a void element is kept, right after it.
      serializeChildren(node, ctx, state);
    } else {
      state.out += `<${tag}${attrText}>`;
      serializeChildren(node, ctx, state);
      state.out += `</${tag}>`;
      leaveScope(state);
    }
  }
  state.depth--;
  if (boiler && state.length > startLength) state.boilerplate.push({ start: startLength, end: state.length });
  if (types.length > 0 && state.length > startLength) state.matter.push({ start: startLength, end: state.length, depth, types });
}

function mergeRanges(ranges: BoilerplateRange[]): BoilerplateRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

function headLinks(head: Element | undefined, ctx: NormalizeContext): string[] {
  if (!head) return [];
  const links: string[] = [];
  for (const child of head.children) {
    if (!isTag(child) || localName(child) !== 'link') continue;
    const rel = (attr(child, 'rel') ?? '').toLowerCase().split(/\s+/);
    const href = attr(child, 'href');
    if (!rel.includes('stylesheet') || !href || isExternalHref(href) || dangerousUrl(href)) continue;
    let target;
    try {
      target = resolveHref(ctx.sectionPath, href);
    } catch {
      continue;
    }
    if (!target || !ctx.exists(target.path)) continue;
    links.push(`<link rel="stylesheet" type="text/css" href="${escapeAttr(cleanXmlText(href))}"/>`);
  }
  return links;
}

/**
 * Remove `@import` of remote stylesheets; everything else is kept (the CSP blocks remote URLs too).
 * Each run of spaces in the pattern can be matched one way only: three runs side by side made a
 * long run of spaces cost its length cubed.
 */
export function sanitizeCss(css: string): string {
  return cleanXmlText(css)
    .replace(/@import\s+(?:url\(\s*)?(?:['"]\s*)?(?:https?:)?\/\/[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, 'invalid(')
    .replace(/-moz-binding\s*:/gi, 'invalid:')
    .replace(/behavior\s*:/gi, 'invalid:');
}

export function normalizeSection(source: string, ctx: NormalizeContext): NormalizedSection {
  const doc = parseXml(cleanXmlText(source));
  const html = firstElement(doc, 'html');
  const head = html ? firstElement(html, 'head') : undefined;
  const body = (html ? firstElement(html, 'body') : undefined) ?? firstElement(doc, 'body');
  const rootPrefixes = new Map<string, string>([
    ['epub', EPUB_NS],
    ['xlink', XLINK_NS],
  ]);
  if (html) {
    for (const [k, v] of Object.entries(html.attribs)) {
      if (!k.startsWith('xmlns:') || k.length <= 6 || rootPrefixes.has(k.slice(6))) continue;
      const uri = decodeEntities(v);
      if (allowedDeclaration(k, uri)) rootPrefixes.set(k.slice(6), uri);
    }
  }
  const state: State = {
    out: '',
    length: 0,
    text: '',
    ids: new Map(),
    picture: null,
    afterPicture: new Map(),
    boilerplate: [],
    matter: [],
    depth: 0,
    styles: [],
    removedElements: 0,
    removedAttributes: 0,
    scopes: [],
    declared: new Map(),
  };
  enterScope(state, new Set(rootPrefixes.keys()));

  if (head) {
    for (const child of head.children) {
      if (isTag(child) && localName(child) === 'style') state.styles.push(cleanXmlText(textContent(child)));
      if (isTag(child) && localName(child) === 'script') state.removedElements++;
    }
  }
  const titleEl = head ? firstElement(head, 'title') : undefined;
  const headTitle = titleEl ? textContent(titleEl).replace(/\s+/g, ' ').trim() : '';

  // Body (or, for a fragment without <body>, everything outside <head>).
  const bodyAttrs: [string, string][] = [];
  if (body) {
    for (const [k, v] of cleanAttributes(body, state)) bodyAttrs.push([k, v]);
    const id = bodyAttrs.find(([k]) => k === 'id')?.[1];
    if (id) state.ids.set(id, 0);
    serializeChildren(body, ctx, state);
  } else {
    for (const child of (html ?? doc).children) {
      if (isTag(child) && localName(child) === 'head') continue;
      serializeNode(child, ctx, state);
    }
  }
  if (body && isBoilerplateElement(body) && state.length > 0) state.boilerplate.push({ start: 0, end: state.length });
  const bodyTypes = body ? matterTypes(body) : [];
  if (bodyTypes.length > 0 && state.length > 0) state.matter.push({ start: 0, end: state.length, depth: 0, types: bodyTypes });

  const lang = (html && (attr(html, 'lang') ?? html.attribs['xml:lang'])) || null;
  const dir = html ? attr(html, 'dir') : undefined;
  const rootAttrs = [
    ` xmlns="${XHTML_NS}"`,
    ...[...rootPrefixes].map(([p, uri]) => ` xmlns:${p}="${escapeAttr(uri)}"`),
    lang ? ` lang="${escapeAttr(lang)}" xml:lang="${escapeAttr(lang)}"` : '',
    dir === 'rtl' || dir === 'ltr' ? ` dir="${dir}"` : '',
  ].join('');
  const styles = state.styles
    .map((css) => sanitizeCss(css))
    .filter((css) => css.trim().length > 0)
    .map((css) => `<style>${escapeText(css)}</style>`)
    .join('');
  const bodyAttrText = bodyAttrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  const xhtml =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<html${rootAttrs}><head><meta charset="utf-8"/><title>${escapeText(headTitle)}</title>` +
    `${headLinks(head, ctx).join('')}${styles}</head><body${bodyAttrText}>${state.out}</body></html>\n`;

  return {
    xhtml,
    textLength: state.length,
    idOffsets: state.ids,
    text: state.text,
    afterPicture: state.afterPicture,
    title: headTitle || null,
    language: lang,
    boilerplate: mergeRanges(state.boilerplate),
    matter: [...state.matter].sort((a, b) => a.start - b.start || a.depth - b.depth),
    removed: { elements: state.removedElements, attributes: state.removedAttributes },
  };
}

/**
 * A standalone SVG file under the rules a section follows (no script, event handlers, script URLs,
 * animation or remote resources), or null when it holds no SVG.
 */
export function sanitizeSvg(source: string): string | null {
  const doc = parseXml(cleanXmlText(source));
  const svg = firstElement(doc, 'svg');
  if (!svg) return null;
  const state: State = {
    out: '',
    length: 0,
    text: '',
    ids: new Map(),
    picture: null,
    afterPicture: new Map(),
    boilerplate: [],
    matter: [],
    depth: 0,
    styles: [],
    removedElements: 0,
    removedAttributes: 0,
    scopes: [],
    declared: new Map(),
  };
  serializeNode(svg, { sectionPath: '', exists: () => false }, state);
  const styles = state.styles
    .map((css) => sanitizeCss(css))
    .filter((css) => css.trim().length > 0)
    .map((css) => `<style>${escapeText(css)}</style>`)
    .join('');
  const open = state.out.indexOf('>') + 1;
  return `<?xml version="1.0" encoding="utf-8"?>\n${state.out.slice(0, open)}${styles}${state.out.slice(open)}\n`;
}

/**
 * The text measure of an XHTML document exactly as a browser computes it: the decoded data of
 * every text node under `<body>`. Used by tests to prove that normalised output re-measures to
 * the length recorded at ingest.
 */
export function measureBodyText(xhtml: string): string {
  return bodyTextWithBreaks(xhtml).text;
}

/** Elements whose edges end a sentence when the text is read aloud. */
const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'div', 'dl', 'dt', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'td', 'th', 'tr', 'ul',
]);

/**
 * The text measure of an XHTML document (see {@link measureBodyText}) together with the offsets
 * where a block element (paragraph, heading, list item, line break…) starts or ends: where a
 * narrator pauses, used to cut the text into sentences for forced alignment.
 */
export function bodyTextWithBreaks(xhtml: string): { text: string; breaks: number[] } {
  const doc = parseXml(xhtml, OWN_DOCUMENT);
  const body = firstElement(doc, 'body');
  if (!body) return { text: '', breaks: [] };
  let text = '';
  const breaks: number[] = [];
  const mark = () => {
    if (breaks[breaks.length - 1] !== text.length) breaks.push(text.length);
  };
  const visit = (n: AnyNode) => {
    if (isText(n)) text += decodeEntities(n.data);
    else if (isCDATA(n)) {
      for (const c of n.children) if (isText(c)) text += c.data;
    } else if ('children' in n) {
      const block = isTag(n) && BLOCK_ELEMENTS.has(localName(n).toLowerCase());
      if (block) mark();
      for (const c of n.children) visit(c);
      if (block) mark();
    }
  };
  visit(body);
  return { text, breaks };
}
