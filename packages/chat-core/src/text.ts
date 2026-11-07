/**
 * Text helpers every part of the core shares: how a name is folded for matching, and how a long
 * message is cut to a quote. Pure, no platform APIs.
 */

const MARKS = /\p{M}+/gu;
const NOT_NAME = /[^\p{L}\p{N}]+/gu;
const SPACES = /\s+/gu;

/**
 * The key a name is matched by: accents folded away (`Zoë` -> `zoe`), lower case, and everything
 * that is not a letter or a digit dropped (`Mary-Jane O'Neil` -> `maryjaneoneil`). Two spellings a
 * person would call the same name get the same key; that is the whole contract.
 */
export function nameKey(name: string): string {
  return name.normalize('NFKD').replace(MARKS, '').toLowerCase().replace(NOT_NAME, '');
}

/** A name or a query folded for prefix search: accents gone, lower case, single spaces, no ends. */
export function foldForSearch(text: string): string {
  return text.normalize('NFKD').replace(MARKS, '').toLowerCase().replace(SPACES, ' ').trim();
}

/** A display name with its runs of whitespace made single spaces, as it is shown and typed. */
export function collapseSpaces(text: string): string {
  return text.replace(SPACES, ' ').trim();
}

/**
 * A message cut down to a one-line quote: whitespace folded, at most `max` characters, cut at a
 * word boundary when one is near enough (else mid-word), with an ellipsis when anything was cut.
 * Counted in code points, so an emoji is never split in half.
 */
export function snippet(text: string, max = 140): string {
  const flat = collapseSpaces(text);
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max).join('');
  // Already at a word's end (the next character is not a letter or digit): nothing to back off.
  const atWordEnd = !/[\p{L}\p{N}]/u.test(chars[max]!);
  const space = cut.lastIndexOf(' ');
  const body = atWordEnd ? cut : space >= Math.floor(cut.length * 0.6) ? cut.slice(0, space) : cut;
  return `${body.replace(/[\s.,;:!?-]+$/u, '')}…`;
}
