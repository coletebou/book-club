import { describe, expect, it } from 'vitest';
import { htmlToText, textAtoms } from './shelf-extract';

describe('textAtoms', () => {
  it('splits on blank lines into atoms with increasing positions', () => {
    const atoms = textAtoms('First paragraph.\n\nSecond paragraph.\n\nThird.');
    expect(atoms.map((a) => a.text)).toEqual(['First paragraph.', 'Second paragraph.', 'Third.']);
    expect(atoms[0]!.m).toBe(0);
    expect(atoms[1]!.m).toBeGreaterThan(atoms[0]!.mEnd - 1);
    expect(atoms[2]!.m).toBeGreaterThan(atoms[1]!.m);
  });

  it('drops empty paragraphs', () => {
    const atoms = textAtoms('One.\n\n\n\nTwo.');
    expect(atoms.map((a) => a.text)).toEqual(['One.', 'Two.']);
  });

  it('returns nothing for blank input', () => {
    expect(textAtoms('   \n\n  ')).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('strips tags and drops script/style content', () => {
    const html = '<html><head><style>.x{color:red}</style></head><body><p>Hello</p><script>evil()</script><p>World</p></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('Hello');
    expect(text).toContain('World');
    expect(text).not.toContain('evil');
    expect(text).not.toContain('color:red');
    expect(text).not.toMatch(/<[^>]+>/);
  });

  it('decodes common entities', () => {
    expect(htmlToText('<p>Alice &amp; the Rabbit&#39;s hole</p>')).toContain("Alice & the Rabbit's hole");
  });

  it('turns block elements into paragraph breaks', () => {
    const text = htmlToText('<div>One</div><div>Two</div>');
    expect(text.split('\n\n').map((s) => s.trim())).toEqual(['One', 'Two']);
  });
});
