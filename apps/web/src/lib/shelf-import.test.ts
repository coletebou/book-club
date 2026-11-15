import { describe, expect, it } from 'vitest';
import { ShelfImportError, parseCsv, parseShelfExport } from './shelf-import';

describe('parseCsv', () => {
  // Every input ends in a newline but the last, and each expects exactly its rows: a trailing
  // blank row for a file ending in a newline would fail them.
  it.each([
    ['splits plain rows on commas and newlines', 'a,b,c\n1,2,3\n', [['a', 'b', 'c'], ['1', '2', '3']]],
    ['keeps a comma inside a quoted field', '"Smith, Jane",42\n', [['Smith, Jane', '42']]],
    ['keeps a newline inside a quoted field, one row', '"line one\nline two",ok\n', [['line one\nline two', 'ok']]],
    ['reads a doubled quote inside a quoted field as one literal quote', '"She said ""hi""",ok\n', [['She said "hi"', 'ok']]],
    ['handles CRLF line endings the same as LF', 'a,b\r\n1,2\r\n', [['a', 'b'], ['1', '2']]],
    ['strips a leading byte-order mark', '\uFEFFa,b\n1,2\n', [['a', 'b'], ['1', '2']]],
    ['still reads the last row of a file with no trailing newline', 'a,b\n1,2', [['a', 'b'], ['1', '2']]],
  ])('%s', (_what, input: string, rows: string[][]) => {
    expect(parseCsv(input)).toEqual(rows);
  });
});

describe('parseShelfExport: Goodreads', () => {
  // A small synthetic Goodreads library export (Library → Import and export → Export library):
  // made-up titles, the shape of the real columns, ISBN cells written Excel-style.
  const GOODREADS_CSV =
    'Book Id,Title,Author,ISBN,ISBN13,My Rating,Exclusive Shelf\n' +
    '1,"Wonder, Boy",Nora Finch,="0141439512",="9780141439518",0,to-read\n' +
    '2,The Long Reply,Dev Okafor,,="",0,currently-reading\n' +
    '3,Salt and Lantern,Priya Ashworth,,,5,read\n' +
    '4,A Second Pick,Nora Finch,,,0,to-read\n';

  it('keeps only the to-read shelf, with title, author and a cleaned ISBN', () => {
    const result = parseShelfExport(GOODREADS_CSV);
    expect(result.source).toBe('goodreads');
    expect(result.totalRows).toBe(4);
    expect(result.toRead).toEqual([
      { title: 'Wonder, Boy', author: 'Nora Finch', isbn: '9780141439518' },
      { title: 'A Second Pick', author: 'Nora Finch', isbn: null },
    ]);
  });

  it('falls back to ISBN when ISBN13 is blank', () => {
    const csv = 'Title,Author,ISBN,ISBN13,Exclusive Shelf\nOnly Ten,Someone,="0141439512",="",to-read\n';
    expect(parseShelfExport(csv).toRead[0]!.isbn).toBe('0141439512');
  });
});

describe('parseShelfExport: StoryGraph', () => {
  // A small synthetic StoryGraph export (Manage Account → Export your data): made-up titles.
  const STORYGRAPH_CSV =
    'Title,Authors,Contributors,ISBN/UID,Format,Read Status,Star Rating\n' +
    'The Quiet Orchard,Mei Lindqvist,,9780000000016,paperback,to-read\n' +
    'Harbor Lights,"Tomas Reyes, Ida Quraishi",,,audiobook,currently-reading\n' +
    'Winter Almanac,Mei Lindqvist,,9780000000023,ebook,to-read,4\n';

  it('keeps only the to-read status, with title, authors and ISBN/UID', () => {
    const result = parseShelfExport(STORYGRAPH_CSV);
    expect(result.source).toBe('storygraph');
    expect(result.totalRows).toBe(3);
    expect(result.toRead).toEqual([
      { title: 'The Quiet Orchard', author: 'Mei Lindqvist', isbn: '9780000000016' },
      { title: 'Winter Almanac', author: 'Mei Lindqvist', isbn: '9780000000023' },
    ]);
  });
});

describe('parseShelfExport: refusals', () => {
  it('refuses an empty file', () => {
    expect(() => parseShelfExport('')).toThrow(ShelfImportError);
    expect(() => parseShelfExport('\n\n')).toThrow(ShelfImportError);
  });

  it('refuses a CSV that is neither a Goodreads nor a StoryGraph export', () => {
    expect(() => parseShelfExport('Name,Phone\nAna,555-0100\n')).toThrow(/Goodreads or StoryGraph/);
  });

  it('a row shorter than the header (a trailing blank cell dropped) is still read, with no author', () => {
    const csv = 'Title,Author,Exclusive Shelf\nBare Title,,to-read\nShorter Row\n';
    const result = parseShelfExport(csv);
    expect(result.totalRows).toBe(2);
    expect(result.toRead).toEqual([{ title: 'Bare Title', author: null, isbn: null }]);
  });
});
