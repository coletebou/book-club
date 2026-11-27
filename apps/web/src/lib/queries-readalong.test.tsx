import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReadAlongTrack } from '@bookclub/shared';
import type { PropsWithChildren } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { useReadAlong } from './queries';

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

it('asks for offline sentences when the optional timing request is waiting to retry', async () => {
  const plain: ReadAlongTrack = { audioEditionId: 'audio', textEditionId: 'text', track: 0, sentences: [[0, 0, 5, 500, 1_000]], text: ['Hello'] };
  const client = new QueryClient({ defaultOptions: { queries: { networkMode: 'offlineFirst', retry: 1, retryDelay: 0 } } });
  onlineManager.setOnline(false);
  vi.spyOn(api, 'readAlong').mockImplementation(async (_editionId, track, includeWords) => {
    if (includeWords) throw new Error('No connection');
    return { ...plain, track };
  });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useReadAlong('audio', 0, true), { wrapper });
  await waitFor(() => expect(client.getQueryState(['readalong', 'audio', 0, 'words'])?.fetchStatus).toBe('paused'));
  await waitFor(() => expect(result.current.data?.text).toEqual(['Hello']));
});

it('keeps cached sentences when the optional word timing request fails', async () => {
  const plain: ReadAlongTrack = { audioEditionId: 'audio', textEditionId: 'text', track: 0, sentences: [[0, 0, 5, 500, 1_000]], text: ['Hello'] };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['readalong', 'audio', 0], plain);
  vi.spyOn(api, 'readAlong').mockImplementation(async (_editionId, track, includeWords) => {
    if (includeWords) throw new Error('No connection');
    return { ...plain, track };
  });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useReadAlong('audio', 0, true), { wrapper });
  await waitFor(() => expect(client.getQueryState(['readalong', 'audio', 0, 'words'])?.status).toBe('error'));
  expect(result.current.data?.text).toEqual(['Hello']);
});
