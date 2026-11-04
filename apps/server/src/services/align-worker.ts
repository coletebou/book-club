/*
 * The worker thread in which EPUBs are read, PDFs' text is read (with the chapter headings of those
 * without bookmarks), transcripts are read, and audiobooks and PDFs are lined up with their text
 * (aligner.ts starts one for each piece of work), so that neither a very long book nor a
 * file made to keep the parser or the alignment busy holds up the server: a worker that takes too
 * long, or whose JavaScript heap grows past its limit, is stopped. (Buffers sit outside that heap:
 * what a book unpacks to is bounded by the EPUB's own limits, DEFAULT_LIMITS.) The production build makes it a file of its own beside the server's
 * (dist/align-worker.mjs, build.mjs); run from the sources, aligner.ts bundles it in memory the same
 * way, since Node cannot load the workspace packages' TypeScript by itself. Imported anywhere else
 * (the server matching a transcript it already has, a test), it listens for nothing.
 */
import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { type BuiltPublication, EpubError, bodyTextWithBreaks, buildPublication } from '@bookclub/epub';
import {
  type CanonicalChapter,
  type ChunkAtom,
  type ChapterLike,
  type PrintedSyncStats,
  type SyncMap,
  type TextSection,
  type Transcript,
  TranscriptSchema,
  alignPrinted,
  chaptersHeard,
  formatDuration,
  forceAlign,
  mToT,
  printedSync,
  refineAudioSync,
  refineTextSync,
  tracksOpenWith,
  withChapterOpenings,
  withinChapters,
} from '@bookclub/shared';
import { type PdfOutlineEntry, parsePrinted, pdfText } from '../ingest/pdf';
import { HttpError, badRequest, zodFields } from '../lib/errors';
import { toJson } from '../lib/json';
import { transcriptAtoms } from '../cal/transcript-atoms';
import { READ_ALONG_RULES, type ReadAlongStats, type StoredSentence, type TranscriptTrackRow, transcriptWordsJson } from '../repos/readalong';

/* ------------------------------------------------------------------------------------------ */
/* Reading a transcript                                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * Words a transcript may hold for each second of the audio it is matched to. Narrators read about
 * 2.5 words a second (the reference LibriVox Alice: 2.5 over the whole book, 3.4 in its fastest
 * track); eight is more than twice the fastest, so a recording sped up to double speed still passes,
 * while what a recogniser can have heard stays bounded by how long the audio really is.
 */
export const MAX_WORDS_PER_SECOND = 8;

/**
 * Words any transcript may hold beyond that: a short recording's (a test's tracks of a few seconds
 * read whole chapters). Ten thousand words line up with a book in a few milliseconds.
 */
export const SPARE_WORDS = 10_000;

/** The most words a transcript may hold for this much audio. */
export function wordsAllowed(durationMs: number): number {
  return Math.floor((Math.max(0, durationMs) / 1000) * MAX_WORDS_PER_SECOND) + SPARE_WORDS;
}

/** One track file of an audiobook, as the server measured it. */
export interface TrackFile {
  readonly blobId: string;
  /** Its content's SHA-256, or null when its blob is gone. */
  readonly sha256: string | null;
  readonly durationMs: number;
}

/**
 * The words of a transcript for each track file of an audiobook, as they are kept. Its tracks are
 * matched to the files by content (SHA-256) when the transcript names them, otherwise in order when
 * there are as many with the same lengths; anything else is refused rather than guessed, and so are
 * more words than the matched files' lengths allow (the lengths the server measured, not those the
 * transcript states).
 */
export function matchTranscript(doc: Transcript, files: readonly TrackFile[]): TranscriptTrackRow[] {
  const byHash = doc.tracks.every((t) => t.sha256);
  const matched: { file: TrackFile; words: Transcript['tracks'][number]['words'] }[] = [];
  if (byHash) {
    for (const file of files) {
      const track = doc.tracks.find((t) => t.sha256 === file.sha256);
      if (track) matched.push({ file, words: track.words });
    }
    if (matched.length === 0) throw badRequest('None of the transcript’s tracks is a track of this audiobook.');
  } else {
    if (doc.tracks.length !== files.length) throw badRequest(`The transcript has ${doc.tracks.length} tracks; this audiobook has ${files.length}.`);
    doc.tracks.forEach((t, i) => {
      const ms = files[i]!.durationMs;
      if (Math.abs(t.durationMs - ms) > Math.max(3000, ms * 0.02)) throw badRequest(`Track ${i + 1} of the transcript is not as long as track ${i + 1} of this audiobook.`);
      matched.push({ file: files[i]!, words: t.words });
    });
  }
  const words = matched.reduce((n, m) => n + m.words.length, 0);
  const ms = matched.reduce((n, m) => n + m.file.durationMs, 0);
  if (words > wordsAllowed(ms)) {
    throw badRequest(
      `The transcript has ${words.toLocaleString('en')} words for ${formatDuration(ms)} of audio: more than anyone says in that time (${MAX_WORDS_PER_SECOND} words a second at most).`,
    );
  }
  return matched.map((m) => ({ blobId: m.file.blobId, words: m.words.map(([a, b, w]) => [a, b, w] as const) }));
}

export interface ReadTask {
  readonly kind: 'read';
  /** The transcript as it was uploaded, or as the server's recogniser wrote it. */
  readonly body: Uint8Array;
  readonly files: readonly TrackFile[];
}

/** A transcript read and matched to its audiobook, ready to keep; or why it is refused. */
export type ReadResult =
  | {
      readonly engine: string;
      /** The words of each matched track file (TranscriptTrackRow[]) as JSON, as they are kept. */
      readonly tracks: string;
      readonly words: number;
    }
  | { readonly refused: string; readonly fields?: Record<string, string> };

/** The transcript checked against the format, or null when it is not JSON at all. */
function parseTranscript(body: Uint8Array) {
  try {
    // The document as parsed is checked at once and not kept: only the checked copy is.
    return TranscriptSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return null;
  }
}

/** Read a transcript: parse it, check it against the format, and match it to the audiobook. */
export function readTranscript(task: ReadTask): ReadResult {
  const parsed = parseTranscript(task.body);
  if (!parsed) return { refused: 'That is not a transcript: it is not JSON.' };
  if (!parsed.success) {
    const fields = zodFields(parsed.error);
    return { refused: Object.values(fields)[0] ?? 'Invalid request.', fields };
  }
  const doc = parsed.data;
  try {
    const tracks = matchTranscript(doc, task.files);
    return { engine: [doc.engine, doc.model].filter(Boolean).join(' '), tracks: toJson(tracks), words: tracks.reduce((n, t) => n + t.words.length, 0) };
  } catch (err) {
    if (err instanceof HttpError) return { refused: err.message, ...(err.fields ? { fields: err.fields } : {}) };
    throw err;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Lining an audiobook up with its text                                                         */
/* ------------------------------------------------------------------------------------------ */

export interface AlignTask {
  readonly kind: 'align';
  /** The text edition, for messages. */
  readonly textEditionId: string;
  /** Its sections, in order: each one's file and the length readers measure it at. */
  readonly sections: readonly { readonly index: number; readonly file: string | null; readonly textLength: number }[];
  /** The part of its measure that is the story. */
  readonly story: { readonly start: number; readonly end: number };
  /** Stretches of the story no recording reads: its title page's lines, its printed contents (readingContents, FR154). */
  readonly unread?: readonly { readonly start: number; readonly end: number }[];
  /** The database file, where the worker reads what was heard in the audiobook (its kept transcript). */
  readonly database: string;
  readonly audioEditionId: string;
  /** The audiobook's track files in play order. */
  readonly tracks: readonly { readonly blobId: string; readonly durationMs: number }[];
  readonly chapters: readonly ChapterLike[];
  /** Whether the book's timeline rests on the audiobook: then the text is refined, else the audiobook. */
  readonly audioIsReference: boolean;
  readonly audioSync: SyncMap;
  readonly textSync: SyncMap;
  /** The refined edition's chapter-level map, which the alignment may only refine. */
  readonly fallback: SyncMap;
  /** The refined edition's whole measure (milliseconds, or characters). */
  readonly total: number;
}

export interface AlignResult {
  /** The sentences of each track (StoredSentence[][]) as JSON, as they are kept; null when none aligned. */
  readonly sentences: string | null;
  readonly stats: ReadAlongStats;
  /** The refined edition's new map, when sentences aligned. */
  readonly sync: SyncMap | null;
  /**
   * Where the recording is heard to start each of the book's chapters, `[chapter, track, ms]`
   * (chaptersHeard, FR152), when the audiobook is the edition refined: none when its own units are
   * the book's chapters.
   */
  readonly chapters: [number, number, number][];
  /**
   * The chapter each track opens with by its read-along (tracksOpenWith, FR161), null where none of
   * it was lined up; when the audiobook is the edition refined, else none.
   */
  readonly opensWith: (number | null)[];
}

/** A text edition's sections read and measured as readers measure them (the offsets comments and read ranges use). */
async function measuredSections(task: Pick<AlignTask, 'sections' | 'textEditionId'>): Promise<TextSection[]> {
  const sections: TextSection[] = [];
  for (const s of task.sections) {
    const measured = s.file ? bodyTextWithBreaks(await readFile(s.file, 'utf8')) : { text: '', breaks: [] };
    // The offsets must be the ones readers and comments use: refuse a text that measures differently.
    if (measured.text.length !== s.textLength) throw new Error(`section ${s.index} of ${task.textEditionId} measures ${measured.text.length}, not ${s.textLength}`);
    sections.push(measured);
  }
  return sections;
}

/** Line an audiobook up with its text and refine the map of whichever the book's timeline does not rest on. */
export async function alignText(task: AlignTask): Promise<AlignResult> {
  const sections = await measuredSections(task);
  // Read here, not handed over: a transcript removed meanwhile is one that heard nothing.
  const kept = transcriptWordsJson(task.database, task.audioEditionId);
  const heard = new Map((kept ? (JSON.parse(kept) as TranscriptTrackRow[]) : []).map((t) => [t.blobId, t.words]));
  const aligned = forceAlign({
    sections,
    story: task.story,
    ...(task.unread ? { unread: task.unread } : {}),
    tracks: task.tracks.map((f) => ({ durationMs: f.durationMs, words: heard.get(f.blobId) ?? [] })),
  });
  // The timeline rests on the reference edition: the other one is refined, and its sentences may
  // only move inside the chapters its chapter map already puts them in.
  const { audioIsReference, audioSync, textSync, fallback } = task;
  const placed = withinChapters(
    aligned,
    task.chapters,
    (s) => (audioIsReference ? mToT(audioSync, s.ms) : mToT(textSync, s.m)),
    (s) => (audioIsReference ? mToT(fallback, s.m) : mToT(fallback, s.ms)),
  );
  // What a track's closing words matched of the next chapter's heading is none of it (FR160).
  const result = withChapterOpenings(placed, task.chapters, textSync);
  const sentences: StoredSentence[][] = task.tracks.map(() => []);
  for (const s of result.sentences) {
    const start = result.tracks[s.track]!.startMs;
    sentences[s.track]!.push([s.section, s.offset, s.length, Math.round(s.trackMs), Math.round(s.msEnd - start)]);
  }
  const stats: ReadAlongStats = { ...result.stats, alignedTracks: result.tracks.filter((t) => t.aligned).length, tracks: result.tracks.length, rules: READ_ALONG_RULES };
  if (result.sentences.length === 0) return { sentences: null, stats, sync: null, chapters: [], opensWith: [] };
  const sync = audioIsReference ? refineTextSync(result, audioSync, fallback, task.total) : refineAudioSync(result, textSync, fallback, task.total);
  return {
    sentences: toJson(sentences),
    stats,
    sync,
    chapters: audioIsReference ? [] : chaptersHeard(result, task.chapters, textSync),
    opensWith: audioIsReference ? [] : tracksOpenWith(result, task.chapters, textSync),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Reading an EPUB                                                                              */
/* ------------------------------------------------------------------------------------------ */

/** Read an uploaded EPUB into what the server keeps of it: its sanitised files, sections and contents. */
export interface PublicationTask {
  readonly kind: 'publication';
  /** The uploaded file. */
  readonly file: string;
}

async function readPublication(task: PublicationTask): Promise<BuiltPublication> {
  const data = await readFile(task.file);
  // Read where it lies, not copied once more.
  return buildPublication(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

/* ------------------------------------------------------------------------------------------ */
/* Reading a PDF's text                                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * Read a PDF's text once: every page's lines, kept to line it up with the book's text (D75), and,
 * for a PDF without bookmarks, where the book's chapters start, from the text at the top of its
 * pages (D74). pdf.js reads a page's text all at once, on the thread that asks: a page can be made
 * to take seconds (200,000 runs of text in 52 KB held a thread 6 s), so it is read here.
 */
export interface PdfTextTask {
  readonly kind: 'pdf-text';
  /** The uploaded file. */
  readonly file: string;
  /** The book's chapters, from its reference edition, when their headings are looked for (none: they are not). */
  readonly chapters: readonly CanonicalChapter[];
}

/** A PDF's text as it was read: the chapter headings found, and its lines as they are kept (PrintedText as JSON; null when it prints too much). */
export interface PdfTextResult {
  readonly headings: PdfOutlineEntry[];
  readonly printed: string | null;
  readonly lines: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Lining a PDF up with its text                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * Line a PDF's printed lines (as its ingest kept them) up with a text edition's words, and refine
 * the map of whichever of the two the book's timeline does not rest on (D75).
 */
export interface PrintAlignTask {
  readonly kind: 'print-align';
  /** The PDF's printed text, as its ingest kept it (PRINTED_FILE). */
  readonly printed: string;
  /** The text edition, for messages. */
  readonly textEditionId: string;
  /** Its sections, in order: each one's file and the length readers measure it at. */
  readonly sections: readonly { readonly index: number; readonly file: string | null; readonly textLength: number }[];
  /** The part of its measure that is the story. */
  readonly story: { readonly start: number; readonly end: number };
  readonly chapters: readonly ChapterLike[];
  /** Whether the book's timeline rests on the PDF: then the text is refined, else the PDF. */
  readonly pdfIsReference: boolean;
  readonly pdfSync: SyncMap;
  readonly textSync: SyncMap;
  /** The refined edition's chapter-level map, which the alignment may only refine. */
  readonly fallback: SyncMap;
  /** How far from a straight line a line may be, as a share of the book (LINE_SHARE). */
  readonly straightReach: number;
}

export interface PrintAlignResult {
  /** The refined edition's new map; null when the PDF's text is not the book's (it is trusted nowhere). */
  readonly sync: SyncMap | null;
  /** Stretches of the refined edition's measure lined up line by line. */
  readonly exact: [number, number][];
  readonly stats: PrintedSyncStats;
}

/** Line a PDF up with its text (alignPrinted), and its map or the text's refined from it (printedSync). */
export async function alignPrintedText(task: PrintAlignTask): Promise<PrintAlignResult> {
  const pages = parsePrinted(await readFile(task.printed, 'utf8'));
  if (!pages) throw new Error(`the printed text kept in ${task.printed} cannot be read`);
  const alignment = alignPrinted({ sections: await measuredSections(task), story: task.story, pages });
  return printedSync(alignment, task);
}

/**
 * The memory a result may hand over rather than copy: a book's files and cover, which can be
 * hundreds of megabytes. The worker stops once it has answered, so it needs none of it after.
 */
function handedOver(result: WorkResult): ArrayBuffer[] {
  if (!('files' in result)) return [];
  const buffers = new Set<ArrayBuffer>();
  for (const data of result.files.values()) buffers.add(data.buffer as ArrayBuffer);
  if (result.cover) buffers.add(result.cover.bytes.buffer as ArrayBuffer);
  return [...buffers];
}

/* ------------------------------------------------------------------------------------------ */
/* The worker                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * Cal's atoms of an audiobook's kept transcript (D160): read with this worker's own connection to
 * the database, parsed and walked here, so that none of it holds the server's thread.
 */
export interface TranscriptAtomsTask {
  readonly kind: 'transcript-atoms';
  /** The database file (transcriptWordsJson opens its own read-only connection to it). */
  readonly database: string;
  readonly editionId: string;
  /** The edition's tracks: each one's blob and its place in the edition. */
  readonly tracks: readonly { readonly blobId: string; readonly idx: number }[];
  /** Where each track starts on the edition's own measure. */
  readonly starts: readonly number[];
}

export interface TranscriptAtomsResult {
  /** Empty when the edition has no transcript, or one that cannot be parsed. */
  readonly atoms: ChunkAtom[];
}

function transcriptAtomsOf(task: TranscriptAtomsTask): TranscriptAtomsResult {
  const json = transcriptWordsJson(task.database, task.editionId);
  if (!json) return { atoms: [] };
  let tracks: TranscriptTrackRow[];
  try {
    tracks = JSON.parse(json) as TranscriptTrackRow[];
  } catch {
    return { atoms: [] };
  }
  return { atoms: transcriptAtoms(tracks, new Map(task.tracks.map((t) => [t.blobId, t.idx])), task.starts) };
}

export type WorkTask = ReadTask | AlignTask | PublicationTask | PdfTextTask | PrintAlignTask | TranscriptAtomsTask;

/** What a piece of work comes to. */
export type WorkResult = ReadResult | AlignResult | BuiltPublication | PdfTextResult | PrintAlignResult | TranscriptAtomsResult;

/**
 * What the worker answers: what its work came to, or the message of what went wrong, with the
 * EPUB's own reason when that is what it was (members are told it in their words).
 */
export type WorkReply = { readonly result: WorkResult } | { readonly error: string; readonly epub?: EpubError['code'] };

/** The worker's data says what it is for, so that this file listens only where aligner.ts started it. */
export const WORKER_ROLE = 'bookclub-align';

export async function runTask(task: WorkTask): Promise<WorkResult> {
  switch (task.kind) {
    case 'read':
      return readTranscript(task);
    case 'align':
      return alignText(task);
    case 'publication':
      return readPublication(task);
    case 'pdf-text':
      return pdfText(task.file, task.chapters);
    case 'print-align':
      return alignPrintedText(task);
    case 'transcript-atoms':
      return transcriptAtomsOf(task);
  }
}

const port = parentPort;
if (port && (workerData as { role?: unknown } | null)?.role === WORKER_ROLE) {
  // One piece of work for each worker, which is stopped once it answers: all its memory goes with it.
  port.once('message', (task: WorkTask) => {
    void runTask(task).then(
      (result) => {
        try {
          port.postMessage({ result } satisfies WorkReply, handedOver(result));
        } catch {
          // Memory that cannot be handed over (none is expected) is copied instead.
          port.postMessage({ result } satisfies WorkReply);
        }
      },
      (err: unknown) =>
        port.postMessage({ error: err instanceof Error ? err.message : String(err), ...(err instanceof EpubError ? { epub: err.code } : {}) } satisfies WorkReply),
    );
  });
}
