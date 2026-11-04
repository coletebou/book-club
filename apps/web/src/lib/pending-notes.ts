import type { CreateCommentBody } from '@bookclub/shared';

/*
 * Notes and reactions made with no network, kept on the device until they can be pinned: reading
 * on a plane, a reaction is not lost (FR84). Each has its client id, so sending one again never
 * makes it twice. Kept per person, as the reading outbox is, and wiped with the device's data.
 */

export interface PendingNote {
  readonly bookId: string;
  readonly body: CreateCommentBody & { readonly clientId: string };
}

const key = (userId: string) => `bookclub:pending-notes:${userId}`;

export function pendingNotes(userId: string): PendingNote[] {
  try {
    const raw = localStorage.getItem(key(userId));
    return raw ? (JSON.parse(raw) as PendingNote[]) : [];
  } catch {
    return [];
  }
}

function store(userId: string, notes: readonly PendingNote[]): void {
  try {
    if (notes.length === 0) localStorage.removeItem(key(userId));
    else localStorage.setItem(key(userId), JSON.stringify(notes));
  } catch {
    // No storage: the note is lost, as it would have been.
  }
}

/** Keep a note to pin later; the same one (its client id) is kept once. */
export function keepNoteForLater(userId: string, note: PendingNote): void {
  const notes = pendingNotes(userId).filter((n) => n.body.clientId !== note.body.clientId);
  store(userId, [...notes, note]);
}

export function forgetPendingNote(userId: string, clientId: string): void {
  store(userId, pendingNotes(userId).filter((n) => n.body.clientId !== clientId));
}

/** What a note made with no network is told. */
export const KEPT_MESSAGE = 'No network: this is kept on this device and will be pinned when you are back online.';
