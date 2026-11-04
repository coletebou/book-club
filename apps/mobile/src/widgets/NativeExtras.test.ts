/// <reference types="node" />
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
const { LiveActivityDriver, NativeExtras, recordOf } = await import('./NativeExtras');
const { pathOfAppLink } = await import('./appLink');

const native = () => ({
  setWidgetSnapshot: vi.fn(() => Promise.resolve()),
  clearWidgets: vi.fn(),
  liveActivitiesAllowed: vi.fn(() => true),
  showNowPlaying: vi.fn(() => Promise.resolve()),
  endNowPlaying: vi.fn(() => Promise.resolve()),
  addListener: vi.fn(() => ({ remove: vi.fn() })),
});
const playing = { bookId: 'b1', title: 'Alice', author: 'Carroll', chapter: 'Chapter 2', playing: true, position: 30, duration: 300, rate: 1, track: 1, tracks: 12 };

describe('the widgets’ data, from the page (D188, D189)', () => {
  it('hands the snapshot and its covers to the widget extension', () => {
    const n = native();
    const extras = new NativeExtras(n, new LiveActivityDriver(n));
    extras.handle(JSON.stringify({ type: 'widgets', snapshot: { generatedAt: 1, current: { bookId: 'b1' }, others: [] }, covers: { b1: 'https://books.example/c.webp', bad: 'javascript:x' } }));
    expect(n.setWidgetSnapshot).toHaveBeenCalledWith(JSON.stringify({ generatedAt: 1, current: { bookId: 'b1' }, others: [] }), { b1: 'https://books.example/c.webp' });
  });
  it('clears the widgets when there is nobody’s reading to show, and ignores what is not its own', () => {
    const n = native();
    const extras = new NativeExtras(n, new LiveActivityDriver(n));
    extras.handle(JSON.stringify({ type: 'widgets', snapshot: { generatedAt: 1, current: null, others: [] }, covers: {} }));
    expect(n.clearWidgets).toHaveBeenCalled();
    extras.handle(JSON.stringify({ type: 'play' }));
    extras.handle('not json');
    expect(n.setWidgetSnapshot).not.toHaveBeenCalled();
  });
});

describe('the audiobook’s Live Activity (D189)', () => {
  it('shows nothing until the person turns it on, and nothing iOS does not allow', () => {
    const n = native();
    const driver = new LiveActivityDriver(n, () => 1_000_000);
    driver.update(playing);
    expect(n.showNowPlaying).not.toHaveBeenCalled();
    driver.setEnabled(true);
    n.liveActivitiesAllowed.mockReturnValueOnce(false);
    driver.update(playing);
    expect(n.showNowPlaying).not.toHaveBeenCalled();
    driver.update(playing);
    expect(n.showNowPlaying).toHaveBeenCalledTimes(1);
  });

  it('updates only on a change a viewer would see: not every tick of playback', () => {
    let now = 1_000_000;
    const n = native();
    const driver = new LiveActivityDriver(n, () => now);
    driver.setEnabled(true);
    driver.update(playing);
    now += 500;
    driver.update({ ...playing, position: 30.5 });
    now += 500;
    driver.update({ ...playing, position: 31 });
    expect(n.showNowPlaying).toHaveBeenCalledTimes(1);
    driver.update({ ...playing, position: 31, playing: false }); // pause
    driver.update({ ...playing, position: 120 }); // a seek
    driver.update({ ...playing, position: 120, chapter: 'Chapter 3' }); // a new chapter
    expect(n.showNowPlaying).toHaveBeenCalledTimes(4);
  });

  it('ends when the audiobook stops or the person turns it off', () => {
    const n = native();
    const driver = new LiveActivityDriver(n);
    driver.setEnabled(true);
    driver.update(playing);
    driver.update(null);
    expect(n.endNowPlaying).toHaveBeenCalledTimes(1);
    driver.update(playing);
    driver.setEnabled(false);
    expect(n.endNowPlaying).toHaveBeenCalledTimes(2);
  });

  it('draws the file’s start and end at its speed, and how far through the book', () => {
    expect(recordOf({ ...playing, rate: 2 }, 1_000_000)).toEqual(expect.objectContaining({ startedAt: 1_000_000 - 15_000, endsAt: 1_000_000 - 15_000 + 150_000, fraction: 0.1, bookPercent: Math.floor((1.1 / 12) * 100) }));
  });

  it('the activity’s attributes are the same in the app and the widget extension (ActivityKit pairs them by name and shape)', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const inModule = readFileSync(path.join(root, 'modules/book-club-native/ios/NowPlayingAttributes.swift'), 'utf8');
    const inWidget = readFileSync(path.join(root, 'targets/widgets/NowPlayingAttributes.swift'), 'utf8');
    expect(inModule).toBe(inWidget);
  });
});

describe('links into the app (D189)', () => {
  it('opens a book or home, and nothing else', () => {
    expect(pathOfAppLink('bookclub:///books/abcdef12')).toBe('/books/abcdef12');
    expect(pathOfAppLink('bookclub://books/abcdef12')).toBe('/books/abcdef12');
    expect(pathOfAppLink('bookclub:///')).toBe('/');
    expect(pathOfAppLink('bookclub://auth?code=x')).toBeNull();
    expect(pathOfAppLink('bookclub:///settings')).toBeNull();
    expect(pathOfAppLink('https://evil.example/books/abcdef12')).toBeNull();
    expect(pathOfAppLink('bookclub:///books/../../x')).toBeNull();
  });
});
