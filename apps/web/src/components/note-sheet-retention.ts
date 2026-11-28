import { createContext, useContext, useLayoutEffect } from 'react';

export const NoteSheetRetention = createContext<{
  readonly retain: (retain: boolean) => void;
  readonly playbackPositions: Map<string, number>;
} | null>(null);

/** A draft and a media player in the same row can hold independent reasons to stay mounted. */
export function updateNoteRetention(counts: ReadonlyMap<string, number>, noteId: string, retain: boolean): ReadonlyMap<string, number> {
  const count = counts.get(noteId) ?? 0;
  if (!retain && count === 0) return counts;
  const next = new Map(counts);
  if (!retain && count === 1) next.delete(noteId);
  else next.set(noteId, count + (retain ? 1 : -1));
  return next;
}

/** Keep the note row mounted while a child has an active interaction. */
export function useNoteSheetRetention(active: boolean): void {
  const retain = useContext(NoteSheetRetention)?.retain;
  useLayoutEffect(() => {
    if (!retain || !active) return;
    retain(true);
    return () => retain(false);
  }, [active, retain]);
}
