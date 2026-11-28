import { beforeEach, expect, it, vi } from 'vitest';
import { playSpokenFile, sweepSpokenFiles } from './spokenFile';

const files = vi.hoisted(() => ({ write: vi.fn(), remove: vi.fn(), list: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  writeAsStringAsync: files.write,
  deleteAsync: files.remove,
  readDirectoryAsync: files.list,
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'e2a03e68-5444-46d8-86aa-2892a9865087' }));

beforeEach(() => {
  vi.clearAllMocks();
  files.write.mockResolvedValue(undefined);
  files.remove.mockResolvedValue(undefined);
});

it('clears clips left by an older launch and leaves the current clip and other cache files alone', async () => {
  const stale = 'bookclub-car-2cba1304-6557-45a0-9c75-73e131350790.mp3';
  const current = 'bookclub-car-e2a03e68-5444-46d8-86aa-2892a9865087.wav';
  files.list.mockResolvedValue([stale, current, 'read-along-sample.mp3', 'bookclub-car-reactions.json']);
  let start!: () => void;
  let stop!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const paused = new Promise<void>((resolve) => { stop = resolve; });
  const playback = playSpokenFile({ mimeType: 'audio/wav', audioBase64: 'AQID' }, async () => {
    start();
    await paused;
  }, new AbortController().signal);
  try {
    await started;
    await sweepSpokenFiles();
    expect(files.remove.mock.calls).toEqual([[`file:///cache/${stale}`, { idempotent: true }]]);
  } finally {
    stop();
    await playback;
  }
  expect(files.remove).toHaveBeenLastCalledWith(`file:///cache/${current}`, { idempotent: true });
});
