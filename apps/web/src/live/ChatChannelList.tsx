import { type ReactElement, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessageView } from '@bookclub/shared';
import { type Run, groupRuns } from '@coletebou/chat-core';
import { keepBottomVisibleOnResize } from '../lib/scroll-viewport';
import { NEAR_BOTTOM_PX, revealRenderedChatMessage, useChatListScroll } from './chat-scroll';
import { ChatVoiceRetention } from './chat-voice-retention';
import { type ChatMessagePlacement, hasChatMessageTabStops } from './ChatMessageItem';
import './ChatChannelList.css';

export interface ChatChannelListHandle {
  reveal(id: string): boolean;
}

interface Props {
  readonly ref: Ref<ChatChannelListHandle>;
  readonly messages: readonly ChatMessageView[];
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  readonly loadOlder: () => void;
  readonly editingId: string | undefined;
  readonly openMenu: string | null;
  readonly renderMessage: (run: Run<ChatMessageView>, placement?: ChatMessagePlacement) => ReactElement;
}

const ROW_GAP = 4;
const ROW_ESTIMATE = 96;
const EARLIER_ESTIMATE = 38;
const SMALL_HISTORY_ROWS = 50;

/** D286: window the channel's history and keep active rows mounted. */
export function ChatChannelList({ ref, messages, hasMore, loadingOlder, loadOlder, editingId, openMenu, renderMessage }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const earlierRef = useRef<HTMLDivElement>(null);
  const [focusedMessage, setFocusedMessage] = useState<string | null>(null);
  const [pointerMessage, setPointerMessage] = useState<string | null>(null);
  const [activeClips, setActiveClips] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [positions] = useState(() => new Map<string, number>());
  const [earlierHeight, setEarlierHeight] = useState(EARLIER_ESTIMATE);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [modeAnchor, setModeAnchor] = useState<{ id: string; top: number } | null>(null);
  const [windowed, setWindowed] = useState(() => hasMore || messages.length > SMALL_HISTORY_ROWS);
  const longHistory = hasMore || windowed;
  const virtualized = longHistory && !showAll;
  const newest = messages.at(-1);
  useChatListScroll(listRef, messages, '', !virtualized);
  const runs = useMemo(() => groupRuns(messages, (message) => message.author.userId), [messages]);
  const indices = useMemo(() => new Map(runs.map(({ message }, index) => [message.id, index])), [runs]);
  const getScrollElement = useCallback(() => listRef.current, []);
  const getItemKey = useCallback((index: number) => runs[index]!.message.id, [runs]);
  const retain = useCallback((clipId: string, messageId: string, playing: boolean) => {
    setActiveClips((current) => {
      if (current.has(clipId) === playing) return current;
      const next = new Map(current);
      if (playing) next.set(clipId, messageId);
      else next.delete(clipId);
      return next;
    });
  }, []);
  const voiceRetention = useMemo(() => ({ retain, positions }), [retain, positions]);

  const retainedIndices = useMemo(() => {
    const keep = new Set<number>();
    for (const id of [focusedMessage, pointerMessage, editingId, openMenu, modeAnchor?.id, ...activeClips.values()]) {
      const index = id ? indices.get(id) : undefined;
      if (index !== undefined) keep.add(index);
    }

    // Preserve native tab order across the window edges. Keep the opener when a
    // report, lightbox or confirmation takes focus outside the list.
    const focused = focusedMessage ? indices.get(focusedMessage) : undefined;
    if (focused !== undefined) {
      for (let i = focused - 1; i >= 0; i--) {
        if (!hasChatMessageTabStops(runs[i]!.message)) continue;
        keep.add(i);
        break;
      }
      for (let i = focused + 1; i < runs.length; i++) {
        if (!hasChatMessageTabStops(runs[i]!.message)) continue;
        keep.add(i);
        break;
      }
    }
    return keep;
  }, [activeClips, editingId, focusedMessage, indices, modeAnchor, openMenu, pointerMessage, runs]);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const visible = defaultRangeExtractor(range);
    return [...new Set([...visible, ...retainedIndices])].sort((a, b) => a - b);
  }, [retainedIndices]);

  const virtualizer = useVirtualizer({
    enabled: virtualized,
    count: runs.length,
    getScrollElement, getItemKey, rangeExtractor,
    estimateSize: () => ROW_ESTIMATE,
    // Keep the paging control out of the anchor range. At scrollTop 0 the
    // first message is the one the virtualizer should hold during a prepend.
    paddingStart: hasMore ? earlierHeight + ROW_GAP : 0,
    gap: ROW_GAP,
    overscan: 6,
    anchorTo: 'end',
    followOnAppend: 'auto',
    scrollEndThreshold: NEAR_BOTTOM_PX,
    directDomUpdates: true,
    directDomUpdatesMode: 'position',
  });
  const items = virtualized ? virtualizer.getVirtualItems() : [];
  const hasWindow = items.length > 0;
  // The standalone chat is bounded by max-height. Its scrollport needs an
  // estimated extent even before the virtualizer knows which rows to mount.
  const sized = virtualized && (hasWindow || runs.length > SMALL_HISTORY_ROWS);

  useLayoutEffect(() => {
    if (hasMore) setWindowed(true);
  }, [hasMore]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || longHistory || runs.length <= SMALL_HISTORY_ROWS) return;
    // Switch a live conversation to a window at the newest message. A reader
    // farther back can stay on the same rows until returning to the bottom.
    const checkBottom = () => {
      if (list.scrollHeight - list.scrollTop - list.clientHeight <= 2) setWindowed(true);
    };
    checkBottom();
    list.addEventListener('scroll', checkBottom, { passive: true });
    return () => list.removeEventListener('scroll', checkBottom);
  }, [runs.length, longHistory]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!virtualized || !list) return;
    // Row observers update their own heights after reflow. Keep the last
    // heights of offscreen rows so a width change preserves the reading anchor.
    return keepBottomVisibleOnResize(list);
  }, [virtualized]);

  useLayoutEffect(() => {
    const earlier = earlierRef.current;
    if (!earlier) return;
    const measure = () => setEarlierHeight(earlier.offsetHeight || EARLIER_ESTIMATE);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(earlier);
    return () => observer?.disconnect();
  }, [hasMore]);

  const lastNewest = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!hasWindow) return;
    if (newest && (lastNewest.current === undefined || (lastNewest.current !== newest.id && newest.mine))) {
      virtualizer.scrollToEnd();
    }
    lastNewest.current = newest?.id;
  }, [hasWindow, newest, virtualizer]);

  const toggleShowAll = () => {
    const list = listRef.current;
    if (list) {
      const viewport = list.getBoundingClientRect();
      for (const row of list.querySelectorAll<HTMLElement>('[data-message-id]')) {
        const bounds = row.getBoundingClientRect();
        const id = row.dataset.messageId;
        if (id && bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
          setModeAnchor({ id, top: bounds.top - viewport.top });
          break;
        }
      }
    }
    setShowAll((all) => !all);
  };

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!modeAnchor || !list || (virtualized && !hasWindow)) return;
    const row = [...list.querySelectorAll<HTMLLIElement>('[data-message-id]')].find((item) => item.dataset.messageId === modeAnchor.id);
    if (row && virtualized) {
      // The row is held through the handoff. Measure it before applying an
      // offset into it, which can be much larger than an unmeasured estimate.
      virtualizer.measureElement(row);
      const index = indices.get(modeAnchor.id)!;
      const target = virtualizer.getOffsetForIndex(index, 'start');
      if (target) virtualizer.scrollToOffset(target[0] - modeAnchor.top, { align: 'start' });
      const frame = requestAnimationFrame(() => {
        // The window now has measured neighbours as well. Correct any shift
        // from their estimates before releasing the held row.
        const delta = row.getBoundingClientRect().top - list.getBoundingClientRect().top - modeAnchor.top;
        if (Math.abs(delta) > 1) virtualizer.scrollToOffset(list.scrollTop + delta, { align: 'start' });
        setModeAnchor(null);
      });
      return () => cancelAnimationFrame(frame);
    } else if (row) {
      list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - modeAnchor.top;
    }
    setModeAnchor(null);
  }, [hasWindow, indices, modeAnchor, virtualized, virtualizer]);

  useImperativeHandle(ref, () => ({
    reveal(id) {
      if (!virtualized) return revealRenderedChatMessage(id, listRef.current);
      if (!indices.has(id)) return false;
      setJumpTo(id);
      return true;
    },
  }), [indices, virtualized]);

  useLayoutEffect(() => {
    // After returning from a thread the channel scrollport and sizer are new.
    // A jump before they have geometry is clamped to the empty list's top.
    if (!hasWindow || !jumpTo) return;
    const index = indices.get(jumpTo);
    if (index !== undefined) virtualizer.scrollToIndex(index, { align: 'center' });
    setJumpTo(null);
  }, [hasWindow, indices, jumpTo, virtualizer]);

  // Do not clear the last row on blur. Dialogs live outside the scroll element.
  const rememberRow = (target: EventTarget, remember: (id: string) => void) => {
    if (!(target instanceof Element)) return;
    const id = target.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
    if (id) remember(id);
  };

  // During activation the sizer can exist before the measured range. Keep
  // interacting rows in the same keyed collection through that handoff.
  const fallbackRows = sized && !hasWindow
    ? [...retainedIndices].sort((a, b) => a - b).map((index) => runs[index]!)
    : runs;

  const setSize = hasMore ? -1 : runs.length;
  const list = (
    <div
      className={sized ? 'chat-messages chat-channel-messages' : 'chat-messages'}
      ref={listRef}
      data-testid="chat-messages"
      data-loaded={runs.length}
      onFocusCapture={(event) => rememberRow(event.target, setFocusedMessage)}
      onPointerDownCapture={(event) => rememberRow(event.target, setPointerMessage)}
    >
      {hasMore ? (
        <div className="chat-load-earlier" ref={earlierRef} data-next-group={runs[0]?.showHeader || undefined}>
          <button type="button" className="btn btn-small btn-ghost" data-testid="chat-load-earlier" disabled={loadingOlder} onClick={loadOlder}>
            {loadingOlder ? 'Loading…' : 'Earlier messages'}
          </button>
        </div>
      ) : null}
      {sized ? <div aria-hidden="true" ref={virtualizer.containerRef} /> : null}
      {runs.length === 0 ? <p className="muted small">No messages yet. Say hello.</p> : (
        <ul className="chat-channel-rows" role="list">
          {hasWindow ? items.map(({ index }) => renderMessage(runs[index]!, {
            index,
            position: index + 1,
            count: setSize,
            nextStartsGroup: runs[index + 1]?.showHeader ?? false,
            measure: virtualizer.measureElement,
          })) : fallbackRows.map((run) => renderMessage(run, longHistory ? {
            position: indices.get(run.message.id)! + 1,
            count: setSize,
          } : undefined))}
        </ul>
      )}
    </div>
  );
  return (
    <ChatVoiceRetention.Provider value={voiceRetention}>
      {longHistory ? (
        <div className="chat-history-controls">
          <button type="button" className="btn btn-ghost btn-small" aria-label="Show all loaded messages" aria-pressed={showAll} title="Show all loaded messages for browser Find" onClick={toggleShowAll}>
            Show all
          </button>
        </div>
      ) : null}
      {list}
    </ChatVoiceRetention.Provider>
  );;
}
