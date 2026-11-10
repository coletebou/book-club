/**
 * Importing a to-read shelf (D214, D216): a Goodreads or StoryGraph export CSV, parsed entirely in
 * the browser. The file never leaves the device — only the nominations the person goes on to
 * choose are ever sent to the server (components/ImportShelfModal.tsx).
 *
 * Goodreads (Library → Export Library): Title, Author, ISBN13 (and ISBN), Exclusive Shelf
 * ('to-read', 'currently-reading', 'read', …). Both ISBN columns are written Excel-style, as
 * `="9780141439518"`, so a spreadsheet does not truncate or reformat the digits.
 *
 * StoryGraph (Manage Account → Export your data): Title, Authors, ISBN/UID, Read Status
 * ('to-read', 'currently-reading', 'read', …).
 */

export class ShelfImportError extends Error {
  override name = 'ShelfImportError';
}

export interface ShelfBook {
  readonly title: string;
  readonly author: string | null;
  readonly isbn: string | null;
}

export type ShelfSource = 'goodreads' | 'storygraph';

export interface ShelfImportResult {
  readonly source: ShelfSource;
  readonly toRead: readonly ShelfBook[];
  /** How many book rows the export had in total (to-read and otherwise), for "12 of 340 books". */
  readonly totalRows: number;
}

/**
 * A general CSV parser (RFC 4180-ish): quoted fields, commas and newlines inside a quoted field,
 * a doubled quote as one literal quote, and a leading byte-order mark. Returns rows of raw cells;
 * callers map by header name rather than position (export columns are reordered between versions
 * of both services).
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let touched = false;
  const n = text.length;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    touched = false;
  };
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      touched = true;
      i++;
      continue;
    }
    if (c === ',') {
      endField();
      touched = true;
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (touched || field !== '') endRow();
      i++;
      continue;
    }
    field += c;
    touched = true;
    i++;
  }
  if (touched || field !== '') endRow();
  return rows;
}

/**
 * Goodreads writes an ISBN cell as `="9780141439518"` so a spreadsheet keeps the leading zeros and
 * all the digits, rather than reading it as a number. The CSV parser above already un-escapes a
 * real quoted field, so by the time this sees it the pair of quotes around the digits is usually
 * gone too (`="9780141439518"` in the raw file becomes the field `=9780141439518`); a tool that
 * quoted the whole cell at the CSV level instead (`="9780141439518"` quotes and all) is handled
 * the same.
 */
function cleanIsbn(raw: string | undefined): string | null {
  let value = (raw ?? '').trim();
  const stillQuoted = /^="(.*)"$/.exec(value);
  value = (stillQuoted ? stillQuoted[1]! : value.startsWith('=') ? value.slice(1) : value).trim();
  return value === '' ? null : value;
}

function cell(row: readonly string[], index: number): string {
  return index >= 0 ? (row[index] ?? '').trim() : '';
}

function headerIndex(header: readonly string[], name: string): number {
  return header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}

/**
 * Parse a Goodreads or StoryGraph library export and pick out the to-read shelf. Throws
 * `ShelfImportError` (a friendly message, nothing technical) when the file is empty or neither
 * service's headers are found, so the caller can show it directly.
 */
export function parseShelfExport(text: string): ShelfImportResult {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length === 0) throw new ShelfImportError('That file looks empty.');
  const [header, ...body] = rows as [string[], ...string[][]];

  const exclusiveShelf = headerIndex(header, 'Exclusive Shelf');
  if (exclusiveShelf >= 0) {
    const title = headerIndex(header, 'Title');
    const author = headerIndex(header, 'Author');
    const isbn13 = headerIndex(header, 'ISBN13');
    const isbn = headerIndex(header, 'ISBN');
    const toRead = body
      .filter((r) => cell(r, exclusiveShelf).toLowerCase() === 'to-read')
      .map((r): ShelfBook => ({ title: cell(r, title), author: cell(r, author) || null, isbn: cleanIsbn(r[isbn13]) ?? cleanIsbn(r[isbn]) }))
      .filter((b) => b.title !== '');
    return { source: 'goodreads', toRead, totalRows: body.length };
  }

  const readStatus = headerIndex(header, 'Read Status');
  if (readStatus >= 0) {
    const title = headerIndex(header, 'Title');
    const authors = headerIndex(header, 'Authors');
    const isbnUid = headerIndex(header, 'ISBN/UID');
    const toRead = body
      .filter((r) => cell(r, readStatus).toLowerCase() === 'to-read')
      .map((r): ShelfBook => ({ title: cell(r, title), author: cell(r, authors) || null, isbn: cleanIsbn(r[isbnUid]) }))
      .filter((b) => b.title !== '');
    return { source: 'storygraph', toRead, totalRows: body.length };
  }

  throw new ShelfImportError('This does not look like a Goodreads or StoryGraph export. Export your library (or "My Books") as a CSV and try again.');
}
