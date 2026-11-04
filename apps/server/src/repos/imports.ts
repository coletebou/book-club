import { type EditionKind } from '@bookclub/shared';
import { type Db } from '../db/db';
import { newId } from '../lib/crypto';
import { fromJson, toJson } from '../lib/json';

export interface DeclaredFile {
  name: string;
  size: number;
  type: string;
  role: 'main' | 'track' | 'cover';
}

export interface ImportRow {
  id: string;
  club_id: string;
  user_id: string;
  kind: EditionKind;
  status: 'uploading' | 'finalized' | 'cancelled';
  files_json: string;
  book_id: string | null;
  edition_id: string | null;
  created_at: number;
}

export interface UploadRow {
  id: string;
  import_id: string;
  file_index: number;
  user_id: string;
  size: number;
  completed_at: number | null;
  created_at: number;
}

export function createImport(db: Db, input: { clubId: string; userId: string; kind: EditionKind; files: DeclaredFile[] }): ImportRow {
  const id = newId();
  db.exec("INSERT INTO imports (id, club_id, user_id, kind, status, files_json, created_at) VALUES (?, ?, ?, ?, 'uploading', ?, ?)", [
    id,
    input.clubId,
    input.userId,
    input.kind,
    toJson(input.files),
    Date.now(),
  ]);
  return importById(db, id)!;
}

export function importById(db: Db, id: string): ImportRow | undefined {
  return db.get<ImportRow>('SELECT * FROM imports WHERE id = ?', [id]);
}

export function declaredFiles(row: ImportRow): DeclaredFile[] {
  return fromJson<DeclaredFile[]>(row.files_json, []);
}

/**
 * Finish or cancel an import that is still being uploaded: true if it was, false if it had been
 * finished or cancelled already, which stays as it is. A cancel and a finish that cross cannot
 * both happen.
 */
export function setImportStatus(db: Db, id: string, status: Exclude<ImportRow['status'], 'uploading'>, bookId?: string, editionId?: string): boolean {
  const { changes } = db.exec(
    "UPDATE imports SET status = ?, book_id = COALESCE(?, book_id), edition_id = COALESCE(?, edition_id) WHERE id = ? AND status = 'uploading'",
    [status, bookId ?? null, editionId ?? null, id],
  );
  return changes > 0;
}

export function createUploadRow(db: Db, input: { id: string; importId: string; fileIndex: number; userId: string; size: number }): void {
  db.exec('INSERT INTO uploads (id, import_id, file_index, user_id, size, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    input.id,
    input.importId,
    input.fileIndex,
    input.userId,
    input.size,
    Date.now(),
  ]);
}

export function uploadById(db: Db, id: string): UploadRow | undefined {
  return db.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', [id]);
}

export function markUploadComplete(db: Db, id: string): void {
  db.exec('UPDATE uploads SET completed_at = ? WHERE id = ? AND completed_at IS NULL', [Date.now(), id]);
}

export function deleteUploadRow(db: Db, id: string): void {
  db.exec('DELETE FROM uploads WHERE id = ?', [id]);
}

export function uploadsForImport(db: Db, importId: string): UploadRow[] {
  return db.all<UploadRow>('SELECT * FROM uploads WHERE import_id = ? ORDER BY file_index, created_at', [importId]);
}

/** The newest upload for each declared file index (a file may have been re-sent). */
export function latestUploads(db: Db, importId: string): Map<number, UploadRow> {
  const out = new Map<number, UploadRow>();
  for (const u of uploadsForImport(db, importId)) {
    const prev = out.get(u.file_index);
    // Prefer a completed upload; otherwise the most recent attempt.
    if (!prev || (u.completed_at !== null && prev.completed_at === null) || (u.completed_at === null) === (prev.completed_at === null)) {
      if (!prev || u.completed_at !== null || prev.completed_at === null) out.set(u.file_index, u);
    }
  }
  return out;
}

export function staleImports(db: Db, olderThan: number): ImportRow[] {
  return db.all<ImportRow>("SELECT * FROM imports WHERE status = 'uploading' AND created_at < ?", [olderThan]);
}
