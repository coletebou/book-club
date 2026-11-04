import {
  type Chapter,
  type Edition,
  type EditionGeometry,
  type EditionKind,
  type EditionTimeline,
  type PrintedSyncStats,
  type SyncMap,
  type Track,
} from '@bookclub/shared';
import { type Db } from '../db/db';
import { newId } from '../lib/crypto';
import { fromJson, isoRequired, toJson } from '../lib/json';
import { foldEditionReading } from './progress';
import { readAlongFor, readAlongStats } from './readalong';

export interface BookRow {
  id: string;
  club_id: string;
  title: string;
  author: string;
  cover_blob_id: string | null;
  reference_edition_id: string | null;
  chapters_json: string;
  created_by: string;
  created_at: number;
  /**
   * Cal's series grouping (migration 012, D162): null for a standalone book. Optional (not just
   * nullable) so existing hand-built `BookRow` test fixtures that predate D162 need no changes;
   * a row actually read from the database always has both, even if both are null.
   */
  series_id?: string | null;
  series_order?: number | null;
}

export interface EditionRow {
  id: string;
  book_id: string;
  kind: EditionKind;
  status: 'processing' | 'ready' | 'failed';
  error: string | null;
  geometry_json: string | null;
  units_json: string;
  sync_json: string | null;
  alignment_json: string;
  meta_json: string;
  size_bytes: number;
  created_by: string;
  created_at: number;
}

export interface EditionFileRow {
  edition_id: string;
  idx: number;
  blob_id: string;
  role: 'main' | 'track';
  title: string;
  duration_ms: number | null;
  original_name: string;
}

export interface EditionUnit {
  title: string;
  m: number;
}

export interface AlignmentRecord {
  method: Edition['alignment']['method'];
  unitToChapter: (number | null)[];
  /** Under a forced alignment: how the tracks were matched to chapters, for when it goes. */
  chapterMethod?: Exclude<Edition['alignment']['method'], 'forced'>;
  /**
   * Under a forced alignment of a PDF's printed text with a text edition's (D75), rather than of
   * an audiobook's transcript (whose sentences the readalong table keeps): the edition it was lined
   * up with (the text, or the PDF the timeline rests on), and the stretches of this edition's own
   * measure it lined up line by line.
   */
  printed?: PrintedRecord;
  /**
   * Under a forced alignment of an audiobook: where its read-along hears each of the book's chapters
   * start, `[chapter, track, ms into the track]` (FR152). A track holding several is listed with
   * them, and names the one being heard.
   */
  chaptersHeard?: readonly (readonly [number, number, number])[];
  /**
   * Under a forced alignment of an audiobook: the chapter each track opens with by its read-along,
   * null where none of it was lined up (FR161). A track is named after it, whatever its chapter
   * match (none, for numbers that are not the book's).
   */
  opensWith?: readonly (number | null)[];
}

/** A printed alignment as an edition keeps it (AlignmentRecord.printed). */
export interface PrintedRecord {
  readonly editionId: string;
  readonly exact: readonly (readonly [number, number])[];
  readonly stats: PrintedSyncStats;
}

/** A book the app knows: one removed from its club (D179) is not found, here and so everywhere. */
export function bookById(db: Db, id: string): BookRow | undefined {
  return db.get<BookRow>('SELECT * FROM books WHERE id = ? AND deleted_at IS NULL', [id]);
}

export function booksForClub(db: Db, clubId: string): BookRow[] {
  return db.all<BookRow>('SELECT * FROM books WHERE club_id = ? AND deleted_at IS NULL ORDER BY created_at DESC', [clubId]);
}

export function createBook(db: Db, input: { clubId: string; title: string; author: string; createdBy: string }): BookRow {
  const id = newId();
  db.exec('INSERT INTO books (id, club_id, title, author, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    input.clubId,
    input.title,
    input.author,
    input.createdBy,
    Date.now(),
  ]);
  return bookById(db, id)!;
}

export function updateBook(db: Db, id: string, input: { title?: string; author?: string }): void {
  if (input.title !== undefined) db.exec('UPDATE books SET title = ? WHERE id = ?', [input.title, id]);
  if (input.author !== undefined) db.exec('UPDATE books SET author = ? WHERE id = ?', [input.author, id]);
}

export function setBookCover(db: Db, bookId: string, blobId: string | null): void {
  db.exec('UPDATE books SET cover_blob_id = ? WHERE id = ?', [blobId, bookId]);
}

export function setBookTimeline(db: Db, bookId: string, referenceEditionId: string, chapters: Chapter[]): void {
  db.exec('UPDATE books SET reference_edition_id = ?, chapters_json = ? WHERE id = ?', [referenceEditionId, toJson(chapters), bookId]);
}

export function deleteBook(db: Db, id: string): void {
  db.exec('DELETE FROM books WHERE id = ?', [id]);
}

export function bookChapters(book: BookRow): Chapter[] {
  return fromJson<Chapter[]>(book.chapters_json, []);
}

/* Editions --------------------------------------------------------------------------------- */

export function editionById(db: Db, id: string): EditionRow | undefined {
  return db.get<EditionRow>('SELECT * FROM editions WHERE id = ?', [id]);
}

export function editionsForBook(db: Db, bookId: string): EditionRow[] {
  return db.all<EditionRow>('SELECT * FROM editions WHERE book_id = ? ORDER BY created_at', [bookId]);
}

export function createEdition(db: Db, input: { bookId: string; kind: EditionKind; createdBy: string; sizeBytes: number }): EditionRow {
  const id = newId();
  db.exec(
    "INSERT INTO editions (id, book_id, kind, status, size_bytes, created_by, created_at) VALUES (?, ?, ?, 'processing', ?, ?, ?)",
    [id, input.bookId, input.kind, input.sizeBytes, input.createdBy, Date.now()],
  );
  return editionById(db, id)!;
}

export function markEditionReady(
  db: Db,
  id: string,
  input: { geometry: EditionGeometry; units: EditionUnit[]; sync: SyncMap; alignment: AlignmentRecord; meta: Record<string, unknown> },
): void {
  db.exec(
    "UPDATE editions SET status = 'ready', error = NULL, ingest_starts = 0, geometry_json = ?, units_json = ?, sync_json = ?, alignment_json = ?, meta_json = ? WHERE id = ?",
    [toJson(input.geometry), toJson(input.units), toJson(input.sync), toJson(input.alignment), toJson(input.meta), id],
  );
}

export function setEditionSync(db: Db, id: string, sync: SyncMap, alignment: AlignmentRecord): void {
  db.exec('UPDATE editions SET sync_json = ?, alignment_json = ? WHERE id = ?', [toJson(sync), toJson(alignment), id]);
}

export function markEditionFailed(db: Db, id: string, error: string): void {
  db.exec("UPDATE editions SET status = 'failed', error = ?, ingest_starts = 0 WHERE id = ?", [error.slice(0, 500), id]);
}

/** Count one more start of reading an edition's files (migration 009). */
export function countIngestStart(db: Db, id: string): void {
  db.exec('UPDATE editions SET ingest_starts = ingest_starts + 1 WHERE id = ?', [id]);
}

export function deleteEdition(db: Db, id: string): void {
  db.tx(() => {
    const edition = db.get<EditionRow>('SELECT * FROM editions WHERE id = ?', [id]);
    // What was read in it stays read (its rows go with it).
    if (edition?.sync_json) foldEditionReading(db, id, fromJson<SyncMap>(edition.sync_json, { points: [] }));
    db.exec('DELETE FROM editions WHERE id = ?', [id]);
  });
}

export function addEditionFile(db: Db, file: Omit<EditionFileRow, 'title' | 'duration_ms'> & { title?: string; duration_ms?: number | null }): void {
  db.exec(
    'INSERT INTO edition_files (edition_id, idx, blob_id, role, title, duration_ms, original_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [file.edition_id, file.idx, file.blob_id, file.role, file.title ?? '', file.duration_ms ?? null, file.original_name],
  );
}

export function updateEditionFile(db: Db, editionId: string, idx: number, input: { title?: string; durationMs?: number }): void {
  if (input.title !== undefined) db.exec('UPDATE edition_files SET title = ? WHERE edition_id = ? AND idx = ?', [input.title, editionId, idx]);
  if (input.durationMs !== undefined) {
    db.exec('UPDATE edition_files SET duration_ms = ? WHERE edition_id = ? AND idx = ?', [input.durationMs, editionId, idx]);
  }
}

export function editionFiles(db: Db, editionId: string): EditionFileRow[] {
  return db.all<EditionFileRow>('SELECT * FROM edition_files WHERE edition_id = ? ORDER BY idx', [editionId]);
}

export function editionFile(db: Db, editionId: string, idx: number): EditionFileRow | undefined {
  return db.get<EditionFileRow>('SELECT * FROM edition_files WHERE edition_id = ? AND idx = ?', [editionId, idx]);
}

/** The edition placed on the book timeline, or null while it is still processing. */
export function editionTimeline(edition: EditionRow): EditionTimeline | null {
  if (edition.status !== 'ready' || !edition.geometry_json || !edition.sync_json) return null;
  return { geometry: fromJson<EditionGeometry>(edition.geometry_json, { kind: 'pdf', pageCount: 0 }), sync: fromJson<SyncMap>(edition.sync_json, { points: [] }) };
}

export function editionUnits(edition: EditionRow): EditionUnit[] {
  return fromJson<EditionUnit[]>(edition.units_json, []);
}

export function editionAlignment(edition: EditionRow): AlignmentRecord {
  return fromJson<AlignmentRecord>(edition.alignment_json, { method: 'none', unitToChapter: [] });
}

export function editionMeta<T extends Record<string, unknown>>(edition: EditionRow): T {
  return fromJson<T>(edition.meta_json, {} as T);
}

const TRACK_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

export function audioMimeForName(name: string): string {
  return TRACK_MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'audio/mpeg';
}

/** Whether an audiobook has been lined up with a text, and how well. */
function readAlongInfo(db: Db, editionId: string): Edition['readAlong'] {
  const row = readAlongFor(db, editionId);
  const stats = row ? readAlongStats(row) : null;
  if (!row || !stats || stats.alignedSentences === 0) return null;
  return { textEditionId: row.text_edition_id, sentences: stats.alignedSentences, coverage: stats.textWords > 0 ? stats.matchedWords / stats.textWords : 0 };
}

/**
 * For each audio file, the unit it starts with. A file with chapters of its own (an M4B) holds
 * several units, so a file's index is not its unit's: the unit is found by where the file starts.
 */
export function unitsAtFileStarts(units: readonly EditionUnit[], durationsMs: readonly number[]): number[] {
  const out: number[] = [];
  let u = 0;
  let start = 0;
  for (const d of durationsMs) {
    while (u + 1 < units.length && units[u + 1]!.m <= start + 0.5) u++;
    out.push(u);
    start += d;
  }
  return out;
}

export function toEditionView(db: Db, edition: EditionRow): Edition {
  const geometry = edition.geometry_json ? fromJson<EditionGeometry>(edition.geometry_json, { kind: 'pdf', pageCount: 0 }) : null;
  const alignment = editionAlignment(edition);
  const files = edition.kind === 'audio' ? editionFiles(db, edition.id) : [];
  const trackFiles = files.filter((f) => f.role === 'track');
  const firstUnits = unitsAtFileStarts(editionUnits(edition), trackFiles.map((f) => f.duration_ms ?? 0));
  // The chapters a read-along hears start in each track (FR152), in the order they come.
  // Grouped by track in one pass: an audiobook of a thousand tracks has as many chapters.
  const heard = new Map<number, { chapter: number; ms: number }[]>();
  for (const [chapter, track, ms] of alignment.method === 'forced' ? (alignment.chaptersHeard ?? []) : []) {
    const inTrack = heard.get(track);
    if (inTrack) inTrack.push({ chapter, ms });
    else heard.set(track, [{ chapter, ms }]);
  }
  const opens = alignment.method === 'forced' ? (alignment.opensWith ?? []) : [];
  const tracks: Track[] = trackFiles.map((f, i) => {
    const chapters = heard.get(i) ?? [];
    return {
      index: f.idx,
      title: f.title,
      durationMs: f.duration_ms ?? 0,
      url: `/media/editions/${edition.id}/tracks/${f.idx}`,
      mime: audioMimeForName(f.original_name),
      // The chapter it is heard opening with, where its read-along says (FR161), else its match's.
      chapter: opens[i] ?? alignment.unitToChapter[firstUnits[i]!] ?? null,
      ...(chapters.length > 0 ? { chapters } : {}),
    };
  });
  return {
    id: edition.id,
    kind: edition.kind,
    status: edition.status,
    error: edition.error,
    createdAt: isoRequired(edition.created_at),
    addedBy: edition.created_by,
    sizeBytes: Number(edition.size_bytes),
    geometry,
    sync: edition.sync_json ? fromJson<SyncMap>(edition.sync_json, { points: [] }) : null,
    alignment: { method: alignment.method, unitToChapter: alignment.unitToChapter },
    readAlong: edition.kind === 'audio' ? readAlongInfo(db, edition.id) : null,
    units: editionUnits(edition),
    publicationUrl: edition.kind === 'epub' && edition.status === 'ready' ? `/api/editions/${edition.id}/publication` : null,
    fileUrl: edition.kind === 'pdf' && edition.status === 'ready' ? `/media/editions/${edition.id}/file` : null,
    tracks,
    durationMs: geometry?.kind === 'audio' ? geometry.trackDurationsMs.reduce((a, b) => a + b, 0) : null,
    pageCount: geometry?.kind === 'pdf' ? geometry.pageCount : null,
  };
}
