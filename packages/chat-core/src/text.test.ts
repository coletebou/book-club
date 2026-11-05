import { describe, expect, it } from 'vitest';
import { collapseSpaces, foldForSearch, nameKey, snippet } from './text';

describe('nameKey', () => {
  it('folds case, accents and punctuation to one key', () => {
    expect(nameKey('Zoë Ñúñez')).toBe('zoenunez');
    expect(nameKey("Mary-Jane O'Neil")).toBe('maryjaneoneil');
    expect(nameKey('  ANA  ')).toBe('ana');
    expect(nameKey('Ana 🌸')).toBe('ana');
  });

  it('keeps letters of other scripts', () => {
    expect(nameKey('李 小龍')).toBe('李小龍');
    expect(nameKey('Ольга')).toBe('ольга');
  });
});

describe('foldForSearch and collapseSpaces', () => {
  it('folds a query to lower case, no accents, single spaces', () => {
    expect(foldForSearch('  Zoë   Ñ ')).toBe('zoe n');
    expect(collapseSpaces(' Grant \t Smith ')).toBe('Grant Smith');
  });
});

describe('snippet', () => {
  it('keeps a short message as it is, whitespace folded', () => {
    expect(snippet('one\n two')).toBe('one two');
  });

  it('cuts a long one at a word boundary with an ellipsis', () => {
    const text = 'The Queen of Hearts, she made some tarts, all on a summer day: the Knave of Hearts, he stole those tarts, and took them quite away!';
    const cut = snippet(text, 40);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(41);
    expect(text.startsWith(cut.slice(0, -1))).toBe(true);
    expect(cut).toBe('The Queen of Hearts, she made some tarts…');
  });

  it('cuts mid-word when no space is near enough, never splitting an emoji', () => {
    expect(snippet('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghij…');
    expect(snippet('😀😀😀😀😀', 3)).toBe('😀😀😀…');
  });
});
