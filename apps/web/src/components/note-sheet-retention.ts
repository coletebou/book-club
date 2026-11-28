import { createContext, useContext, useLayoutEffect } from 'react';

export const NoteSheetRetention = createContext<{
  readonly retain: (retain: boolean) => void;
  readonly playbackPositions: Map<string, number>;
} | null>(null);

/** Keep the note row mounted while a child has an active interaction. */
export function useNoteSheetRetention(active: boolean): void {
  const retain = useContext(NoteSheetRetention)?.retain;
  useLayoutEffect(() => {
    if (!retain || !active) return;
    retain(true);
    return () => retain(false);
  }, [active, retain]);
}
