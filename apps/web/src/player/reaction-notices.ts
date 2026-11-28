import { useSyncExternalStore } from 'react';

// A device preference so announcements can be disabled where a screen reader is in use (D262).
const KEY = 'bookclub:passing-reactions';
const CHANGED = 'bookclub:passing-reactions-changed';
let inMemoryChoice: boolean | undefined;

function enabled(): boolean {
  if (inMemoryChoice !== undefined) return inMemoryChoice;
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

function subscribe(notify: () => void): () => void {
  const changedElsewhere = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) notify();
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
    localStorage.setItem(KEY, show ? 'on' : 'off');
    inMemoryChoice = undefined;
  } catch {
    inMemoryChoice = show;
  }
  window.dispatchEvent(new Event(CHANGED));
}
