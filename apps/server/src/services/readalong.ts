import { type ChildProcess, spawn } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { measureBodyText } from '@bookclub/epub';
import {
  type EditionGeometry,
  type Locator,
  type Publication,
  type ReadAlongTrack,
  type Span,
  type SyncMap,
  type Transcript,
  type TranscriptionStatus,
  formatBytes,
  formatDuration,
  linearSyncMap,
  locatorToT,
  mToT,
  normalizeRanges,
  rangesCoverage,
  rangesFurthest,
  readingContents,
  syncMapFromAlignment,
  tToM,
  totalMeasure,
} from '@bookclub/shared';
import { queueIndexEdition } from '../cal/indexer';
import { type AppContext } from '../context';
import { HttpError, badRequest } from '../lib/errors';
import { fromJson, toJson } from '../lib/json';
import { PRINTED_FILE } from '../ingest/pdf';
import { storyUnits } from '../ingest/units';
import { blobById } from '../repos/blobs';
import {
  type AlignmentRecord,
  type BookRow,
  type EditionRow,
  bookById,
  bookChapters,
  editionAlignment,
  editionById,
  editionFiles,
  editionMeta,
  editionUnits,
  editionsForBook,
  setEditionSync,
} from '../repos/books';
import { progressForBook, readRanges } from '../repos/progress';
import {
  READ_ALONG_RULES,
  audiobooksAwaitingTranscript,
  awaitsTranscript,
  beginTranscriptionRun,
  bookHasTranscripts,
  booksWithReadAlongsBefore,
  deleteReadAlong,
  endTranscriptionRun,
  giveBackTranscriptionRun,
  hasTranscript,
  transcriptionFor,
  readAlongFor,
  readAlongSentences,
  readAlongsForBook,
  saveReadAlong,
  saveTranscript,
  saveTranscriptJson,
  transcriptRemoved,
} from '../repos/readalong';
import { type AlignResult, type AlignTask, type PrintAlignResult, type TrackFile, matchTranscript, wordsAllowed } from './align-worker';
import { type WorkLimits, WorkLimitError, runInWorker } from './aligner';
import {
  type LiveTranscription,
  applyProgressDoc,
  initialLive,
  lastRecogniserError,
  parseProgressDoc,
  parseProgressLine,
  toTranscriptionStatus,
} from './transcription-progress';
import { LINE_SHARE } from './gating';
import { chapterLabel } from './labels';

/**
 * Read-along (D46): an audiobook lined up with the book's text, sentence by sentence, from a
 * transcript of what the narrator says. The transcript comes from a speech recogniser outside
 * the app (tools/align/transcribe.py, or TRANSCRIBE_COMMAND on the server); everything here is
 * text alignment, deterministic, and done in worker threads (align-worker.ts) with time and
 * memory limits: a transcript is parsed and a book lined up there, never on the server's thread.
 * A PDF is lined up with the text the same way, line by line, from its printed text (D75).
 */

function geometryOf(edition: EditionRow): EditionGeometry | null {
  return edition.geometry_json ? fromJson<EditionGeometry | null>(edition.geometry_json, null) : null;
}

function syncOf(edition: EditionRow): SyncMap | null {
  return edition.sync_json ? fromJson<SyncMap | null>(edition.sync_json, null) : null;
}

/** The audiobook's track files in play order. */
function trackFiles(ctx: AppContext, audio: EditionRow) {
  return editionFiles(ctx.db, audio.id).filter((f) => f.role === 'track');
}

/** The audiobook's track files as the server measured them: what a transcript is matched to. */
function measuredTracks(ctx: AppContext, audio: EditionRow): TrackFile[] {
  return trackFiles(ctx, audio).map((f) => ({ blobId: f.blob_id, sha256: blobById(ctx.db, f.blob_id)?.sha256 ?? null, durationMs: f.duration_ms ?? 0 }));
}

/** A transcript is given to an audiobook that is ready, and to nothing else. */
export function requireTranscribable(edition: EditionRow): void {
  if (edition.kind !== 'audio' || edition.status !== 'ready') throw badRequest('A transcript belongs to an audiobook that is ready.');
}

/* ------------------------------------------------------------------------------------------ */
/* Keeping a transcript                                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * The most a transcript may weigh, uploaded by the owner or written by the server's recogniser:
 * enough for the longest audiobooks a club reads, with room to spare. A recogniser writes about
 * 30 bytes a word ([12345,12678,"word",0.987]): War and Peace read in 61 hours is 540,000 words
 * and 16 MB, and would be 23 MB read throughout at the pace of the reference recording's fastest
 * track (3.4 words a second).
 */
export const TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Refuse a transcript of `bytes` bytes, before it is read, when no transcript of this audiobook
 * can be that big: a few kilobytes for the document and each track, and 200 bytes for each word
 * the audio's length allows (wordsAllowed), several times what a recogniser writes for one, never
 * more than TRANSCRIPT_MAX_BYTES. Fifty megabytes of words for a minute of audio are never read.
 */
export function checkTranscriptSize(ctx: AppContext, audio: EditionRow, bytes: number): void {
  const tracks = trackFiles(ctx, audio);
  const ms = tracks.reduce((n, f) => n + (f.duration_ms ?? 0), 0);
  const allowed = Math.min(TRANSCRIPT_MAX_BYTES, 64 * 1024 + tracks.length * 1024 + wordsAllowed(ms) * 200);
  if (bytes <= allowed) return;
  throw new HttpError(
    413,
    'too_large',
    bytes > TRANSCRIPT_MAX_BYTES
      ? `That transcript is ${formatBytes(bytes)}: a transcript may be ${formatBytes(TRANSCRIPT_MAX_BYTES)} at most.`
      : `That transcript is ${formatBytes(bytes)}: one of this audiobook (${formatDuration(ms)} of audio) is never more than ${formatBytes(allowed)}.`,
  );
}

/**
 * How long, and with how much memory, a transcript may be read, and an audiobook lined up; how
 * slowly an upload may come in; and when an alignment that ran out of its limits is tried again.
 */
export interface ReadAlongLimits {
  readonly read: WorkLimits;
  readonly align: WorkLimits;
  /** An upload's body must come at `bytesPerSecond` at least, and is given `minMs` however small. */
  readonly upload: { readonly bytesPerSecond: number; readonly minMs: number };
  /** How long after an alignment ran out of its limits the book is lined up once more. */
  readonly alignAgainMs: number;
}

/**
 * Measured in a worker on War and Peace (567,000 words) and a transcript of 61 hours of it
 * (540,000 words, 16 MB): reading the transcript takes a second and between 192 and 256 MB, lining
 * the book up 4 s and between 320 and 384 MB. The limits leave room for a book twice as long on a
 * box several times slower; a transcript made to take longer, or more, is stopped at them.
 *
 * An upload must come at 64 KiB a second (half of hotel Wi-Fi's 1 Mbit/s), with a minute for any
 * transcript: War and Peace's 16 MB in four minutes, the most a transcript may weigh (32 MiB) in
 * eight and a half, inside the ten the server gives any request (app.ts). One that stops coming
 * is cut off there, and its place goes to someone else's.
 *
 * An alignment stopped at its limits may only have met a busy box: it is tried once more half an
 * hour later.
 */
export const READ_ALONG_LIMITS: ReadAlongLimits = {
  read: { ms: 30_000, heapMb: 512 },
  align: { ms: 60_000, heapMb: 768 },
  upload: { bytesPerSecond: 64 * 1024, minMs: 60_000 },
  alignAgainMs: 30 * 60_000,
};

/** An alignment that ran out of its limits: what was tried, and where it stands with its second try. */
interface OverLimits {
  /** `<transcript>:<text>` (Work.kept, the text edition). */
  readonly tried: string;
  /** Waiting for its second try (alignAgainMs), due for it, or past it: not tried again until either changes. */
  state: 'waiting' | 'due' | 'spent';
}

/** A text read along, measured (sectionTexts), and how many characters it holds once it is. */
interface MeasuredText {
  readonly sections: Promise<readonly string[] | null>;
  chars: number;
}

/** One server's read-along work (tests run several servers in one process). */
interface Work {
  limits: ReadAlongLimits;
  /** The transcript being read: one at a time, for each holds its whole document in memory. */
  reading: Promise<unknown>;
  /** Transcripts kept for each audiobook since the server started: which one an alignment lined up. */
  readonly kept: Map<string, number>;
  /**
   * Audiobooks whose transcript, and PDFs whose printed text, could not be lined up with a text
   * within the limits, and what was tried: tried once more alignAgainMs later, then not again until
   * either changes, so that what lines a book up again (a new format, a chapter match) cannot keep a
   * worker at its limits. A restart tries once more.
   */
  readonly overLimits: Map<string, OverLimits>;
  /** Books waiting to be lined up, with what tells whoever waits for it that it has been (alignmentOf). */
  readonly aligning: Map<string, { readonly done: Promise<void>; readonly tell: () => void }>;
  /** The texts read along, measured, the one read along longest ago first (sectionTexts). */
  readonly texts: Map<string, MeasuredText>;
}

const works = new WeakMap<AppContext, Work>();

function workOf(ctx: AppContext): Work {
  let work = works.get(ctx);
  if (!work) {
    work = { limits: READ_ALONG_LIMITS, reading: Promise.resolve(), kept: new Map(), overLimits: new Map(), aligning: new Map(), texts: new Map() };
    works.set(ctx, work);
  }
  return work;
}

/** Give one server other limits (tests make them small). */
export function setReadAlongLimits(ctx: AppContext, limits: Partial<ReadAlongLimits>): void {
  const work = workOf(ctx);
  work.limits = { ...work.limits, ...limits };
}

/** How long the body of an upload of `bytes` bytes may take to come in (ReadAlongLimits.upload). */
export function uploadDeadlineMs(ctx: AppContext, bytes: number): number {
  const { bytesPerSecond, minMs } = workOf(ctx).limits.upload;
  return Math.max(minMs, Math.ceil((bytes / bytesPerSecond) * 1000));
}

/** An audiobook has a new transcript: whatever went over the limits before is tried again. */
function noteKept(ctx: AppContext, audioId: string): void {
  const { kept } = workOf(ctx);
  kept.set(audioId, (kept.get(audioId) ?? 0) + 1);
  // Theirs stands (an owner's upload, the demo's): a recogniser still reading the audiobook stops.
  stopTranscriptionOf(ctx, audioId);
}

/** Keep a transcript already read (the demo's, by the seed): matched to the audiobook's tracks here. */
export function importTranscript(ctx: AppContext, audio: EditionRow, doc: Transcript): void {
  requireTranscribable(audio);
  saveTranscript(ctx.db, audio.id, [doc.engine, doc.model].filter(Boolean).join(' '), matchTranscript(doc, measuredTracks(ctx, audio)));
  noteKept(ctx, audio.id);
}

/**
 * Read a transcript (an upload, or what the server's recogniser wrote) and keep it for an
 * audiobook. It is parsed, checked and matched to the audiobook's tracks (matchTranscript) in a
 * worker thread, one transcript at a time; one the worker cannot read within its limits is refused
 * as too big (413). False when it was not kept: the audiobook is gone, or `wanted` says no once it
 * has been read (the owner gave it another meanwhile).
 */
export async function importTranscriptBody(ctx: AppContext, audio: EditionRow, body: Uint8Array, wanted: (fresh: EditionRow) => boolean = () => true): Promise<boolean> {
  requireTranscribable(audio);
  checkTranscriptSize(ctx, audio, body.byteLength);
  const work = workOf(ctx);
  const files = measuredTracks(ctx, audio);
  const reading = work.reading.then(() => runInWorker({ kind: 'read', body, files }, work.limits.read));
  work.reading = reading.catch(() => undefined);
  const read = await reading.catch((err: unknown) => {
    if (err instanceof WorkLimitError) throw new HttpError(413, 'too_large', `That transcript is too big to read: ${err.message}.`);
    throw err;
  });
  if ('refused' in read) throw badRequest(read.refused, read.fields);
  // While it was read, the audiobook may have been deleted, or have been given another transcript.
  const fresh = editionById(ctx.db, audio.id);
  if (!fresh || !wanted(fresh)) return false;
  requireTranscribable(fresh);
  saveTranscriptJson(ctx.db, fresh.id, read.engine, read.tracks);
  noteKept(ctx, fresh.id);
  // Cal's hybrid search (D160): the audiobook now has a transcript to index (or has a new one).
  queueIndexEdition(ctx, fresh.id);
  return true;
}

/**
 * Line a book's audiobooks up again in the background. A book waiting to be lined up is lined up
 * once, from what it is by then, however many uploads or changes queued it (Jobs.enqueue).
 */
export function scheduleAlignment(ctx: AppContext, bookId: string): void {
  void alignmentOf(ctx, bookId);
}

/**
 * Queue a book's alignment (scheduleAlignment) and know when it is done: resolves once the book
 * has been lined up from what it is now, by whichever job of that name runs next (one that fails
 * is logged by the queue). Every alignment goes through this one queue, so that no two of a book
 * run at once, and none saves what it worked out from a state another has since changed.
 */
function alignmentOf(ctx: AppContext, bookId: string): Promise<void> {
  const { aligning } = workOf(ctx);
  let waiting = aligning.get(bookId);
  if (!waiting) {
    let tell = () => {};
    const done = new Promise<void>((resolve) => (tell = resolve));
    waiting = { done, tell };
    aligning.set(bookId, waiting);
  }
  ctx.jobs.enqueue(`align:${bookId}`, async () => {
    // Whoever waits until now is told once this run ends; whoever comes meanwhile, after the next.
    const these = aligning.get(bookId);
    aligning.delete(bookId);
    try {
      await alignBook(ctx, bookId);
    } finally {
      these?.tell();
    }
  });
  return waiting.done;
}

/** A book with a PDF and a text that PDF's printed lines are lined up with (D75). */
function printedPair(editions: readonly EditionRow[]): boolean {
  const ready = (kind: EditionRow['kind']) => editions.some((e) => e.kind === kind && e.status === 'ready');
  return ready('pdf') && ready('epub');
}

/**
 * After any change to a book's editions: line its audiobooks up again (or undo it), when it has
 * transcripts, and its PDFs, when it has a text to line their printed lines up with (D75).
 */
export function realignIfTranscribed(ctx: AppContext, bookId: string): void {
  const book = bookById(ctx.db, bookId);
  if (!book) return;
  const editions = editionsForBook(ctx.db, bookId);
  const forced = editions.some((e) => editionAlignment(e).method === 'forced');
  if (forced || printedPair(editions) || bookHasTranscripts(ctx.db, bookId)) scheduleAlignment(ctx, bookId);
}

/**
 * After an edition of a book has been read: a book with a PDF and a text is lined up at once,
 * before the reading ends (in its job, so after any alignment queued before it), so that a new PDF,
 * or a text added to one, is lined up line by line as it becomes ready, and whatever follows (the
 * demo placing its readers) uses that map. Anything else is lined up as realignIfTranscribed does,
 * on the alignment queue. A book that cannot be lined up keeps its edition ready all the same.
 */
export async function realignAfterIngest(ctx: AppContext, bookId: string): Promise<void> {
  if (!printedPair(editionsForBook(ctx.db, bookId))) return realignIfTranscribed(ctx, bookId);
  try {
    await alignBook(ctx, bookId);
  } catch (err) {
    ctx.log.warn({ bookId, err: err instanceof Error ? err.message : String(err) }, 'the book could not be lined up with its text');
  }
}

/** The text an audiobook is lined up with: the reference EPUB, or the first ready one. */
function pickText(book: BookRow, editions: readonly EditionRow[]): EditionRow | undefined {
  const epubs = editions.filter((e) => e.kind === 'epub' && e.status === 'ready');
  return epubs.find((e) => e.id === book.reference_edition_id) ?? epubs[0];
}

/** A text edition's manifest (its sections, with their files and lengths, and its story), or null without one. */
async function publicationOf(ctx: AppContext, text: EditionRow): Promise<Publication | null> {
  const manifest = ctx.storage.pubFile(text.id, '.publication.json');
  return manifest ? (JSON.parse(await readFile(manifest, 'utf8')) as Publication) : null;
}

/**
 * Characters of text kept measured for reading along, on each server: nine War and Peaces. A
 * club's books all fit, each measured once for as long as the server runs; past it, the text read
 * along longest ago is let go, so that texts made huge cannot pile up in the server's memory.
 */
const TEXTS_KEPT_CHARS = 32 * 1024 * 1024;

/**
 * The text of each section of an edition as readers measure it, which a read-along's sentences
 * quote: measured on the server's thread once, then kept (Work.texts). The sections are the
 * server's own, written under the EPUB limits at ingest, and the worker that lined the book up
 * found these same files to measure as readers measure them (alignText). Measuring them takes
 * 50 ms for all of War and Peace, 0.7 s for a section of a million nodes (the most one may hold).
 * A text that could not be read is not kept: the next request tries again.
 */
function sectionTexts(ctx: AppContext, text: EditionRow): Promise<readonly string[] | null> {
  const { texts } = workOf(ctx);
  const kept = texts.get(text.id);
  if (kept) {
    // Read along again: the last to be let go.
    texts.delete(text.id);
    texts.set(text.id, kept);
    return kept.sections;
  }
  const measured: MeasuredText = { sections: measureSections(ctx, text), chars: 0 };
  texts.set(text.id, measured);
  measured.sections.then(
    (sections) => {
      measured.chars = sections?.reduce((n, s) => n + s.length, 0) ?? 0;
      // Those read along longest ago go until the rest fit; the one just measured stays, and so do
      // any still being measured (they weigh nothing yet).
      let chars = [...texts.values()].reduce((n, t) => n + t.chars, 0);
      for (const [id, t] of texts) {
        if (chars <= TEXTS_KEPT_CHARS || t === measured) break;
        if (t.chars === 0) continue;
        texts.delete(id);
        chars -= t.chars;
      }
    },
    () => {
      if (texts.get(text.id) === measured) texts.delete(text.id);
    },
  );
  return measured.sections;
}

async function measureSections(ctx: AppContext, text: EditionRow): Promise<string[] | null> {
  const publication = await publicationOf(ctx, text);
  if (!publication) return null;
  const sections: string[] = [];
  for (const s of publication.sections) {
    const file = ctx.storage.pubFile(text.id, s.href);
    sections.push(file ? measureBodyText(await readFile(file, 'utf8')) : '');
  }
  return sections;
}

/** The edition's chapter-level map, from its stored chapter match (what forced alignment refines). */
function chapterSync(book: BookRow, edition: EditionRow): SyncMap | null {
  const geometry = geometryOf(edition);
  if (!geometry) return null;
  const total = totalMeasure(geometry);
  const story = editionMeta<{ story?: { start: number; end: number } }>(edition).story ?? { start: 0, end: total };
  const alignment = editionAlignment(edition);
  const method = alignment.method === 'forced' ? (alignment.chapterMethod ?? 'none') : alignment.method;
  if (method === 'reference') return story.end > story.start ? linearSyncMap(story.start, story.end) : null;
  const inStory = storyUnits(editionUnits(edition), story);
  const pairs = inStory.flatMap((s, k) => {
    const chapter = alignment.unitToChapter[s.index];
    return chapter === null || chapter === undefined ? [] : [{ unit: k, chapter }];
  });
  return syncMapFromAlignment(
    bookChapters(book),
    inStory.map((s) => s.unit),
    { method: 'manual', pairs },
    story,
  );
}

/**
 * What both maps agree was read: each range intersected with where the new map moves it. A range
 * that moves clear of itself agrees on nothing; it must never become the gap between the two.
 */
export function agreedRanges(ranges: readonly Span[], moved: (t: number) => number): Span[] {
  return normalizeRanges(ranges.map(([a, b]): Span => [Math.max(a, moved(a)), Math.min(b, moved(b))]).filter(([a, b]) => a < b));
}

/**
 * Positions made in an edition whose map changed keep their place in it (their locators) and get
 * new timeline values. The book's merged read ranges (progress, the club bar) keep, for a member
 * whose place is in this edition, only what both the old and the new map agree they read: never
 * more, at worst a sliver less until they pass it again. Notes open from reading kept per edition
 * (D63), which a new map does not move.
 */
function retime(ctx: AppContext, book: BookRow, edition: EditionRow, before: SyncMap, after: SyncMap): void {
  const geometry = geometryOf(edition);
  if (!geometry) return;
  const timeline = { geometry, sync: after };
  const tOf = (json: string | null) => (json ? locatorToT(timeline, JSON.parse(json) as Locator) : null);
  for (const c of ctx.db.all<{ id: string; locator_json: string; end_locator_json: string | null }>(
    'SELECT id, locator_json, end_locator_json FROM comments WHERE book_id = ? AND edition_id = ?',
    [book.id, edition.id],
  )) {
    ctx.db.exec('UPDATE comments SET t = ?, end_t = ? WHERE id = ?', [tOf(c.locator_json), tOf(c.end_locator_json), c.id]);
  }
  const first = before.points[0]!.t;
  const last = before.points[before.points.length - 1]!.t;
  const moved = (x: number) => (x < first || x > last ? x : mToT(after, tToM(before, x)));
  const chapters = bookChapters(book);
  for (const p of progressForBook(ctx.db, book.id)) {
    if (p.edition_id !== edition.id || !p.locator_json) continue;
    const t = tOf(p.locator_json)!;
    const ranges = agreedRanges(readRanges(p), moved);
    ctx.db.exec('UPDATE progress SET t = ?, label = ?, read_ranges_json = ?, furthest = ?, coverage = ? WHERE user_id = ? AND book_id = ?', [
      t,
      chapterLabel(chapters, t),
      toJson(ranges),
      rangesFurthest(ranges),
      rangesCoverage(ranges),
      p.user_id,
      p.book_id,
    ]);
  }
}

/** Give an edition its chapter-level map back (its text is gone, or its transcript). */
function restoreChapterMap(ctx: AppContext, book: BookRow, edition: EditionRow): void {
  const alignment = editionAlignment(edition);
  if (alignment.method !== 'forced') return;
  const current = syncOf(edition);
  const fallback = chapterSync(book, edition);
  if (!current || !fallback) return;
  ctx.db.tx(() => {
    setEditionSync(ctx.db, edition.id, fallback, { method: alignment.chapterMethod ?? 'none', unitToChapter: alignment.unitToChapter });
    retime(ctx, book, edition, current, fallback);
  });
}

/**
 * The text's sections as a worker reads them (each one's file and the length readers measure it
 * at) and its story, from its manifest: the sections themselves are read and measured in the worker.
 */
async function textToAlign(ctx: AppContext, text: EditionRow): Promise<(Pick<AlignTask, 'sections' | 'story' | 'unread'>) | null> {
  const publication = await publicationOf(ctx, text);
  if (!publication) return null;
  return {
    sections: publication.sections.map((s) => ({ index: s.index, file: ctx.storage.pubFile(text.id, s.href), textLength: s.textLength })),
    story: publication.story,
    // What of the story no recording reads: a narrator's announcement is never its title page or contents (FR154).
    unread: readingContents(publication).unread,
  };
}

/**
 * An alignment stopped at its limits for the first time: the book is lined up once more
 * alignAgainMs later, through the queue as any alignment is, unless the server is stopping or what
 * was tried has changed meanwhile (a new transcript, another text, a success). `editionId` is the
 * audiobook or the PDF lined up.
 */
function tryAgainLater(ctx: AppContext, work: Work, bookId: string, editionId: string, tried: string): void {
  const over: OverLimits = { tried, state: 'waiting' };
  work.overLimits.set(editionId, over);
  setTimeout(() => {
    if (work.overLimits.get(editionId) !== over || transcriberOf(ctx).stopping) return;
    over.state = 'due';
    scheduleAlignment(ctx, bookId);
  }, work.limits.alignAgainMs).unref();
}

/**
 * Line one audiobook up with one text and refine whichever map the book's timeline does not rest
 * on. The alignment is worked out in a worker thread with its time and memory limits, which reads
 * the transcript itself; only the outcome is kept here. One stopped at its limits changes nothing,
 * since the box may only have been busy: the read-along from before, if any, stays with the map it
 * refined, and the pair is tried once more later (tryAgainLater). Stopped again, it is left alone
 * until the transcript or the text changes (Work.overLimits).
 */
async function alignPair(ctx: AppContext, book: BookRow, audio: EditionRow, text: EditionRow): Promise<void> {
  const audioSync = syncOf(audio);
  const textSync = syncOf(text);
  const audioGeometry = geometryOf(audio);
  const textGeometry = geometryOf(text);
  if (!hasTranscript(ctx.db, audio.id) || !audioSync || !textSync || !audioGeometry || !textGeometry) return;
  // The timeline rests on the reference edition: the other one is refined, and its sentences may
  // only move inside the chapters its chapter map already puts them in.
  const audioIsReference = book.reference_edition_id === audio.id;
  const refined = audioIsReference ? text : audio;
  const fallback = chapterSync(book, refined);
  const work = workOf(ctx);
  const tried = `${work.kept.get(audio.id) ?? 0}:${text.id}`;
  const alignsNothing = () => {
    deleteReadAlong(ctx.db, audio.id);
    restoreChapterMap(ctx, book, refined);
  };
  if (!fallback) return alignsNothing();
  const over = work.overLimits.get(audio.id);
  if (over?.tried === tried) {
    // Left as it is until its second try, and from then on.
    if (over.state !== 'due') return;
    over.state = 'spent';
  }
  const toAlign = await textToAlign(ctx, text);
  if (!toAlign) return;
  let result: AlignResult;
  try {
    result = await runInWorker(
      {
        kind: 'align',
        textEditionId: text.id,
        ...toAlign,
        database: ctx.storage.dbFile,
        audioEditionId: audio.id,
        tracks: trackFiles(ctx, audio).map((f) => ({ blobId: f.blob_id, durationMs: f.duration_ms ?? 0 })),
        chapters: bookChapters(book),
        audioIsReference,
        audioSync,
        textSync,
        fallback,
        total: totalMeasure(audioIsReference ? textGeometry : audioGeometry),
      },
      work.limits.align,
    );
  } catch (err) {
    if (!(err instanceof WorkLimitError)) throw err;
    const again = over?.tried !== tried;
    if (again) tryAgainLater(ctx, work, book.id, audio.id, tried);
    ctx.log.warn({ bookId: book.id, audio: audio.id, text: text.id, err: err.message, again }, 'audiobook not aligned: its transcript could not be lined up within the limits');
    return;
  }
  work.overLimits.delete(audio.id);
  const { sentences, stats, sync: next, chapters, opensWith } = result;
  if (!sentences || !next) return alignsNothing();
  ctx.db.tx(() => {
    // Read again: the worker took a while, and either edition may have gone meanwhile.
    const fresh = editionById(ctx.db, refined.id);
    if (!fresh || !editionById(ctx.db, audioIsReference ? audio.id : text.id)) return;
    const before = syncOf(fresh) ?? fallback;
    const alignment = editionAlignment(fresh);
    const record: AlignmentRecord = {
      method: 'forced',
      unitToChapter: alignment.unitToChapter,
      chapterMethod: alignment.method === 'forced' ? (alignment.chapterMethod ?? 'none') : alignment.method,
      ...(chapters.length > 0 ? { chaptersHeard: chapters } : {}),
      ...(opensWith.some((c) => c !== null) ? { opensWith } : {}),
    };
    saveReadAlong(ctx.db, { audioEditionId: audio.id, textEditionId: text.id, refinedEditionId: refined.id, sentencesJson: sentences, stats });
    setEditionSync(ctx.db, refined.id, next, record);
    retime(ctx, book, fresh, before, next);
  });
  ctx.log.info({ bookId: book.id, audio: audio.id, text: text.id, ...stats }, 'audiobook aligned with its text');
}

/* ------------------------------------------------------------------------------------------ */
/* A PDF lined up with its text (D75)                                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * The printed text a PDF's ingest kept (PRINTED_FILE) and when it was written, or null without one
 * (its text could not be read, or it prints too much).
 */
async function printedOf(ctx: AppContext, pdf: EditionRow): Promise<{ file: string; written: number } | null> {
  const file = ctx.storage.pubFile(pdf.id, PRINTED_FILE);
  const found = file ? await stat(file).catch(() => null) : null;
  return file && found?.isFile() ? { file, written: found.mtimeMs } : null;
}

/**
 * Line a PDF's printed lines up with a text's words and refine whichever map the book's timeline
 * does not rest on: the PDF's, or the text's when the timeline rests on the PDF. Worked out in a
 * worker with the alignment's limits, as a transcript is (alignPair); a PDF whose text is not the
 * book's (another book, another translation, a part of it its chapter map does not hold) is
 * trusted nowhere and keeps its chapter map.
 */
async function alignPrintedPair(ctx: AppContext, book: BookRow, pdf: EditionRow, text: EditionRow): Promise<void> {
  const pdfSync = syncOf(pdf);
  const textSync = syncOf(text);
  const printed = await printedOf(ctx, pdf);
  if (!pdfSync || !textSync || !printed) return;
  const pdfIsReference = book.reference_edition_id === pdf.id;
  const refined = pdfIsReference ? text : pdf;
  const fallback = chapterSync(book, refined);
  if (!fallback) return restoreChapterMap(ctx, book, refined);
  const work = workOf(ctx);
  // The PDF read again, or another text, is another try.
  const tried = `printed:${printed.written}:${text.id}`;
  const over = work.overLimits.get(pdf.id);
  if (over?.tried === tried) {
    if (over.state !== 'due') return;
    over.state = 'spent';
  }
  const toAlign = await textToAlign(ctx, text);
  if (!toAlign) return;
  let result: PrintAlignResult;
  try {
    result = await runInWorker(
      { kind: 'print-align', printed: printed.file, textEditionId: text.id, sections: toAlign.sections, story: toAlign.story, chapters: bookChapters(book), pdfIsReference, pdfSync, textSync, fallback, straightReach: LINE_SHARE },
      work.limits.align,
    );
  } catch (err) {
    if (!(err instanceof WorkLimitError)) throw err;
    const again = over?.tried !== tried;
    if (again) tryAgainLater(ctx, work, book.id, pdf.id, tried);
    ctx.log.warn({ bookId: book.id, pdf: pdf.id, text: text.id, err: err.message, again }, 'PDF not lined up with its text: it could not be within the limits');
    return;
  }
  work.overLimits.delete(pdf.id);
  const { sync: next, exact, stats } = result;
  if (!next) {
    ctx.log.info({ bookId: book.id, pdf: pdf.id, text: text.id, ...stats }, 'PDF not lined up with its text: its text is not the book’s, or not where its chapters are');
    return restoreChapterMap(ctx, book, refined);
  }
  ctx.db.tx(() => {
    // Read again: the worker took a while, and either edition may have gone meanwhile.
    const fresh = editionById(ctx.db, refined.id);
    if (!fresh || !editionById(ctx.db, pdfIsReference ? pdf.id : text.id)) return;
    const before = syncOf(fresh) ?? fallback;
    const alignment = editionAlignment(fresh);
    setEditionSync(ctx.db, refined.id, next, {
      method: 'forced',
      unitToChapter: alignment.unitToChapter,
      chapterMethod: alignment.method === 'forced' ? (alignment.chapterMethod ?? 'none') : alignment.method,
      printed: { editionId: pdfIsReference ? pdf.id : text.id, exact, stats },
    });
    retime(ctx, book, fresh, before, next);
  });
  ctx.log.info({ bookId: book.id, pdf: pdf.id, text: text.id, ...stats }, 'PDF lined up with its text');
}

/**
 * Bring a book's read-alongs up to date with its editions: every audiobook with a transcript, and
 * every PDF whose printed text its ingest kept, is lined up with the book's text; anything refined
 * for a text, transcript or PDF that is gone gets its chapter map back.
 */
export async function alignBook(ctx: AppContext, bookId: string): Promise<void> {
  const book = bookById(ctx.db, bookId);
  if (!book) return;
  const editions = editionsForBook(ctx.db, book.id);
  const text = pickText(book, editions);
  const audios = editions.filter((e) => e.kind === 'audio' && e.status === 'ready' && hasTranscript(ctx.db, e.id));
  const pdfs: EditionRow[] = [];
  for (const e of editions) if (text && e.kind === 'pdf' && e.status === 'ready' && (await printedOf(ctx, e))) pdfs.push(e);
  const wanted = new Set(text ? audios.map((a) => a.id) : []);
  for (const row of readAlongsForBook(ctx.db, book.id)) {
    if (!wanted.has(row.audio_edition_id) || row.text_edition_id !== text?.id) deleteReadAlong(ctx.db, row.audio_edition_id);
  }
  // The editions the alignments below refine (whichever of each pair the timeline does not rest
  // on); any other edition still refined by an alignment that is gone gets its chapter map back.
  const refining = new Set(text ? [...audios, ...pdfs].map((e) => (book.reference_edition_id === e.id ? text.id : e.id)) : []);
  for (const e of editions) if (!refining.has(e.id)) restoreChapterMap(ctx, book, e);
  if (text) {
    // The format the timeline rests on first: it refines the text, which the others are then
    // lined up against, read afresh each time (not the copy from before the first alignment).
    const ordered = [...audios, ...pdfs].sort((a, b) => Number(b.id === book.reference_edition_id) - Number(a.id === book.reference_edition_id));
    for (const other of ordered) {
      const freshText = editionById(ctx.db, text.id);
      const freshOther = editionById(ctx.db, other.id);
      if (!freshText || !freshOther) continue;
      if (freshOther.kind === 'audio') await alignPair(ctx, book, freshOther, freshText);
      else await alignPrintedPair(ctx, book, freshOther, freshText);
    }
  }
  ctx.hub.publish(book.club_id, () => ({ type: 'book:changed', clubId: book.club_id, bookId: book.id }));
}

/** The sentences one track of an audiobook reads, with their text, for following along. */
export async function readAlongTrack(ctx: AppContext, audio: EditionRow, track: number): Promise<ReadAlongTrack | null> {
  const row = readAlongFor(ctx.db, audio.id);
  const text = row ? editionById(ctx.db, row.text_edition_id) : undefined;
  if (!row || !text) return null;
  const all = readAlongSentences(row);
  const sentences = all[track];
  if (!sentences) return null;
  const sections = await sectionTexts(ctx, text);
  if (!sections) return null;
  // Where this track's narration meets the text next (its first sentence, or a later track's: a
  // track of opening credits leads into the story), and where the text was left before it (D184).
  const lead = all.slice(track).flat()[0];
  const previous = all.slice(0, track).flat().at(-1);
  return {
    audioEditionId: audio.id,
    textEditionId: text.id,
    track,
    lead: lead ? [lead[0], lead[1]] : null,
    previous: previous ? [previous[0], previous[1] + previous[2]] : null,
    sentences: sentences.map((s) => [...s] as [number, number, number, number, number]),
    text: sentences.map(([section, offset, length]) => (sections[section]?.slice(offset, offset + length) ?? '').replace(/\s+/g, ' ').trim()),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Transcribing on the server (optional: TRANSCRIBE_COMMAND)                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * Runs of the recogniser an audiobook gets, counted across restarts: the first, and one more at a
 * later start, since the first may have failed for a passing reason (memory something else held,
 * a model download cut short, a full disk). A second failure is the file or the recogniser, and
 * each run can take hours (up to twice the audio's length). The owner can still upload one.
 */
export const TRANSCRIPTION_RUNS = 2;

/** Split a command line on spaces, keeping "quoted parts" together (no shell is involved). */
export function splitCommand(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}

/** What a recogniser is given of the server's environment: enough to run, none of its secrets. */
function recogniserEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'HF_HOME', 'XDG_CACHE_HOME'];
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.includes(k) || k.startsWith('TRANSCRIBE_')));
}

/** One server's transcriptions (tests run several servers in one process). */
interface Transcriber {
  /** The server is stopping: no recogniser starts any more. */
  stopping: boolean;
  /** Audiobooks queued or being transcribed, so that none is queued twice. */
  readonly queued: Set<string>;
  /** The recogniser running now (one at a time, on their own queue) and its audiobook, so that it can be stopped. */
  readonly running: Map<ChildProcess, string>;
  /** Audiobooks whose run was stopped because their owner gave them a transcript or removed one. */
  readonly superseded: Set<string>;
  /** Live progress while queued, running, or aligning (cleared when the run ends). */
  readonly progress: Map<string, LiveTranscription>;
}

const transcribers = new WeakMap<AppContext, Transcriber>();

function transcriberOf(ctx: AppContext): Transcriber {
  let state = transcribers.get(ctx);
  if (!state) {
    state = { stopping: false, queued: new Set(), running: new Map(), superseded: new Set(), progress: new Map() };
    transcribers.set(ctx, state);
  }
  return state;
}

/** Signal a recogniser and whatever it started: it leads a process group of its own. */
function signalAll(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Every process in the group has ended.
  }
}

/** Ask a recogniser to stop, and make it stop if it has not after a grace period. */
function stop(child: ChildProcess, graceMs = 30_000): void {
  signalAll(child, 'SIGTERM');
  const hard = setTimeout(() => signalAll(child, 'SIGKILL'), graceMs);
  hard.unref();
  child.once('close', () => clearTimeout(hard));
}

/**
 * The server is stopping: no recogniser starts from now on, and the one running is stopped. Its
 * audiobook, and those queued behind it, are transcribed at the next start. (Nor is an alignment
 * that ran out of its limits tried again, tryAgainLater.)
 */
export function stopTranscriptions(ctx: AppContext): void {
  const state = transcriberOf(ctx);
  state.stopping = true;
  for (const child of state.running.keys()) stop(child, 5000);
}

/**
 * An audiobook was given a transcript, or its transcript was removed, while the recogniser read it:
 * the owner's choice stands, and the run stops now rather than an hour on (its result would be
 * set aside anyway). It counts as a run, ended so.
 */
export function stopTranscriptionOf(ctx: AppContext, editionId: string): void {
  const state = transcribers.get(ctx);
  if (!state) return;
  for (const [child, id] of state.running) {
    if (id !== editionId) continue;
    state.superseded.add(id);
    stop(child, 5000);
  }
}

/** The server exits without waiting (asked twice): the recogniser is killed now, not after its grace. */
export function killTranscriptions(ctx: AppContext): void {
  for (const child of transcriberOf(ctx).running.keys()) signalAll(child, 'SIGKILL');
}

function pollProgressFile(state: Transcriber, editionId: string, file: string): void {
  try {
    if (!existsSync(file)) return;
    const doc = parseProgressDoc(readFileSync(file, 'utf8'));
    const live = state.progress.get(editionId);
    if (doc && live) applyProgressDoc(live, doc);
  } catch {
    // ignore
  }
}

function run(
  state: Transcriber,
  editionId: string,
  argv: readonly string[],
  timeoutMs: number,
  extraEnv: NodeJS.ProcessEnv = {},
  progressFile?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // In a process group of its own (detached), so that stopping it stops what it started too: a
    // wrapper script's children, ffmpeg.
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...recogniserEnv(), ...extraEnv },
      detached: true,
    });
    state.running.set(child, editionId);
    let stderr = '';
    let timedOut = false;
    let lineBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr = (stderr + text).slice(-4000);
      lineBuf += text;
      const parts = lineBuf.split('\n');
      lineBuf = parts.pop() ?? '';
      const live = state.progress.get(editionId);
      for (const line of parts) {
        const doc = parseProgressLine(line);
        if (doc && live) applyProgressDoc(live, doc);
      }
    });
    const poll = progressFile
      ? setInterval(() => pollProgressFile(state, editionId, progressFile), 1000)
      : null;
    if (poll) poll.unref();
    const timer = setTimeout(() => {
      timedOut = true;
      stop(child);
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      state.running.delete(child);
    };
    child.on('error', (err) => {
      finish();
      reject(err);
    });
    child.on('close', (code, signal) => {
      finish();
      if (progressFile) pollProgressFile(state, editionId, progressFile);
      if (code === 0) resolve();
      else if (timedOut) reject(new Error(`transcriber stopped after ${Math.round(timeoutMs / 60_000)} minutes, its time limit`));
      else reject(new Error(`transcriber exited with ${code ?? signal}: ${lastRecogniserError(stderr)}`));
    });
  });
}

/**
 * At start: audiobooks still waiting for a transcript get one (the server stopped before or during
 * their run, or their first run failed). Returns how many were queued.
 */
/**
 * At a start, every book with a read-along lined up by older rules (READ_ALONG_RULES) is lined up
 * again, once, on the alignment queue: its audiobook keeps its transcript, and what was placed with
 * the map from before moves with the new one (D47). Returns how many books were queued.
 */
export function realignOldReadAlongs(ctx: AppContext): number {
  const books = booksWithReadAlongsBefore(ctx.db, READ_ALONG_RULES);
  for (const bookId of books) scheduleAlignment(ctx, bookId);
  return books.length;
}

export function resumeTranscriptions(ctx: AppContext): number {
  if (!ctx.config.TRANSCRIBE_COMMAND) return 0;
  let queued = 0;
  for (const id of audiobooksAwaitingTranscript(ctx.db, TRANSCRIPTION_RUNS)) {
    const audio = editionById(ctx.db, id);
    if (audio && scheduleTranscription(ctx, audio)) queued++;
  }
  return queued;
}

/**
 * Transcribe an audiobook in the background with the configured recogniser, then line it up; true
 * when it was queued. One at a time on their own queue: an hour of speech recognition must not
 * hold up an upload. The book is lined up on the alignment queue, with any alignment of it queued
 * there already (alignmentOf), and waited for: the next recogniser starts once it is done, never
 * beside its worker, and a server stopping waits for it as it waits for this queue. Never one whose
 * transcript the owner removed, nor one that has had its runs (TRANSCRIPTION_RUNS), nor any once
 * the server is stopping.
 */
export function scheduleTranscription(ctx: AppContext, audio: EditionRow): boolean {
  const command = ctx.config.TRANSCRIBE_COMMAND;
  const state = transcriberOf(ctx);
  if (!command || state.stopping || state.queued.has(audio.id) || !awaitsTranscript(ctx.db, audio.id, TRANSCRIPTION_RUNS)) return false;
  const totalMs = trackFiles(ctx, audio).reduce((n, f) => n + (f.duration_ms ?? 0), 0);
  if (totalMs > ctx.config.TRANSCRIBE_MAX_HOURS * 3_600_000) {
    ctx.log.info({ editionId: audio.id, hours: Math.round(totalMs / 360_000) / 10 }, 'audiobook too long for the recogniser to read by itself');
    return false;
  }
  state.queued.add(audio.id);
  const preferGpu = Boolean(process.env.TRANSCRIBE_REMOTE_URL?.trim() || ctx.config.TRANSCRIBE_COMMAND?.includes('transcribe_remote'));
  state.progress.set(
    audio.id,
    initialLive({
      stage: 'queued',
      tracksTotal: trackFiles(ctx, audio).length || 1,
      audioMsTotal: totalMs,
      engine: preferGpu ? 'gpu' : 'cpu',
    }),
  );
  publishBookChanged(ctx, audio);
  ctx.slowJobs.enqueue(`transcribe:${audio.id}`, async () => {
    try {
      // The server may be stopping (the next start does it), or the audiobook may have changed.
      if (state.stopping || !awaitsTranscript(ctx.db, audio.id, TRANSCRIPTION_RUNS)) return;
      const edition = editionById(ctx.db, audio.id)!;
      if (await transcribe(ctx, state, edition, command)) {
        const live = state.progress.get(audio.id);
        if (live) {
          live.stage = 'aligning';
          live.updatedAt = Date.now();
          publishBookChanged(ctx, edition);
        }
        await alignmentOf(ctx, edition.book_id);
      }
    } finally {
      state.queued.delete(audio.id);
      state.progress.delete(audio.id);
      publishBookChanged(ctx, audio);
    }
  });
  return true;
}

/**
 * One run of the recogniser on an audiobook, counted as it begins (so that one bringing the whole
 * server down counts too); one the server stops as it shuts down is given back. True when the
 * audiobook got its transcript.
 */
async function transcribe(ctx: AppContext, state: Transcriber, edition: EditionRow, command: string): Promise<boolean> {
  const files = trackFiles(ctx, edition);
  const out = path.join(ctx.storage.tmpDir, `transcript-${edition.id}.json`);
  const progressFile = path.join(ctx.storage.tmpDir, `progress-${edition.id}.json`);
  const totalMs = files.reduce((n, f) => n + (f.duration_ms ?? 0), 0);
  const live = state.progress.get(edition.id) ?? initialLive({ tracksTotal: files.length || 1, audioMsTotal: totalMs });
  live.audioMsTotal = totalMs;
  live.tracksTotal = files.length || 1;
  live.updatedAt = Date.now();
  state.progress.set(edition.id, live);
  beginTranscriptionRun(ctx.db, edition.id);
  try {
    await run(
      state,
      edition.id,
      [...splitCommand(command), '--out', out, ...files.map((f) => ctx.storage.blobPath(f.blob_id))],
      Math.max(3_600_000, totalMs * 2),
      {
        TRANSCRIBE_PROGRESS_FILE: progressFile,
        TRANSCRIBE_AUDIO_MS_TOTAL: String(totalMs),
        TRANSCRIBE_TRACKS_TOTAL: String(files.length),
      },
      progressFile,
    );
    // Held to what an upload is held to, before it is read.
    checkTranscriptSize(ctx, edition, (await stat(out)).size);
    // While it ran (or while what it wrote is read), the audiobook may have been deleted, or its
    // owner may have given it a transcript or removed it: theirs stands.
    const theirs = (e: EditionRow) => hasTranscript(ctx.db, e.id) || transcriptRemoved(ctx.db, e.id);
    const fresh = editionById(ctx.db, edition.id);
    if (!fresh || theirs(fresh)) return false;
    if (!(await importTranscriptBody(ctx, fresh, await readFile(out), (e) => !theirs(e)))) return false;
    endTranscriptionRun(ctx.db, fresh.id, null);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (state.superseded.delete(edition.id)) {
      endTranscriptionRun(ctx.db, edition.id, 'stopped: its owner gave it a transcript, or removed it');
      ctx.log.info({ editionId: edition.id }, 'transcription stopped: the owner’s transcript stands');
    } else if (state.stopping) {
      giveBackTranscriptionRun(ctx.db, edition.id);
      ctx.log.info({ editionId: edition.id }, 'transcription stopped with the server; it runs again at the next start');
    } else {
      endTranscriptionRun(ctx.db, edition.id, message);
      const failed = state.progress.get(edition.id);
      if (failed) {
        failed.stage = 'failed';
        failed.message = message.slice(0, 500);
        failed.updatedAt = Date.now();
      }
      ctx.log.warn({ editionId: edition.id, err: message }, 'transcription failed');
    }
    return false;
  } finally {
    await rm(out, { force: true });
    await rm(progressFile, { force: true });
  }
}

/** Tell open book pages to refetch (transcription stage/ETA changed). */
function publishBookChanged(ctx: AppContext, edition: EditionRow): void {
  const clubId = bookById(ctx.db, edition.book_id)?.club_id;
  if (!clubId) return;
  ctx.hub.publish(clubId, () => ({ type: 'book:changed', clubId, bookId: edition.book_id }));
}

/**
 * Live transcription / alignment status for an audiobook, for Edition.transcription. Null when
 * nothing is in flight and there is no last failure to show; undefined is not used — callers
 * attach null or the status.
 */
export function transcriptionStatusOf(ctx: AppContext, editionId: string): TranscriptionStatus | null {
  const state = transcribers.get(ctx);
  const live = state?.progress.get(editionId);
  if (live) return toTranscriptionStatus(live);
  if (!hasTranscript(ctx.db, editionId) && !transcriptRemoved(ctx.db, editionId)) {
    const row = transcriptionFor(ctx.db, editionId);
    if (row?.last_error && row.runs >= TRANSCRIPTION_RUNS) {
      return {
        stage: 'failed',
        tracksDone: null,
        tracksTotal: null,
        audioMsDone: null,
        audioMsTotal: null,
        fraction: null,
        etaMs: null,
        message: row.last_error,
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    }
  }
  return null;
}
