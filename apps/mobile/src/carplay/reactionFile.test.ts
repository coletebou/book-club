import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactionFile } from './reactionFile';
import { type PendingReaction } from './reactionOutbox';

const fs = vi.hoisted(() => ({ entries: new Map<string, string>(), move: vi.fn(), read: vi.fn() }));
const DIR = 'file:///private/bookclub-car-reactions/';
const id = (n: number) => `01000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = (clientId: string): PendingReaction => ({
  userId: 'user01', bookId: 'book01', editionId: 'edition01', locator: { kind: 'audio', track: 1, ms: 1200 }, reaction: '❤️', clientId,
});

vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///private/',
  getInfoAsync: async () => ({ exists: true }),
  readDirectoryAsync: async (dir: string) => [...fs.entries.keys()].filter((key) => key.startsWith(dir)).map((key) => key.slice(dir.length)),
  readAsStringAsync: fs.read,
  writeAsStringAsync: async (name: string, json: string) => { fs.entries.set(name, json); },
  moveAsync: fs.move,
  deleteAsync: async (name: string) => { fs.entries.delete(name); },
}));

beforeEach(() => {
  fs.entries.clear();
  fs.read.mockReset().mockImplementation(async (name: string) => fs.entries.get(name)!);
  fs.move.mockReset().mockImplementation(async ({ from, to }: { from: string; to: string }) => {
    fs.entries.set(to, fs.entries.get(from)!);
    fs.entries.delete(from);
  });
});

describe('CarPlay reaction files', () => {
  it('recovers a complete interrupted write and removes unreadable JSON content', async () => {
    fs.entries.set(`${DIR}${id(1)}.json.tmp`, JSON.stringify(entry(id(1))));
    fs.entries.set(`${DIR}${id(2)}.json`, '{');
    fs.entries.set(`${DIR}${id(3)}.json.tmp`, 'corrupt');
    const accept = vi.fn();
    await reactionFile.read(accept);
    expect(accept).toHaveBeenCalledExactlyOnceWith(entry(id(1)));
    expect([...fs.entries.keys()]).toEqual([`${DIR}${id(1)}.json`]);
  });

  it('keeps temporary and final files intact if the final file is inaccessible', async () => {
    const final = `${DIR}${id(1)}.json`;
    const partial = `${final}.tmp`;
    fs.entries.set(final, JSON.stringify(entry(id(1))));
    fs.entries.set(partial, JSON.stringify(entry(id(1))));
    fs.read.mockRejectedValueOnce(new Error('device is still locked'));
    const accept = vi.fn();
    await expect(reactionFile.read(accept)).rejects.toThrow();
    expect(accept).not.toHaveBeenCalled();
    expect([...fs.entries.keys()]).toEqual([final, partial]);
  });

  it('writes by moving a complete temporary file and keeps the previously queued taps at capacity', async () => {
    await reactionFile.write(entry(id(0)));
    expect(fs.move).toHaveBeenCalledExactlyOnceWith({ from: `${DIR}${id(0)}.json.tmp`, to: `${DIR}${id(0)}.json` });
    for (let i = 1; i < 128; i++) fs.entries.set(`${DIR}${id(i)}.json`, JSON.stringify(entry(id(i))));
    await expect(reactionFile.write(entry(id(128)))).rejects.toThrow('Too many pending reactions');
    expect(fs.entries.size).toBe(128);
    expect(fs.entries.get(`${DIR}${id(0)}.json`)).toBe(JSON.stringify(entry(id(0))));
  });

  it('accepts a complete temporary write even when promotion fails, then removes it after delivery', async () => {
    fs.move.mockRejectedValue(new Error('move delayed'));
    await expect(reactionFile.write(entry(id(1)))).resolves.toBeUndefined();
    const accept = vi.fn();
    await reactionFile.read(accept);
    expect(accept).toHaveBeenCalledExactlyOnceWith(entry(id(1)));
    await reactionFile.remove(id(1));
    expect(fs.entries.size).toBe(0);
  });
});
