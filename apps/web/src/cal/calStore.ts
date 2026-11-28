import { useSyncExternalStore } from 'react';
import { listeningCaptureAllowed, useListeningCaptureAllowed } from '../player/native-bridge';
import { supportsVoiceRecording } from '../lib/media-capture';

/** Which panel is open, and for whom: the club to talk about, and the book it was opened from, if any. */
export interface CalOpenState {
  readonly clubId: string;
  readonly bookId: string | null;
  readonly voice?: boolean;
}

let state: CalOpenState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/**
 * Cal's panel, shared across the app (D160, D170): the reader and the player open the very same
 * panel their own header's "Ask Cal" offers, as the floating launcher does everywhere else, so
 * there is one conversation and one place that owns it, not a copy per page.
 */
export function openCal(clubId: string, bookId: string | null = null, options?: { voice?: boolean }): void {
  state = { clubId, bookId, ...(options?.voice && listeningCaptureAllowed() && !document.hidden ? { voice: true } : {}) };
  emit();
}

export function cancelCalVoiceLaunch(): void {
  if (!state?.voice) return;
  state = { clubId: state.clubId, bookId: state.bookId };
  emit();
}

export function useCanAskCalByVoice(): boolean {
  return useListeningCaptureAllowed() && typeof AudioContext === 'function' && supportsVoiceRecording();
}

export function closeCal(): void {
  state = null;
  emit();
}

export function useCalOpen(): CalOpenState | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => state,
  );
}
