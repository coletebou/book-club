import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { changeModerationGeneration, clearModeratedResponses, moderationGeneration } from './moderation-cache';

export const memberBlocksKey = ['moderation-blocks'] as const;
const moderatedQueries = new Set(['chat', 'chatThread', 'chatUnread', 'comments', 'notifications', 'places']);
const blockChangeEvent = 'bc-member-blocks-changed';
const storageKey = 'bookclub:moderation-blocks';
let snapshot: string | null = null;
let refreshing = Promise.resolve();

const subscribe = (notify: () => void) => {
  window.addEventListener(blockChangeEvent, notify);
  return () => window.removeEventListener(blockChangeEvent, notify);
};

export const useMemberBlocksGeneration = () => useSyncExternalStore(subscribe, () => moderationGeneration);

export async function syncMemberBlocks(qc: QueryClient, userId: string, ids: readonly string[]): Promise<void> {
  const next = JSON.stringify([userId, [...ids].sort()]);
  let previous = snapshot;
  snapshot = next;
  try {
    previous ??= localStorage.getItem(storageKey);
    if (previous !== next) localStorage.setItem(storageKey, next);
  } catch {
    // The in-memory snapshot still detects changes during this visit.
  }
  if (previous === next || (previous === null && ids.length === 0)) return refreshing;
  changeModerationGeneration();
  window.dispatchEvent(new Event(blockChangeEvent));
  refreshing = refreshModeratedContent(qc);
  return refreshing;
}

async function refreshModeratedContent(qc: QueryClient): Promise<void> {
  const predicate = ({ queryKey }: { queryKey: readonly unknown[] }) => typeof queryKey[0] === 'string' && moderatedQueries.has(queryKey[0]);
  await qc.cancelQueries({ predicate });
  const worker = navigator.serviceWorker?.controller;
  // Keep a page without a controller safe too, such as the first visit on this device.
  if (worker) {
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      const finish = () => {
        window.clearTimeout(timeout);
        channel.port1.close();
        resolve();
      };
      // An older worker does not know this message yet. Clear its existing entries locally.
      const timeout = window.setTimeout(() => { void clearModeratedResponses().catch(() => undefined).then(finish); }, 500);
      channel.port1.onmessage = finish;
      worker.postMessage({ type: 'moderation:blocks' }, [channel.port2]);
    });
  } else {
    await clearModeratedResponses().catch(() => undefined);
  }
  await Promise.all([
    qc.resetQueries({ predicate }),
    qc.invalidateQueries({ queryKey: memberBlocksKey }),
    qc.invalidateQueries({ queryKey: ['book'] }),
    qc.invalidateQueries({ queryKey: ['books'] }),
  ]);
}
