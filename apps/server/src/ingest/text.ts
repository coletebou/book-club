/**
 * Characters a title taken from a file must not carry: control characters (C0, DEL and C1), the
 * marks that reorder the text around them (bidirectional embeddings, overrides and isolates, which
 * can make "evil.mp3" display as something else), byte-order marks, noncharacters and lone halves
 * of surrogate pairs. Line breaks and tabs are turned into spaces before this is applied.
 */
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const UNWANTED = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Text from inside an uploaded file (a tag, a chapter mark, an entry of a table of contents), as
 * every member will see it: one line, tidy, at most `max` characters, never cut inside a character.
 */
export function cleanTitle(input: string, max: number): string {
  const text = input
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(UNWANTED, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max).trimEnd();
}
