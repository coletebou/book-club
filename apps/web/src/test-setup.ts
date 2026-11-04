/**
 * Test environment for the web client (vitest + jsdom).
 *
 * jsdom implements neither IndexedDB nor ResizeObserver; the app needs both. IndexedDB comes from
 * fake-indexeddb, a complete in-memory implementation, so the outbox, positions and page-count
 * caches run their real code. ResizeObserver only reports layout, which jsdom does not do (every
 * element is 0 px wide), so an observer that never fires is exactly what a real browser would
 * report for an element that never changes size.
 */
import 'fake-indexeddb/auto';

class InertResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= InertResizeObserver;
