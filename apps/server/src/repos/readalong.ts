import { DatabaseSync } from 'node:sqlite';
import { type TranscriptWord } from '@bookclub/shared';
import { type Db } from '../db/db';
import { fromJson, toJson } from '../lib/json';

/** What was heard in one track file of an audiobook (kept by blob, whatever the track order). */
export interface TranscriptTrackRow {
  readonly blobId: string;
  readonly words: readonly TranscriptWord[];
}

export interface TranscriptRow {
  edition_id: string;
  engine: string;
  tracks_json: string;
  created_at: number;
}

/** One aligned sentence: `[section, offset, length, startMs, endMs]`, times inside its track. */
export type StoredSentence = readonly [number, number, number, number, number];

/**
 * The rules a read-along is lined up by, counted: 2 since a track's closing words are kept from the
 * next chapter's heading (FR160) and the chapter each track opens with is kept (FR161). One lined up
 * by older rules is lined up again, once, at the next start (realignOldReadAlongs).
 */
export const READ_ALONG_RULES = 2;

export interface ReadAlongStats {
  readonly textWords: number;
  readonly spokenWords: number;
  readonly matchedWords: number;
  readonly sentences: number;
  readonly alignedSentences: number;
  readonly alignedTracks: number;
  readonly tracks: number;
  /** The rules it was lined up by (READ_ALONG_RULES); absent before they were counted. */
  readonly rules?: number;
}

export interface ReadAlongRow {
  audio_edition_id: string;
  text_edition_id: string;
  refined_edition_id: string;
  sentences_json: string;
  stats_json: string;
  created_at: number;
}

export function saveTranscript(db: Db, editionId: string, engine: string, tracks: readonly TranscriptTrackRow[]): void {
  saveTranscriptJson(db, editionId, engine, toJson(tracks));
}

/** Keep a transcript whose tracks (TranscriptTrackRow[]) a worker thread wrote out as JSON. */
export function saveTranscriptJson(db: Db, editionId: string, engine: string, tracksJson: string): void {
  db.exec(
    `INSERT INTO transcripts (edition_id, engine, tracks_json, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (edition_id) DO UPDATE SET engine = excluded.engine, tracks_json = excluded.tracks_json, created_at = excluded.created_at`,
    [editionId, engine, tracksJson, Date.now()],
  );
}

/**
 * The words of an audiobook's transcript as they are kept (TranscriptTrackRow[] as JSON), read
 * through a connection of their own that only reads (WAL lets it read beside the server's): the
 * worker thread that lines the audiobook up reads them so, and tens of megabytes of them never
 * pass through the server's thread.
 */
export function transcriptWordsJson(file: string, editionId: string): string | null {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try {
    const row = db.prepare('SELECT tracks_json FROM transcripts WHERE edition_id = ?').get(editionId) as Pick<TranscriptRow, 'tracks_json'> | undefined;
    return row?.tracks_json ?? null;
  } finally {
    db.close();
  }
}

export function deleteTranscript(db: Db, editionId: string): void {
  db.exec('DELETE FROM transcripts WHERE edition_id = ?', [editionId]);
}

export function hasTranscript(db: Db, editionId: string): boolean {
  return !!db.get('SELECT 1 AS x FROM transcripts WHERE edition_id = ?', [editionId]);
}

/** The club owner removes an audiobook's transcript: the server never makes it one by itself again. */
export function removeTranscript(db: Db, editionId: string, now = Date.now()): void {
  db.tx(() => {
    deleteTranscript(db, editionId);
    db.exec(
      `INSERT INTO transcriptions (edition_id, removed_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (edition_id) DO UPDATE SET removed_at = excluded.removed_at, updated_at = excluded.updated_at`,
      [editionId, now, now],
    );
  });
}

export function transcriptRemoved(db: Db, editionId: string): boolean {
  return !!db.get('SELECT 1 AS x FROM transcriptions WHERE edition_id = ? AND removed_at IS NOT NULL', [editionId]);
}

/** What the server's own recogniser has done with an audiobook (migration 007). */
export interface TranscriptionRow {
  edition_id: string;
  runs: number;
  last_error: string | null;
  removed_at: number | null;
  updated_at: number;
}

export function transcriptionFor(db: Db, editionId: string): TranscriptionRow | undefined {
  return db.get<TranscriptionRow>('SELECT * FROM transcriptions WHERE edition_id = ?', [editionId]);
}

/** Ready audiobooks without a transcript, whose owner never removed one, with fewer than `?` runs begun. */
const AWAITING_TRANSCRIPT = `e.kind = 'audio' AND e.status = 'ready'
  AND NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.edition_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM transcriptions r WHERE r.edition_id = e.id AND (r.removed_at IS NOT NULL OR r.runs >= ?))`;

/** The audiobooks the server's recogniser should make a transcript for, oldest first. */
export function audiobooksAwaitingTranscript(db: Db, maxRuns: number): string[] {
  return db.all<{ id: string }>(`SELECT e.id FROM editions e WHERE ${AWAITING_TRANSCRIPT} ORDER BY e.created_at`, [maxRuns]).map((r) => r.id);
}

export function awaitsTranscript(db: Db, editionId: string, maxRuns: number): boolean {
  return !!db.get(`SELECT 1 AS x FROM editions e WHERE e.id = ? AND ${AWAITING_TRANSCRIPT}`, [editionId, maxRuns]);
}

/** A run of the recogniser begins. It counts from now, so one that brings the server down counts too. */
export function beginTranscriptionRun(db: Db, editionId: string, now = Date.now()): void {
  db.exec(
    `INSERT INTO transcriptions (edition_id, runs, updated_at) VALUES (?, 1, ?)
     ON CONFLICT (edition_id) DO UPDATE SET runs = runs + 1, updated_at = excluded.updated_at`,
    [editionId, now],
  );
}

/** The server stopped the run as it shut down: that was not the recogniser failing, so it is not counted. */
export function giveBackTranscriptionRun(db: Db, editionId: string, now = Date.now()): void {
  db.exec('UPDATE transcriptions SET runs = MAX(runs - 1, 0), updated_at = ? WHERE edition_id = ?', [now, editionId]);
}

/** How the run ended: with the error it failed with, or with a transcript (null). */
export function endTranscriptionRun(db: Db, editionId: string, error: string | null, now = Date.now()): void {
  db.exec('UPDATE transcriptions SET last_error = ?, updated_at = ? WHERE edition_id = ?', [error?.slice(0, 1000) ?? null, now, editionId]);
}

export function bookHasTranscripts(db: Db, bookId: string): boolean {
  return !!db.get('SELECT 1 AS x FROM transcripts t JOIN editions e ON e.id = t.edition_id WHERE e.book_id = ?', [bookId]);
}

/** Keep an audiobook's read-along: its sentences (StoredSentence[][]) as the worker thread wrote them out. */
export function saveReadAlong(
  db: Db,
  row: { audioEditionId: string; textEditionId: string; refinedEditionId: string; sentencesJson: string; stats: ReadAlongStats },
): void {
  db.exec(
    `INSERT INTO readalong (audio_edition_id, text_edition_id, refined_edition_id, sentences_json, stats_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (audio_edition_id) DO UPDATE SET text_edition_id = excluded.text_edition_id, refined_edition_id = excluded.refined_edition_id,
       sentences_json = excluded.sentences_json, stats_json = excluded.stats_json, created_at = excluded.created_at`,
    [row.audioEditionId, row.textEditionId, row.refinedEditionId, row.sentencesJson, toJson(row.stats), Date.now()],
  );
}

export function readAlongFor(db: Db, audioEditionId: string): ReadAlongRow | undefined {
  return db.get<ReadAlongRow>('SELECT * FROM readalong WHERE audio_edition_id = ?', [audioEditionId]);
}

export function readAlongsForBook(db: Db, bookId: string): ReadAlongRow[] {
  return db.all<ReadAlongRow>('SELECT r.* FROM readalong r JOIN editions e ON e.id = r.audio_edition_id WHERE e.book_id = ?', [bookId]);
}

/** The books with a read-along lined up by rules older than `rules` (READ_ALONG_RULES), oldest first. */
export function booksWithReadAlongsBefore(db: Db, rules: number): string[] {
  const rows = db.all<{ book_id: string; stats_json: string }>(
    'SELECT e.book_id, r.stats_json FROM readalong r JOIN editions e ON e.id = r.audio_edition_id ORDER BY r.created_at',
  );
  return [...new Set(rows.filter((r) => (fromJson<Partial<ReadAlongStats> | null>(r.stats_json, null)?.rules ?? 0) < rules).map((r) => r.book_id))];
}

export function deleteReadAlong(db: Db, audioEditionId: string): void {
  db.exec('DELETE FROM readalong WHERE audio_edition_id = ?', [audioEditionId]);
}

export function readAlongSentences(row: ReadAlongRow): StoredSentence[][] {
  return fromJson<StoredSentence[][]>(row.sentences_json, []);
}

export function readAlongStats(row: ReadAlongRow): ReadAlongStats | null {
  return fromJson<ReadAlongStats | null>(row.stats_json, null);
}
