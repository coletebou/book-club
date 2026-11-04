import { type Db } from '../db/db';
import { newId } from '../lib/crypto';
import { fromJson, toJson } from '../lib/json';
import {
  type CalChunkRow,
  type CalConversationRow,
  type CalContentPart,
  type CalEmbeddingRow,
  type CalIndexKind,
  type CalIndexState,
  type CalIndexStatusRow,
  type CalMessageRow,
  type CalSettingsRow,
  type CalShelfItemRow,
  type NewChunk,
  type SeriesRow,
} from './types';

/* Series ----------------------------------------------------------------------------------- */

export function seriesForClub(db: Db, clubId: string): SeriesRow[] {
  return db.all<SeriesRow>('SELECT * FROM series WHERE club_id = ? ORDER BY title', [clubId]);
}

export function seriesById(db: Db, id: string): SeriesRow | undefined {
  return db.get<SeriesRow>('SELECT * FROM series WHERE id = ?', [id]);
}

export function createSeries(db: Db, input: { clubId: string; title: string; createdBy: string }): SeriesRow {
  const id = newId();
  db.exec('INSERT INTO series (id, club_id, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [id, input.clubId, input.title, input.createdBy, Date.now()]);
  return seriesById(db, id)!;
}

export function setBookSeries(db: Db, bookId: string, seriesId: string | null, order: number | null): void {
  db.exec('UPDATE books SET series_id = ?, series_order = ? WHERE id = ?', [seriesId, order, bookId]);
}

/** Books of a series, in reading order (an unset order sorts last, by title as a tiebreak). */
export function booksInSeries(db: Db, seriesId: string): { id: string; title: string; series_order: number | null }[] {
  return db.all('SELECT id, title, series_order FROM books WHERE series_id = ? ORDER BY series_order IS NULL, series_order, title', [seriesId]);
}

/* Chunks ------------------------------------------------------------------------------------- */

export function insertChunks(db: Db, chunks: readonly NewChunk[]): string[] {
  const now = Date.now();
  const ids: string[] = [];
  db.tx(() => {
    for (const c of chunks) {
      const id = newId();
      ids.push(id);
      db.exec(
        `INSERT INTO cal_chunks (id, club_id, source_type, book_id, edition_id, shelf_item_id, chapter_title, t_start, t_end, seq, text, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, c.clubId, c.sourceType, c.bookId, c.editionId, c.shelfItemId, c.chapterTitle, c.tStart, c.tEnd, c.seq, c.text, c.tokenCount, now],
      );
    }
  });
  return ids;
}

/** Chunks per transaction in {@link insertChunksYielding}: a few milliseconds of FTS5 work each. */
const INSERT_BATCH = 100;

/**
 * {@link insertChunks} for a whole book's worth (a 16-hour audiobook's transcript is thousands of
 * chunks): one transaction per {@link INSERT_BATCH}, letting the event loop run between them, so
 * that indexing never holds the server's thread (in one transaction, 2,000 chunks into FTS5 held it
 * for over a third of a second). Readers never see a half-indexed edition as anything but fewer
 * results: the edition's index status stays 'processing' until it is done.
 */
export async function insertChunksYielding(db: Db, chunks: readonly NewChunk[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
    ids.push(...insertChunks(db, chunks.slice(i, i + INSERT_BATCH)));
    await yieldToLoop();
  }
  return ids;
}

/** Let everything waiting on the event loop (requests, sockets, timers) run before going on. */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function deleteChunksForEdition(db: Db, editionId: string): void {
  db.exec('DELETE FROM cal_chunks WHERE edition_id = ?', [editionId]);
}

export function deleteChunksForShelfItem(db: Db, shelfItemId: string): void {
  db.exec('DELETE FROM cal_chunks WHERE shelf_item_id = ?', [shelfItemId]);
}

export function chunkById(db: Db, id: string): CalChunkRow | undefined {
  return db.get<CalChunkRow>('SELECT * FROM cal_chunks WHERE id = ?', [id]);
}

/** Chunks of the same source around `seq` (inclusive), for get_passage's "neighbours". */
export function chunkNeighbors(db: Db, chunk: CalChunkRow, before: number, after: number): CalChunkRow[] {
  const column = chunk.edition_id ? 'edition_id' : 'shelf_item_id';
  const ref = chunk.edition_id ?? chunk.shelf_item_id;
  return db.all<CalChunkRow>(`SELECT * FROM cal_chunks WHERE ${column} = ? AND seq BETWEEN ? AND ? ORDER BY seq`, [ref, chunk.seq - before, chunk.seq + after]);
}

export interface FtsHit {
  readonly id: string;
  readonly rank: number;
}

/** BM25 full-text search (lower `rank` = better match, FTS5's own convention) over a club's chunks. */
export function ftsSearch(db: Db, clubId: string, query: string, limit: number): FtsHit[] {
  return db.all<{ id: string; rank: number }>(
    `SELECT c.id AS id, bm25(cal_chunks_fts) AS rank
     FROM cal_chunks_fts
     JOIN cal_chunks c ON c.rowid = cal_chunks_fts.rowid
     WHERE cal_chunks_fts.text MATCH ? AND c.club_id = ?
     ORDER BY rank LIMIT ?`,
    [query, clubId, limit],
  );
}

export interface EmbeddedChunk {
  readonly id: string;
  readonly vector: Float32Array;
}

/** Every embedded chunk of a club, for brute-force cosine search (vector-search.ts, D161). */
export function embeddedChunksForClub(db: Db, clubId: string, provider: string, model: string): EmbeddedChunk[] {
  const rows = db.all<{ id: string; vector: Uint8Array }>(
    `SELECT e.chunk_id AS id, e.vector AS vector
     FROM cal_embeddings e JOIN cal_chunks c ON c.id = e.chunk_id
     WHERE c.club_id = ? AND e.provider = ? AND e.model = ?`,
    [clubId, provider, model],
  );
  return rows.map((r) => ({ id: r.id, vector: new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength)) }));
}

export function insertEmbeddings(db: Db, rows: readonly { chunkId: string; provider: string; model: string; vector: Float32Array }[]): void {
  const now = Date.now();
  db.tx(() => {
    for (const r of rows) {
      const bytes = new Uint8Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength));
      db.exec(
        `INSERT INTO cal_embeddings (chunk_id, provider, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (chunk_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, dim = excluded.dim, vector = excluded.vector, created_at = excluded.created_at`,
        [r.chunkId, r.provider, r.model, r.vector.length, bytes, now],
      );
    }
  });
}

/** A chunk's embedding row, if any (used to detect "already embedded" when resuming). */
export function embeddingFor(db: Db, chunkId: string): CalEmbeddingRow | undefined {
  return db.get<CalEmbeddingRow>('SELECT * FROM cal_embeddings WHERE chunk_id = ?', [chunkId]);
}

/* Index status (resumable indexing, mirrors ingest's resumeIngest) --------------------------- */

export function setIndexStatus(db: Db, kind: CalIndexKind, refId: string, status: CalIndexState, error: string | null = null, chunkCount?: number): void {
  db.exec(
    `INSERT INTO cal_index_status (kind, ref_id, status, error, chunk_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, ref_id) DO UPDATE SET status = excluded.status, error = excluded.error,
       chunk_count = COALESCE(?, chunk_count), updated_at = excluded.updated_at`,
    [kind, refId, status, error, chunkCount ?? 0, Date.now(), chunkCount ?? null],
  );
}

export function indexStatus(db: Db, kind: CalIndexKind, refId: string): CalIndexStatusRow | undefined {
  return db.get<CalIndexStatusRow>('SELECT * FROM cal_index_status WHERE kind = ? AND ref_id = ?', [kind, refId]);
}

export function pendingIndexJobs(db: Db, kind: CalIndexKind): CalIndexStatusRow[] {
  return db.all<CalIndexStatusRow>("SELECT * FROM cal_index_status WHERE kind = ? AND status IN ('pending', 'processing')", [kind]);
}

/* Shelf items ---------------------------------------------------------------------------------- */

export function createShelfItem(db: Db, input: { clubId: string; userId: string; kind: CalShelfItemRow['kind']; title: string; sourceUrl: string | null; blobId: string | null }): CalShelfItemRow {
  const id = newId();
  db.exec(
    'INSERT INTO cal_shelf_items (id, club_id, user_id, kind, title, source_url, blob_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.clubId, input.userId, input.kind, input.title, input.sourceUrl, input.blobId, 'pending', Date.now()],
  );
  return shelfItemById(db, id)!;
}

export function shelfItemById(db: Db, id: string): CalShelfItemRow | undefined {
  return db.get<CalShelfItemRow>('SELECT * FROM cal_shelf_items WHERE id = ?', [id]);
}

export function shelfItemsForClub(db: Db, clubId: string): CalShelfItemRow[] {
  return db.all<CalShelfItemRow>('SELECT * FROM cal_shelf_items WHERE club_id = ? ORDER BY created_at DESC', [clubId]);
}

export function setShelfItemStatus(db: Db, id: string, status: CalShelfItemRow['status'], error: string | null = null): void {
  db.exec('UPDATE cal_shelf_items SET status = ?, error = ? WHERE id = ?', [status, error, id]);
}

export function deleteShelfItem(db: Db, id: string): void {
  db.exec('DELETE FROM cal_shelf_items WHERE id = ?', [id]);
}

/* Conversations and messages ------------------------------------------------------------------ */

export function createConversation(db: Db, input: { userId: string; clubId: string; bookId: string | null; title: string }): CalConversationRow {
  const id = newId();
  const now = Date.now();
  db.exec('INSERT INTO cal_conversations (id, user_id, club_id, book_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    id,
    input.userId,
    input.clubId,
    input.bookId,
    input.title,
    now,
    now,
  ]);
  return conversationById(db, id)!;
}

export function conversationById(db: Db, id: string): CalConversationRow | undefined {
  return db.get<CalConversationRow>('SELECT * FROM cal_conversations WHERE id = ?', [id]);
}

/** A thread in someone's list (D183): the conversation row, with the title of the book it is about while that book is still there. */
export interface CalThreadRow extends CalConversationRow {
  book_title: string | null;
}

/**
 * Someone's threads with Cal in one club, most recent first (D183): only their own (threads are
 * private, D166), and only those with at least one message. A thread is created at its first
 * question, so the only empty ones are older rows the panel used to open eagerly, before threads.
 */
export function conversationsForUser(db: Db, userId: string, clubId: string): CalThreadRow[] {
  return db.all<CalThreadRow>(
    `SELECT c.*, b.title AS book_title
     FROM cal_conversations c
     LEFT JOIN books b ON b.id = c.book_id AND b.deleted_at IS NULL
     WHERE c.user_id = ? AND c.club_id = ?
       AND EXISTS (SELECT 1 FROM cal_messages m WHERE m.conversation_id = c.id)
     ORDER BY c.updated_at DESC, c.created_at DESC`,
    [userId, clubId],
  );
}

/** The longest title a thread takes from its first question (D183), in characters. */
export const THREAD_TITLE_MAX = 60;

/**
 * A thread's title, taken from its first question (D183): whitespace folded to single spaces, and
 * cut at the last word boundary that fits in {@link THREAD_TITLE_MAX} characters with an ellipsis,
 * rather than mid-word (a word longer than that is cut where it must be).
 */
export function threadTitle(question: string): string {
  const text = question.replace(/\s+/g, ' ').trim();
  if (text.length <= THREAD_TITLE_MAX) return text;
  const room = text.slice(0, THREAD_TITLE_MAX - 1);
  const space = room.lastIndexOf(' ');
  const cut = space >= THREAD_TITLE_MAX / 2 ? room.slice(0, space) : room;
  return `${cut.replace(/[\s.,;:!?-]+$/, '')}…`;
}

export function touchConversation(db: Db, id: string): void {
  db.exec('UPDATE cal_conversations SET updated_at = ? WHERE id = ?', [Date.now(), id]);
}

export function renameConversation(db: Db, id: string, title: string): void {
  db.exec('UPDATE cal_conversations SET title = ? WHERE id = ?', [title, id]);
}

export function setConversationShared(db: Db, id: string, shared: boolean): void {
  db.exec('UPDATE cal_conversations SET shared_to_club = ? WHERE id = ?', [shared ? 1 : 0, id]);
}

export function deleteConversation(db: Db, id: string): void {
  db.exec('DELETE FROM cal_conversations WHERE id = ?', [id]);
}

export function insertMessage(
  db: Db,
  input: { conversationId: string; role: 'user' | 'assistant'; content: CalContentPart[]; wholeSeries: boolean; inputTokens?: number; outputTokens?: number },
): CalMessageRow {
  const id = newId();
  db.exec(
    'INSERT INTO cal_messages (id, conversation_id, role, content_json, whole_series, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.conversationId, input.role, toJson(input.content), input.wholeSeries ? 1 : 0, input.inputTokens ?? null, input.outputTokens ?? null, Date.now()],
  );
  touchConversation(db, input.conversationId);
  return messageById(db, id)!;
}

export function messageById(db: Db, id: string): CalMessageRow | undefined {
  return db.get<CalMessageRow>('SELECT * FROM cal_messages WHERE id = ?', [id]);
}

export function messagesForConversation(db: Db, conversationId: string): CalMessageRow[] {
  return db.all<CalMessageRow>('SELECT * FROM cal_messages WHERE conversation_id = ? ORDER BY created_at', [conversationId]);
}

export function messageContent(row: CalMessageRow): CalContentPart[] {
  return fromJson<CalContentPart[]>(row.content_json, []);
}

/* Settings --------------------------------------------------------------------------------- */

export function settingsFor(db: Db, userId: string): CalSettingsRow {
  const row = db.get<CalSettingsRow>('SELECT * FROM cal_settings WHERE user_id = ?', [userId]);
  return row ?? { user_id: userId, whole_series: 0, voice_provider: null, updated_at: 0 };
}

export function setWholeSeries(db: Db, userId: string, wholeSeries: boolean): void {
  db.exec(
    `INSERT INTO cal_settings (user_id, whole_series, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET whole_series = excluded.whole_series, updated_at = excluded.updated_at`,
    [userId, wholeSeries ? 1 : 0, Date.now()],
  );
}

export function setVoiceProvider(db: Db, userId: string, provider: string | null): void {
  db.exec(
    `INSERT INTO cal_settings (user_id, whole_series, voice_provider, updated_at) VALUES (?, 0, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET voice_provider = excluded.voice_provider, updated_at = excluded.updated_at`,
    [userId, provider, Date.now()],
  );
}

/* Cost log ----------------------------------------------------------------------------------- */

export function logCost(db: Db, input: { clubId: string | null; userId: string | null; kind: 'embed' | 'chat' | 'voice_stt' | 'voice_tts'; provider: string; model: string; inputUnits: number; outputUnits: number; costUsd: number }): void {
  db.exec(
    'INSERT INTO cal_cost_log (id, club_id, user_id, kind, provider, model, input_units, output_units, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [newId(), input.clubId, input.userId, input.kind, input.provider, input.model, input.inputUnits, input.outputUnits, input.costUsd, Date.now()],
  );
}

/** A club's total Cal spend since the start of the current calendar month (UTC). */
function monthStart(): number {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime();
}

export function monthSpend(db: Db, clubId: string): number {
  const row = db.get<{ total: number | null }>('SELECT SUM(cost_usd) AS total FROM cal_cost_log WHERE club_id = ? AND created_at >= ?', [clubId, monthStart()]);
  return row?.total ?? 0;
}

/** Every club's Cal spend this calendar month together (D176). */
export function instanceMonthSpend(db: Db): number {
  const row = db.get<{ total: number | null }>('SELECT SUM(cost_usd) AS total FROM cal_cost_log WHERE created_at >= ?', [monthStart()]);
  return row?.total ?? 0;
}

/** Which monthly budget, if any, stops a new Cal turn for this club: its own, or the instance's (D176). */
export function calBudgetSpent(db: Db, clubId: string, caps: { club: number; instance: number }): 'club' | 'instance' | null {
  if (monthSpend(db, clubId) >= caps.club) return 'club';
  if (instanceMonthSpend(db) >= caps.instance) return 'instance';
  return null;
}
