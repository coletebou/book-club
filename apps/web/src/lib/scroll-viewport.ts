/** D270: a list that shrinks while a composer has focus keeps its latest message visible. */
export function keepBottomVisibleOnResize(list: HTMLElement): (() => void) | undefined {
  if (typeof ResizeObserver === 'undefined') return;
  let height = list.clientHeight;
  const observer = new ResizeObserver(() => {
    const nextHeight = list.clientHeight;
    if (height === nextHeight) return;
    // The previous bottom still identifies a reader following the newest message when we
    // shrink. On expansion the browser may already have clamped them to the new bottom.
    // Read scrollTop now so a scroll made in the same frame as the resize is respected.
    const wasAtBottom = list.scrollHeight - list.scrollTop - Math.max(height, nextHeight) <= 2;
    height = nextHeight;
    if (wasAtBottom) list.scrollTop = list.scrollHeight;
  });
  observer.observe(list);
  return () => observer.disconnect();
}
