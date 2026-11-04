/**
 * A link to a note on the book page (a notification's): `#note-<id>`, the note's conversation, and
 * for an answer in it, which one, in the link's state. Arriving there, the note or the answer is
 * brought into view, marked in gold and given the focus, so that a screen reader reads it out.
 */
export interface NoteLink {
  readonly noteId: string;
  /** The note itself, or an answer under it. */
  readonly commentId: string;
}

/** A comment's id, as the server makes them (anything else in an address is not one). */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The link the book page was opened with, if it is one to a note. */
export function noteLinkFrom(hash: string, state: unknown): NoteLink | null {
  const noteId = hash.startsWith('#note-') ? hash.slice('#note-'.length) : '';
  if (!ID.test(noteId)) return null;
  const comment = typeof state === 'object' && state !== null ? (state as { comment?: unknown }).comment : undefined;
  return { noteId, commentId: typeof comment === 'string' && ID.test(comment) ? comment : noteId };
}

/** Where a link takes you on the page: the answer in its note's conversation, else the note (once it is there). */
export function noteLinkTarget(link: NoteLink, root: Document | HTMLElement = document): HTMLElement | null {
  const note = root.querySelector<HTMLElement>(`[id="note-${link.noteId}"]`);
  if (!note || link.commentId === link.noteId) return note;
  return [...note.querySelectorAll<HTMLElement>('[data-comment]')].find((el) => el.dataset.comment === link.commentId) ?? note;
}

/**
 * Arrived at from a link: in the middle of the screen, marked (a gold glow that fades, then a gold
 * ring while it has the focus; app.css), and focused, which a screen reader reads out. The mark
 * goes when the focus does.
 */
export function markArrival(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center' });
  if (!el.hasAttribute('tabindex')) el.tabIndex = -1;
  el.dataset.arrived = 'true';
  el.focus({ preventScroll: true });
  el.addEventListener('blur', () => delete el.dataset.arrived, { once: true });
}
