/// <reference types="node" />
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type WidgetBook, type WidgetSnapshot } from '@bookclub/shared';
import { describe, expect, it, vi } from 'vitest';
import { type KeptPlace } from '../audio/BackgroundProgress';
import { CarPlayDriver, DEFAULT_CAR_CONTROLS, type ServerPlace, startingPlace } from './CarPlayDriver';
import { KEPT_QUEUES_MAX, KeptQueues, type KeptQueueFile, parseKeptQueues, withQueue } from './keptQueues';
import { type KeptQueue, NOT_READY, carPlayModel, parseCarCommand } from './model';

const book = (bookId: string, title: string, extra: Partial<WidgetBook> = {}): WidgetBook => ({
  bookId, clubId: 'club01', clubName: 'Tuesday Club', title, author: 'Ursula', coverUrl: `https://books.test/covers/${bookId}`, t: 0.25, percent: 25,
  label: 'Chapter 4 · 25%', format: 'audio', finished: false, at: 1_000, stop: null, ...extra,
});
const snapshot = (current: WidgetBook | null, ...others: WidgetBook[]): WidgetSnapshot => ({ generatedAt: 1, current, others });
const queue = (bookId: string, at: number, tracks = ['Chapter 1', 'Chapter 2', 'Chapter 3']): KeptQueue => ({
  bookId, editionId: `e-${bookId}`, userId: 'u1', title: `Queue title ${bookId}`, author: 'Ursula', artworkUrl: null, at,
  tracks: tracks.map((title, i) => ({ url: `https://books.test/media/editions/e-${bookId}/tracks/${i}`, title })),
});
const kept = (bookId: string, track: number, ms: number, at: number): KeptPlace => ({ bookId, editionId: `e-${bookId}`, userId: 'u1', locator: { kind: 'audio', track, ms }, at, spans: [] });

describe('what CarPlay lists (D221)', () => {
  it('lists only the books of the person signed in now, and plays only those opened on this phone', () => {
    const m = carPlayModel({ snapshot: snapshot(book('b1', 'Earthsea'), book('b2', 'Dune')), queues: [queue('b1', 5), queue('gone', 9)], nowPlaying: null });
    expect(m.books.map((b) => [b.id, b.playable])).toEqual([['book:b1', true], ['book:b2', false]]);
    expect(m.books[1]!.detail).toBe('Not ready for the car yet');
    // A queue kept for a book no longer in the snapshot (another person's, or a club left) is never shown.
    expect(JSON.stringify(m)).not.toContain('gone');
    expect(m.continue).toEqual(expect.objectContaining({ id: 'continue', title: 'Earthsea', detail: 'Chapter 4 · 25%', coverBookId: 'b1' }));
  });

  it('lists nothing at all signed out (no snapshot), whatever is kept', () => {
    expect(carPlayModel({ snapshot: null, queues: [queue('b1', 5)], nowPlaying: { bookId: 'b1', track: 0, playing: true } })).toEqual({ continue: null, books: [], chapters: null, upNext: null, nav: null });
  });

  it('continues the book playing, else the one heard last; its chapters are the track titles the page gave', () => {
    const snap = snapshot(book('b1', 'Earthsea'), book('b2', 'Dune'));
    const queues = [queue('b1', 5), queue('b2', 9, ['Part 1', 'Part 2'])];
    expect(carPlayModel({ snapshot: snap, queues, nowPlaying: null }).continue?.coverBookId).toBe('b2');
    const m = carPlayModel({ snapshot: snap, queues, nowPlaying: { bookId: 'b1', track: 1, playing: true } });
    expect(m.continue).toEqual(expect.objectContaining({ coverBookId: 'b1', detail: 'Chapter 2', playing: true }));
    expect(m.chapters?.rows.map((r) => [r.id, r.title, r.playing])).toEqual([['chapter:b1:0', 'Chapter 1', false], ['chapter:b1:1', 'Chapter 2', true], ['chapter:b1:2', 'Chapter 3', false]]);
    expect(m.books.find((b) => b.id === 'book:b1')?.playing).toBe(true);
    expect(carPlayModel({ snapshot: snap, queues, nowPlaying: null, chaptersOf: 'b1' }).chapters?.bookId).toBe('b1');
  });

  it('reads a row id back as its command, and nothing else', () => {
    expect(parseCarCommand('continue')).toEqual({ kind: 'continue' });
    expect(parseCarCommand('book:b-1_x')).toEqual({ kind: 'book', bookId: 'b-1_x' });
    expect(parseCarCommand('chapter:b1:12')).toEqual({ kind: 'chapter', bookId: 'b1', track: 12 });
    expect(parseCarCommand('control:react:heart')).toEqual({ kind: 'control', id: 'react:heart' });
    expect(parseCarCommand('voice:cancel')).toEqual({ kind: 'voice', event: 'cancel' });
    expect(parseCarCommand('sheet:unavailable')).toEqual({ kind: 'sheet', event: 'unavailable' });
    // The car connecting is the audio session's news (appAudio.ts), not a tap.
    expect(parseCarCommand('connected')).toBeNull();
    for (const bad of ['book:', 'book:a/b', 'chapter:b1:-1', 'chapter:b1:x', 'control:', 'control:a b', 'voice:nope', 'nope', 42, null]) expect(parseCarCommand(bad)).toBeNull();
  });

  it('shows the active book in Up Next while browsing another book’s Chapters', () => {
    const queues = [queue('b1', 5), queue('b2', 9, ['Part 1', 'Part 2'])];
    const input = { snapshot: snapshot(book('b1', 'Earthsea'), book('b2', 'Dune')), queues, chaptersOf: 'b2' };
    const model = carPlayModel({ ...input, nowPlaying: { bookId: 'b1', track: 2, playing: true } });
    expect(model.chapters?.rows.map((row) => row.id)).toEqual(['chapter:b2:0', 'chapter:b2:1']);
    expect(model.upNext?.rows.find((row) => row.playing)?.id).toBe('chapter:b1:2');
    expect(carPlayModel({ ...input, nowPlaying: null }).upNext).toBeNull();
  });

  it('is what the native side decodes (the shared vectors, scripts/test-carplay-swift.sh)', () => {
    const vectors = JSON.parse(readFileSync(path.join(__dirname, 'carplay-vectors.json'), 'utf8')) as { model: unknown };
    const m = carPlayModel({
      snapshot: snapshot(book('b1', 'Earthsea'), book('b2', 'Dune')),
      queues: [queue('b1', 5, ['Chapter 1', 'Chapter 2'])],
      nowPlaying: { bookId: 'b1', track: 1, playing: true },
      nav: { seq: 3, to: 'nowPlaying' },
      controls: { buttons: [{ id: 'cal', symbol: 'sparkles' }, { id: 'speed', system: 'rate' }], upNext: 'Chapters' },
    });
    expect(m).toEqual(vectors.model);
  });
});

describe('the audiobooks kept on the device for the car (D221)', () => {
  it('keeps one queue a book, newest first, at most a few', () => {
    let list: KeptQueue[] = [];
    for (let i = 0; i < KEPT_QUEUES_MAX + 2; i++) list = withQueue(list, queue(`b${i}`, i));
    list = withQueue(list, queue('b3', 100));
    expect(list).toHaveLength(KEPT_QUEUES_MAX);
    expect(list.map((q) => q.bookId).slice(0, 2)).toEqual(['b3', 'b7']);
  });

  it('keeps one person’s only: another’s queue leaves the last person’s behind', () => {
    const mine = withQueue(withQueue([], queue('b1', 1)), queue('b2', 2));
    const theirs = withQueue(mine, { ...queue('b3', 3), userId: 'u2' });
    expect(theirs.map((q) => [q.bookId, q.userId])).toEqual([['b3', 'u2']]);
  });

  it('drops what it cannot read', () => {
    expect(parseKeptQueues('not json')).toEqual([]);
    expect(parseKeptQueues(JSON.stringify([queue('b1', 1), { bookId: 'b2' }, { ...queue('b3', 1), tracks: [] }]))).toEqual([queue('b1', 1)]);
  });

  it('writes each change through, but not the same queue again; and forgets everything signing out', async () => {
    const file = { read: vi.fn(() => Promise.resolve(JSON.stringify([queue('b0', 1)]))), write: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) };
    const changed = vi.fn();
    const q = new KeptQueues(file, changed);
    await q.ready;
    expect(q.all().map((x) => x.bookId)).toEqual(['b0']);
    q.keep(queue('b1', 5));
    q.keep(queue('b1', 6));
    await new Promise((r) => setTimeout(r, 0)); // the file's writes go one after another
    expect(file.write).toHaveBeenCalledTimes(1);
    q.keep(queue('b0', 7)); // an earlier book again: the newest now
    expect(q.all()[0]!.bookId).toBe('b0');
    q.clear();
    expect(q.all()).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(file.remove).toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it('loads the saved queue after a read was refused before first unlock', async () => {
    const file = {
      read: vi.fn().mockRejectedValueOnce(new Error('protected file')).mockResolvedValue(JSON.stringify([queue('book01', 5)])),
      write: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    const queues = new KeptQueues(file);
    await queues.ready;
    expect(queues.all()).toEqual([]);
    await queues.reload();
    expect(file.read).toHaveBeenCalledTimes(2);
    expect(queues.all().map((saved) => saved.bookId)).toEqual(['book01']);
  });

  it('keeps the saved bookmark when fresh metadata arrives before the file has been read', async () => {
    let release!: (json: string) => void;
    const first = new Promise<string>((resolve) => { release = resolve; });
    const file = { read: () => first, write: vi.fn(async (_json: string) => {}), remove: async () => {} };
    const old = queue('book01', 5);
    const mark = { trackUrl: old.tracks[2]!.url, ms: 38_012 };
    const queues = new KeptQueues(file);
    queues.keep({ ...queue('book01', 9), title: 'New title' });
    await Promise.resolve();
    expect(file.write).not.toHaveBeenCalled();
    release(JSON.stringify([{ ...old, bookmark: mark }]));
    await queues.ready;
    expect(queues.get('book01')).toMatchObject({ title: 'New title', bookmark: mark });
    await vi.waitFor(() => expect(file.write).toHaveBeenCalledOnce());
    expect(JSON.parse(file.write.mock.calls[0]![0])).toMatchObject([{ title: 'New title', bookmark: mark }]);
  });

  it('leaves the old bookmark on disk until a transiently unreadable queue has been read', async () => {
    const old = queue('book01', 5);
    const mark = { trackUrl: old.tracks[1]!.url, ms: 5_000 };
    let refuse!: (reason: Error) => void;
    let readable!: (json: string) => void;
    const first = new Promise<string>((_resolve, reject) => { refuse = reject; });
    const retry = new Promise<string>((resolve) => { readable = resolve; });
    const file = {
      read: vi.fn().mockReturnValueOnce(first).mockReturnValue(retry),
      write: vi.fn(async (_json: string) => {}), remove: async () => {},
    };
    const queues = new KeptQueues(file);
    queues.keep({ ...old, title: 'New title' });
    queues.keep({ ...old, title: 'New title' });
    expect(file.read).toHaveBeenCalledOnce();
    refuse(new Error('file could not be read'));
    await vi.waitFor(() => expect(file.read).toHaveBeenCalledTimes(2));
    expect(file.write).not.toHaveBeenCalled();
    readable(JSON.stringify([{ ...old, bookmark: mark }]));
    await queues.ready;
    await vi.waitFor(() => expect(file.write).toHaveBeenCalledOnce());
    expect(JSON.parse(file.write.mock.calls[0]![0])).toMatchObject([{ title: 'New title', bookmark: mark }]);
  });

  it('tries the protected file again on audiobook activity without waiting for another connection', async () => {
    const old = queue('book01', 5);
    const mark = { trackUrl: old.tracks[1]!.url, ms: 5_000 };
    const file = {
      read: vi.fn().mockRejectedValueOnce(new Error('protected file'))
        .mockRejectedValueOnce(new Error('still protected'))
        .mockResolvedValue(JSON.stringify([{ ...old, bookmark: mark }])),
      write: vi.fn(async (_json: string) => {}),
      remove: async () => {},
    };
    const queues = new KeptQueues(file);
    await queues.ready;
    const current = { ...old, title: 'New title' };
    queues.keep(current);
    await queues.ready;
    expect(file.read).toHaveBeenCalledTimes(2);
    expect(file.write).not.toHaveBeenCalled();

    queues.keep(current); // The same metadata is enough to retry.
    await queues.ready;
    expect(file.read).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(file.write).toHaveBeenCalledOnce());
    expect(JSON.parse(file.write.mock.calls[0]![0])).toMatchObject([{ title: 'New title', bookmark: mark }]);
  });

  it('runs one retry if a connect and foreground arrive during an unavailable startup read', async () => {
    let unavailable!: (error: Error) => void;
    const first = new Promise<string>((_, reject) => { unavailable = reject; });
    const file = {
      read: vi.fn().mockReturnValueOnce(first).mockResolvedValue(JSON.stringify([queue('book01', 5)])),
      write: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    const queues = new KeptQueues(file);
    const connected = queues.reload();
    const active = queues.reload();
    unavailable(new Error('protected file'));
    await Promise.all([connected, active]);
    expect(file.read).toHaveBeenCalledTimes(2);
    expect(queues.all().map((saved) => saved.bookId)).toEqual(['book01']);
  });

  it('keeps nothing of the file when signed out before it was read, and never writes after removing', async () => {
    let release: (json: string) => void = () => {};
    const order: string[] = [];
    const file = { read: () => new Promise<string>((r) => (release = r)), write: vi.fn(async () => void order.push('write')), remove: vi.fn(async () => void order.push('remove')) };
    const q = new KeptQueues(file);
    q.keep(queue('b9', 1));
    q.clear();
    release(JSON.stringify([queue('b0', 1)]));
    await q.ready;
    await new Promise((r) => setTimeout(r, 0));
    expect(q.all()).toEqual([]);
    expect(order).toEqual(['write', 'remove']);
  });
});

describe('where a book starts in the car (D221)', () => {
  const q = queue('b1', 5);
  it('takes the newer of the place kept here and the server’s, in this audiobook only', () => {
    const server = (track: number, ms: number, at: number, editionId = 'e-b1'): ServerPlace => ({ editionId, locator: { kind: 'audio', track, ms }, at });
    expect(startingPlace(q, kept('b1', 1, 500, 10), server(2, 900, 20))).toEqual({ kind: 'audio', track: 2, ms: 900 });
    expect(startingPlace(q, kept('b1', 1, 500, 30), server(2, 900, 20))).toEqual({ kind: 'audio', track: 1, ms: 500 });
    expect(startingPlace(q, kept('other', 1, 500, 30), server(2, 900, 20, 'e-other'))).toBe('unknown');
    expect(startingPlace(q, null, server(9, 0, 20))).toBe('unknown'); // not a track this queue has
    // A place kept on this phone by someone else (signed out since), or by nobody known, is not theirs.
    expect(startingPlace(q, { ...kept('b1', 1, 500, 30), userId: 'someone-else' }, null)).toEqual({ kind: 'audio', track: 0, ms: 0 });
    expect(startingPlace(q, { ...kept('b1', 1, 500, 30), userId: null }, server(2, 900, 20))).toEqual({ kind: 'audio', track: 2, ms: 900 });
  });
  it('starts a book never begun at its beginning, and guesses nothing else', () => {
    expect(startingPlace(q, null, null)).toEqual({ kind: 'audio', track: 0, ms: 0 });
    expect(startingPlace(q, null, undefined)).toBe('unknown'); // offline
    expect(startingPlace(q, null, { editionId: null, locator: { kind: 'epub' }, at: 5 })).toBe('unknown'); // reading the ebook
  });
});

describe('a tap in the car (D221)', () => {
  /** `server` absent: never started (null); present as undefined: the server could not be asked. */
  function setup(opts: { server?: ServerPlace | null; kept?: KeptPlace | null; file?: KeptQueueFile } = {}, answers: { onControl?: (id: string, car: CarPlayDriver) => void; onVoice?: (event: string, car: CarPlayDriver) => void; onSheet?: (event: string, car: CarPlayDriver) => void } = {}) {
    const server = 'server' in opts ? opts.server : null;
    const keptPlace = opts.kept ?? null;
    const models: Record<string, unknown>[] = [];
    const native = { setCarPlayModel: vi.fn((json: string) => models.push(JSON.parse(json) as Record<string, unknown>)), widgetSnapshot: () => JSON.stringify(snapshot(book('book01', 'Earthsea'), book('book02', 'Dune'))) };
    const engine = { playFromCar: vi.fn().mockResolvedValue(true), carDisconnected: vi.fn(), keptPlace: vi.fn(() => Promise.resolve(keptPlace)) };
    const queues = new KeptQueues(opts.file ?? { read: () => Promise.resolve(JSON.stringify([queue('book01', 5)])), write: () => Promise.resolve(), remove: () => Promise.resolve() });
    const serverPlace = vi.fn(() => Promise.resolve(server));
    const driver = new CarPlayDriver({ native, engine, queues, serverPlace, ...answers });
    const nav = () => models.at(-1)?.nav as { to: string; message?: string } | null;
    return { driver, engine, models, nav, native, queues, serverPlace };
  }

  it('continues the book from its place, in the car, going on into its next tracks, then shows Now Playing', async () => {
    const { driver, engine, nav } = setup({ server: { editionId: 'e-book01', locator: { kind: 'audio', track: 2, ms: 1234 }, at: 50 } });
    await driver.command('continue');
    expect(engine.playFromCar).toHaveBeenCalledWith(expect.objectContaining({ bookId: 'book01', editionId: 'e-book01', userId: 'u1', advance: true }), expect.objectContaining({ title: 'Chapter 3', albumTitle: 'Queue title book01', artist: 'Ursula' }), 2, 1234);
    expect(nav()?.to).toBe('nowPlaying');
  });

  it('only opens Now Playing after a track starts and shows a message when its start fails', async () => {
    const { driver, engine, nav } = setup();
    let finish!: (started: boolean) => void;
    engine.playFromCar.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const starting = driver.command('continue');
    await vi.waitFor(() => expect(engine.playFromCar).toHaveBeenCalledTimes(1));
    expect(nav()?.to).not.toBe('nowPlaying');
    finish(false);
    await starting;
    expect(nav()).toMatchObject({ to: 'message', message: 'Playback could not start' });
  });

  it('follows the chapters of another book started after the car chose its first one', async () => {
    const { driver, queues } = setup();
    await driver.command('book:book01');
    expect(driver.model().chapters?.bookId).toBe('book01');
    driver.setNowPlaying({ bookId: 'book02', track: 0, playing: true });
    expect(driver.model().chapters).toBeNull();
    queues.keep(queue('book02', 9));
    expect(driver.model().chapters?.bookId).toBe('book02');
  });

  it('keeps running and retries a model that native could not accept yet', () => {
    const { driver, native } = setup();
    const unavailable = () => { throw new Error('native error details'); };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      native.setCarPlayModel.mockImplementationOnce(unavailable).mockImplementationOnce(unavailable);
      expect(() => driver.refresh()).not.toThrow();
      driver.refresh();
      expect(warning.mock.calls).toEqual([['CarPlay screen update failed']]);
      driver.refresh();
      driver.refresh();
      expect(native.setCarPlayModel).toHaveBeenCalledTimes(3);
      native.setCarPlayModel.mockImplementationOnce(unavailable);
      driver.setControls({ buttons: [{ id: 'cal', symbol: 'sparkles' }] });
      expect(warning.mock.calls).toEqual([['CarPlay screen update failed'], ['CarPlay screen update failed']]);
    } finally {
      warning.mockRestore();
    }
  });

  it('shows the chapters of a book whose place in this audiobook is not known, rather than guess', async () => {
    const { driver, engine, nav } = setup({ server: undefined });
    await driver.command('book:book01');
    expect(engine.playFromCar).not.toHaveBeenCalled();
    expect(nav()?.to).toBe('chapters');
  });

  it('plays a chapter from its beginning, or from the place when it is the chapter you are in', async () => {
    const { driver, engine } = setup({ kept: kept('book01', 1, 777, 10) });
    await driver.command('chapter:book01:0');
    expect(engine.playFromCar).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 0, 0);
    await driver.command('chapter:book01:1');
    expect(engine.playFromCar).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 1, 777);
    await driver.command('chapter:book01:9');
    expect(engine.playFromCar).toHaveBeenCalledTimes(2);
  });

  it('saves the active place locally and starts that bookmark after reopening offline', async () => {
    let stored: string | null = JSON.stringify([queue('book01', 5)]);
    const file = {
      read: async () => stored,
      write: vi.fn(async (json: string) => { stored = json; }),
      remove: async () => { stored = null; },
    };
    const { driver, nav } = setup({ file });
    await driver.saveBookmark({ ...kept('book01', 2, 38_012, 50), trackUrl: queue('book01', 5).tracks[2]!.url });
    expect(file.write).toHaveBeenCalledOnce();
    expect(nav()?.message).toBe('Bookmark saved');

    const reopened = setup({ file, server: undefined });
    await reopened.queues.ready;
    expect(reopened.driver.model().chapters?.rows[0]).toMatchObject({ id: 'bookmark:book01', title: 'Bookmark', detail: 'Chapter 3' });
    await reopened.driver.command('bookmark:book01');
    expect(reopened.engine.keptPlace).not.toHaveBeenCalled();
    expect(reopened.engine.playFromCar).toHaveBeenCalledWith(expect.objectContaining({ editionId: 'e-book01' }), expect.anything(), 2, 38_012);
    expect(reopened.nav()?.to).toBe('nowPlaying');
  });

  it('does not confirm a bookmark write that overlaps sign-out or expose it after restart', async () => {
    let stored: string | null = JSON.stringify([queue('book01', 5)]);
    let begin!: () => void;
    let release!: () => void;
    const opened = new Promise<void>((resolve) => { begin = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const file = {
      read: async () => stored,
      write: vi.fn(async (json: string) => { stored = json; }).mockImplementationOnce(async (json) => {
        begin();
        await held;
        stored = json;
      }),
      remove: async () => { stored = null; },
    };
    const { driver, queues, nav } = setup({ file });
    const saving = driver.saveBookmark({ ...kept('book01', 0, 5_000, 50), trackUrl: queue('book01', 5).tracks[0]!.url });
    await opened;
    queues.clear();
    queues.keep({ ...queue('book01', 8), userId: 'u2' });
    release();
    await saving;
    expect(nav()?.message).not.toBe('Bookmark saved');
    await vi.waitFor(() => expect(file.write).toHaveBeenCalledTimes(2));
    const reopened = setup({ file });
    await reopened.queues.ready;
    expect(reopened.queues.get('book01')?.userId).toBe('u2');
    await reopened.driver.command('bookmark:book01');
    expect(reopened.engine.playFromCar).not.toHaveBeenCalled();
  });

  it('keeps the tapped file when its queue is reordered before saving', async () => {
    let release!: (json: string) => void;
    const first = new Promise<string>((resolve) => { release = resolve; });
    const file = { read: () => first, write: async () => {}, remove: async () => {} };
    const old = queue('book01', 5);
    const { driver, queues, engine } = setup({ file });
    const saving = driver.saveBookmark({ ...kept('book01', 0, 5_000, 50), trackUrl: old.tracks[0]!.url });
    queues.keep({ ...old, at: 10, tracks: [old.tracks[1]!, old.tracks[0]!, old.tracks[2]!] });
    release(JSON.stringify([old]));
    await saving;
    expect(driver.model().chapters?.rows[0]).toMatchObject({ id: 'bookmark:book01', detail: 'Chapter 1' });
    await driver.command('bookmark:book01');
    expect(engine.playFromCar).toHaveBeenCalledWith(expect.anything(), expect.anything(), 1, 5_000);
  });

  it('plays nothing it does not list: a book not opened on this phone, or not this person’s', async () => {
    const { driver, engine, nav } = setup();
    await driver.command('book:book02');
    expect(nav()).toEqual(expect.objectContaining({ to: 'message', message: 'Not ready for the car yet' }));
    await driver.command('book:someone-else');
    await driver.command('chapter:someone-else:0');
    expect(engine.playFromCar).not.toHaveBeenCalled();
  });

  it('gives the page the player back when the car goes away', async () => {
    const { driver, engine } = setup();
    await driver.command('disconnected');
    expect(engine.carDisconnected).toHaveBeenCalled();
    expect(engine.playFromCar).not.toHaveBeenCalled();
  });

  it('plays nothing for a tap still being answered when the car goes away', async () => {
    const { driver, engine } = setup({ server: { editionId: 'e-book01', locator: { kind: 'audio', track: 2, ms: 1234 }, at: 50 } });
    // The tap is waiting on the kept queues, then on the server's place; the car unplugs meanwhile.
    const tapped = driver.command('continue');
    await driver.command('disconnected');
    await tapped;
    expect(engine.carDisconnected).toHaveBeenCalled();
    expect(engine.playFromCar).not.toHaveBeenCalled();
  });

  it('stops showing a stale native snapshot and cancels a pending selection at sign-out', async () => {
    const { driver, engine, queues } = setup();
    await queues.ready;
    expect(driver.model().continue?.coverBookId).toBe('book01');
    const tap = driver.command('continue');
    driver.setSignedOut(true);
    await tap;
    expect(driver.model().books).toEqual([]);
    expect(driver.model().continue).toBeNull();
    expect(engine.playFromCar).not.toHaveBeenCalled();
  });

  it('does not start a previous account’s pending Continue after sign-out clears its queues', async () => {
    const { driver, engine, queues, serverPlace } = setup();
    let finish!: (place: null) => void;
    serverPlace.mockReturnValueOnce(new Promise<null>((resolve) => { finish = resolve; }));
    const pending = driver.command('continue');
    await vi.waitFor(() => expect(serverPlace).toHaveBeenCalledOnce());
    driver.cancelPending();
    queues.clear();
    finish(null);
    await pending;
    expect(engine.playFromCar).not.toHaveBeenCalled();
  });

  it('never asks the driver to use the phone: what it says states the condition (Apple’s CarPlay guideline)', async () => {
    const { driver, nav, models } = setup();
    await driver.command('book:book02');
    expect(nav()?.message).toBe(NOT_READY);
    expect(JSON.stringify(models)).not.toMatch(/phone/i);
  });

  it('offers Continue when connecting again after the saved queue becomes available', async () => {
    const file = {
      read: vi.fn().mockRejectedValueOnce(new Error('protected file')).mockResolvedValue(JSON.stringify([queue('book01', 5)])),
      write: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    const { driver, engine, queues } = setup({ file });
    await queues.ready;
    expect(driver.model().continue).toBeNull();
    await driver.command('connected');
    expect(driver.model().continue?.id).toBe('continue');
    await driver.command('continue');
    expect(engine.playFromCar).toHaveBeenCalledTimes(1);
  });

  it('gives Now Playing only CarPlay’s Up Next button until told otherwise, then the buttons it is given (D232)', async () => {
    const { driver, models, queues } = setup();
    await queues.ready;
    driver.refresh();
    expect(models.at(-1)?.controls).toEqual({ buttons: [], upNext: 'Chapters' });
    expect(DEFAULT_CAR_CONTROLS).toEqual({ buttons: [], upNext: 'Chapters' });
    driver.setControls({ buttons: [{ id: 'cal', symbol: 'sparkles' }] });
    expect(models.at(-1)?.controls).toEqual({ buttons: [{ id: 'cal', symbol: 'sparkles' }] });
    driver.setControls(null); // CarPlay's plain Now Playing: the model says nothing of it
    expect(models.at(-1)).not.toHaveProperty('controls');
  });

  it('sends a sheet, the voice screen and their dismissal as the steps native decodes (the shared vectors, D232)', async () => {
    const vectors = JSON.parse(readFileSync(path.join(__dirname, 'carplay-vectors.json'), 'utf8')) as { navs: unknown[] };
    const { driver, models, queues } = setup();
    await queues.ready;
    driver.sheet('React', [{ id: 'react:heart', title: 'Loved that' }, { id: 'react:none', title: 'Cancel', style: 'cancel' }]);
    driver.voice({ states: [{ id: 'listening', title: 'Listening…', symbol: 'waveform' }, { id: 'thinking', title: 'Thinking…' }], state: 'listening', cancel: 'Done' });
    driver.dismiss();
    expect(models.map((m) => m.nav)).toEqual(vectors.navs);
    const sent = models.length;
    driver.sheet('Nothing to choose', []); // a sheet with no choices is never shown
    expect(models).toHaveLength(sent);
  });

  it('hands a button’s or a choice’s tap, and the voice screen’s news, to whoever answers them, and plays nothing itself (D232)', async () => {
    const onControl = vi.fn();
    const onVoice = vi.fn();
    const { driver, engine, native } = setup({}, { onControl, onVoice });
    await driver.command('control:cal');
    await driver.command('voice:closed');
    expect(onControl).toHaveBeenCalledWith('cal', driver);
    expect(onVoice).toHaveBeenCalledWith('closed', driver);
    expect(engine.playFromCar).not.toHaveBeenCalled();
    expect(native.setCarPlayModel).not.toHaveBeenCalled();
    // With nobody answering (this build's own JavaScript), a tap does nothing, and nothing breaks.
    const quiet = setup();
    await quiet.driver.command('control:cal');
    expect(quiet.engine.playFromCar).not.toHaveBeenCalled();
  });

  it('sends the model only when it changed', async () => {
    const { driver, native, queues } = setup();
    await queues.ready;
    driver.refresh();
    driver.refresh();
    driver.setNowPlaying({ bookId: 'book01', track: 0, playing: true });
    driver.setNowPlaying({ bookId: 'book01', track: 0, playing: true });
    expect(native.setCarPlayModel).toHaveBeenCalledTimes(2);
  });
});
