import { open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_LIMITS as EPUB_LIMITS, EpubError, keepShallowest, mediaTypeForPath } from '@bookclub/epub';
import {
  type Chapter,
  type EditionGeometry,
  type Publication,
  type SyncMap,
  LIMITS,
  MAX_COVER_BYTES,
  MAX_EDITION_UNITS,
  alignUnitsToChapters,
  chaptersFromContents,
  implausibleStretch,
  linearSyncMap,
  mToT,
  naturalCompare,
  prettifyTrackTitle,
  syncMapFromAlignment,
  manualAlignment,
  totalMeasure,
} from '@bookclub/shared';
import { queueIndexEdition } from '../cal/indexer';
import { type AppContext } from '../context';
import { MIN_COMPRESS_BYTES, compressedCopy, isCompressible } from '../lib/compress';
import { newId } from '../lib/crypto';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors';
import { toJson } from '../lib/json';
import { insertBlob, sharedBlob } from '../repos/blobs';
import {
  type AlignmentRecord,
  type BookRow,
  type EditionRow,
  type EditionUnit,
  addEditionFile,
  bookById,
  bookChapters,
  createBook,
  createEdition,
  editionById,
  editionFiles,
  editionsForBook,
  editionUnits,
  countIngestStart,
  markEditionFailed,
  markEditionReady,
  setBookCover,
  setBookTimeline,
  setEditionSync,
  updateEditionFile,
  editionMeta,
} from '../repos/books';
import { membership } from '../repos/clubs';
import { type DeclaredFile, type ImportRow, declaredFiles, importById, latestUploads, setImportStatus } from '../repos/imports';
import { progressForBook } from '../repos/progress';
import { type UserRow } from '../repos/users';
import { requireBook } from '../auth/access';
import { type TrackInfo, type TrackReaderOptions, TrackReader, TrackTimeoutError, looksLikeAudio, looksLikeImage, looksLikePdf, looksLikeZip } from './audio';
import { learnChapterNames } from './chapter-names';
import { pictureLooksBlank } from './blank';
import { normaliseCover } from './covers';
import { PRINTED_FILE, type PdfOutlineEntry, inspectPdf } from './pdf';
import { cleanTitle } from './text';
import { storyUnits } from './units';
import { chapterLabel } from '../services/labels';
import { type WorkLimits, WorkLimitError, runInWorker } from '../services/aligner';
import { clearUpNextIfMatches } from '../services/next-book';
import { realignAfterIngest, scheduleTranscription } from '../services/readalong';

const MIME: Record<'epub' | 'pdf', string> = { epub: 'application/epub+zip', pdf: 'application/pdf' };

/**
 * Longest text kept from inside a file, beside a title or author (held to what members may type for
 * a book's): a unit's title (a chapter mark, an entry of the contents) and a language tag.
 */
const UNIT_TITLE_MAX = 200;
const LANGUAGE_MAX = 35;

/**
 * An upload whose file is gone (expired and cleaned up) is answered 410: not a server fault, and
 * no use retrying. Any other failure to read it (a disk error, too many open files) is the
 * server's own, thrown on to be logged and answered as one.
 */
function lostIfGone(err: unknown): never {
  if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') throw new HttpError(410, 'upload_gone', 'This upload is no longer on the server. Start it again.');
  throw err;
}

async function readHead(file: string, bytes = 4096): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const buf = new Uint8Array(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function checkKind(role: DeclaredFile['role'], kind: ImportRow['kind'], head: Uint8Array, name: string): void {
  if (role === 'cover') {
    if (!looksLikeImage(head)) throw badRequest(`${name} is not a JPEG, PNG, GIF or WebP image.`);
    return;
  }
  if (kind === 'epub' && !looksLikeZip(head)) throw badRequest(`${name} is not an EPUB file.`);
  if (kind === 'pdf' && !looksLikePdf(head)) throw badRequest(`${name} is not a PDF file.`);
  if (kind === 'audio' && !looksLikeAudio(head)) throw badRequest(`${name} is not an audio file we can play.`);
}

export interface FinalizeInput {
  readonly title: string;
  readonly author: string;
  readonly bookId?: string | undefined;
  readonly trackOrder?: readonly number[] | undefined;
  readonly trackTitles?: readonly string[] | undefined;
}

/** Imports being finished right now. One process serves the app (D1), so a claim in memory is enough. */
const finishing = new Set<string>();

/**
 * Turn a fully uploaded import into a book edition. Files are validated by their content, moved
 * into the blob store and recorded; the heavier ingest work runs as a background job. Finishing
 * is idempotent: asked again (a retry after a lost answer), it answers with the same book; asked
 * while the first request is still at work, it says so (409 `finishing`) and the client waits.
 */
export async function finalizeImport(ctx: AppContext, user: UserRow, imp: ImportRow, input: FinalizeInput): Promise<{ bookId: string; editionId: string }> {
  if (imp.status === 'finalized' && imp.book_id && imp.edition_id) return { bookId: imp.book_id, editionId: imp.edition_id };
  if (imp.status !== 'uploading') throw conflict('This upload was cancelled.');
  if (finishing.has(imp.id)) throw conflict('This upload is being finished already.', 'finishing');
  finishing.add(imp.id);
  try {
    return await finishClaimed(ctx, user, imp, input);
  } finally {
    finishing.delete(imp.id);
  }
}

async function finishClaimed(ctx: AppContext, user: UserRow, imp: ImportRow, input: FinalizeInput): Promise<{ bookId: string; editionId: string }> {
  const declared = declaredFiles(imp);
  const uploads = latestUploads(ctx.db, imp.id);
  const ready: { index: number; file: DeclaredFile; path: string }[] = [];
  for (const [index, file] of declared.entries()) {
    const upload = uploads.get(index);
    if (!upload || upload.completed_at === null) {
      if (file.role === 'cover') continue;
      throw badRequest(`${file.name} has not finished uploading yet.`);
    }
    ready.push({ index, file, path: path.join(ctx.storage.uploadsDir, upload.id) });
  }
  const content = ready.filter((r) => r.file.role !== 'cover');
  if (content.length === 0) throw badRequest('Nothing was uploaded.');
  if (imp.kind !== 'audio' && content.length !== 1) throw badRequest(`An ${imp.kind.toUpperCase()} upload has exactly one file.`);
  for (const r of ready) checkKind(r.file.role, imp.kind, await readHead(r.path).catch(lostIfGone), r.file.name);

  // Track order: as chosen in the upload form, else natural filename order.
  let order = content.map((r) => r.index);
  if (imp.kind === 'audio') {
    if (input.trackOrder && input.trackOrder.length > 0) {
      const wanted = [...input.trackOrder];
      const valid = wanted.length === order.length && wanted.every((i) => order.includes(i)) && new Set(wanted).size === wanted.length;
      if (!valid) throw badRequest('The track order does not match the uploaded tracks.');
      order = wanted;
    } else {
      order.sort((a, b) => naturalCompare(declared[a]!.name, declared[b]!.name));
    }
  }

  if (input.bookId) {
    const access = requireBook(ctx.db, input.bookId, user.id);
    if (access.book.club_id !== imp.club_id) throw badRequest('That book belongs to another club.');
  }

  // Measure every file where it lies. Nothing moves before it is recorded, so a failure up to
  // the transaction below leaves the upload as it was, ready to be finished again.
  const measured = new Map<number, { sha256: string; size: number }>();
  for (const r of ready) measured.set(r.index, await ctx.storage.measure(r.path).catch(lostIfGone));

  // One step: the book, the blobs, the edition and its files. Content already stored is shared
  // (D45), decided here, together with recording the use: a book deleted at the same moment
  // cannot take a shared blob away from under this one.
  const { book, edition, blobs } = ctx.db.tx(() => {
    // Measuring can take minutes. Whoever uploaded may have left the club since, or cancelled the
    // upload: checked again here, where nothing can change before the book is recorded.
    if (!membership(ctx.db, imp.club_id, user.id)) throw notFound('Upload session not found.');
    if (importById(ctx.db, imp.id)?.status !== 'uploading') throw conflict('This upload was cancelled.');
    const target = input.bookId ? bookById(ctx.db, input.bookId) : createBook(ctx.db, { clubId: imp.club_id, title: input.title, author: input.author, createdBy: user.id });
    if (!target) throw notFound('That book is no longer in the club.');
    const chosen = new Map<number, { id: string; size: number; fresh: boolean }>();
    const inThisUpload = new Map<string, string>();
    for (const r of ready) {
      const { sha256, size } = measured.get(r.index)!;
      const sameHere = inThisUpload.get(`${sha256}:${size}`);
      const shared = sameHere ?? sharedBlob(ctx.db, ctx.storage, sha256, size)?.id;
      if (shared) {
        chosen.set(r.index, { id: shared, size, fresh: false });
        continue;
      }
      const id = newId();
      const mime = r.file.role === 'cover' ? 'image/*' : imp.kind === 'audio' ? r.file.type || 'audio/mpeg' : MIME[imp.kind];
      insertBlob(ctx.db, { id, sha256, size, mime });
      chosen.set(r.index, { id, size, fresh: true });
      inThisUpload.set(`${sha256}:${size}`, id);
    }
    const totalSize = content.reduce((sum, r) => sum + chosen.get(r.index)!.size, 0);
    const e = createEdition(ctx.db, { bookId: target.id, kind: imp.kind, createdBy: user.id, sizeBytes: totalSize });
    order.forEach((fileIndex, idx) => {
      const file = declared[fileIndex]!;
      addEditionFile(ctx.db, {
        edition_id: e.id,
        idx,
        blob_id: chosen.get(fileIndex)!.id,
        role: imp.kind === 'audio' ? 'track' : 'main',
        title: imp.kind === 'audio' ? (input.trackTitles?.[idx]?.trim() ?? '') : '',
        // Shown back in errors and track titles: no control or bidi characters.
        original_name: cleanTitle(file.name, 500) || 'file',
      });
    });
    // Only an upload still open is finished: a cancel recorded first wins, and undoes all of this.
    if (!setImportStatus(ctx.db, imp.id, 'finalized', target.id, e.id)) throw conflict('This upload was cancelled.');
    return { book: target, edition: e, blobs: chosen };
  });

  // The files follow the records: a new blob's upload moves into the store (a rename on the same
  // volume); the upload of content already stored is let go.
  for (const r of ready) {
    const blob = blobs.get(r.index)!;
    try {
      if (blob.fresh) await ctx.storage.moveInto(r.path, blob.id);
      else await rm(r.path, { force: true });
    } catch (err) {
      ctx.log.error({ err, upload: r.path, blob: blob.id }, 'an uploaded file could not be moved into the store');
    }
    await rm(`${r.path}.json`, { force: true });
  }

  // An uploaded cover (the folder's cover.jpg, the PDF's first page, the EPUB's cover) wins
  // over one found later during ingest, but never replaces a cover the book already has.
  const cover = ready.find((r) => r.file.role === 'cover');
  if (cover && !book.cover_blob_id) {
    const blob = blobs.get(cover.index)!;
    try {
      // A cover is read whole to be redrawn: only if the file really is the size of a picture.
      const file = ctx.storage.blobPath(blob.id);
      const { size } = await stat(file);
      if (size > MAX_COVER_BYTES) throw new Error(`the cover file has ${size} bytes, more than ${MAX_COVER_BYTES}`);
      const jpeg = await normaliseCover(await readFile(file));
      // A picture of one shade (a PDF's first page drawn white by a browser that could not decode
      // its pictures) is no cover: the server draws the page itself, or the book gets a made one (D103).
      if (await pictureLooksBlank(jpeg)) ctx.log.info({ bookId: book.id }, 'an uploaded cover of one shade was left out');
      else await setCoverFromBytes(ctx, book.id, jpeg);
    } catch (err) {
      ctx.log.warn({ err }, 'uploaded cover could not be read');
    }
  }

  scheduleIngest(ctx, edition.id);
  ctx.hub.publish(book.club_id, () => ({ type: 'book:changed', clubId: book.club_id, bookId: book.id }));
  // A brand-new book (never a format added to one the club already has): if it is the one the
  // club voted Up next, the picker has nothing left to point at (D214/D215).
  if (!input.bookId) clearUpNextIfMatches(ctx, book.club_id, book.title);
  return { bookId: book.id, editionId: edition.id };
}

async function setCoverFromBytes(ctx: AppContext, bookId: string, jpeg: Uint8Array): Promise<void> {
  const stored = await ctx.storage.putBytes(jpeg);
  insertBlob(ctx.db, { id: stored.id, sha256: stored.sha256, size: stored.size, mime: 'image/jpeg' });
  setBookCover(ctx.db, bookId, stored.id);
}

async function coverIfMissing(ctx: AppContext, bookId: string, bytes: Uint8Array | null | undefined): Promise<void> {
  if (!bytes || bytes.byteLength === 0) return;
  const book = bookById(ctx.db, bookId);
  if (!book || book.cover_blob_id) return;
  try {
    await setCoverFromBytes(ctx, bookId, await normaliseCover(bytes));
  } catch (err) {
    ctx.log.warn({ err }, 'cover could not be read');
  }
}

/** A reason a file could not become an edition, written for the member who uploaded it. */
export class IngestError extends Error {
  override name = 'IngestError';
}

/** What members are told when a file fails for a reason not meant for them (it goes to the log). */
const COULD_NOT_READ: Record<EditionRow['kind'], string> = {
  epub: 'This EPUB could not be read.',
  pdf: 'This PDF could not be read.',
  audio: 'These audio files could not be read.',
};

export function scheduleIngest(ctx: AppContext, editionId: string): void {
  ctx.jobs.enqueue(`ingest:${editionId}`, () => ingestEdition(ctx, editionId));
}

interface Ingested {
  geometry: EditionGeometry;
  units: EditionUnit[];
  story: { start: number; end: number };
  meta: Record<string, unknown>;
}

/**
 * How long reading an EPUB may take, and in how much heap: twenty seconds and one more for each
 * megabyte of the file. Alice takes a fifth of a second, War and Peace about two; a book's
 * documents together hold at most BOOK_NODES nodes, which keeps the worst one within this too.
 */
export function epubLimits(bytes: number): WorkLimits {
  return { ms: 20_000 + Math.ceil(bytes / (1024 * 1024)) * 1000, heapMb: 1024 };
}

/**
 * How long reading a PDF's text may take (its lines, and the chapter headings of one without
 * bookmarks), and in how much heap: as long as reading an EPUB of its size. Alice's 91 pages take
 * about a third of a second.
 */
export function pdfHeadingLimits(bytes: number): WorkLimits {
  return epubLimits(bytes);
}

/** Options for reading an edition's files: the audio reader's, and the EPUB and PDF readers' limits. */
export interface IngestOptions extends TrackReaderOptions {
  readonly epub?: WorkLimits;
  /** Reading a PDF's text: its lines, and its chapter headings when it has no bookmarks (pdfHeadingLimits). */
  readonly pdfHeadings?: WorkLimits;
}

async function ingestEpub(ctx: AppContext, edition: EditionRow, file: string, limits?: WorkLimits): Promise<Ingested> {
  // In a worker thread with a time and a memory limit (D66): a book made to keep the parser busy
  // costs that worker, never the server its answers.
  const { size } = await stat(file);
  // An archive larger than all it may unpack to holds something other than a book.
  if (size > EPUB_LIMITS.maxTotalBytes) throw new IngestError(`This EPUB is larger than ${EPUB_LIMITS.maxTotalBytes / (1024 * 1024)} MB, more than any book needs.`);
  const pub = await runInWorker({ kind: 'publication', file }, limits ?? epubLimits(size)).catch((err: unknown) => {
    throw err instanceof WorkLimitError ? new IngestError('This EPUB is too large or too complex to read.', { cause: err }) : err;
  });
  await ctx.storage.removePub(edition.id);
  for (const [containerPath, data] of pub.files) await ctx.storage.writePubFile(edition.id, containerPath, data);
  // Compress the book's text now, so its first reader is not kept waiting while it is done.
  for (const [containerPath, data] of pub.files) {
    const file = ctx.storage.pubFile(edition.id, containerPath);
    if (!file || data.byteLength < MIN_COMPRESS_BYTES || !isCompressible(pub.mediaTypes.get(containerPath) ?? mediaTypeForPath(containerPath))) continue;
    await compressedCopy(file, 'br');
    await compressedCopy(file, 'gzip');
  }
  const starts: number[] = [];
  let at = 0;
  for (const s of pub.sections) {
    starts.push(at);
    at += s.textLength;
  }
  // The entries that start the book's chapters, and their names (D77).
  const entries = pub.toc.map((e) => ({ title: cleanTitle(e.title, UNIT_TITLE_MAX), m: starts[e.section]! + e.offset, depth: e.depth, alone: e.alone, caption: e.caption }));
  const chapters = new Map(chaptersFromContents(entries, pub.story).map((c) => [c.index, c]));
  // What the book says of itself is shown to members: tidied and bounded, as is any text from a file.
  const title = cleanTitle(pub.metadata.title, LIMITS.bookTitle);
  const author = cleanTitle(pub.metadata.author, LIMITS.bookAuthor);
  const language = cleanTitle(pub.metadata.language, LANGUAGE_MAX);
  const manifest: Publication = {
    editionId: edition.id,
    baseUrl: `/media/editions/${edition.id}/epub/`,
    title,
    author,
    language,
    direction: pub.metadata.direction,
    sections: pub.sections.map((s) => ({ index: s.index, href: s.path, textLength: s.textLength, linear: s.linear })),
    toc: pub.toc.map((e, i) => {
      const chapter = chapters.get(i);
      const title = entries[i]!.title;
      const named = chapter ? cleanTitle(chapter.title, UNIT_TITLE_MAX) : null;
      return { title, href: e.href, section: e.section, offset: e.offset, depth: e.depth, ...(chapter ? (named !== title ? { chapterTitle: named! } : {}) : { chapter: false }) };
    }),
    story: pub.story,
    // What follows the story and is the book's own (D109): read past the story, listed after it.
    ...(pub.backMatter ? { backMatter: pub.backMatter } : {}),
    resources: [...pub.files.keys()],
  };
  await ctx.storage.writePubFile(edition.id, '.publication.json', toJson(manifest));
  await ctx.storage.writePubFile(edition.id, '.media-types.json', toJson(Object.fromEntries(pub.mediaTypes)));
  await coverIfMissing(ctx, edition.book_id, pub.cover?.bytes);
  return {
    geometry: { kind: 'epub', sectionLengths: pub.sections.map((s) => s.textLength) },
    units: contentsUnits(
      [...chapters.values()].map((c) => ({ title: c.title, depth: entries[c.index]!.depth, m: c.m })),
      (c) => c.m,
    ),
    story: pub.story,
    meta: { title, author, language, story: pub.story },
  };
}

async function ingestPdf(ctx: AppContext, edition: EditionRow, file: string, limits?: WorkLimits): Promise<Ingested> {
  const info = await inspectPdf(file);
  if (info.pageCount === 0) throw new IngestError('The PDF has no pages.');
  await coverIfMissing(ctx, edition.book_id, info.coverJpeg);
  // Without bookmarks, its units are where the book's chapter headings top its pages (D74).
  const { headings, printed } = await printedTextOf(ctx, edition, file, info.outline.length === 0, limits);
  const outline = info.outline.length > 0 ? info.outline : headings;
  return {
    geometry: { kind: 'pdf', pageCount: info.pageCount },
    units: contentsUnits(outline, (o) => o.page + o.y),
    story: { start: 0, end: info.pageCount },
    meta: { title: cleanTitle(info.title, LIMITS.bookTitle), author: cleanTitle(info.author, LIMITS.bookAuthor), printed },
  };
}

/**
 * A PDF's text, read once in a worker within its limits: its lines are kept beside the edition
 * (PRINTED_FILE), for lining it up with the book's text (D75, readalong.ts), and the pages the
 * book's chapter headings top are returned when `headings` are wanted (a PDF without bookmarks,
 * findChapterHeadings, D74). No headings for a book that has no chapters yet or whose chapters are
 * this PDF's own; none, and no lines, when the worker runs out of its limits: that PDF is lined up
 * with the book by chapters only, or from start to end only, and its owner told (BookPage).
 */
async function printedTextOf(ctx: AppContext, edition: EditionRow, file: string, headings: boolean, limits?: WorkLimits): Promise<{ headings: PdfOutlineEntry[]; printed: boolean }> {
  const book = bookById(ctx.db, edition.book_id);
  const chapters = headings && book && book.reference_edition_id !== edition.id ? bookChapters(book) : [];
  // What was kept from a file read before goes: only what is read now is lined up.
  await rm(ctx.storage.pubDir(edition.id), { recursive: true, force: true });
  try {
    const { size } = await stat(file);
    const read = await runInWorker({ kind: 'pdf-text', file, chapters: chapters.map(({ title, t }) => ({ title, t })) }, limits ?? pdfHeadingLimits(size));
    if (read.printed) await ctx.storage.writePubFile(edition.id, PRINTED_FILE, read.printed);
    else ctx.log.warn({ editionId: edition.id, lines: read.lines }, 'a PDF prints too much text to be lined up with it');
    return { headings: read.headings, printed: read.printed !== null };
  } catch (err) {
    ctx.log.warn({ editionId: edition.id, err: err instanceof Error ? err.message : String(err) }, 'the text of a PDF could not be read');
    return { headings: [], printed: false };
  }
}

/**
 * A PDF read before its text was kept (D75; its reading does not say whether it was): its text
 * alone is read, once, and its book lined up again, so that it is lined up with the text as one
 * read now is. Whether the text was kept is noted either way: it is not tried at every start.
 */
async function readPrintedText(ctx: AppContext, editionId: string): Promise<void> {
  const edition = editionById(ctx.db, editionId);
  const main = edition?.status === 'ready' ? editionFiles(ctx.db, edition.id)[0] : undefined;
  if (!edition || !main) return;
  const { printed } = await printedTextOf(ctx, edition, ctx.storage.blobPath(main.blob_id), false);
  const fresh = editionById(ctx.db, edition.id);
  if (!fresh) return;
  ctx.db.exec('UPDATE editions SET meta_json = ? WHERE id = ?', [toJson({ ...editionMeta(fresh), printed }), fresh.id]);
  await realignAfterIngest(ctx, fresh.book_id);
}

/**
 * The entries of a table of contents or an outline as an edition's units: titles tidied, and at
 * most MAX_EDITION_UNITS of them. Contents too long for that (every chapter of every book of a
 * Bible) keep their shallower levels, as many as fit, and lose the rest; then the tail goes.
 */
function contentsUnits<T extends { readonly title: string; readonly depth: number }>(entries: readonly T[], measure: (entry: T) => number): EditionUnit[] {
  // The rule the EPUB's own contents were cut by (packages/epub), to the server's smaller count.
  return keepShallowest(entries, MAX_EDITION_UNITS).map((e) => ({ title: cleanTitle(e.title, UNIT_TITLE_MAX), m: measure(e) }));
}

async function ingestAudio(ctx: AppContext, edition: EditionRow, reading: TrackReaderOptions): Promise<Ingested> {
  const files = editionFiles(ctx.db, edition.id);
  const durations: number[] = [];
  const tracks: { title: string; m: number; chapters: TrackInfo['chapters'] }[] = [];
  let at = 0;
  let album: string | null = null;
  let artist: string | null = null;
  // One reader for the whole edition: its worker is started once, and a file whose chapters take
  // too long to read spares the files after it the wait.
  const reader = new TrackReader(reading);
  try {
    for (const f of files) {
      let info: TrackInfo | null;
      try {
        info = await reader.inspect(ctx.storage.blobPath(f.blob_id));
      } catch (err) {
        // A parser error names the blob's path on disk: it goes to the log; members see the file's name.
        ctx.log.warn({ err, editionId: edition.id, file: f.original_name }, 'track could not be read');
        if (err instanceof TrackTimeoutError) throw new IngestError(`${f.original_name} took too long to read.`);
        info = null;
      }
      if (!info || info.durationMs <= 0) throw new IngestError(`${f.original_name} has no playable audio.`);
      if (info.chaptersSkipped) ctx.log.warn({ editionId: edition.id, file: f.original_name, why: info.chaptersSkipped }, 'chapters marked in a track were left out');
      const title = cleanTitle(f.title || prettifyTrackTitle(info.title ?? undefined, f.original_name), LIMITS.bookTitle) || `Track ${f.idx + 1}`;
      updateEditionFile(ctx.db, edition.id, f.idx, { title, durationMs: info.durationMs });
      durations.push(info.durationMs);
      tracks.push({ title, m: at, chapters: info.chapters });
      at += info.durationMs;
      album ??= info.album;
      artist ??= info.artist;
      if (info.picture) await coverIfMissing(ctx, edition.book_id, info.picture.data);
    }
  } finally {
    await reader.close();
  }
  // A file with its own chapters (a single-file M4B audiobook) gives one unit per chapter, so
  // its chapters line up with the book's and appear in the player's list; else one per file.
  // Should the chapters come to more than MAX_EDITION_UNITS in all, every file is one unit.
  const marked = tracks.reduce((n, t) => n + Math.max(1, t.chapters.length), 0);
  const byChapter = marked <= MAX_EDITION_UNITS;
  if (!byChapter) ctx.log.warn({ editionId: edition.id, chapters: marked }, 'too many chapters marked in the tracks: one unit per track');
  const units = tracks.flatMap((t): EditionUnit[] =>
    byChapter && t.chapters.length > 1 ? t.chapters.map((c) => ({ title: c.title, m: t.m + c.startMs })) : [{ title: t.title, m: t.m }],
  );
  return {
    geometry: { kind: 'audio', trackDurationsMs: durations },
    units,
    story: { start: 0, end: at },
    meta: { album, artist },
  };
}


export interface Placement {
  readonly sync: SyncMap;
  readonly alignment: AlignmentRecord;
  /**
   * Set when this edition defines the book's chapters, or names them: all of them, for a book whose
   * first edition had none; real names, for chapters known only by number.
   */
  readonly chapters: Chapter[] | null;
}

/**
 * Put an edition on the book timeline. The first edition defines the timeline (a linear map over
 * its story) and the chapters; later editions are aligned to those chapters.
 */
export function placeOnTimeline(book: BookRow, others: readonly EditionRow[], editionId: string, ingested: Ingested): Placement {
  const { units, story } = ingested;
  const inStory = storyUnits(units, story);
  const chapters = bookChapters(book);
  const hasOtherReady = others.some((e) => e.id !== editionId && e.status === 'ready');
  const isReference = !hasOtherReady && (book.reference_edition_id === null || book.reference_edition_id === editionId);
  if (isReference || (chapters.length === 0 && !hasOtherReady)) {
    const sync = story.end > story.start ? linearSyncMap(story.start, story.end) : linearSyncMap(0, 1);
    const derived: Chapter[] = inStory.map(({ unit }, i) => ({ index: i, title: unit.title, t: mToT(sync, unit.m) }));
    const unitToChapter: (number | null)[] = units.map(() => null);
    inStory.forEach((s, k) => {
      unitToChapter[s.index] = k;
    });
    // Read again, the edition finds its chapters where they were: those keep the names other
    // editions taught them.
    const kept = chapters.flatMap((c, i) => (derived[i] && Math.abs(derived[i].t - c.t) < 1e-9 ? [{ chapter: i, title: c.title }] : []));
    return { sync, alignment: { method: 'reference', unitToChapter }, chapters: learnChapterNames(derived, kept, book) ?? derived };
  }
  const candidates = inStory.map((s) => s.unit);
  const alignment = alignUnitsToChapters(chapters, candidates, story);
  const sync = syncMapFromAlignment(chapters, candidates, alignment, story);
  const unitToChapter: (number | null)[] = units.map(() => null);
  for (const { unit, chapter } of alignment.pairs) unitToChapter[inStory[unit]!.index] = chapter;
  // A book whose first edition had no chapters learns them from this one, without moving anything.
  const learned = chapters.length === 0 && inStory.length > 0 ? inStory.map(({ unit }, i) => ({ index: i, title: unit.title, t: mToT(sync, unit.m) })) : null;
  // Chapters known only by number ("Chapter 3", "Track 07") learn the names of the units matched with them.
  const named = learnChapterNames(chapters, alignment.pairs.map(({ unit, chapter }) => ({ chapter, title: candidates[unit]!.title })), book);
  return { sync, alignment: { method: alignment.method, unitToChapter }, chapters: learned ?? named };
}

/** Saved places keep their t; what they are called ("Chapter 3 · 24%") follows the chapters' names. */
function relabelProgress(ctx: AppContext, bookId: string, chapters: readonly Chapter[]): void {
  for (const p of progressForBook(ctx.db, bookId)) {
    const label = chapterLabel(chapters, p.t);
    if (label !== p.label) ctx.db.exec('UPDATE progress SET label = ? WHERE user_id = ? AND book_id = ?', [label, p.user_id, p.book_id]);
  }
}

/** Ingest an edition; `reading` sets how long its audio files may take to read (tests shorten it). */
export async function ingestEdition(ctx: AppContext, editionId: string, reading: IngestOptions = {}): Promise<void> {
  const edition = editionById(ctx.db, editionId);
  if (!edition) return;
  countIngestStart(ctx.db, edition.id);
  try {
    const main = editionFiles(ctx.db, edition.id)[0];
    if (!main) throw new IngestError('The edition has no files.');
    const ingested =
      edition.kind === 'epub'
        ? await ingestEpub(ctx, edition, ctx.storage.blobPath(main.blob_id), reading.epub)
        : edition.kind === 'pdf'
          ? await ingestPdf(ctx, edition, ctx.storage.blobPath(main.blob_id), reading.pdfHeadings)
          : await ingestAudio(ctx, edition, reading);
    const book = bookById(ctx.db, edition.book_id);
    if (!book) return;
    ctx.db.tx(() => {
      const fresh = bookById(ctx.db, edition.book_id)!;
      const placement = placeOnTimeline(fresh, editionsForBook(ctx.db, fresh.id), edition.id, ingested);
      markEditionReady(ctx.db, edition.id, {
        ...ingested,
        meta: { ...ingested.meta, story: ingested.story },
        sync: placement.sync,
        alignment: placement.alignment,
      });
      if (placement.chapters) {
        const referenceId = placement.alignment.method === 'reference' ? edition.id : (fresh.reference_edition_id ?? edition.id);
        setBookTimeline(ctx.db, fresh.id, referenceId, placement.chapters);
        relabelProgress(ctx, fresh.id, placement.chapters);
      }
    });
    ctx.hub.publish(book.club_id, () => ({ type: 'book:changed', clubId: book.club_id, bookId: book.id }));
    // Sentence-level sync: a new text or audiobook is lined up with what was heard (D46); a PDF
    // and the text, line by line, before this ends (D75).
    await realignAfterIngest(ctx, book.id);
    const ready = editionById(ctx.db, edition.id);
    if (ready?.kind === 'audio') scheduleTranscription(ctx, ready);
    // Cal's hybrid search (D160, D164): queued after realignment, so the chunks it indexes carry
    // this edition's final sync map, not one a forced alignment is about to replace.
    if (ready) queueIndexEdition(ctx, ready.id);
  } catch (err) {
    // Members see why in their own words (a DRM-locked EPUB, a PDF with no pages); anything else,
    // such as a disk error naming the server's paths, stays in the log.
    const meant = err instanceof IngestError || err instanceof EpubError;
    const message = meant ? err.message : COULD_NOT_READ[edition.kind];
    markEditionFailed(ctx.db, edition.id, message);
    const book = bookById(ctx.db, edition.book_id);
    if (book) ctx.hub.publish(book.club_id, () => ({ type: 'book:changed', clubId: book.club_id, bookId: book.id }));
    // With the reason behind the members' words, for whoever runs the server ("it took longer than 21 s").
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
    ctx.log.warn({ editionId, err: err instanceof Error ? err.message : String(err), ...(cause ? { cause } : {}) }, 'ingest failed');
  }
}

/** Apply a manual track-to-chapter alignment from the book settings. */
export function realign(ctx: AppContext, edition: EditionRow, unitToChapter: readonly (number | null)[]): void {
  const book = bookById(ctx.db, edition.book_id)!;
  if (edition.status !== 'ready') throw badRequest('That edition is not ready yet.');
  if (book.reference_edition_id === edition.id) throw badRequest('This edition defines the book’s chapters; there is nothing to align it to.');
  const chapters = bookChapters(book);
  const units = editionUnits(edition);
  const story = (editionMeta<{ story?: { start: number; end: number } }>(edition).story) ?? null;
  const geometryTotal = edition.geometry_json ? totalMeasure(JSON.parse(edition.geometry_json) as EditionGeometry) : 0;
  const range = story ?? { start: 0, end: geometryTotal };
  const alignment = manualAlignment(chapters, units, unitToChapter);
  // Held to the pace a match found by the server is (D77): a part heard over a few lines of the
  // book would open what is said at its end to friends at its start.
  const off = implausibleStretch(chapters, units, alignment, range);
  if (off) {
    const name = units[off.unit]?.title ?? 'One part';
    throw badRequest(
      off.squeezed
        ? `With these chapters, “${name}” would be heard over far too little of the book. Check the chapter each part starts.`
        : `With these chapters, “${name}” would be heard over far too much of the book. Check the chapter each part starts.`,
    );
  }
  const sync = syncMapFromAlignment(chapters, units, alignment, range);
  const chosen: (number | null)[] = units.map(() => null);
  for (const { unit, chapter } of alignment.pairs) chosen[unit] = chapter;
  setEditionSync(ctx.db, edition.id, sync, { method: alignment.method, unitToChapter: chosen });
  // The sync map just changed: Cal's chunks of this edition (if any) carry the old one.
  queueIndexEdition(ctx, edition.id);
}

/** Starts after which an edition that never finished being read is given up on (migration 009). */
export const INGEST_STARTS = 3;

/** Re-queue editions interrupted by a restart, and read the text of PDFs read before it was kept (D75). */
export function resumeIngest(ctx: AppContext): number {
  const stuck = ctx.db.all<{ id: string; ingest_starts: number }>("SELECT id, ingest_starts FROM editions WHERE status = 'processing'");
  let resumed = 0;
  for (const e of stuck) {
    // Started this often and never finished: reading it stops the server, every time.
    if (e.ingest_starts >= INGEST_STARTS) {
      markEditionFailed(ctx.db, e.id, 'This file stopped the server each time it was read, so it was put aside.');
      ctx.log.warn({ editionId: e.id, starts: e.ingest_starts }, 'ingest given up after repeated starts');
      continue;
    }
    scheduleIngest(ctx, e.id);
    resumed++;
  }
  // PDFs read before their text was kept (D75): their text is read now, once.
  for (const e of ctx.db.all<EditionRow>("SELECT * FROM editions WHERE kind = 'pdf' AND status = 'ready'")) {
    if (editionMeta<{ printed?: boolean }>(e).printed === undefined) ctx.jobs.enqueue(`printed:${e.id}`, () => readPrintedText(ctx, e.id));
  }
  return resumed;
}
