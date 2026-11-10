/// <reference types="node" />
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
const { LiveActivityDriver, NativeExtras, WatchDriver, recordOf } = await import('./NativeExtras');
const { pathOfAppLink } = await import('./appLink');

const native = () => ({
  setWidgetSnapshot: vi.fn(() => Promise.resolve()),
  clearWidgets: vi.fn(),
  liveActivitiesAllowed: vi.fn(() => true),
  showNowPlaying: vi.fn(() => Promise.resolve()),
  endNowPlaying: vi.fn(() => Promise.resolve()),
  addListener: vi.fn(() => ({ remove: vi.fn() })),
  setCarPlayModel: vi.fn(),
  widgetSnapshot: vi.fn(() => null),
  setWatchNowPlaying: vi.fn(),
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
  it('tells CarPlay of each snapshot once the App Group has it, and of a signed-out one at once (D221)', async () => {
    const n = native();
    const heard: boolean[] = [];
    const extras = new NativeExtras(n, new LiveActivityDriver(n), null, (signedOut) => heard.push(signedOut));
    extras.handle(JSON.stringify({ type: 'widgets', snapshot: { generatedAt: 1, current: { bookId: 'b1' }, others: [] }, covers: {} }));
    expect(heard).toEqual([]);
    await Promise.resolve();
    expect(heard).toEqual([false]);
    extras.handle(JSON.stringify({ type: 'widgets', snapshot: { generatedAt: 2, current: null, others: [] }, covers: {} }));
    expect(heard).toEqual([false, true]);
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
  it('opens what a Book Club message from iMessage is about, and nothing else (D220)', () => {
    expect(pathOfAppLink('bookclub:///join/abcdefgh12')).toBe('/join/abcdefgh12');
    expect(pathOfAppLink('bookclub:///clubs/club0001/next-book')).toBe('/clubs/club0001/next-book');
    expect(pathOfAppLink('bookclub:///books/abcdef12#note-comment01')).toBe('/books/abcdef12#note-comment01');
    expect(pathOfAppLink('bookclub:///join/short')).toBeNull();
    expect(pathOfAppLink('bookclub:///clubs/club0001')).toBeNull();
    expect(pathOfAppLink('bookclub:///clubs/club0001/next-book#note-comment01')).toBeNull();
    expect(pathOfAppLink('bookclub:///books/abcdef12#settings')).toBeNull();
    expect(pathOfAppLink('bookclub:///books/abcdef12?x=1')).toBeNull();
    expect(pathOfAppLink('bookclub:///?next=/settings')).toBeNull();
  });
});

describe('the session for the Messages extension (D220)', () => {
  it('is shared with every snapshot, for this server only, and deleted once the page says nobody is signed in', () => {
    const n = { ...native(), shareSession: vi.fn(() => true) };
    const extras = new NativeExtras(n, new LiveActivityDriver(n), 'https://books.example');
    extras.handle(JSON.stringify({ type: 'widgets', snapshot: { generatedAt: 1, current: { bookId: 'b1' }, others: [] }, covers: {} }));
    extras.handle(JSON.stringify({ type: 'widgets', snapshot: { generatedAt: 2, current: null, others: [] }, covers: {} }));
    // Signed out: the cookie the WebView mirrored outlives the sign-out, so the page's word decides.
    expect(n.shareSession.mock.calls).toEqual([['https://books.example', true], ['https://books.example', false]]);
    extras.shareSession(); // a foreground after signing out shares nothing
    expect(n.shareSession).toHaveBeenLastCalledWith('https://books.example', false);
    extras.handle(JSON.stringify({ type: 'widgets', snapshot: { generatedAt: 3, current: { bookId: 'b1' }, others: [] }, covers: {} }));
    expect(n.shareSession).toHaveBeenLastCalledWith('https://books.example', true);
    extras.handle(JSON.stringify({ type: 'live-activity', enabled: true }));
    expect(n.shareSession).toHaveBeenCalledTimes(4);
  });

  it('does nothing on a build without it, or with no server to share for, and never throws', () => {
    const old = native();
    expect(() => new NativeExtras(old, new LiveActivityDriver(old), 'https://books.example').shareSession()).not.toThrow();
    const n = { ...native(), shareSession: vi.fn(() => { throw new Error('keychain'); }) };
    expect(() => new NativeExtras(n, new LiveActivityDriver(n), 'https://books.example').shareSession()).not.toThrow();
    const none = { ...native(), shareSession: vi.fn(() => true) };
    new NativeExtras(none, new LiveActivityDriver(none)).shareSession();
    expect(none.shareSession).not.toHaveBeenCalled();
  });
});

describe('the shared-session Swift file (D220)', () => {
  it('is the same in the native module, which writes it, and the Messages extension, which reads it', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const a = readFileSync(path.join(root, 'modules', 'book-club-native', 'ios', 'SharedSession.swift'), 'utf8');
    const b = readFileSync(path.join(root, 'targets', 'messages', '_shared', 'SharedSession.swift'), 'utf8');
    expect(a).toBe(b);
    // the App Group the widgets use, so no new entitlement
    expect(a).toContain('static let accessGroup = "group.ai.badland.books"');
    expect(readFileSync(path.join(root, 'targets', 'widgets', 'Snapshot.swift'), 'utf8')).toContain('let appGroup = "group.ai.badland.books"');
  });
});

describe('the watch app’s view of the player (D222)', () => {
  it('tells the watch what plays, whether or not the Live Activity is on, only when something it shows changed', () => {
    const n = native();
    let now = 100_000;
    const watch = new WatchDriver(n, () => now);
    watch.update(playing);
    expect(n.setWatchNowPlaying).toHaveBeenCalledTimes(1);
    expect(JSON.parse(n.setWatchNowPlaying.mock.calls[0]![0] as string)).toEqual(recordOf(playing, 100_000));
    now += 1000;
    watch.update({ ...playing, position: 31 }); // playing on: the watch's own clock moves it
    expect(n.setWatchNowPlaying).toHaveBeenCalledTimes(1);
    watch.update({ ...playing, position: 31, playing: false });
    expect(n.setWatchNowPlaying).toHaveBeenCalledTimes(2);
    watch.update(null);
    watch.update(null);
    expect(n.setWatchNowPlaying).toHaveBeenLastCalledWith(null);
    expect(n.setWatchNowPlaying).toHaveBeenCalledTimes(3);
  });
  it('does nothing in a build without the module', () => {
    expect(() => new WatchDriver(null).update(playing)).not.toThrow();
  });
});
