import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import type { ChatMessageView } from '@bookclub/shared';
import { keepBottomVisibleOnResize } from '../lib/scroll-viewport';

/** New messages follow the bottom when it is near, or when you sent them. */
export const NEAR_BOTTOM_PX = 120;

export function useChatListScroll(
  listRef: RefObject<HTMLElement | null>,
  messages: readonly ChatMessageView[],
  resetKey: string,
  enabled = true,
) {
  const seen = useRef<{ key: string; newest?: string; oldest?: string; height: number; atBottom: boolean }>({ key: resetKey, height: 0, atBottom: true });
  useEffect(() => {
    const el = listRef.current;
    if (!enabled || !el) return;
    const onScroll = () => {
      seen.current.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const stopResize = keepBottomVisibleOnResize(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      stopResize?.();
    };
  }, [enabled, listRef, resetKey]);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!enabled || !el) return;
    if (seen.current.key !== resetKey) seen.current = { key: resetKey, height: 0, atBottom: true };
    const was = seen.current;
    const oldest = messages[0];
    const newest = messages.at(-1);
    let atBottom = was.atBottom;
    if (oldest && was.oldest && oldest.id !== was.oldest && newest?.id === was.newest) {
      el.scrollTop += el.scrollHeight - was.height;
    } else if (newest && newest.id !== was.newest && (was.newest === undefined || was.atBottom || newest.mine)) {
      el.scrollTop = el.scrollHeight;
      atBottom = true;
    }
    seen.current = { key: resetKey, newest: newest?.id, oldest: oldest?.id, height: el.scrollHeight, atBottom };
  }, [enabled, listRef, messages, resetKey]);
}

export function revealRenderedChatMessage(id: string, list: HTMLElement | null): boolean {
  const row = [...(list?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find((item) => item.dataset.messageId === id);
  if (!row) return false;
  // WebKit can cut short a smooth scroll in a nested list on the next layout pass.
  row.scrollIntoView?.({ block: 'center' });
  return true;
}
