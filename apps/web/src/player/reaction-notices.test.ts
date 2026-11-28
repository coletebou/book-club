import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetReactionNoticeMemory, setReactionNotices, useReactionNotices } from './reaction-notices';

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetReactionNoticeMemory();
});

it('uses the in-memory choice when storage throws and resets it for the next session', () => {
  const unavailable = () => { throw new DOMException('Storage unavailable', 'SecurityError'); };
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(unavailable);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(unavailable);
  const { result } = renderHook(useReactionNotices);
  expect(result.current).toBe(true);
  act(() => { setReactionNotices(false); });
  expect(result.current).toBe(false);
  act(() => { resetReactionNoticeMemory(); });
  expect(result.current).toBe(true);
});

it('interprets the stored literal off and writes on when enabled', () => {
  localStorage.setItem('bookclub:passing-reactions', 'off');
  const { result } = renderHook(useReactionNotices);
  expect(result.current).toBe(false);
  act(() => { setReactionNotices(true); });
  expect(result.current).toBe(true);
  expect(localStorage.getItem('bookclub:passing-reactions')).toBe('on');
});

it('returns to the default when another tab clears the storage area', () => {
  localStorage.setItem('bookclub:passing-reactions', 'off');
  const { result } = renderHook(useReactionNotices);
  expect(result.current).toBe(false);
  act(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }));
  });
  expect(result.current).toBe(true);
});
