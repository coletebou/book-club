import { useSyncExternalStore } from 'react';

// A device preference so announcements can be disabled where a screen reader is in use (D262).
export const REACTION_NOTICE_STORAGE_KEY = 'bookclub:passing-reactions';
const CHANGED = 'bookclub:passing-reactions-changed';
let inMemoryChoice: boolean | undefined;

export function storedReactionNotice(): 'on' | 'off' | undefined {
  try {
    const stored = localStorage.getItem(REACTION_NOTICE_STORAGE_KEY);
    return stored === 'on' || stored === 'off' ? stored : undefined;
  } catch {
    return undefined;
  }
}

function enabled(): boolean {
  return inMemoryChoice ?? (storedReactionNotice() !== 'off');
}

function subscribe(notify: () => void): () => void {
  const changedElsewhere = (event: StorageEvent) => {
    if (event.key === REACTION_NOTICE_STORAGE_KEY || event.key === null) notify();
  };
  window.addEventListener(CHANGED, notify);
  window.addEventListener('storage', changedElsewhere);
  return () => {
    window.removeEventListener(CHANGED, notify);
    window.removeEventListener('storage', changedElsewhere);
  };
}

export function useReactionNotices(): boolean {
  return useSyncExternalStore(subscribe, enabled, () => true);
}

export function setReactionNotices(show: boolean): void {
  try {
    localStorage.setItem(REACTION_NOTICE_STORAGE_KEY, show ? 'on' : 'off');
    inMemoryChoice = undefined;
  } catch {
    inMemoryChoice = show;
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** A storage failure can leave a choice for this session only (D262). */
export function resetReactionNoticeMemory(): void {
  if (inMemoryChoice === undefined) return;
  inMemoryChoice = undefined;
  window.dispatchEvent(new Event(CHANGED));
}
