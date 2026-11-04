/** Cal (Callimachus): shared server-side types. D160-D169 (docs/DECISIONS.md). */

export type CalSourceType = 'book' | 'shelf';

export interface CalChunkRow {
  id: string;
  club_id: string;
  source_type: CalSourceType;
  book_id: string | null;
  edition_id: string | null;
  shelf_item_id: string | null;
  chapter_title: string | null;
  t_start: number | null;
  t_end: number | null;
  seq: number;
  text: string;
  token_count: number;
  created_at: number;
}

export interface NewChunk {
  clubId: string;
  sourceType: CalSourceType;
  bookId: string | null;
  editionId: string | null;
  shelfItemId: string | null;
  chapterTitle: string | null;
  tStart: number | null;
  tEnd: number | null;
  seq: number;
  text: string;
  tokenCount: number;
}

export interface CalEmbeddingRow {
  chunk_id: string;
  provider: string;
  model: string;
  dim: number;
  vector: Uint8Array;
  created_at: number;
}

export interface CalShelfItemRow {
  id: string;
  club_id: string;
  user_id: string;
  kind: 'pdf' | 'epub' | 'txt' | 'md' | 'url';
  title: string;
  source_url: string | null;
  blob_id: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  error: string | null;
  created_at: number;
}

export interface CalConversationRow {
  id: string;
  user_id: string;
  club_id: string;
  book_id: string | null;
  title: string;
  shared_to_club: number;
  created_at: number;
  updated_at: number;
}

export type CalContentPart =
  | { type: 'text'; text: string }
  | { type: 'citation'; chunkId: string; bookId: string; bookTitle: string; chapterTitle: string | null; t: number; quote: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; name: string; summary: string };

export interface CalMessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content_json: string;
  whole_series: number;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: number;
}

export interface CalSettingsRow {
  user_id: string;
  whole_series: number;
  voice_provider: string | null;
  updated_at: number;
}

export type CalIndexKind = 'edition' | 'shelf_item';
export type CalIndexState = 'pending' | 'processing' | 'ready' | 'failed';

export interface CalIndexStatusRow {
  kind: CalIndexKind;
  ref_id: string;
  status: CalIndexState;
  error: string | null;
  chunk_count: number;
  updated_at: number;
}

export interface SeriesRow {
  id: string;
  club_id: string;
  title: string;
  created_by: string;
  created_at: number;
}

/** A hybrid search hit: a chunk plus the book/shelf-item context Cal (and the UI) needs to show it. */
export interface SearchHit {
  readonly chunkId: string;
  readonly text: string;
  readonly sourceType: CalSourceType;
  readonly bookId: string | null;
  readonly bookTitle: string | null;
  readonly editionId: string | null;
  readonly shelfItemId: string | null;
  readonly shelfTitle: string | null;
  readonly chapterTitle: string | null;
  readonly t: number | null;
  readonly fusedScore: number;
}
