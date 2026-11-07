/**
 * Attachments: pictures added to a message before it is sent. The core keeps the composer's list
 * of them (in the order they were picked, however their uploads finish), and reads which files a
 * paste or a drop holds. Uploading is the app's: it reports back when each upload came through
 * or why not. Types are structural, so a browser's File, DataTransfer and ClipboardData fit, and
 * so does anything shaped like them.
 */

/** What the core reads of a file: its name and its type. */
export interface FileLike {
  readonly name: string;
  readonly type: string;
}

/** What the core reads of a paste's or a drop's contents (a DataTransfer or ClipboardData). */
export interface TransferLike<F extends FileLike> {
  readonly files?: ArrayLike<F> | null;
  readonly items?: ArrayLike<{ readonly kind: string; readonly type: string; getAsFile(): F | null }> | null;
}

/** The pictures among a paste's or a drop's contents, in order; anything else (text, a PDF) is left out. */
export function imageFilesFrom<F extends FileLike>(transfer: TransferLike<F> | null | undefined): F[] {
  if (!transfer) return [];
  const isImage = (type: string) => /^image\//iu.test(type);
  const fromItems: F[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== 'file' || !isImage(item.type)) continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(transfer.files ?? []).filter((f) => isImage(f.type));
}

/** One picture in the composer. */
export interface ComposerAttachment {
  /** The composer's own key for it, given when it was added. */
  readonly key: string;
  readonly name: string;
  readonly status: 'uploading' | 'ready' | 'failed';
  /** The server's id for it, once uploaded. */
  readonly id: string | null;
  /** What the app shows of it while it is not sent (an object URL, say): the app's to make and to free. */
  readonly preview: string | null;
  /** Why it did not come through, in words for the person who added it. */
  readonly error: string | null;
}
